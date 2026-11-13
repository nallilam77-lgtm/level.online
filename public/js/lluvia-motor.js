// =========================================================================
// MOTOR DE "LLUVIA DE DIAMANTES" (minijuego). Módulo ES compartido:
//   - public/minijuego.html lo usa para jugar y dibujar.
//   - api/minijuego.js lo usa para REPETIR cada partida y calcular los puntos él mismo.
// Por eso es determinista: pasos fijos de 1/60 s y azar con semilla (la da el servidor al cobrar las
// fichas). Con la semilla y el registro de movimientos del cofre sale siempre la misma partida.
// Nada de DOM, colores ni Math.random aquí. Si cambias una regla, cambia para la página y el servidor
// a la vez (las partidas ya jugadas no se vuelven a calcular).
// =========================================================================

export const W = 360;
export const H = 480;
export const SUELO = H - 22;          // donde explotan las granadas (solo se ve)
export const COFRE_Y = H - 52;
export const COFRE_MEDIO = 28;        // medio ancho del cofre
export const DURACION_S = 60;         // 1 minuto como máximo
export const VIDAS = 3;
export const PASO = 1 / 60;
export const TICKS_MAX = DURACION_S * 60;
export const X_MIN = COFRE_MEDIO;
export const X_MAX = W - COFRE_MEDIO;

// Qué cae y cuánto (pesos; a = 0 → 1 a lo largo del minuto). Escudo, lento y rápido: raros.
export const OBJETOS = {
  gema:     { peso: () => 44, r: 11 },
  oro:      { peso: () => 4, r: 13 },
  bomba:    { peso: (a) => 14 + a * 10, r: 13 },
  granada:  { peso: (a) => 7 + a * 7, r: 12 },
  cegadora: { peso: (a) => 1.5 + a * 1.5, r: 12 },
  escudo:   { peso: () => 0.7, r: 13 },
  lento:    { peso: () => 0.7, r: 13 },
  rapido:   { peso: () => 0.7, r: 13 },
};
export const RADIO_GRANADA = 72;      // tamaño de la explosión que se dibuja (no hace daño)
export const RADIO_CEGADORA = 95;
export const DUR = { escudo: 8, lento: 5, rapido: 5, ciego: 0.2 };

