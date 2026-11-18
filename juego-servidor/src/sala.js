// =========================================================================
// Último en Pie · la sala (Cloudflare Durable Object).
//
// Una sola sala para todos. Mientras haya alguien conectado corre 20 veces por segundo y manda a todos el
// mismo mensaje con lo que cambió. Si no queda nadie, se detiene (no gasta).
//
// Mensajes del navegador (JSON, pequeños):
//   { t: 'jugar', n: 'Nombre' }                 anotarse para la próxima partida
//   { t: 'd', x: 1, y: 0, a: 1.57, f: 1 }       moverse (x, y entre -1 y 1), apuntar (radianes) y disparar
//   { t: 'c' }                                  cambiar el arma por la del piso
//   { t: 'r' }                                  recargar
//   { t: 'p', k: 123 }                          ping (el servidor contesta { t: 'po', k })
// =========================================================================

import { Partida, AJUSTES } from './partida.js';

const MAX_CONEXIONES = 40;        // jugadores + quienes miran
const MAX_MENSAJES_SEG = 30;      // más que esto por segundo = se cierra la conexión
const MAX_BYTES = 200;

export class Sala {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.partida = new Partida();
    this.conexiones = new Set();
    this.porEntrar = [];
    this.reloj = null;
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Solo WebSocket', { status: 426 });
    const prueba = Number(request.headers.get('X-Espera-Prueba'));   // solo llega desde localhost (worker.js)
    if (prueba > 0) this.partida.esperaS = prueba;
    if (this.conexiones.size + this.porEntrar.length >= MAX_CONEXIONES) return new Response('Sala llena', { status: 503 });

    const par = new WebSocketPair();
    const [cliente, servidor] = Object.values(par);
    servidor.accept();
    const con = { ws: servidor, id: null, mensajes: 0, desde: Date.now() };
    this.porEntrar.push(con);
    servidor.addEventListener('message', (e) => this.recibir(con, e.data));
    servidor.addEventListener('close', () => this.salir(con));
    servidor.addEventListener('error', () => this.salir(con));
    this.arrancar();
    return new Response(null, { status: 101, webSocket: cliente });
  }

  arrancar() {
    if (this.reloj) return;
    this.reloj = setInterval(() => this.paso(), AJUSTES.TICK_MS);
  }

  enviar(con, datos) {
    try { con.ws.send(typeof datos === 'string' ? datos : JSON.stringify(datos)); } catch (e) { this.salir(con); }
  }

  recibir(con, crudo) {
    const ahora = Date.now();
    if (ahora - con.desde > 1000) { con.desde = ahora; con.mensajes = 0; }
    if (++con.mensajes > MAX_MENSAJES_SEG || typeof crudo !== 'string' || crudo.length > MAX_BYTES) {
      try { con.ws.close(1008, 'demasiados mensajes'); } catch (e) { /* ya cerrada */ }
      this.salir(con);
      return;
    }
    let m;
    try { m = JSON.parse(crudo); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;

    if (m.t === 'd') {
      if (con.id) this.partida.dirigir(con.id, m);
    } else if (m.t === 'jugar') {
      if (!con.id) {
        con.id = this.partida.unirse(m.n);
        this.enviar(con, { t: 'yo', id: con.id });
      }
      this.partida.listo(con.id, m.n);
    } else if (m.t === 'c') {
      if (con.id) this.partida.cambiar(con.id);
    } else if (m.t === 'r') {
      if (con.id) this.partida.recargar(con.id);
    } else if (m.t === 'p') {
      this.enviar(con, { t: 'po', k: Number(m.k) || 0 });
    }
  }

  salir(con) {
    if (con.salio) return;
    con.salio = true;
    this.conexiones.delete(con);
    this.porEntrar = this.porEntrar.filter((c) => c !== con);
    if (con.id) this.partida.salir(con.id);
  }

  paso() {
    if (!this.conexiones.size && !this.porEntrar.length) {
      clearInterval(this.reloj);
      this.reloj = null;
      // Sala vacía: la próxima vez empieza limpia (sin una partida a medias)
      const esperaS = this.partida.esperaS;
      this.partida = new Partida();
      this.partida.esperaS = esperaS;
      return;
    }
    const cambios = JSON.stringify(this.partida.paso());
    for (const con of this.conexiones) this.enviar(con, cambios);
    // Los recién llegados reciben la foto completa justo después del paso, y desde el siguiente, los cambios
    if (this.porEntrar.length) {
      const foto = JSON.stringify(this.partida.foto());
      for (const con of this.porEntrar.splice(0)) {
        this.enviar(con, foto);
        if (!con.salio) this.conexiones.add(con);
      }
    }
  }
}
