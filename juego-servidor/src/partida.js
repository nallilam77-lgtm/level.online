// =========================================================================
// Último en Pie · lógica de la partida (sin red).
//
// Battle royale 2D visto desde arriba. El servidor manda: mueve a los jugadores, dispara, decide los
// impactos, cierra la zona y declara al ganador. El navegador solo dice hacia dónde se mueve, hacia
// dónde apunta y si dispara.
//
// Ciclo de la sala:  espera (cuenta regresiva con los que tocaron "Jugar") → partida → fin → espera …
// =========================================================================

export const AJUSTES = {
  TICK_MS: 50,               // 20 pasos por segundo
  MAPA: 2400,                // cuadrado de 2400 × 2400
  R: 22,                     // radio de cada jugador
  VEL: 11,                   // unidades por paso (220 por segundo)
  MAX_JUGADORES: 15,
  MIN_EN_PARTIDA: 10,        // si hay menos personas, se rellena con bots
  ESPERA_S: 20,
  ESPERA_LLENA_S: 5,
  FIN_S: 8,
  ALCANCE_RECOGER: 40,
};

// Igual que en public/juego/juego.js
// cad = pasos entre disparos · cargador = balas antes de recargar · recarga = segundos
export const ARMAS = [
  { nombre: 'Pistola', cad: 8, dano: 14, vel: 40, alcance: 700, disp: 0.05, balas: 1, cargador: 12, recarga: 1.1 },
  { nombre: 'Subfusil', cad: 2, dano: 8, vel: 42, alcance: 600, disp: 0.12, balas: 1, cargador: 30, recarga: 1.8 },
  { nombre: 'Escopeta', cad: 16, dano: 10, vel: 38, alcance: 380, disp: 0.3, balas: 6, cargador: 5, recarga: 2.2 },
  { nombre: 'Rifle', cad: 5, dano: 17, vel: 48, alcance: 950, disp: 0.04, balas: 1, cargador: 24, recarga: 2 },
  { nombre: 'Francotirador', cad: 30, dano: 80, vel: 75, alcance: 1600, disp: 0, balas: 1, cargador: 5, recarga: 2.6 },
];

// Obstáculos: [x, y, ancho, alto, tipo]. El rectángulo es lo que choca; el navegador dibuja según el tipo.
export const OBSTACULO = { CAJAS: 0, BARRIL: 1, MURO: 2, ARBOL: 3, ROCA: 4 };
const T = 48;   // una casilla del dibujo (16 px × 3)
export const BOTIQUIN = 10;   // +35 de vida
export const CHALECO = 11;    // +50 de escudo

// La zona: espera (s), cuánto tarda en cerrarse (s), radio final y daño por segundo afuera
const FASES = [
  { espera: 35, cierre: 30, r: 1000, dano: 3 },
  { espera: 25, cierre: 25, r: 550, dano: 5 },
  { espera: 20, cierre: 20, r: 250, dano: 8 },
  { espera: 15, cierre: 25, r: 0, dano: 12 },
];

const COLORES = 12;
const NOMBRES_BOT = ['Kairo', 'Nebula', 'Vortex', 'Zafiro', 'Pixel', 'Rayo', 'Cobra', 'Jade', 'Turbo', 'Eclipse',
  'Fénix', 'Orion', 'Tifón', 'Volt', 'Lince', 'Quasar', 'Brasa', 'Nova'];

const azar = (a, b) => a + Math.random() * (b - a);
const pasos = (seg) => Math.round(seg * 1000 / AJUSTES.TICK_MS);

