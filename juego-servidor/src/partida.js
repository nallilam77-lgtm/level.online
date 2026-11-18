// =========================================================================
// Serpientes Neón · lógica de la partida (sin red).
//
// El servidor manda: mueve las serpientes, reparte la comida y decide los choques. El navegador solo dice
// hacia dónde apunta y si acelera. Las posiciones se guardan en enteros para que el navegador rehaga cada
// cuerpo exactamente igual (recibe la cabeza en cada paso y recorta con recortar(), la misma función).
// =========================================================================

export const AJUSTES = {
  TICK_MS: 50,              // 20 pasos por segundo
  RADIO_MAPA: 2000,
  COMIDA: 650,              // comida suelta que siempre hay en el mapa
  MIN_SERPIENTES: 12,       // con pocos jugadores se rellena con bots
  MAX_JUGADORES: 15,
  MASA_INICIAL: 10,
  VELOCIDAD: 9,             // unidades por paso (180 por segundo)
  VELOCIDAD_TURBO: 17,
  MASA_MINIMA_TURBO: 12,
  GASTO_TURBO: 0.12,        // masa por paso acelerando
};

const COLORES = 12;
const NOMBRES_BOT = ['Kairo', 'Nebula', 'Vortex', 'Zafiro', 'Pixel', 'Rayo', 'Cobra', 'Jade', 'Turbo', 'Eclipse',
  'Fénix', 'Orion', 'Tifón', 'Volt', 'Lince', 'Quasar', 'Brasa', 'Nova'];

export const largo = (masa) => 40 + masa * 3;
export const radio = (masa) => Math.min(28, 8 + Math.sqrt(masa) * 0.9);

// Deja el cuerpo (cola en [0], cabeza al final) con el largo pedido. El navegador usa la misma función.
export function recortar(pts, L) {
  let total = 0;
  for (let i = pts.length - 1; i > 0; i--) {
    total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (total >= L) {
      if (i - 1 > 0) pts.splice(0, i - 1);
      return;
    }
  }
}

const azar = (a, b) => a + Math.random() * (b - a);
const angulo = (a) => Math.atan2(Math.sin(a), Math.cos(a));   // entre -π y π

