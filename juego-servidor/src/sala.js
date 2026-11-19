// =========================================================================
// Duelo de Acero · una sala (Cloudflare Durable Object, una por enlace de sala).
//
// La crea quien tiene un código de acceso (worker.js la abre con X-Crear); los demás entran con el enlace
// ?s=<sala>. El creador (anfitrión) decide cuándo empieza; los puestos vacíos los juegan bots.
// Fases: 'sala' (eligen puesto y clase) → 'combate' → 'fin' → (anfitrión: "Otra partida") → 'sala'.
// Si se cae alguien en pleno combate, su luchador juega solo hasta que vuelva (con el mismo `tok`).
// Si no queda nadie conectado por 2 minutos, la sala se borra y el enlace deja de servir.
//
// Mensajes del navegador (JSON):
//   { t: 'hola', n: 'Nombre', tok }   entrar (tok: para volver al mismo puesto tras recargar la página)
//   { t: 'puesto', p: 0-3 | -1 }      sentarse (0 Rojo adelante, 1 Rojo atrás, 2 Azul adelante, 3 Azul atrás; -1 mirar)
//   { t: 'clase', k: 'guerrero' }     elegir clase
//   { t: 'empezar' }                  solo el anfitrión
//   { t: 'accion', h: 'b'|0|1|2|'cambiar', o: 0-3 }
//   { t: 'otra' }                     solo el anfitrión, al terminar
//   { t: 'p', k }                     ping
// Al navegador: { t: 'yo', id, tok, clases } al entrar y { t: 's', ... } con el estado completo en cada cambio
// (ev = lo que acaba de pasar, para animarlo). Errores: { t: 'error', m } y se cierra.
// =========================================================================

import { Combate, NOMBRES_CLASES, infoClases } from './combate.js';

const MAX_CONEXIONES = 12;           // 4 jugadores + quienes miran
const MAX_MENSAJES_SEG = 10;
const MAX_BYTES = 200;
const TURNO_MS = 20000;              // tiempo para decidir
const BOT_MS = 1600;                 // lo que "piensa" un bot (o un jugador desconectado)
const PAUSA_MS = 1100;               // entre una jugada y el siguiente turno (para ver la animación)
const SIN_NADIE_MS = 120000;         // sala vacía: se borra
const SALIDA_SALA_MS = 30000;        // en la sala de espera, quien se desconecta pierde su puesto a los 30 s
const NOMBRES_BOT = ['Bot Rayo', 'Bot Toro', 'Bot Sombra', 'Bot Hierro', 'Bot Lobo', 'Bot Puma', 'Bot Trueno', 'Bot Cobra'];
const CLASE_INICIAL = ['guerrero', 'picaro', 'barbaro', 'lancero'];
const INFO_CLASES = infoClases();

const azarHex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');
const limpiarNombre = (n) => String(n || '').replace(/[^\p{L}\p{N} _.\-]/gu, '').trim().slice(0, 14) || 'Jugador';

