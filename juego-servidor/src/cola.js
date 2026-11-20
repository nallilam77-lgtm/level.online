// =========================================================================
// Duelo de Acero · cola del duelo rápido (un solo Durable Object, "cola"). Ver ARENA.md.
//
// El navegador se conecta a /cola y manda { t: 'hola', jwt }. Con dos clientes distintos esperando, arma
// una sala 'ranking' (1 vs 1, el resultado da puntos) y les manda { t: 'emparejado', s: <sala> }. Si en
// 20 s no aparece nadie, arma una sala 'bot' (contra la máquina, sin puntos) y manda { t: 'emparejado', s, bot: true }.
// Mientras espera recibe { t: 'esperando', gente: <cuántos buscan> }.
// /cola?modo=fichas: duelo por fichas (mejor de 3, cuesta 2 fichas que se cobran al empezar): salas 'fichas'
// o, sin nadie en 20 s, 'fichas_bot' (contra un bot experto). Cada modo tiene su propia fila de espera.
// =========================================================================
import { usuarioDe, pedirTienda } from './sesion.js';

const ESPERA_BOT_MS = 20000;
const LETRAS = 'abcdefghjkmnpqrstuvwxyz23456789';
const nuevaSala = () => [...crypto.getRandomValues(new Uint8Array(10))].map((b) => LETRAS[b % LETRAS.length]).join('');

export class Cola {
  constructor(state, env) {
    this.env = env;
    this.colas = { gratis: new Map(), fichas: new Map() };   // modo → (usuario → { ws, usuario, nombre, reloj })
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Solo WebSocket', { status: 426 });
    const modo = new URL(request.url).searchParams.get('modo') === 'fichas' ? 'fichas' : 'gratis';
    const esperando = this.colas[modo];
    const [cliente, ws] = Object.values(new WebSocketPair());
    ws.accept();
    let yo = null;
    const enviar = (d) => { try { ws.send(JSON.stringify(d)); } catch (e) { /* cerrada */ } };
    ws.addEventListener('message', async (e) => {
      if (yo || typeof e.data !== 'string' || e.data.length > 3000) return;
      let m;
      try { m = JSON.parse(e.data); } catch (err) { return; }
      if (!m || m.t !== 'hola') return;
      const s = await usuarioDe(this.env, m.jwt);
      if (!s) { enviar({ t: 'error', m: 'Inicia sesión con Google para jugar.' }); try { ws.close(1008, 'sin sesión'); } catch (err) { /* */ } return; }
      // Cola de fichas: solo quien tiene para pagar (si la tienda no responde, entra igual: el cobro al empezar decide)
      if (modo === 'fichas') {
        const r = await pedirTienda(this.env, { tipo: 'fichas_saldo', usuario: s.usuario });
        if (r && typeof r.fichas === 'number' && r.fichas < (r.costo || 2)) {
          enviar({ t: 'error', m: `No tienes fichas suficientes: el duelo cuesta ${r.costo || 2} y tienes ${r.fichas}. Recarga con tu sesión iniciada para ganar fichas.` });
          try { ws.close(1008, 'sin fichas'); } catch (err) { /* */ }
          return;
        }
        if (ws.readyState !== 1) return;          // se fue mientras se revisaba
      }
      yo = { ws, usuario: s.usuario, nombre: s.nombre, reloj: null };
      // La misma cuenta en otra pestaña: se queda la nueva
      const viejo = esperando.get(s.usuario);
      if (viejo) { clearTimeout(viejo.reloj); try { viejo.ws.close(1000, 'otra pestaña'); } catch (err) { /* */ } }
      esperando.delete(s.usuario);
      const rival = [...esperando.values()][0];
      if (rival) {
        esperando.delete(rival.usuario);
        clearTimeout(rival.reloj);
        await this.armar(modo === 'fichas' ? 'fichas' : 'ranking', [rival, yo]);
        return;
      }
      esperando.set(s.usuario, yo);
      yo.reloj = setTimeout(() => {
        if (esperando.get(yo.usuario) !== yo) return;
        esperando.delete(yo.usuario);
        this.armar(modo === 'fichas' ? 'fichas_bot' : 'bot', [yo]);
      }, ESPERA_BOT_MS);
      this.contar(esperando);
    });
    const fuera = () => {
      if (yo && esperando.get(yo.usuario) === yo) { clearTimeout(yo.reloj); esperando.delete(yo.usuario); this.contar(esperando); }
    };
    ws.addEventListener('close', fuera);
    ws.addEventListener('error', fuera);
    return new Response(null, { status: 101, webSocket: cliente });
  }

  contar(esperando) {
    const d = JSON.stringify({ t: 'esperando', gente: esperando.size });
    for (const x of esperando.values()) try { x.ws.send(d); } catch (e) { /* */ }
  }

  async armar(tipo, jugadores) {
    const s = nuevaSala();
    const datos = { tipo, id: s, jugadores: jugadores.map((x, i) => ({ usuario: x.usuario, nombre: x.nombre, puesto: i === 0 ? 0 : 2 })) };
    try {
      await this.env.SALA.get(this.env.SALA.idFromName('sala-' + s)).fetch('https://sala/config', { method: 'POST', body: JSON.stringify(datos) });
    } catch (e) {
      for (const x of jugadores) { try { x.ws.send(JSON.stringify({ t: 'error', m: 'No se pudo armar la partida. Intenta de nuevo.' })); x.ws.close(1011, 'error'); } catch (err) { /* */ } }
      return;
    }
    for (const x of jugadores) {
      try { x.ws.send(JSON.stringify({ t: 'emparejado', s, bot: tipo === 'bot' || tipo === 'fichas_bot' || undefined })); x.ws.close(1000, 'emparejado'); } catch (e) { /* se fue: su rival lo espera 45 s */ }
    }
  }
}
