// =========================================================================
// Duelo de Acero · una sala (Cloudflare Durable Object). Cuatro tipos (ver ARENA.md):
//   'libre'   la del administrador (enlace ?s=): 2 vs 2 o 1 vs 1, él decide cuándo empieza, bots en lo vacío.
//   'arena'   partida del torneo pagado (?a=<partida>): solo los inscritos se sientan (con su sesión de Google),
//             puestos fijos, empieza sola, mejor de 3, y avisa el resultado a la tienda (premio).
//   'ranking' duelo rápido entre dos clientes (la crea la cola, cola.js): un combate; el resultado da puntos.
//   'bot'     duelo rápido contra un bot (nadie más en la cola): un combate, sin puntos.
//   'fichas'  duelo por fichas entre dos clientes (cola ?modo=fichas): mejor de 3; al empezar se cobran 2 fichas
//             a cada uno (por la tienda, todos o ninguno) y al terminar el ganador recibe el doble.
//   'fichas_bot'  igual, contra un bot experto (nadie más en la cola): si gana el cliente, recibe el doble.
//
// Fases: 'sala' (eligen clase; en 'libre' también puesto) → 'combate' → ('entre' combates de la serie) → 'fin'.
// Si se cae alguien en pleno combate, su luchador juega solo hasta que vuelva (mismo `tok` o misma sesión).
// Si no queda nadie conectado por 2 minutos, la sala se borra.
//
// La flecha la mide el servidor: el navegador pide { t: 'flecha', h } al abrirla, el servidor anota la hora
// y contesta con la duración de cada pasada; al tocar, el navegador manda los ms que vio y se aceptan solo
// dentro del margen de su ping (rtt, medido con { t: 'pi' } / { t: 'pa' } en cada turno).
//
// Mensajes del navegador (JSON):
//   { t: 'hola', n, tok, jwt }        entrar (jwt: sesión de Google, obligatoria salvo en 'libre')
//   { t: 'puesto', p } · { t: 'modo', m } · { t: 'empezar' } · { t: 'otra' }   solo en 'libre'
//   { t: 'clase', k }                 en la sala y entre combates
//   { t: 'flecha', h }                abre la flecha de la acción h (en su turno)
//   { t: 'accion', h: 'r'|'f'|0|1|2|'cambiar', o: luchador, ms }
//   { t: 'p', k } ping · { t: 'pa', k } respuesta al ping del servidor
// Al navegador: { t: 'yo', id, tok, clases }, { t: 's', ... } (estado completo; ev = lo que pasó),
// { t: 'flecha', h, pasada }, { t: 'pi', k } y { t: 'error', m } (y se cierra).
// =========================================================================

import { Combate, NOMBRES_CLASES, infoClases, usaFlecha, pasadaFlecha, pFlecha } from './combate.js';
import { usuarioDe, avisarTienda, partidaDe, pedirTienda } from './sesion.js';

const MAX_CONEXIONES = 12;           // 4 jugadores + quienes miran
const MAX_MENSAJES_SEG = 10;
const MAX_BYTES = 3000;              // el primer mensaje lleva la sesión (~1 KB)
const TURNO_MS = 25000;              // tiempo para decidir (incluye detener la flecha)
const BOT_MS = 1600;                 // lo que "piensa" un bot (o un jugador desconectado)
const PAUSA_MS = 1100;               // entre una jugada y el siguiente turno (para ver la animación)
const ENTRE_MS = 12000;              // entre combates de una serie (se puede cambiar de clase)
const SIN_NADIE_MS = 120000;         // sala vacía: se borra
const SALIDA_SALA_MS = 30000;        // en la sala de espera ('libre'), quien se desconecta pierde su puesto a los 30 s
const ABRE_ANTES_MS = 10 * 60_000;   // la sala del torneo abre 10 min antes de la hora
const EMPIEZA_ANTES_MS = 5 * 60_000; // y empieza sola si están todos desde 5 min antes
const AUSENCIA_MS = 10 * 60_000;     // a la hora + 10 min empieza con los que haya
const RANKING_ESPERA_MS = 45_000;    // duelo rápido: si el rival no entra en 45 s, se cancela
const RTT_MAX = 400;
const NOMBRES_EXPERTO = ['Maestro Kael', 'Maestra Vega', 'Maestro Draco', 'Maestra Nyx'];
const NOMBRES_BOT = ['Bot Rayo', 'Bot Toro', 'Bot Sombra', 'Bot Hierro', 'Bot Lobo', 'Bot Puma', 'Bot Trueno', 'Bot Cobra'];
const CLASE_INICIAL = ['guerrero', 'clerigo', 'barbaro', 'asesino'];
const PUESTOS = { '2v2': [0, 1, 2, 3], '1v1': [0, 2] };
const INFO_CLASES = infoClases();