export class Sala {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.reiniciar();
  }

  reiniciar() {
    if (this.reloj) clearTimeout(this.reloj);
    if (this.relojVacia) clearTimeout(this.relojVacia);
    this.creada = false;
    this.id = '';
    this.conexiones = new Set();
    this.jugadores = new Map();    // id → { id, n, tok, con, p (puesto o -1), k (clase), salidaReloj }
    this.anfitrion = null;
    this.fase = 'sala';
    this.combate = null;
    this.reloj = null;             // turno / pausa del combate
    this.relojVacia = null;
    this.limite = 0;               // cuándo se acaba el turno (ms)
    this.siguienteId = 1;
    this.seq = 0;
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Solo WebSocket', { status: 426 });
    const par = new WebSocketPair();
    const [cliente, servidor] = Object.values(par);
    servidor.accept();
    const cerrar = (m) => {
      try { servidor.send(JSON.stringify({ t: 'error', m })); servidor.close(1008, 'no'); } catch (e) { /* ya cerrada */ }
      return new Response(null, { status: 101, webSocket: cliente });
    };

    const crear = request.headers.get('X-Crear') === '1';
    if (crear && !this.creada) {
      this.reiniciar();
      this.creada = true;
      this.id = request.headers.get('X-Sala') || '';
    } else if (!this.creada) {
      return cerrar('Esta sala ya no existe. Pídele a quien te invitó un enlace nuevo.');
    }
    if (this.conexiones.size >= MAX_CONEXIONES) return cerrar('La sala está llena.');

    const con = { ws: servidor, jid: null, creador: crear, mensajes: 0, desde: Date.now() };
    this.conexiones.add(con);
    if (this.relojVacia) { clearTimeout(this.relojVacia); this.relojVacia = null; }
    servidor.addEventListener('message', (e) => this.recibir(con, e.data));
    servidor.addEventListener('close', () => this.salir(con));
    servidor.addEventListener('error', () => this.salir(con));
    return new Response(null, { status: 101, webSocket: cliente });
  }

  enviar(con, datos) {
    try { con.ws.send(typeof datos === 'string' ? datos : JSON.stringify(datos)); } catch (e) { this.salir(con); }
  }

  // Estado completo para todos (es pequeño: 4 luchadores y unos pocos jugadores)
  difundir(ev) {
    this.seq++;
    const datos = JSON.stringify({
      t: 's', seq: this.seq, fase: this.fase, sala: this.id, anf: this.anfitrion,
      jug: [...this.jugadores.values()].map((j) => ({ id: j.id, n: j.n, p: j.p, k: j.k, on: !!j.con })),
      c: this.combate ? this.combate.foto() : null,
      queda: this.limite ? Math.max(0, this.limite - Date.now()) : 0,
      ev: ev && ev.length ? ev : undefined,
    });
    for (const con of this.conexiones) if (con.jid) this.enviar(con, datos);
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
    if (m.t === 'p') { this.enviar(con, { t: 'po', k: Number(m.k) || 0 }); return; }
    if (m.t === 'hola') { this.hola(con, m); return; }

    const j = con.jid && this.jugadores.get(con.jid);
    if (!j) return;
    const esAnfitrion = j.id === this.anfitrion;
    if (m.t === 'puesto' && this.fase === 'sala') {
      const p = Number(m.p);
      if (p === -1) j.p = -1;
      else if (Number.isInteger(p) && p >= 0 && p <= 3 && !this.ocupante(p)) j.p = p;
      else return;
      this.difundir();
    } else if (m.t === 'clase' && this.fase === 'sala' && NOMBRES_CLASES.includes(m.k)) {
      j.k = m.k;
      this.difundir();
    } else if (m.t === 'empezar' && esAnfitrion && this.fase === 'sala') {
      this.empezar();
    } else if (m.t === 'otra' && esAnfitrion && this.fase === 'fin') {
      this.volverASala();
    } else if (m.t === 'accion' && this.fase === 'combate') {
      const x = this.combate.actual();
      if (!x || x.jid !== j.id) return;
      const h = m.h === 'b' || m.h === 'cambiar' ? m.h : Number(m.h);
      if (h !== 'b' && h !== 'cambiar' && ![0, 1, 2].includes(h)) return;
      this.jugar(h, Number(m.o));
    }
  }

  ocupante(p) {
    for (const j of this.jugadores.values()) if (j.p === p) return j;
    return null;
  }

  hola(con, m) {
    if (con.jid) return;
    let j = null;
    if (typeof m.tok === 'string' && /^[a-f0-9]{32}$/.test(m.tok)) {
      j = [...this.jugadores.values()].find((x) => x.tok === m.tok) || null;
    }
    if (j) {
      // Vuelve el mismo jugador (recargó la página o se le fue la señal): la conexión vieja sobra
      if (j.con && j.con !== con) { const vieja = j.con; vieja.jid = null; try { vieja.ws.close(1000, 'otra pestaña'); } catch (e) { /* */ } this.conexiones.delete(vieja); }
      if (j.salidaReloj) { clearTimeout(j.salidaReloj); j.salidaReloj = null; }
      j.n = limpiarNombre(m.n || j.n);
    } else {
      const libre = this.fase === 'sala' ? [0, 2, 1, 3].find((p) => !this.ocupante(p)) : undefined;
      j = { id: 'j' + this.siguienteId++, n: limpiarNombre(m.n), tok: azarHex(16), con: null, p: libre === undefined ? -1 : libre, k: 'guerrero', salidaReloj: null };
      if (j.p >= 0) j.k = CLASE_INICIAL[j.p];
      this.jugadores.set(j.id, j);
    }
    j.con = con;
    con.jid = j.id;
    if (!this.anfitrion || (con.creador && !this.jugadores.has(this.anfitrion))) this.anfitrion = j.id;
    this.enviar(con, { t: 'yo', id: j.id, tok: j.tok, clases: INFO_CLASES });
    this.difundir();
    // Si era su turno y estaba jugando solo, recupera el control con el tiempo normal
    if (this.fase === 'combate' && this.combate.turno >= 0 && this.combate.actual().jid === j.id) this.programarTurno();
  }

  salir(con) {
    if (con.salio) return;
    con.salio = true;
    this.conexiones.delete(con);
    const j = con.jid && this.jugadores.get(con.jid);
    if (j && j.con === con) {
      j.con = null;
      if (this.fase !== 'combate') {
        j.salidaReloj = setTimeout(() => this.quitar(j), SALIDA_SALA_MS);
      } else if (this.combate.turno >= 0 && this.combate.actual().jid === j.id) {
        this.programarTurno();          // juega solo
      }
      this.difundir();
    }
    if (!this.conexiones.size && !this.relojVacia) {
      this.relojVacia = setTimeout(() => this.reiniciar(), SIN_NADIE_MS);
    }
  }

  quitar(j) {
    if (j.con || !this.jugadores.has(j.id)) return;
    if (this.fase === 'combate') return;   // en combate se queda (su luchador juega solo)
    this.jugadores.delete(j.id);
    if (this.anfitrion === j.id) this.anfitrion = this.nuevoAnfitrion();
    this.difundir();
  }

  nuevoAnfitrion() {
    for (const j of this.jugadores.values()) if (j.con) return j.id;
    return null;
  }

  empezar() {
    const usados = new Set();
    const bot = () => {
      const libres = NOMBRES_BOT.filter((n) => !usados.has(n));
      const n = libres[Math.floor(Math.random() * libres.length)];
      usados.add(n);
      return n;
    };
    const luchadores = [0, 1, 2, 3].map((p) => {
      const j = this.ocupante(p);
      return j ? { n: j.n, k: j.k, jid: j.id } : { n: bot(), k: NOMBRES_CLASES[Math.floor(Math.random() * NOMBRES_CLASES.length)], jid: null };
    });
    this.fase = 'combate';
    this.combate = new Combate(luchadores);
    const ev = this.combate.siguienteTurno();
    this.programarTurno(ev);
  }

  // Arranca el reloj del turno actual y avisa a todos
  programarTurno(ev) {
    if (this.reloj) clearTimeout(this.reloj);
    this.reloj = null;
    if (this.combate.ganador !== null) { this.terminar(ev); return; }
    const x = this.combate.actual();
    const j = x.jid && this.jugadores.get(x.jid);
    const solo = !j || !j.con;
    this.limite = solo ? 0 : Date.now() + TURNO_MS;
    this.reloj = setTimeout(() => this.jugarSolo(!solo), solo ? BOT_MS : TURNO_MS + 300);
    this.difundir(ev);
  }

  // Bot, jugador desconectado o se le acabó el tiempo (entonces solo ataca)
  jugarSolo(tiempoAgotado) {
    this.reloj = null;
    if (this.fase !== 'combate' || this.combate.turno < 0) return;
    const [h, o] = this.combate.automatica(tiempoAgotado);
    this.jugar(h, o, tiempoAgotado);
  }

  jugar(h, o, tiempoAgotado = false) {
    const ev = this.combate.accion(this.combate.turno, h, o);
    if (!ev) return;
    if (tiempoAgotado) ev.unshift({ t: 'tiempo', o: ev[0].a });
    if (this.reloj) clearTimeout(this.reloj);
    this.limite = 0;
    this.difundir(ev);
    const golpes = ev.filter((e) => e.t === 'dano' || e.t === 'esquiva' || e.t === 'contra').length;
    this.reloj = setTimeout(() => {
      this.reloj = null;
      if (this.fase !== 'combate') return;
      if (this.combate.ganador !== null) { this.terminar(); return; }
      this.programarTurno(this.combate.siguienteTurno());
    }, PAUSA_MS + Math.min(3, golpes) * 250);
  }

  terminar(ev) {
    this.fase = 'fin';
    this.limite = 0;
    // Los que se fueron durante el combate salen a los 30 s (así el anfitrión se pasa a otro si era él)
    for (const j of this.jugadores.values()) if (!j.con && !j.salidaReloj) j.salidaReloj = setTimeout(() => this.quitar(j), SALIDA_SALA_MS);
    this.difundir(ev);
  }

  volverASala() {
    // Fuera los que se fueron durante el combate; los demás conservan puesto y clase
    for (const j of [...this.jugadores.values()]) if (!j.con) this.jugadores.delete(j.id);
    if (!this.jugadores.has(this.anfitrion)) this.anfitrion = this.nuevoAnfitrion();
    this.fase = 'sala';
    this.combate = null;
    this.limite = 0;
    this.difundir();
  }
}