export function limpiarNombre(texto) {
  const n = String(texto || '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 14);
  return n || 'Jugador';
}

// Saca un círculo de dentro de las cajas y del borde del mapa. El navegador usa la misma función.
export function empujarFuera(o, cajas, R = AJUSTES.R) {
  for (const [x, y, w, h] of cajas) {
    const cx = Math.max(x, Math.min(o.x, x + w));
    const cy = Math.max(y, Math.min(o.y, y + h));
    const dx = o.x - cx;
    const dy = o.y - cy;
    const d2 = dx * dx + dy * dy;
    if (d2 >= R * R) continue;
    if (d2 === 0) {
      // El centro quedó dentro: sale por el lado más cercano
      const lados = [o.x - x, x + w - o.x, o.y - y, y + h - o.y];
      const m = Math.min(...lados);
      if (m === lados[0]) o.x = x - R; else if (m === lados[1]) o.x = x + w + R;
      else if (m === lados[2]) o.y = y - R; else o.y = y + h + R;
    } else {
      const d = Math.sqrt(d2);
      o.x = cx + (dx / d) * R;
      o.y = cy + (dy / d) * R;
    }
  }
  o.x = Math.max(R, Math.min(AJUSTES.MAPA - R, o.x));
  o.y = Math.max(R, Math.min(AJUSTES.MAPA - R, o.y));
}

// Un paso de movimiento (el navegador lo usa para que el propio jugador se mueva sin esperar al servidor)
export function mover(o, mx, my, cajas, factor = 1) {
  const l = Math.hypot(mx, my);
  if (l > 1) { mx /= l; my /= l; }
  o.x += mx * AJUSTES.VEL * factor;
  o.y += my * AJUSTES.VEL * factor;
  empujarFuera(o, cajas);
}

const dentroDeCaja = (x, y, cajas) => cajas.some(([cx, cy, w, h]) => x >= cx && x <= cx + w && y >= cy && y <= cy + h);
const cargar = (j, arma) => { j.arma = arma; j.mun = ARMAS[arma].cargador; j.recarga = 0; };

export class Partida {
  constructor() {
    this.personas = new Map();      // conexiones: id → { id, nombre, listo }
    this.sigPersona = 1;
    this.estado = 'espera';
    this.cuenta = null;             // pasos que faltan para empezar o para volver a la espera
    this.paso_ = 0;
    this.sigBala = 1;
    this.sigItem = 1;
    this.sigBot = 100000;
    this.ganador = null;
    this.vaciar();
    this.limpiarEventos();
  }

  vaciar() {
    this.jugadores = new Map();     // los de la partida en curso (vivos y eliminados)
    this.balas = [];
    this.items = new Map();
    this.cajas = [];
    this.zona = null;
  }

  limpiarEventos() {
    this.balasNuevas = [];
    this.balasFin = [];
    this.itemsNuevos = [];
    this.itemsFuera = [];
    this.bajas = [];
    this.inicio = null;
    this.cambioEstado = false;
  }

  // ------------------------------------------------------------ personas
  unirse(nombre) {
    const id = this.sigPersona++;
    this.personas.set(id, { id, nombre: limpiarNombre(nombre), listo: false });
    return id;
  }

  listo(id, nombre) {
    const p = this.personas.get(id);
    if (!p) return;
    p.nombre = limpiarNombre(nombre);
    const j = this.jugadores.get(id);
    if (this.estado === 'partida' && j && j.vivo) return;   // ya está jugando
    p.listo = true;
    this.cambioEstado = true;
  }

  salir(id) {
    const j = this.jugadores.get(id);
    if (j && j.vivo) this.eliminar(j, null, -1);
    this.personas.delete(id);
    this.cambioEstado = true;
  }

  dirigir(id, m) {
    const j = this.jugadores.get(id);
    if (!j || !j.vivo || j.bot) return;
    const mx = Number(m.x);
    const my = Number(m.y);
    const a = Number(m.a);
    j.mx = Number.isFinite(mx) ? Math.max(-1, Math.min(1, mx)) : 0;
    j.my = Number.isFinite(my) ? Math.max(-1, Math.min(1, my)) : 0;
    if (Number.isFinite(a)) j.a = a;
    j.disparando = m.f === 1 || m.f === true;
  }

  // Cambiar el arma por la que está en el piso (botón "Cambiar" / tecla E)
  cambiar(id) {
    const j = this.jugadores.get(id);
    if (!j || !j.vivo) return;
    const it = this.itemCerca(j, (t) => t >= 1 && t <= 4 && t !== j.arma);
    if (!it) return;
    this.quitarItem(it[0]);
    if (j.arma !== 0) this.ponerItem(it[1], it[2], j.arma);
    cargar(j, it[3]);
    j.proximo = Math.max(j.proximo, this.paso_ + 6);
  }

  // Recargar antes de vaciar el cargador (tecla R / botón)
  recargar(id) {
    const j = this.jugadores.get(id);
    if (j && j.vivo) this.empezarRecarga(j);
  }

  empezarRecarga(j) {
    if (j.recarga || j.mun >= ARMAS[j.arma].cargador) return;
    j.recarga = this.paso_ + pasos(ARMAS[j.arma].recarga);
  }

  // ------------------------------------------------------------ mapa
  generarMapa() {
    const L = AJUSTES.MAPA;
    const cajas = [];
    // Deja al menos 60 de paso entre obstáculos (un jugador mide 44)
    const libre = (x, y, w, h) => x > 90 && y > 90 && x + w < L - 90 && y + h < L - 90 && cajas.every(([cx, cy, cw, ch]) =>
      x + w + 60 < cx || cx + cw + 60 < x || y + h + 60 < cy || cy + ch + 60 < y);
    const poner = (cuantos, medida, tipo) => {
      for (let i = 0, intentos = 0; i < cuantos && intentos < 600; intentos++) {
        const [w, h] = medida();
        const x = Math.round(azar(0, L - w) / 4) * 4;
        const y = Math.round(azar(0, L - h) / 4) * 4;
        if (libre(x, y, w, h)) { cajas.push([x, y, w, h, tipo]); i++; }
      }
    };
    const formas = [[1, 1], [1, 1], [2, 1], [1, 2], [2, 2], [3, 1], [1, 3]];
    poner(12, () => [T * Math.round(azar(3, 6)), 36], OBSTACULO.MURO);
    poner(26, () => { const f = formas[Math.floor(Math.random() * formas.length)]; return [f[0] * T, f[1] * T]; }, OBSTACULO.CAJAS);
    poner(22, () => [30, 26], OBSTACULO.ARBOL);
    poner(12, () => [30, 36], OBSTACULO.BARRIL);
    poner(10, () => [40, 30], OBSTACULO.ROCA);
    this.cajas = cajas;
    this.semilla = Math.floor(Math.random() * 1e9);
    for (let i = 0; i < 48; i++) {
      const [x, y] = this.puntoLibre(60);
      const r = Math.random();
      const tipo = r < 0.22 ? 1 : r < 0.42 ? 2 : r < 0.62 ? 3 : r < 0.7 ? 4 : r < 0.86 ? BOTIQUIN : CHALECO;
      this.ponerItem(x, y, tipo, true);
    }
  }

  puntoLibre(margen) {
    for (let i = 0; i < 200; i++) {
      const x = Math.round(azar(80, AJUSTES.MAPA - 80));
      const y = Math.round(azar(80, AJUSTES.MAPA - 80));
      const cerca = this.cajas.some(([cx, cy, w, h]) => x > cx - margen && x < cx + w + margen && y > cy - margen && y < cy + h + margen);
      if (!cerca) return [x, y];
    }
    return [AJUSTES.MAPA / 2, AJUSTES.MAPA / 2];
  }

  ponerItem(x, y, tipo, inicial = false) {
    const it = [this.sigItem++, Math.round(x), Math.round(y), tipo];
    this.items.set(it[0], it);
    if (!inicial) this.itemsNuevos.push(it);
  }

  quitarItem(id) {
    if (this.items.delete(id)) this.itemsFuera.push(id);
  }

  itemCerca(j, sirve) {
    let mejor = null;
    let dm = AJUSTES.ALCANCE_RECOGER + AJUSTES.R;
    for (const it of this.items.values()) {
      if (!sirve(it[3])) continue;
      const d = Math.hypot(it[1] - j.x, it[2] - j.y);
      if (d < dm) { dm = d; mejor = it; }
    }
    return mejor;
  }

  // ------------------------------------------------------------ partida
  iniciar() {
    this.vaciar();
    this.generarMapa();
    const entran = [...this.personas.values()].filter((p) => p.listo).slice(0, AJUSTES.MAX_JUGADORES);
    const bots = Math.max(0, AJUSTES.MIN_EN_PARTIDA - entran.length);
    const lugares = [];
    const lugar = () => {
      let mejor = null;
      let mejorD = -1;
      for (let i = 0; i < 30; i++) {
        const p = this.puntoLibre(40);
        const d = Math.min(Infinity, ...lugares.map((q) => Math.hypot(q[0] - p[0], q[1] - p[1])));
        if (d > mejorD) { mejorD = d; mejor = p; }
        if (d > 500) break;
      }
      lugares.push(mejor);
      return mejor;
    };
    const crear = (id, nombre, bot) => {
      const [x, y] = lugar();
      this.jugadores.set(id, {
        id, nombre, bot, color: Math.floor(Math.random() * COLORES), x, y, a: azar(-Math.PI, Math.PI),
        mx: 0, my: 0, disparando: false, vivo: true, vida: 100, escudo: 0, arma: 0, mun: ARMAS[0].cargador, recarga: 0, proximo: 0, bajas: 0, puesto: 0,
        idea: 0, visto: 0, lado: Math.random() < 0.5 ? 1 : -1, vagar: azar(-Math.PI, Math.PI),
      });
    };
    for (const p of entran) { p.listo = false; crear(p.id, p.nombre, false); }
    const usados = new Set();
    for (let i = 0; i < bots; i++) {
      const libres = NOMBRES_BOT.filter((n) => !usados.has(n));
      const nombre = libres[Math.floor(Math.random() * libres.length)] || 'Bot';
      usados.add(nombre);
      crear(this.sigBot++, nombre, true);
    }
    const L = AJUSTES.MAPA;
    this.zona = { cx: L / 2, cy: L / 2, r: Math.ceil(L * 0.72), fase: 0, modo: 'espera', t: pasos(FASES[0].espera) };
    this.siguienteObjetivo();
    this.estado = 'partida';
    this.ganador = null;
    this.cuenta = null;
    this.cambioEstado = true;
    this.inicio = this.datosMapa();
  }

  siguienteObjetivo() {
    const z = this.zona;
    const f = FASES[z.fase];
    const margen = Math.max(0, z.r - f.r);
    const a = azar(0, Math.PI * 2);
    const d = azar(0, margen * 0.8);
    z.ox = z.cx; z.oy = z.cy; z.or = z.r;                // de dónde parte el cierre
    z.tx = Math.max(f.r, Math.min(AJUSTES.MAPA - f.r, z.cx + Math.cos(a) * d));
    z.ty = Math.max(f.r, Math.min(AJUSTES.MAPA - f.r, z.cy + Math.sin(a) * d));
    z.tr = f.r;
  }

  moverZona() {
    const z = this.zona;
    if (z.t-- > 0) {
      if (z.modo === 'cierre') {
        const total = pasos(FASES[z.fase].cierre);
        const k = 1 - z.t / total;
        z.cx = z.ox + (z.tx - z.ox) * k;
        z.cy = z.oy + (z.ty - z.oy) * k;
        z.r = z.or + (z.tr - z.or) * k;
      }
      return;
    }
    if (z.modo === 'espera') {
      z.modo = 'cierre';
      z.t = pasos(FASES[z.fase].cierre);
    } else if (z.fase < FASES.length - 1) {
      z.cx = z.tx; z.cy = z.ty; z.r = z.tr;
      z.fase++;
      z.modo = 'espera';
      z.t = pasos(FASES[z.fase].espera);
      this.siguienteObjetivo();
    } else {
      z.t = 0;
    }
  }

  vivos() {
    return [...this.jugadores.values()].filter((j) => j.vivo);
  }

  eliminar(j, asesino, arma) {
    if (!j.vivo) return;
    j.puesto = this.vivos().length;
    j.vivo = false;
    j.disparando = false;
    if (asesino && asesino !== j) asesino.bajas++;
    this.bajas.push([asesino ? asesino.id : 0, j.id, arma]);
    if (arma === -1) return;           // se desconectó: no suelta nada
    if (j.arma !== 0) this.ponerItem(j.x + azar(-15, 15), j.y + azar(-15, 15), j.arma);
    if (Math.random() < 0.6) this.ponerItem(j.x + azar(-25, 25), j.y + azar(-25, 25), BOTIQUIN);
  }

  danar(j, cantidad, asesino, arma, ignoraEscudo = false) {
    let resto = cantidad;
    if (!ignoraEscudo && j.escudo > 0) {
      const absorbe = Math.min(j.escudo, resto);
      j.escudo -= absorbe;
      resto -= absorbe;
    }
    j.vida -= resto;
    if (j.vida <= 0) { j.vida = 0; this.eliminar(j, asesino, arma); }
  }

  disparar(j) {
    const arma = ARMAS[j.arma];
    j.proximo = this.paso_ + arma.cad;
    if (--j.mun <= 0) { j.mun = 0; this.empezarRecarga(j); }
    for (let i = 0; i < arma.balas; i++) {
      const a = j.a + (arma.balas > 1 ? (i / (arma.balas - 1) - 0.5) * arma.disp * 2 : azar(-arma.disp, arma.disp));
      const x = j.x + Math.cos(a) * (AJUSTES.R + 8);
      const y = j.y + Math.sin(a) * (AJUSTES.R + 8);
      const b = { id: this.sigBala++, x, y, dx: Math.cos(a), dy: Math.sin(a), vel: arma.vel, resto: arma.alcance, dano: arma.dano, dueno: j, arma: j.arma };
      this.balas.push(b);
      this.balasNuevas.push([b.id, Math.round(x), Math.round(y), Math.round(a * 1000), arma.vel, arma.alcance, j.arma, j.id]);
    }
  }

  moverBalas() {
    const vivos = this.vivos();
    const R2 = AJUSTES.R * AJUSTES.R;
    this.balas = this.balas.filter((b) => {
      const n = Math.ceil(b.vel / 12);
      const paso = b.vel / n;
      for (let s = 0; s < n; s++) {
        b.x += b.dx * paso;
        b.y += b.dy * paso;
        b.resto -= paso;
        if (b.resto <= 0 || b.x < 0 || b.y < 0 || b.x > AJUSTES.MAPA || b.y > AJUSTES.MAPA || dentroDeCaja(b.x, b.y, this.cajas)) {
          this.balasFin.push([b.id, 0]);
          return false;
        }
        for (const j of vivos) {
          if (j === b.dueno || !j.vivo) continue;
          const dx = j.x - b.x;
          const dy = j.y - b.y;
          if (dx * dx + dy * dy < R2) {
            this.danar(j, b.dano, b.dueno, b.arma);
            this.balasFin.push([b.id, j.id]);
            return false;
          }
        }
      }
      return true;
    });
  }

  recoger(j) {
    for (const it of this.items.values()) {
      if (Math.hypot(it[1] - j.x, it[2] - j.y) > AJUSTES.R + 18) continue;
      const t = it[3];
      if (t === BOTIQUIN && j.vida < 100) { j.vida = Math.min(100, j.vida + 35); this.quitarItem(it[0]); }
      else if (t === CHALECO && j.escudo < 100) { j.escudo = Math.min(100, j.escudo + 50); this.quitarItem(it[0]); }
      else if (t >= 1 && t <= 4 && j.arma === 0) { cargar(j, t); this.quitarItem(it[0]); }   // con pistola se agarra sola
    }
  }

  tieneVista(a, b) {
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.ceil(d / 25);
    for (let i = 1; i < n; i++) {
      const k = i / n;
      if (dentroDeCaja(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k, this.cajas)) return false;
    }
    return true;
  }

  pensarBot(j) {
    if (--j.idea > 0) return;
    j.idea = 3;
    const z = this.zona;
    const fuera = Math.hypot(j.x - z.cx, j.y - z.cy) > z.r - 80;
    let objetivo = null;
    let dmin = 650;
    for (const o of this.jugadores.values()) {
      if (o === j || !o.vivo) continue;
      const d = Math.hypot(o.x - j.x, o.y - j.y);
      if (d < dmin && this.tieneVista(j, o)) { dmin = d; objetivo = o; }
    }
    let rumbo;
    if (objetivo) {
      j.visto++;
      j.a = Math.atan2(objetivo.y - j.y, objetivo.x - j.x) + azar(-0.16, 0.16);
      j.disparando = j.visto > 4 && dmin <= ARMAS[j.arma].alcance * 0.9;
      if (Math.random() < 0.05) j.lado = -j.lado;
      if (fuera) rumbo = Math.atan2(z.cy - j.y, z.cx - j.x);
      else if (dmin < 220) rumbo = j.a + Math.PI + j.lado * 0.6;
      else if (dmin > 450 || (j.arma === 2 && dmin > 250)) rumbo = j.a + j.lado * 0.4;
      else rumbo = j.a + j.lado * Math.PI / 2;
    } else {
      j.visto = 0;
      j.disparando = false;
      if (j.mun < ARMAS[j.arma].cargador / 2) this.empezarRecarga(j);
      const lejosDelObjetivo = Math.hypot(j.x - z.tx, j.y - z.ty) > z.tr * 0.85;
      let item = null;
      let di = 700;
      for (const it of this.items.values()) {
        const t = it[3];
        const sirve = (t <= 4 && j.arma === 0) || (t === BOTIQUIN && j.vida < 70) || (t === CHALECO && j.escudo < 50);
        if (!sirve) continue;
        const d = Math.hypot(it[1] - j.x, it[2] - j.y);
        if (d < di) { di = d; item = it; }
      }
      if (fuera || (z.modo === 'cierre' && lejosDelObjetivo)) rumbo = Math.atan2(z.ty - j.y, z.tx - j.x);
      else if (item) rumbo = Math.atan2(item[2] - j.y, item[1] - j.x);
      else {
        if (Math.random() < 0.04) j.vagar += azar(-1.2, 1.2);
        rumbo = j.vagar;
      }
      j.a = rumbo;
    }
    // Esquivar cajas: si adelante hay una, girar 90°
    for (let intento = 0; intento < 3; intento++) {
      const ax = j.x + Math.cos(rumbo) * 45;
      const ay = j.y + Math.sin(rumbo) * 45;
      const choca = this.cajas.some(([x, y, w, h]) => ax > x - AJUSTES.R && ax < x + w + AJUSTES.R && ay > y - AJUSTES.R && ay < y + h + AJUSTES.R);
      if (!choca) break;
      rumbo += j.lado * Math.PI / 2;
    }
    j.mx = Math.cos(rumbo);
    j.my = Math.sin(rumbo);
  }

  pasoPartida() {
    this.moverZona();
    const z = this.zona;
    const f = FASES[z.fase];
    for (const j of this.vivos()) if (j.bot) this.pensarBot(j);
    for (const j of this.vivos()) {
      mover(j, j.mx, j.my, this.cajas);
      j.x = Math.round(j.x * 10) / 10;
      j.y = Math.round(j.y * 10) / 10;
      this.recoger(j);
    }
    for (const j of this.vivos()) {
      if (j.recarga && this.paso_ >= j.recarga) { j.mun = ARMAS[j.arma].cargador; j.recarga = 0; }
      if (j.disparando && !j.recarga && j.mun > 0 && this.paso_ >= j.proximo) this.disparar(j);
    }
    this.moverBalas();
    for (const j of this.vivos()) {
      if (Math.hypot(j.x - z.cx, j.y - z.cy) > z.r) this.danar(j, f.dano / 20, null, -2, true);
    }
    const vivos = this.vivos();
    const humanosVivos = vivos.filter((j) => !j.bot).length;
    if (vivos.length <= 1 || humanosVivos === 0) {
      const g = vivos.length === 1 ? vivos[0] : null;
      if (g) g.puesto = 1;
      this.ganador = g ? { id: g.id, nombre: g.nombre, bajas: g.bajas, bot: g.bot } : null;
      for (const j of vivos) j.puesto = g ? 1 : 0;   // 0 = seguía en pie cuando se acabó (ya no quedaban personas)
      this.tabla = [...this.jugadores.values()].sort((a, b) => a.puesto - b.puesto || b.bajas - a.bajas).slice(0, 10)
        .map((j) => [j.id, j.nombre, j.puesto, j.bajas, j.bot ? 1 : 0]);
      this.estado = 'fin';
      this.cuenta = pasos(AJUSTES.FIN_S);
      this.cambioEstado = true;
    }
  }

  pasoEspera() {
    const listos = [...this.personas.values()].filter((p) => p.listo).length;
    if (!listos) { if (this.cuenta !== null) { this.cuenta = null; this.cambioEstado = true; } return; }
    if (this.cuenta === null) { this.cuenta = pasos(this.esperaS || AJUSTES.ESPERA_S); this.cambioEstado = true; }
    if (listos >= AJUSTES.MAX_JUGADORES) this.cuenta = Math.min(this.cuenta, pasos(AJUSTES.ESPERA_LLENA_S));
    if (--this.cuenta <= 0) this.iniciar();
  }

  datosEstado() {
    const listos = [...this.personas.values()].filter((p) => p.listo);
    return {
      s: this.estado,
      t: this.cuenta === null ? null : Math.ceil(this.cuenta * AJUSTES.TICK_MS / 1000),
      n: listos.length,
      c: this.personas.size,
      v: this.estado === 'partida' ? this.vivos().length : 0,
      g: this.ganador,
      tabla: this.estado === 'fin' ? this.tabla : undefined,
      max: AJUSTES.MAX_JUGADORES,
    };
  }

  datosMapa() {
    return {
      cajas: this.cajas,
      semilla: this.semilla,
      items: [...this.items.values()],
      jugadores: [...this.jugadores.values()].map((j) => [j.id, j.nombre, j.color, j.bot ? 1 : 0, j.vivo ? 1 : 0, j.bajas]),
    };
  }

  datosZona() {
    const z = this.zona;
    if (!z) return null;
    return [Math.round(z.cx), Math.round(z.cy), Math.round(z.r), Math.round(z.tx), Math.round(z.ty), Math.round(z.tr),
      Math.ceil(z.t * AJUSTES.TICK_MS / 1000), z.modo === 'cierre' ? 1 : 0, FASES[z.fase].dano];
  }

  // Un paso de 50 ms. Devuelve lo que cambió (el mismo mensaje para todos).
  paso() {
    this.paso_++;
    if (this.estado === 'espera') this.pasoEspera();
    else if (this.estado === 'partida') this.pasoPartida();
    else if (this.estado === 'fin' && --this.cuenta <= 0) {
      this.estado = 'espera';
      this.cuenta = null;
      this.vaciar();
      this.cambioEstado = true;
    }
    const m = { t: 'u' };
    if (this.inicio) m.ini = this.inicio;
    if (this.estado === 'partida' || this.estado === 'fin') {
      m.p = this.vivos().map((j) => [j.id, Math.round(j.x), Math.round(j.y), Math.round(j.a * 100), Math.ceil(j.vida), Math.ceil(j.escudo), j.arma, j.mun, j.recarga ? 1 : 0]);
      if (this.paso_ % 2 === 0 || this.inicio) m.z = this.datosZona();
    }
    if (this.balasNuevas.length) m.b = this.balasNuevas;
    if (this.balasFin.length) m.x = this.balasFin;
    if (this.itemsNuevos.length) m.ia = this.itemsNuevos;
    if (this.itemsFuera.length) m.ir = this.itemsFuera;
    if (this.bajas.length) m.k = this.bajas;
    if (this.cambioEstado || this.paso_ % 20 === 0) m.e = this.datosEstado();
    this.limpiarEventos();
    return m;
  }

  // Todo el estado, para quien recién se conecta
  foto() {
    return {
      t: 'i',
      L: AJUSTES.MAPA,
      R: AJUSTES.R,
      tick: AJUSTES.TICK_MS,
      e: this.datosEstado(),
      mapa: this.estado === 'espera' ? null : this.datosMapa(),
      p: this.vivos().map((j) => [j.id, Math.round(j.x), Math.round(j.y), Math.round(j.a * 100), Math.ceil(j.vida), Math.ceil(j.escudo), j.arma, j.mun, j.recarga ? 1 : 0]),
      z: this.datosZona(),
    };
  }
}