export function limpiarNombre(texto) {
  const n = String(texto || '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 14);
  return n || 'Jugador';
}

export class Partida {
  constructor() {
    this.serpientes = new Map();
    this.comida = new Map();
    this.sigSerpiente = 1;
    this.sigComida = 1;
    this.paso_ = 0;
    this.limpiarEventos();
    while (this.comida.size < AJUSTES.COMIDA) this.soltarComida(...this.puntoAlAzar(0.97), 1, true);
    this.limpiarEventos();
  }

  limpiarEventos() {
    this.nuevas = [];      // serpientes que aparecieron en este paso
    this.muertes = [];     // [id, idDelQueLaEliminó (0 = borde o se fue)]
    this.comidaNueva = [];
    this.comidaComida = [];
  }

  get humanos() {
    let n = 0;
    for (const s of this.serpientes.values()) if (!s.bot) n++;
    return n;
  }

  puntoAlAzar(fraccion) {
    const r = AJUSTES.RADIO_MAPA * fraccion * Math.sqrt(Math.random());
    const a = Math.random() * Math.PI * 2;
    return [Math.round(Math.cos(a) * r), Math.round(Math.sin(a) * r)];
  }

  soltarComida(x, y, valor, inicial = false) {
    const id = this.sigComida++;
    const c = [id, Math.round(x), Math.round(y), Math.round(valor * 10), Math.floor(Math.random() * COLORES)];
    this.comida.set(id, c);
    if (!inicial) this.comidaNueva.push(c);
  }

  // Busca un lugar lejos de las demás cabezas y cuerpos
  lugarLibre() {
    let mejor = null;
    let mejorDist = -1;
    for (let intento = 0; intento < 8; intento++) {
      const [x, y] = this.puntoAlAzar(0.7);
      let min = Infinity;
      for (const s of this.serpientes.values()) {
        for (let i = 0; i < s.pts.length; i += 3) {
          const d = Math.hypot(s.pts[i][0] - x, s.pts[i][1] - y);
          if (d < min) min = d;
        }
      }
      if (min > mejorDist) { mejorDist = min; mejor = [x, y]; }
      if (min > 500) break;
    }
    return mejor;
  }

  crearSerpiente(nombre, bot) {
    const id = this.sigSerpiente++;
    const [x, y] = this.lugarLibre();
    const ang = Math.atan2(-y, -x) + azar(-0.8, 0.8);    // mirando más o menos hacia el centro
    const masa = bot ? azar(10, 60) : AJUSTES.MASA_INICIAL;
    const L = largo(masa);
    const pts = [];
    for (let d = L; d >= 0; d -= AJUSTES.VELOCIDAD) {
      pts.push([Math.round(x - Math.cos(ang) * d), Math.round(y - Math.sin(ang) * d)]);
    }
    const s = {
      id, nombre: limpiarNombre(nombre), color: Math.floor(Math.random() * COLORES), bot,
      x, y, ang, objetivo: ang, turbo: false, masa, pts, pasoTurbo: 0, idea: 0,
    };
    this.serpientes.set(id, s);
    this.nuevas.push(s);
    return id;
  }

  dirigir(id, a, turbo) {
    const s = this.serpientes.get(id);
    if (!s || s.bot) return;
    if (Number.isFinite(a)) s.objetivo = angulo(a);
    s.turbo = turbo === true || turbo === 1;
  }

  // El jugador se desconectó: su serpiente desaparece sin soltar comida
  quitar(id) {
    if (this.serpientes.delete(id)) this.muertes.push([id, 0]);
  }

  matar(s, asesino) {
    if (!this.serpientes.has(s.id)) return;
    this.serpientes.delete(s.id);
    this.muertes.push([s.id, asesino || 0]);
    // Suelta comida por el cuerpo: el 70 % de su masa, en bolitas grandes
    const total = s.masa * 0.7;
    const cada = Math.max(1, Math.floor(s.pts.length / Math.max(1, Math.round(total / 3))));
    let soltada = 0;
    for (let i = s.pts.length - 1; i >= 0 && soltada < total; i -= cada) {
      const v = Math.min(3, total - soltada);
      this.soltarComida(s.pts[i][0] + azar(-6, 6), s.pts[i][1] + azar(-6, 6), Math.max(0.5, v));
      soltada += v;
    }
  }

  pensarBot(s) {
    if (--s.idea > 0) return;
    s.idea = 3;
    const R = AJUSTES.RADIO_MAPA;
    const r = radio(s.masa);
    // 1) Cerca del borde: volver hacia el centro
    if (Math.hypot(s.x, s.y) > R - 220 - r) {
      s.objetivo = Math.atan2(-s.y, -s.x) + azar(-0.3, 0.3);
      s.turbo = false;
      return;
    }
    // 2) Algo adelante: esquivar
    const mira = 70 + r * 2;
    const ax = s.x + Math.cos(s.ang) * mira;
    const ay = s.y + Math.sin(s.ang) * mira;
    for (const o of this.serpientes.values()) {
      if (o === s) continue;
      const lim = radio(o.masa) + r + 30;
      for (let i = 0; i < o.pts.length; i += 2) {
        const p = o.pts[i];
        if (Math.abs(p[0] - ax) < lim && Math.abs(p[1] - ay) < lim) {
          const lado = Math.sin(Math.atan2(p[1] - s.y, p[0] - s.x) - s.ang) > 0 ? -1 : 1;
          s.objetivo = s.ang + lado * 1.4;
          s.turbo = false;
          return;
        }
      }
    }
    // 3) Ir a la comida más rica cerca
    let mejor = null;
    let puntaje = 0;
    for (const c of this.comida.values()) {
      const dx = c[1] - s.x;
      const dy = c[2] - s.y;
      if (Math.abs(dx) > 450 || Math.abs(dy) > 450) continue;
      const p = (c[3] + 5) / (Math.hypot(dx, dy) + 40);
      if (p > puntaje) { puntaje = p; mejor = c; }
    }
    if (mejor) s.objetivo = Math.atan2(mejor[2] - s.y, mejor[1] - s.x);
    else if (Math.random() < 0.1) s.objetivo = s.ang + azar(-1, 1);
    s.turbo = s.masa > 40 && Math.random() < 0.03 ? true : (s.turbo && Math.random() < 0.85);
  }

  mover(s) {
    const r = radio(s.masa);
    const giro = Math.max(0.12, 0.24 - (r - 8) * 0.006);
    const diff = angulo(s.objetivo - s.ang);
    s.ang = angulo(s.ang + Math.max(-giro, Math.min(giro, diff)));
    const turbo = s.turbo && s.masa > AJUSTES.MASA_MINIMA_TURBO;
    const v = turbo ? AJUSTES.VELOCIDAD_TURBO : AJUSTES.VELOCIDAD;
    s.x = Math.round(s.x + Math.cos(s.ang) * v);
    s.y = Math.round(s.y + Math.sin(s.ang) * v);
    s.pts.push([s.x, s.y]);
    s.acelerando = turbo;
    if (turbo) {
      s.masa -= AJUSTES.GASTO_TURBO;
      if (++s.pasoTurbo % 5 === 0) this.soltarComida(s.pts[0][0], s.pts[0][1], AJUSTES.GASTO_TURBO * 5 * 0.8);
    }
    recortar(s.pts, largo(s.masa));
  }

  comer(s) {
    const r = radio(s.masa) + 12;
    for (const c of this.comida.values()) {
      const dx = c[1] - s.x;
      const dy = c[2] - s.y;
      const alcance = r + c[3] / 10 * 2;
      if (dx * dx + dy * dy < alcance * alcance) {
        this.comida.delete(c[0]);
        this.comidaComida.push(c[0]);
        s.masa += c[3] / 10;
      }
    }
  }

  // Choques: la cabeza contra el cuerpo de otra serpiente, o contra el borde
  choques() {
    const vivas = [...this.serpientes.values()];
    const cajas = new Map();
    for (const s of vivas) {
      let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
      for (const p of s.pts) {
        if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
        if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
      }
      cajas.set(s.id, [x0, y0, x1, y1]);
    }
    const muertas = [];
    for (const a of vivas) {
      const ra = radio(a.masa);
      if (Math.hypot(a.x, a.y) + ra > AJUSTES.RADIO_MAPA) { muertas.push([a, 0]); continue; }
      for (const b of vivas) {
        if (b === a) continue;
        const rb = radio(b.masa);
        const [x0, y0, x1, y1] = cajas.get(b.id);
        const m = ra + rb;
        if (a.x < x0 - m || a.x > x1 + m || a.y < y0 - m || a.y > y1 + m) continue;
        const lim = (ra * 0.8 + rb) ** 2;
        let choco = false;
        for (const p of b.pts) {
          const dx = p[0] - a.x;
          const dy = p[1] - a.y;
          if (dx * dx + dy * dy < lim) { choco = true; break; }
        }
        if (choco) { muertas.push([a, b.id]); break; }
      }
    }
    for (const [s, asesino] of muertas) this.matar(s, asesino);
  }

  // Bots: rellenan hasta MIN_SERPIENTES; si entran jugadores, sobran y se van
  ajustarBots() {
    const humanos = this.humanos;
    const quiero = Math.max(0, AJUSTES.MIN_SERPIENTES - humanos);
    const bots = [...this.serpientes.values()].filter((s) => s.bot);
    if (bots.length < quiero && this.paso_ % 20 === 0) {
      const usados = new Set([...this.serpientes.values()].map((s) => s.nombre));
      const libres = NOMBRES_BOT.filter((n) => !usados.has(n));
      const lista = libres.length ? libres : NOMBRES_BOT;
      this.crearSerpiente(lista[Math.floor(Math.random() * lista.length)], true);
    } else if (bots.length > quiero + 1 && this.paso_ % 40 === 0) {
      this.quitar(bots[0].id);
    }
  }

  // Un paso de 50 ms. Devuelve lo que cambió, para mandarlo igual a todos.
  paso() {
    this.paso_++;
    for (const s of this.serpientes.values()) if (s.bot) this.pensarBot(s);
    for (const s of this.serpientes.values()) this.mover(s);
    for (const s of this.serpientes.values()) this.comer(s);
    this.choques();
    this.ajustarBots();
    let faltan = AJUSTES.COMIDA - this.comida.size;
    for (let i = 0; i < 6 && faltan > 0; i++, faltan--) this.soltarComida(...this.puntoAlAzar(0.97), 1);

    const nuevasIds = new Set(this.nuevas.map((s) => s.id));
    const cambios = {
      t: 'u',
      s: [...this.serpientes.values()].map((s) => [s.id, s.x, s.y, Math.round(largo(s.masa)), Math.round(radio(s.masa) * 10), s.acelerando ? 1 : 0]),
      j: this.nuevas.filter((s) => this.serpientes.has(s.id)).map((s) => this.datosCompletos(s)),
      m: this.muertes.filter(([id]) => !nuevasIds.has(id)),   // la que nació y murió en el mismo paso nunca se mandó
      n: this.comidaNueva.filter((c) => this.comida.has(c[0])),
      e: this.comidaComida.filter((id) => !this.comidaNueva.some((c) => c[0] === id)),
    };
    this.limpiarEventos();
    return cambios;
  }

  datosCompletos(s) {
    return [s.id, s.nombre, s.color, s.pts.flat(), Math.round(largo(s.masa)), Math.round(radio(s.masa) * 10), s.bot ? 1 : 0];
  }

  // Todo el estado, para quien recién se conecta
  foto() {
    return {
      t: 'i',
      R: AJUSTES.RADIO_MAPA,
      tick: AJUSTES.TICK_MS,
      sn: [...this.serpientes.values()].map((s) => this.datosCompletos(s)),
      f: [...this.comida.values()],
    };
  }
}
