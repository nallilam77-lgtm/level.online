// Prueba la Arena de punta a punta contra el servidor local, con una tienda simulada (no toca nada real).
// Uso: npm run dev:arena (en otra terminal) y luego node prueba/arena.mjs
//   - Torneo 1 vs 1 al mejor de 3 (dos clientes con sesión de prueba) → la tienda recibe "empezo" y "resultado".
//   - Torneo con un solo jugador presente a la hora + 10 min → gana por ausencia (W.O.).
//   - Un intruso sin sesión no entra; uno con sesión pero no inscrito solo mira.
//   - Duelo rápido: dos en la cola → sala con puntos → la tienda recibe "ranking". Uno solo → bot a los 20 s.
import http from 'node:http';

const BASE = process.env.BASE || 'ws://localhost:8787';
const SECRETO = 'x'.repeat(64);
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const uuid = () => crypto.randomUUID();
let fallas = 0;
const ok = (cond, texto) => { console.log(`${cond ? '✅' : '❌'} ${texto}`); if (!cond) fallas++; };

// ---------- Tienda simulada (api/juego?accion=arena_*) ----------
const partidas = new Map();
const eventos = [];
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.headers['x-arena'] !== SECRETO) { res.writeHead(403); res.end(); return; }
  if (url.searchParams.get('accion') === 'arena_sala') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'success', partida: partidas.get(url.searchParams.get('id')) || null }));
    return;
  }
  let cuerpo = '';
  req.on('data', (d) => { cuerpo += d; });
  req.on('end', () => { eventos.push(JSON.parse(cuerpo)); res.writeHead(200); res.end('{"status":"success"}'); });
}).listen(8790);

// ---------- Un cliente que juega solo ----------
function cliente(nombre, url, jwt) {
  const c = { nombre, ws: new WebSocket(url), est: null, id: null, errores: [], jugadas: 0, perfectos: 0 };
  c.ws.addEventListener('open', () => c.ws.send(JSON.stringify({ t: 'hola', n: nombre, jwt })));
  c.ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.t === 'yo') c.id = m.id;
    else if (m.t === 'error') c.errores.push(m.m);
    else if (m.t === 'pi') c.ws.send(JSON.stringify({ t: 'pa', k: m.k }));
    else if (m.t === 'emparejado') c.emparejado = m;
    else if (m.t === 'flecha') {
      // Detiene la flecha justo en el centro (media pasada) y ataca
      setTimeout(() => { c.ws.send(JSON.stringify({ t: 'accion', h: c.op.h, o: c.op.o[0], ms: m.pasada / 2 })); c.jugadas++; }, m.pasada / 2);
    } else if (m.t === 's') {
      c.est = m;
      const k = m.c;
      if (m.fase === 'combate' && k.t >= 0 && k.l[k.t].j === c.id && m.queda > 0 && c.turnoVisto !== `${m.serie && m.serie.num}-${k.r}-${k.t}`) {
        c.turnoVisto = `${m.serie && m.serie.num}-${k.r}-${k.t}`;
        c.op = k.op.find((o) => o.h === 'f') || k.op[0];
        setTimeout(() => c.ws.send(JSON.stringify({ t: 'flecha', h: c.op.h })), 50);
      }
      if (m.ev) c.perfectos += m.ev.filter((x) => x.t === 'accion' && x.p >= 0.95 && k.l[x.a].j === c.id).length;
    }
  });
  return c;
}
const jwt = (u, n) => `prueba:${u}:${n}`;
const terminar = async (c, s = 300) => { for (let i = 0; i < s && !(c.est && c.est.fase === 'fin'); i++) await espera(1000); };

// ---------- 1. Torneo 1 vs 1, mejor de 3 ----------
const ana = uuid(), beto = uuid();
partidas.set('aaaaaaaaaa', { id: 'aaaaaaaaaa', modo: '1v1', estado: 'lista', hora: new Date(Date.now() + 60000).toISOString(),
  jugadores: [{ usuario: ana, nombre: 'Ana', puesto: 0 }, { usuario: beto, nombre: 'Beto', puesto: 2 }] });