const azarHex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');
const limpiarNombre = (n) => String(n || '').replace(/[^\p{L}\p{N} _.\-]/gu, '').trim().slice(0, 14) || 'Jugador';
const horaVe = (ms) => new Date(ms).toLocaleTimeString('es-VE', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Caracas' });

export class Sala {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.reiniciar();
  }

  reiniciar() {
    for (const r of ['reloj', 'relojVacia', 'relojInicio']) if (this[r]) { clearTimeout(this[r]); clearInterval(this[r]); }
    if (this.conexiones) for (const con of this.conexiones) try { con.ws.close(1000, 'sala cerrada'); } catch (e) { /* */ }
    this.creada = false;
    this.tipo = 'libre';
    this.id = '';
    this.conexiones = new Set();
    this.jugadores = new Map();    // id → { id, n, tok, usuario, con, p (puesto o -1), k (clase), salidaReloj }
    this.anfitrion = null;
    this.fase = 'sala';
    this.modo = '2v2';
    this.combate = null;
    this.reloj = null;             // turno / pausa del combate / espera entre combates
    this.relojVacia = null;
    this.relojInicio = null;       // 'arena'/'ranking': revisa si ya puede empezar
    this.limite = 0;               // cuándo se acaba el turno (ms)
    this.siguienteId = 1;
    this.seq = 0;
    this.hora = 0;                 // 'arena': hora de la partida (ms)
    this.serie = null;             // { meta, gan: [0, 0], num, fin: { ganador, motivo } }
    this.flecha = null;            // { jid, h, t0, pasada }
    this.creadaEn = Date.now();
  }

  async fetch(request) {
    const url = new URL(request.url);
    // La cola (cola.js) arma una sala de duelo rápido: { tipo: 'ranking'|'bot', id, jugadores: [{ usuario, nombre, puesto }] }
    if (url.pathname === '/config' && request.method === 'POST') {
      const c = await request.json();
      this.configurar(c.tipo, c.id, '1v1', c.jugadores);
      return new Response('ok');
    }
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Solo WebSocket', { status: 426 });
    const par = new WebSocketPair();
    const [cliente, servidor] = Object.values(par);
    servidor.accept();
    const cerrar = (m) => {
      try { servidor.send(JSON.stringify({ t: 'error', m })); servidor.close(1008, 'no'); } catch (e) { /* ya cerrada */ }
      return new Response(null, { status: 101, webSocket: cliente });
    };

    const partida = request.headers.get('X-Arena-Sala');
    const crear = request.headers.get('X-Crear') === '1';
    if (partida) {
      const error = await this.prepararArena(partida);
      if (error) return cerrar(error);
    } else if (crear && !this.creada) {
      this.reiniciar();
      this.creada = true;
      this.id = request.headers.get('X-Sala') || '';
    } else if (!this.creada) {
      return cerrar('Esta sala ya no existe. Pídele a quien te invitó un enlace nuevo.');
    }
    if (this.conexiones.size >= MAX_CONEXIONES) return cerrar('La sala está llena.');

    const con = { ws: servidor, jid: null, creador: crear, mensajes: 0, desde: Date.now(), rtt: 250 };
    this.conexiones.add(con);
    if (this.relojVacia) { clearTimeout(this.relojVacia); this.relojVacia = null; }
    servidor.addEventListener('message', (e) => this.recibir(con, e.data));
    servidor.addEventListener('close', () => this.salir(con));
    servidor.addEventListener('error', () => this.salir(con));
    return new Response(null, { status: 101, webSocket: cliente });
  }

  // Sala del torneo: la primera conexión trae de la tienda la partida y sus inscritos. Devuelve un error o ''.
  async prepararArena(id) {
    if (this.creada && this.tipo === 'arena' && this.id === id) {
      return this.fase === 'fin' && this.conexiones.size === 0 ? 'Esta partida ya terminó. Mira el resultado en la Arena.' : '';
    }
    if (!this.cargando) this.cargando = partidaDe(this.env, id).finally(() => { this.cargando = null; });
    const p = await this.cargando;
    if (this.creada && this.tipo === 'arena' && this.id === id) return '';   // otra conexión ya la armó
    if (p === null) return 'No pudimos abrir la partida. Intenta de nuevo en un momento.';
    if (!p) return 'Esa partida no existe.';
    if (p.estado === 'esperando') return 'Todavía falta que pague tu rival. Te avisamos cuando esté lista.';
    if (!['lista', 'jugando'].includes(p.estado)) return 'Esta partida ya terminó. Mira el resultado en la Arena.';
    const hora = Date.parse(p.hora);
    if (Date.now() < hora - ABRE_ANTES_MS) return `La sala abre 10 minutos antes de tu partida (a las ${horaVe(hora)}).`;
    this.configurar('arena', id, p.modo, p.jugadores);
    this.hora = hora;
    return '';
  }

  configurar(tipo, id, modo, jugadores) {
    this.reiniciar();
    this.creada = true;
    this.tipo = tipo;
    this.id = id;
    this.modo = modo;
    this.serie = { meta: tipo === 'arena' || tipo === 'fichas' || tipo === 'fichas_bot' ? 2 : 1, gan: [0, 0], num: 1, fin: null };
    (jugadores || []).forEach((x, i) => {
      const j = { id: 'j' + this.siguienteId++, n: limpiarNombre(x.nombre), tok: azarHex(16), usuario: x.usuario, con: null,
        p: Number(x.puesto), k: CLASE_INICIAL[Number(x.puesto)] || 'guerrero', salidaReloj: null, inscrito: true };
      this.jugadores.set(j.id, j);
      if (i === 0) this.anfitrion = null;
    });
    // Revisa cada 3 s si ya puede empezar (y para el duelo rápido, si el rival no llegó)
    this.relojInicio = setInterval(() => this.revisarInicio(), 3000);
  }

  enviar(con, datos) {
    try { con.ws.send(typeof datos === 'string' ? datos : JSON.stringify(datos)); } catch (e) { this.salir(con); }
  }

  // Estado completo para todos (es pequeño: 4 luchadores y unos pocos jugadores)
  difundir(ev) {
    this.seq++;
    const datos = JSON.stringify({
      t: 's', seq: this.seq, fase: this.fase, sala: this.id, anf: this.anfitrion, modo: this.modo, tipo: this.tipo,
      jug: [...this.jugadores.values()].map((j) => ({ id: j.id, n: j.n, p: j.p, k: j.k, on: !!j.con, ins: j.inscrito || undefined })),
      c: this.combate ? this.combate.foto() : null,
      queda: this.limite ? Math.max(0, this.limite - Date.now()) : 0,
      serie: this.serie || undefined,
      hora: this.hora || undefined,
      ahora: Date.now(),
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
    if (m.t === 'pa') {
      const rtt = ahora - Number(m.k);
      if (rtt >= 0 && rtt < 5000) con.rtt = Math.round(con.rtt * 0.6 + Math.min(RTT_MAX, rtt) * 0.4);
      return;
    }
    if (m.t === 'hola') { this.hola(con, m); return; }

    const j = con.jid && this.jugadores.get(con.jid);
    if (!j) return;
    const libre = this.tipo === 'libre';
    const esAnfitrion = libre && j.id === this.anfitrion;
    if (m.t === 'puesto' && libre && this.fase === 'sala') {
      const p = Number(m.p);
      if (p === -1) j.p = -1;
      else if (PUESTOS[this.modo].includes(p) && !this.ocupante(p)) j.p = p;
      else return;
      this.difundir();
    } else if (m.t === 'clase' && (this.fase === 'sala' || this.fase === 'entre') && j.p >= 0 && NOMBRES_CLASES.includes(m.k)) {
      j.k = m.k;
      this.difundir();
    } else if (m.t === 'modo' && esAnfitrion && this.fase === 'sala' && PUESTOS[m.m] && m.m !== this.modo) {
      this.cambiarModo(m.m);
    } else if (m.t === 'empezar' && esAnfitrion && this.fase === 'sala') {
      this.empezar();
    } else if (m.t === 'otra' && esAnfitrion && this.fase === 'fin') {
      this.volverASala();
    } else if ((m.t === 'flecha' || m.t === 'accion') && this.fase === 'combate') {
      const x = this.combate.actual();
      if (!x || x.jid !== j.id) return;
      const h = ['r', 'f', 'cambiar'].includes(m.h) ? m.h : Number(m.h);
      if (typeof h !== 'string' && ![0, 1, 2].includes(h)) return;
      if (m.t === 'flecha') {
        if (!usaFlecha(x.k, h)) return;
        this.flecha = { jid: j.id, h, t0: ahora, pasada: pasadaFlecha(h) };
        this.enviar(con, { t: 'flecha', h, pasada: this.flecha.pasada });
        return;
      }
      let p = 0;
      if (usaFlecha(x.k, h)) {
        const f = this.flecha;
        if (f && f.jid === j.id && f.h === h) {
          // Lo que dice el navegador, pero dentro de lo posible: entre (transcurrido − ping − 150 ms) y lo transcurrido
          const pasado = ahora - f.t0;
          const ms = Math.min(pasado, Math.max(pasado - con.rtt - 150, Number(m.ms) || 0));
          p = pFlecha(ms, f.pasada);
        } else {
          p = 0.3;                                 // sin flecha (no la pidió): golpe flojo
        }
      }
      this.flecha = null;
      this.jugar(h, Number(m.o), p);
    }
  }

  ocupante(p) {
    for (const j of this.jugadores.values()) if (j.p === p) return j;
    return null;
  }

  async hola(con, m) {
    if (con.jid || con.entrando) return;
    let j = null;
    if (this.tipo === 'libre') {
      if (typeof m.tok === 'string' && /^[a-f0-9]{32}$/.test(m.tok)) j = [...this.jugadores.values()].find((x) => x.tok === m.tok) || null;
    } else {
      // Con sesión de Google: el inscrito vuelve a su puesto; cualquier otro mira
      con.entrando = true;
      const s = await usuarioDe(this.env, m.jwt);
      con.entrando = false;
      if (con.salio) return;
      if (!s) {
        this.enviar(con, { t: 'error', m: 'Inicia sesión con Google en la tienda para jugar.' });
        try { con.ws.close(1008, 'sin sesión'); } catch (e) { /* */ }
        return;
      }
      j = [...this.jugadores.values()].find((x) => x.usuario === s.usuario) || null;
      if (!j && this.tipo !== 'arena') {
        this.enviar(con, { t: 'error', m: 'Esta partida es de otros jugadores.' });
        try { con.ws.close(1008, 'ajeno'); } catch (e) { /* */ }
        return;
      }
      if (!j) {
        j = { id: 'j' + this.siguienteId++, n: limpiarNombre(s.nombre), tok: azarHex(16), usuario: s.usuario, con: null, p: -1, k: 'guerrero', salidaReloj: null };
        this.jugadores.set(j.id, j);
      }
    }
    if (j) {
      // Vuelve el mismo jugador (recargó la página o se le fue la señal): la conexión vieja sobra
      if (j.con && j.con !== con) { const vieja = j.con; vieja.jid = null; try { vieja.ws.close(1000, 'otra pestaña'); } catch (e) { /* */ } this.conexiones.delete(vieja); }
      if (j.salidaReloj) { clearTimeout(j.salidaReloj); j.salidaReloj = null; }
      if (this.tipo === 'libre') j.n = limpiarNombre(m.n || j.n);
    } else {
      const libre = this.fase === 'sala' ? [0, 2, 1, 3].find((p) => PUESTOS[this.modo].includes(p) && !this.ocupante(p)) : undefined;
      j = { id: 'j' + this.siguienteId++, n: limpiarNombre(m.n), tok: azarHex(16), con: null, p: libre === undefined ? -1 : libre, k: 'guerrero', salidaReloj: null };
      if (j.p >= 0) j.k = CLASE_INICIAL[j.p];
      this.jugadores.set(j.id, j);
    }
    j.con = con;
    con.jid = j.id;
    if (this.tipo === 'libre' && (!this.anfitrion || (con.creador && !this.jugadores.has(this.anfitrion)))) this.anfitrion = j.id;
    this.enviar(con, { t: 'yo', id: j.id, tok: j.tok, clases: INFO_CLASES });
    this.difundir();
    this.revisarInicio();
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
        if (!j.inscrito) j.salidaReloj = setTimeout(() => this.quitar(j), SALIDA_SALA_MS);
      } else if (this.combate.turno >= 0 && this.combate.actual().jid === j.id) {
        this.programarTurno();          // juega solo
      }
      this.difundir();
    }
    if (!this.conexiones.size && !this.relojVacia) {
      // Serie con algo en juego (torneo o fichas): sigue aunque no mire nadie (los luchadores juegan solos) hasta terminar
      this.relojVacia = setTimeout(() => {
        const serie = this.tipo === 'arena' || this.tipo === 'fichas' || this.tipo === 'fichas_bot';
        if (!serie || this.fase === 'fin' || this.fase === 'sala') this.reiniciar();
        else if (this.conexiones.size === 0) this.relojVacia = null;      // sigue sola hasta terminar; al final se borra
      }, SIN_NADIE_MS);
    }
  }

  quitar(j) {
    if (j.con || !this.jugadores.has(j.id) || j.inscrito) return;
    if (this.fase === 'combate') return;   // en combate se queda (su luchador juega solo)
    this.jugadores.delete(j.id);
    if (this.anfitrion === j.id) this.anfitrion = this.nuevoAnfitrion();
    this.difundir();
  }

  nuevoAnfitrion() {
    for (const j of this.jugadores.values()) if (j.con) return j.id;
    return null;
  }

  // Al pasar a 1 vs 1, los de atrás se van adelante si está libre; si no, quedan mirando
  cambiarModo(modo) {
    this.modo = modo;
    if (modo === '1v1') {
      for (const j of this.jugadores.values()) {
        if (j.p === 1 || j.p === 3) j.p = this.ocupante(j.p - 1) ? -1 : j.p - 1;
      }
    }
    this.difundir();
  }

  // ------------------------------------------------------------------ inicio automático (arena / duelo rápido)
  revisarInicio() {
    if (this.tipo === 'libre' || this.fase !== 'sala') return;
    const inscritos = [...this.jugadores.values()].filter((j) => j.inscrito);
    const todos = inscritos.every((j) => j.con);
    const alguno = inscritos.some((j) => j.con);
    const ahora = Date.now();
    if (this.cobrando) return;
    if (this.tipo === 'bot' || this.tipo === 'fichas_bot') {
      if (alguno) this.empezarSerie();
    } else if (this.tipo === 'ranking' || this.tipo === 'fichas') {
      if (todos) this.empezarSerie();
      else if (ahora - this.creadaEn > RANKING_ESPERA_MS) {
        for (const con of this.conexiones) this.enviar(con, { t: 'error', m: 'Tu rival no entró. Vuelve a la Arena y busca otro.' });
        this.reiniciar();
      }
    } else if (this.tipo === 'arena') {
      if (todos && ahora >= this.hora - EMPIEZA_ANTES_MS) this.empezarSerie();
      else if (ahora >= this.hora + AUSENCIA_MS && alguno) this.empezarSerie();
    }
  }

  async empezarSerie() {
    if (this.relojInicio) { clearInterval(this.relojInicio); this.relojInicio = null; }
    if (this.tipo === 'fichas' || this.tipo === 'fichas_bot') {
      // Se cobran las fichas antes del primer combate (todos o ninguno)
      this.cobrando = true;
      const inscritos = [...this.jugadores.values()].filter((j) => j.inscrito);
      const r = await pedirTienda(this.env, { tipo: 'fichas_cobrar', sala: this.id, modo: this.tipo === 'fichas' ? 'persona' : 'bot',
        jugadores: inscritos.map((j) => ({ usuario: j.usuario, nombre: j.n })) });
      this.cobrando = false;
      if (!r || !r.ok) {
        const faltan = r && Array.isArray(r.faltan) ? r.faltan : [];
        for (const j of inscritos) {
          if (!j.con) continue;
          const m = !r ? 'No pudimos cobrar las fichas ahora. Intenta de nuevo en un momento (no se te cobró nada).'
            : faltan.includes(j.usuario) ? 'No tienes fichas suficientes: el duelo cuesta 2. Recarga para ganar fichas.'
              : 'Tu rival no tiene fichas suficientes. Busca otro duelo (no se te cobró nada).';
          this.enviar(j.con, { t: 'error', m });
        }
        this.reiniciar();
        return;
      }
      this.serie.costo = r.costo || 2;
    }
    if (this.tipo === 'arena') {
      // Ausencia: equipo sin nadie conectado pierde; si no hay nadie de ningún lado, no gana nadie
      const presentes = [0, 1].map((e) => [...this.jugadores.values()].some((j) => j.inscrito && j.con && (j.p >= 2 ? 1 : 0) === e));
      if (!presentes[0] || !presentes[1]) {
        const ganador = presentes[0] ? 0 : presentes[1] ? 1 : 2;
        this.terminarSerie(ganador, ganador === 2 ? 'No entró nadie' : 'El rival no entró a tiempo (ausencia)');
        return;
      }
      avisarTienda(this.env, { tipo: 'empezo', partida: this.id });
    }
    this.empezar();
  }

  empezar() {
    const usados = new Set();
    const bot = () => {
      const libres = NOMBRES_BOT.filter((n) => !usados.has(n));
      const n = libres[Math.floor(Math.random() * libres.length)];
      usados.add(n);
      return n;
    };
    const luchadores = PUESTOS[this.modo].map((p) => {
      const j = this.ocupante(p);
      const lugar = { e: p < 2 ? 0 : 1, f: this.modo === '1v1' ? 0 : p % 2 };
      if (j) return { n: j.n, k: j.k, jid: j.id, ...lugar };
      const experto = this.tipo === 'fichas_bot';
      if (experto && !this.nombreExperto) this.nombreExperto = NOMBRES_EXPERTO[Math.floor(Math.random() * NOMBRES_EXPERTO.length)];
      return { n: experto ? this.nombreExperto : bot(), k: NOMBRES_CLASES[Math.floor(Math.random() * NOMBRES_CLASES.length)], jid: null, experto, ...lugar };
    });
    this.fase = 'combate';
    this.flecha = null;
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
    if (!solo) this.enviar(j.con, { t: 'pi', k: Date.now() });   // mide su ping (margen de la flecha)
  }

  // Bot, jugador desconectado o se le acabó el tiempo (entonces solo ataca)
  jugarSolo(tiempoAgotado) {
    this.reloj = null;
    if (this.fase !== 'combate' || this.combate.turno < 0) return;
    const [h, o, p] = this.combate.automatica(tiempoAgotado);
    this.jugar(h, o, p, tiempoAgotado);
  }

  jugar(h, o, p, tiempoAgotado = false) {
    const ev = this.combate.accion(this.combate.turno, h, o, p);
    if (!ev) return;
    if (tiempoAgotado) ev.unshift({ t: 'tiempo', o: ev[0].a });
    if (this.reloj) clearTimeout(this.reloj);
    this.limite = 0;
    this.difundir(ev);
    const golpes = ev.filter((e) => e.t === 'dano' || e.t === 'esquiva' || e.t === 'contra' || e.t === 'cura').length;
    this.reloj = setTimeout(() => {
      this.reloj = null;
      if (this.fase !== 'combate') return;
      if (this.combate.ganador !== null) { this.terminar(); return; }
      this.programarTurno(this.combate.siguienteTurno());
    }, PAUSA_MS + Math.min(3, golpes) * 250);
  }

  terminar(ev) {
    this.limite = 0;
    if (this.tipo === 'libre') {
      this.fase = 'fin';
      // Los que se fueron durante el combate salen a los 30 s (así el anfitrión se pasa a otro si era él)
      for (const j of this.jugadores.values()) if (!j.con && !j.salidaReloj) j.salidaReloj = setTimeout(() => this.quitar(j), SALIDA_SALA_MS);
      this.difundir(ev);
      return;
    }
    // Serie: empate = se repite ese combate
    const g = this.combate.ganador;
    if (g === 0 || g === 1) this.serie.gan[g]++;
    if (g !== 2 && this.serie.gan[g] >= this.serie.meta) {
      this.terminarSerie(g, '', ev);
      return;
    }
    if (g !== 2) this.serie.num++;
    this.fase = 'entre';
    this.serie.siguiente = Date.now() + ENTRE_MS;
    this.difundir(ev);
    this.reloj = setTimeout(() => { this.reloj = null; if (this.fase === 'entre') this.empezar(); }, ENTRE_MS);
  }

  terminarSerie(ganador, motivo, ev) {
    if (this.relojInicio) { clearInterval(this.relojInicio); this.relojInicio = null; }
    this.fase = 'fin';
    this.serie.fin = { ganador, motivo: motivo || undefined };
    this.difundir(ev);
    if (!this.conexiones.size && !this.relojVacia) this.relojVacia = setTimeout(() => this.reiniciar(), SIN_NADIE_MS);
    const marcador = motivo && ganador !== 2 ? 'W.O.' : `${this.serie.gan[0]}-${this.serie.gan[1]}`;
    if (this.tipo === 'arena') {
      avisarTienda(this.env, { tipo: 'resultado', partida: this.id, ganador, marcador, motivo: motivo || '' });
    } else if (this.tipo === 'fichas' || this.tipo === 'fichas_bot') {
      // Ganador: el cliente de ese lado (contra el bot, el lado 1 es el bot → null). Empate imposible aquí.
      const lado = [...this.jugadores.values()].find((j) => j.inscrito && (j.p >= 2 ? 1 : 0) === ganador);
      avisarTienda(this.env, { tipo: 'fichas_resultado', sala: this.id, ganador: lado ? lado.usuario : null });
    } else if (this.tipo === 'ranking' && ganador !== 2) {
      const lado = (e) => [...this.jugadores.values()].find((j) => j.inscrito && (j.p >= 2 ? 1 : 0) === e);
      const a = lado(ganador), b = lado(1 - ganador);
      if (a && b) avisarTienda(this.env, { tipo: 'ranking', ganador: { usuario: a.usuario, nombre: a.n }, perdedor: { usuario: b.usuario, nombre: b.n } });
    }
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