// Azar con semilla (mulberry32): misma semilla = mismos objetos en el mismo orden
function azarConSemilla(semilla) {
  let a = semilla >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function partidaNueva(semilla) {
  return {
    semilla, azar: azarConSemilla(semilla), tick: 0, jugando: true, fin: '',
    puntos: 0, vidas: VIDAS, racha: 0, x: W / 2, objetivo: W / 2,
    objetos: [], textos: [], explosiones: [], proximo: 0.3, sacudida: 0,
    escudo: 0, lento: 0, rapido: 0, ciego: 0,
    registro: [],                     // [tick, x] cada vez que el cofre cambia de destino
    // Para revisar partidas (no cambian el juego): diamantes atrapados y escapados, golpes recibidos,
    // golpes que paró el escudo y especiales (escudo, lento, rápido) atrapados
    stats: { atrapados: 0, escapados: 0, golpes: 0, bloqueados: 0, especiales: 0 },
  };
}

export const segundos = (e) => e.tick * PASO;
// Combo: cada 8 diamantes seguidos, hasta x5. "Rápido" duplica.
export const multiplicador = (e) => Math.min(5, 1 + Math.floor(e.racha / 8)) * (e.rapido > 0 ? 2 : 1);

function crearObjeto(e) {
  const a = segundos(e) / DURACION_S;
  const pesos = Object.entries(OBJETOS).map(([tipo, o]) => [tipo, o.peso(a)]);
  let r = e.azar() * pesos.reduce((s, [, p]) => s + p, 0);
  const tipo = (pesos.find(([, p]) => (r -= p) < 0) || ['gema'])[0];
  const x = 18 + e.azar() * (W - 36);
  // Cada vez más rápido: al final del minuto caen casi 3 veces más rápido que al inicio
  const v = 190 + a * 260 + a * a * 160 + e.azar() * 60;
  const zigzag = tipo === 'granada' || tipo === 'cegadora';
  const vx = zigzag ? (e.azar() < 0.5 ? -1 : 1) * (40 + e.azar() * 50) : 0;
  e.objetos.push({ tipo, r: OBJETOS[tipo].r, x, y: -20, v, vx, giro: e.azar() * 6 });
}

// Textos flotantes: k es la clase de color que usa la página (gema, oro, bomba, escudo...)
function texto(e, x, t, k) { e.textos.push({ x, y: COFRE_Y - 14, t, k, vida: 0.8 }); }

function golpe(e, x, motivo) {
  if (e.escudo > 0) { e.escudo = 0; e.stats.bloqueados++; texto(e, x, '¡Escudo!', 'escudo'); return; }
  e.stats.golpes++;
  e.vidas--; e.racha = 0; e.sacudida = 0.35; texto(e, x, motivo, 'bomba');
}

// Las granadas solo hacen algo si TOCAN el cofre; al caer al suelo explotan sin hacer nada
function explotar(e, o, tocoCofre) {
  const cegadora = o.tipo === 'cegadora';
  e.explosiones.push({ x: o.x, y: Math.min(o.y, SUELO), radio: cegadora ? RADIO_CEGADORA : RADIO_GRANADA, t: 0, k: o.tipo });
  if (!tocoCofre) return;
  if (cegadora) { e.ciego = DUR.ciego; texto(e, e.x, '¡Cegado!', 'cegadora'); }
  else golpe(e, e.x, '¡Granada!');
}

/** Un paso de 1/60 s. destino = adónde quiere ir el cofre (entero entre X_MIN y X_MAX). */
export function paso(e, destino) {
  const dt = PASO;
  if (destino !== e.objetivo) { e.objetivo = destino; e.registro.push([e.tick, destino]); }
  e.tick++;
  e.escudo = Math.max(0, e.escudo - dt);
  e.lento = Math.max(0, e.lento - dt);
  e.rapido = Math.max(0, e.rapido - dt);
  e.ciego = Math.max(0, e.ciego - dt);
  e.sacudida = Math.max(0, e.sacudida - dt);
  e.x += (e.objetivo - e.x) * Math.min(1, dt * 13);
  // Aparición: cada vez más seguido
  e.proximo -= dt;
  if (e.proximo <= 0) { crearObjeto(e); e.proximo = Math.max(0.17, 0.5 - segundos(e) / 130); }
  const factor = (e.lento > 0 ? 0.5 : 1) * (e.rapido > 0 ? 1.6 : 1);
  for (let i = e.objetos.length - 1; i >= 0; i--) {
    const o = e.objetos[i];
    o.y += o.v * factor * dt; o.giro += dt * 3;
    if (o.vx) { o.x += o.vx * factor * dt; if (o.x < o.r || o.x > W - o.r) o.vx *= -1; }
    const atrapado = o.y + o.r >= COFRE_Y && o.y - o.r <= COFRE_Y + 16 && Math.abs(o.x - e.x) <= COFRE_MEDIO + o.r * 0.5;
    if (atrapado) {
      e.objetos.splice(i, 1);
      switch (o.tipo) {
        case 'bomba': golpe(e, o.x, '−1 vida'); break;
        case 'granada': case 'cegadora': explotar(e, o, true); break;
        case 'escudo': e.stats.especiales++; e.escudo = DUR.escudo; texto(e, o.x, 'Escudo', 'escudo'); break;
        case 'lento': e.stats.especiales++; e.lento = DUR.lento; e.rapido = 0; texto(e, o.x, 'Lento', 'lento'); break;
        case 'rapido': e.stats.especiales++; e.rapido = DUR.rapido; e.lento = 0; texto(e, o.x, 'Rápido ×2', 'rapido'); break;
        default: {
          e.stats.atrapados++;
          e.racha++;
          const pts = (o.tipo === 'oro' ? 50 : 10) * multiplicador(e);
          e.puntos += pts; texto(e, o.x, '+' + pts, o.tipo);
        }
      }
    } else if ((o.tipo === 'granada' || o.tipo === 'cegadora') && o.y >= SUELO) {
      e.objetos.splice(i, 1); explotar(e, o, false);
    } else if (o.y - o.r > H) {
      e.objetos.splice(i, 1);
      if (o.tipo === 'gema' || o.tipo === 'oro') { e.racha = 0; e.stats.escapados++; } // se te escapó: el combo vuelve a x1
    }
  }
  for (const x of e.explosiones) x.t += dt;
  e.explosiones = e.explosiones.filter((x) => x.t < 0.4);
  for (const t of e.textos) { t.vida -= dt; t.y -= 40 * dt; }
  e.textos = e.textos.filter((t) => t.vida > 0);
  if (e.vidas <= 0) { e.jugando = false; e.fin = 'vidas'; }
  else if (e.tick >= TICKS_MAX) { e.jugando = false; e.fin = 'tiempo'; }
}

/** El registro tiene la forma correcta: [[tick, x], ...] con ticks crecientes y x dentro del área. */
export function registroValido(registro) {
  if (!Array.isArray(registro) || registro.length > TICKS_MAX) return false;
  let anterior = -1;
  for (const m of registro) {
    if (!Array.isArray(m) || m.length !== 2) return false;
    const [t, x] = m;
    if (!Number.isInteger(t) || !Number.isInteger(x) || t <= anterior || t >= TICKS_MAX || x < X_MIN || x > X_MAX) return false;
    anterior = t;
  }
  return true;
}

/** Repite una partida con su semilla y su registro: { puntos, ticks, fin, usados, stats } (usados = movimientos aplicados). */
export function repetirPartida(semilla, registro) {
  const e = partidaNueva(semilla);
  let i = 0, destino = W / 2;
  while (e.jugando) {
    while (i < registro.length && registro[i][0] === e.tick) destino = registro[i++][1];
    paso(e, destino);
  }
  return { puntos: e.puntos, ticks: e.tick, fin: e.fin, usados: i, stats: e.stats };
}