const intruso = cliente('Intruso', `${BASE}/ws?a=aaaaaaaaaa`, 'basura');
const a = cliente('Ana', `${BASE}/ws?a=aaaaaaaaaa`, jwt(ana, 'Ana'));
await espera(800);
ok(intruso.errores.length === 1, 'Sin sesión no entra: ' + intruso.errores[0]);
ok(a.est && a.est.fase === 'sala' && a.est.tipo === 'arena', 'Ana entra a la sala del torneo y espera');
const mira = cliente('Mirón', `${BASE}/ws?a=aaaaaaaaaa`, jwt(uuid(), 'Miron'));
const b = cliente('Beto', `${BASE}/ws?a=aaaaaaaaaa`, jwt(beto, 'Beto'));
await espera(4500);
ok(a.est.fase === 'combate', 'Con los dos dentro empieza solo (fase: ' + a.est.fase + ')');
ok(mira.est && mira.est.jug.find((j) => j.id === mira.id).p === -1, 'El no inscrito solo mira');
ok(eventos.some((e) => e.tipo === 'empezo' && e.partida === 'aaaaaaaaaa'), 'La tienda supo que empezó');
await terminar(a);
const res1 = eventos.find((e) => e.tipo === 'resultado' && e.partida === 'aaaaaaaaaa');
ok(a.est.fase === 'fin' && a.est.serie.fin && res1, `Serie terminada: ganó ${['Rojo (Ana)', 'Azul (Beto)'][res1 && res1.ganador]} ${res1 && res1.marcador}`);
ok(res1 && /^2-[01]$|^[01]-2$/.test(res1.marcador), 'Al mejor de 3 (marcador ' + (res1 && res1.marcador) + ')');
ok(a.perfectos + b.perfectos > 0, `La flecha en el centro cuenta como perfecta (${a.perfectos + b.perfectos} perfectos)`);
[a, b, mira, intruso].forEach((c) => c.ws.close());

// ---------- 2. Ausencia ----------
const carla = uuid();
partidas.set('bbbbbbbbbb', { id: 'bbbbbbbbbb', modo: '1v1', estado: 'lista', hora: new Date(Date.now() - 11 * 60000).toISOString(),
  jugadores: [{ usuario: uuid(), nombre: 'Falta', puesto: 0 }, { usuario: carla, nombre: 'Carla', puesto: 2 }] });
const cc = cliente('Carla', `${BASE}/ws?a=bbbbbbbbbb`, jwt(carla, 'Carla'));
await espera(4000);
const res2 = eventos.find((e) => e.tipo === 'resultado' && e.partida === 'bbbbbbbbbb');
ok(res2 && res2.ganador === 1 && res2.marcador === 'W.O.', 'Rival ausente: gana Carla por W.O.');
cc.ws.close();

// ---------- 3. Sala que aún no abre ----------
partidas.set('cccccccccc', { id: 'cccccccccc', modo: '1v1', estado: 'lista', hora: new Date(Date.now() + 60 * 60000).toISOString(), jugadores: [] });
const temprano = cliente('Temprano', `${BASE}/ws?a=cccccccccc`, jwt(uuid(), 'T'));
await espera(800);
ok(/abre 10 minutos antes/.test(temprano.errores[0] || ''), 'Antes de tiempo: ' + temprano.errores[0]);

// ---------- 4. Duelo rápido ----------
const dani = uuid(), eva = uuid();
const q1 = cliente('Dani', `${BASE}/cola`, jwt(dani, 'Dani'));
await espera(500);
const q2 = cliente('Eva', `${BASE}/cola`, jwt(eva, 'Eva'));
await espera(1000);
ok(q1.emparejado && q2.emparejado && q1.emparejado.s === q2.emparejado.s && !q1.emparejado.bot, 'La cola empareja a los dos en la misma sala');
const d = cliente('Dani', `${BASE}/ws?s=${q1.emparejado.s}`, jwt(dani, 'Dani'));
const e2 = cliente('Eva', `${BASE}/ws?s=${q2.emparejado.s}`, jwt(eva, 'Eva'));
await terminar(d);
const rk = eventos.find((x) => x.tipo === 'ranking');
ok(rk && [dani, eva].includes(rk.ganador.usuario) && rk.ganador.usuario !== rk.perdedor.usuario, `Puntos para ${rk && rk.ganador.nombre}`);
[d, e2].forEach((c) => c.ws.close());
const solo = cliente('Solo', `${BASE}/cola`, jwt(uuid(), 'Solo'));
await espera(21500);
ok(solo.emparejado && solo.emparejado.bot, 'Solo en la cola: a los 20 s, contra un bot');

console.log(fallas ? `\n${fallas} prueba(s) fallaron` : '\nTodo bien');
process.exit(fallas ? 1 : 0);
