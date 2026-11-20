// =========================================================================
// Duelo de Acero · el combate por turnos, 2 vs 2 o 1 vs 1 (sin red ni relojes: sala.js decide cuándo llamar a cada cosa).
//
// Cada luchador trae su equipo (e: 0 Rojo, 1 Azul) y su fila (f: 0 adelante, 1 atrás). En 2 vs 2 el orden
// es 0 = Rojo adelante, 1 = Rojo atrás, 2 = Azul adelante, 3 = Azul atrás; en 1 vs 1, 0 = Rojo y 1 = Azul.
// Cuerpo a cuerpo: solo se le pega al enemigo de adelante; el de atrás se alcanza cuando el de adelante cae
// o con ataques que lo permiten (Lancero, Sombra, Tajo giratorio, Estocada, Juicio). "Provocar" obliga a
// los ataques de un objetivo a ir contra el Guerrero.
//
// Ataques de todas las clases:
//   Ataque rápido (h 'r'): poco daño y casi nunca se esquiva (máximo 15 %; Evasión no lo detiene).
//   Golpe fuerte (h 'f'): mucho daño, pero se puede esquivar según la esquiva del rival y la precisión propia.
// Las habilidades de daño también se pueden esquivar, con la mitad de probabilidad que un golpe fuerte.
// El daño de todo ataque depende de la flecha (p: 0 = lejos del centro, 1 = justo en el centro), que el
// jugador detiene en su pantalla; los bots la "detienen" al azar. En el centro ("¡Perfecto!") además suma
// +25 % de probabilidad de crítico.
//
// Atributos fijos por clase (no se pueden cambiar): vida, velocidad (orden de turno), fuerza (multiplica el
// ataque rápido y el golpe fuerte), defensa (resta daño), esquiva, precisión (resta esquiva al rival) y
// crítico (probabilidad de hacer el doble en cualquier golpe). Cada clase tiene además una pasiva (siempre activa).
// Los efectos se cuentan en los turnos del que los tiene (o del que los puso): bajan al EMPEZAR su turno.
// =========================================================================

const RAPIDO = 10;                   // daño base del ataque rápido (× fuerza)
const FUERTE = 27;                   // daño base del golpe fuerte (× fuerza)
const ESQUIVA_FUERTE = 0.25;         // esquiva base de un golpe fuerte (+ esquiva del rival − precisión propia)
const VENENO = { turnos: 3, dano: 8 };
const CONTRAGOLPE = 15;
const CRITICO_PERFECTO = 0.25;       // crítico extra si la flecha quedó en el centro
const AURA = 4;                      // pasiva del Clérigo: curación al empezar su turno
export const RONDAS_MAX = 40;        // por si nadie cae: gana quien conserve más vida

// obj: 'enemigo' = uno alcanzable · 'cualquiera' = cualquier enemigo (ignora filas) · 'aliado' = tú o tu
// compañero · 'todos' = sin elegir · 'yo' = sin elegir. dano: usa la flecha.
export const CLASES = {
  guerrero: {
    nombre: 'Guerrero', arma: 'Espada y escudo', vida: 142, vel: 3, fuerza: 1.05, defensa: 0.15, esquiva: 0.08, precision: 0, critico: 0.08,
    alcance: 'enemigo', resumen: 'Aguanta mucho y protege a su compañero. Su armadura le quita daño a todo.',
    pasiva: { n: 'Último aliento', d: 'Una vez por combate, un golpe que lo mataría lo deja con 1 de vida.' },
    hab: [
      { k: 'escudo', n: 'Golpe de escudo', cd: 3, obj: 'enemigo', dano: true, d: '12 de daño y lo aturde: pierde su próximo turno.' },
      { k: 'provocar', n: 'Provocar', cd: 4, obj: 'yo', d: 'Por 2 rondas los enemigos solo te pueden atacar a ti (estés donde estés).' },
      { k: 'muro', n: 'Muro', cd: 3, obj: 'yo', d: 'Tú y tu compañero reciben la mitad del daño hasta tu próximo turno.' },
    ],
  },
  barbaro: {
    nombre: 'Bárbaro', arma: 'Hacha', vida: 135, vel: 2, fuerza: 1.4, defensa: 0.08, esquiva: 0.03, precision: -0.05, critico: 0.15,
    pasiva: { n: 'Sed de sangre', d: 'Mientras menos vida le queda, más pega: hasta +40 % de daño.' },
    alcance: 'enemigo', resumen: 'El que más pega, pero es lento y sus golpes se ven venir: son fáciles de esquivar.',
    hab: [
      { k: 'tajo', n: 'Tajo giratorio', cd: 3, obj: 'todos', dano: true, d: '15 de daño a todos los enemigos, sin importar la fila.' },
      { k: 'furia', n: 'Furia', cd: 4, obj: 'yo', d: '+50 % de daño en tus 2 próximos turnos, pero recibes +20 %.' },
      { k: 'ejecutar', n: 'Ejecutar', cd: 3, obj: 'enemigo', dano: true, d: '22 de daño; el doble (44) si le queda menos del 35 % de vida.' },
    ],
  },
  lancero: {
    nombre: 'Lancero', arma: 'Lanza', vida: 115, vel: 4, fuerza: 1.08, defensa: 0.1, esquiva: 0.15, precision: 0.15, critico: 0.1,
    pasiva: { n: 'Primera sangre', d: 'Su primer golpe que acierta en el combate es crítico seguro.' },
    alcance: 'cualquiera', resumen: 'Su lanza llega a la fila de atrás y es precisa. Desordena al rival.',
    hab: [
      { k: 'estocada', n: 'Estocada', cd: 2, obj: 'todos', dano: true, d: 'Atraviesa: 22 al enemigo de adelante y 14 al de atrás.' },
      { k: 'empujon', n: 'Empujón', cd: 3, obj: 'enemigo', dano: true, d: '10 de daño y los dos enemigos cambian de fila.' },
      { k: 'guardia', n: 'Guardia', cd: 3, obj: 'yo', d: 'El próximo que te golpee cuerpo a cuerpo recibe 15 de daño.' },
    ],
  },
  asesino: {
    nombre: 'Asesino', arma: 'Dagas', vida: 86, vel: 5, fuerza: 0.7, defensa: 0, esquiva: 0.35, precision: 0.3, critico: 0.2,
    pasiva: { n: 'Remate', d: '+30 % de daño a enemigos envenenados, aturdidos o en la fila de atrás.' },
    alcance: 'enemigo', resumen: 'Esquiva casi todo y sus golpes casi no se pueden esquivar, pero pega suave y aguanta poco.',
    hab: [
      { k: 'veneno', n: 'Veneno', cd: 3, obj: 'enemigo', dano: true, d: '6 de daño y 8 más al inicio de sus 3 próximos turnos.' },
      { k: 'sombra', n: 'Sombra', cd: 2, obj: 'cualquiera', dano: true, d: '24 de daño a cualquier enemigo, sin importar la fila.' },
      { k: 'evasion', n: 'Evasión', cd: 4, obj: 'yo', d: 'Esquivas seguro el próximo golpe fuerte o habilidad (el ataque rápido no).' },
    ],
  },
  clerigo: {
    nombre: 'Clérigo', arma: 'Maza y libro', vida: 112, vel: 3, fuerza: 0.85, defensa: 0.12, esquiva: 0.1, precision: 0.05, critico: 0.05,
    pasiva: { n: 'Aura de luz', d: `Al empezar su turno, él y su compañero recuperan ${AURA} de vida.` },
    alcance: 'enemigo', resumen: 'Cura a su equipo y castiga con luz. Pega poco con la maza.',
    hab: [
      { k: 'curar', n: 'Curar', cd: 2, obj: 'aliado', d: 'Cura 34 de vida a ti o a tu compañero.' },
      { k: 'plegaria', n: 'Plegaria', cd: 4, obj: 'yo', d: 'Tú y tu compañero se curan 18 y se quitan el veneno y el aturdido.' },
      { k: 'juicio', n: 'Juicio', cd: 3, obj: 'cualquiera', dano: true, d: '24 de daño a cualquier enemigo, sin importar la fila.' },
    ],
  },
};
export const NOMBRES_CLASES = Object.keys(CLASES);
const CURAR = 34, PLEGARIA = 18;

const pct = (x) => Math.round(x * 100);
const entre = (x, a, b) => Math.min(b, Math.max(a, x));
// Multiplicador de daño según dónde se detuvo la flecha: 0,4 (en el borde) a 1,35; en el centro, 1,5
export const multFlecha = (p) => (p >= 0.95 ? 1.5 : 0.4 + 0.95 * entre(p, 0, 1));

// ¿La acción h de la clase k usa la flecha? (ataques y habilidades de daño)
export const usaFlecha = (k, h) => h === 'r' || h === 'f' || (typeof h === 'number' && !!(CLASES[k] && CLASES[k].hab[h] && CLASES[k].hab[h].dano));
// Lo que tarda la flecha en cruzar la barra (ms): el golpe fuerte va más rápido
export const pasadaFlecha = (h) => (h === 'r' ? 950 : h === 'f' ? 620 : 800);
// Dónde quedó la flecha tras ms milisegundos (va y viene; se detiene sola a las 3 pasadas) → p de 0 a 1
export function pFlecha(ms, pasada) {
  const t = Math.min(Math.max(0, ms) / pasada, 3);
  const ida = t % 2;
  const x = t >= 3 ? 1 : ida < 1 ? ida : 2 - ida;
  return Math.max(0, 1 - Math.abs(x - 0.5) * 2);
}

// Lo que la página necesita para mostrar las clases (sin funciones)
export function infoClases() {
  const info = {};
  for (const [k, c] of Object.entries(CLASES)) {
    const llega = c.alcance === 'cualquiera' ? ' Llega a la fila de atrás.' : '';
    info[k] = {
      nombre: c.nombre, arma: c.arma, vida: c.vida, vel: c.vel, resumen: c.resumen,
      attr: { fuerza: pct(c.fuerza), defensa: pct(c.defensa), esquiva: pct(c.esquiva), precision: pct(c.precision), critico: pct(c.critico) },
      pasiva: c.pasiva,
      rapido: { n: 'Ataque rápido', obj: c.alcance, dano: true, d: `${Math.round(RAPIDO * c.fuerza)} de daño. Casi nunca se esquiva.${llega}` },
      fuerte: { n: 'Golpe fuerte', obj: c.alcance, dano: true, d: `${Math.round(FUERTE * c.fuerza)} de daño. El rival lo puede esquivar.${llega}` },
      hab: c.hab.map(({ n, cd, obj, d, dano }) => ({ n, cd, obj, d, dano: !!dano })),
    };
  }
  return info;
}

export class Combate {
  // luchadores: en orden → { n, k, jid (id del jugador o null si es bot), e, f }
  constructor(luchadores, azar = Math.random) {
    this.azar = azar;
    this.l = luchadores.map((x, i) => {
      const k = CLASES[x.k] ? x.k : 'guerrero';
      const c = CLASES[k];
      return {
        i, n: x.n, k, jid: x.jid || null, experto: !!x.experto,
        e: x.e ?? (i < 2 ? 0 : 1), f: x.f ?? i % 2, v: c.vida, m: c.vida, vel: c.vel,
        cd: [0, 0, 0], at: false, pr: 0, mu: -1, fu: 0, ve: null, ev: false, gu: false,
        dano: 0, cura: 0, bajas: 0, desempate: azar(),
        aliento: k === 'guerrero', primera: k === 'lancero',   // pasivas de un solo uso
      };
    });
    this.ronda = 0;
    this.orden = [];
    this.turno = -1;        // luchador que está jugando (-1 = entre turnos)
    this.ganador = null;    // 0 Rojo · 1 Azul · 2 empate
  }

  vivos(e) { return this.l.filter((x) => x.v > 0 && (e === undefined || x.e === e)); }
  actual() { return this.turno >= 0 ? this.l[this.turno] : null; }

  revisarFin() {
    if (this.ganador !== null) return true;
    const rojo = this.vivos(0).length, azul = this.vivos(1).length;
    if (!rojo || !azul) this.ganador = rojo ? 0 : azul ? 1 : 2;
    else if (this.ronda > RONDAS_MAX) {
      const vida = (e) => this.l.filter((x) => x.e === e).reduce((s, x) => s + x.v / x.m, 0);
      const a = vida(0), b = vida(1);
      this.ganador = Math.abs(a - b) < 0.01 ? 2 : a > b ? 0 : 1;
    }
    if (this.ganador !== null) this.turno = -1;
    return this.ganador !== null;
  }

  // Pasa al siguiente que pueda actuar (aplica veneno, aturdido y lo que vence). Devuelve los eventos.
  siguienteTurno() {
    const ev = [];
    for (let vueltas = 0; vueltas < 20 && !this.revisarFin(); vueltas++) {
      if (!this.orden.length) {
        this.ronda++;
        if (this.revisarFin()) break;
        this.orden = this.vivos().sort((a, b) => b.vel - a.vel || b.desempate - a.desempate).map((x) => x.i);
        ev.push({ t: 'ronda', r: this.ronda });
      }
      const x = this.l[this.orden.shift()];
      if (x.v <= 0) continue;
      // Empieza su turno: bajan sus enfriamientos y vence lo que dura "hasta tu próximo turno"
      x.cd = x.cd.map((c) => Math.max(0, c - 1));
      for (const y of this.l) if (y.mu === x.i) y.mu = -1;
      if (x.pr > 0) x.pr--;
      if (x.fu > 0) x.fu--;
      x.ev = false;
      x.gu = false;
      if (x.ve) {
        const d = Math.min(x.v, x.ve.d);
        x.v -= d;
        const de = this.l[x.ve.de];
        if (de) de.dano += d;
        ev.push({ t: 'veneno', o: x.i, d });
        if (--x.ve.t <= 0) x.ve = null;
        if (x.v <= 0) {
          if (de && de.e !== x.e) de.bajas++;
          this.morir(x, ev);
          continue;
        }
      }
      if (x.k === 'clerigo') {
        for (const y of this.vivos(x.e)) if (y.v < y.m) this.curar(x, y, AURA, ev, 'aura');
      }
      if (x.at) {
        x.at = false;
        ev.push({ t: 'aturdido', o: x.i });
        continue;
      }
      this.turno = x.i;
      ev.push({ t: 'turno', o: x.i });
      return ev;
    }
    this.turno = -1;
    return ev;
  }

  morir(x, ev) {
    x.v = 0;
    x.at = false; x.pr = 0; x.fu = 0; x.ve = null; x.ev = false; x.gu = false; x.mu = -1;
    ev.push({ t: 'cae', o: x.i });
  }

  // A quién puede apuntar `x` con una acción de tipo obj
  objetivos(x, obj) {
    if (obj === 'yo' || obj === 'todos') return [];
    if (obj === 'aliado') return this.vivos(x.e).map((y) => y.i);
    const enemigos = this.vivos(1 - x.e);
    const provoca = enemigos.find((y) => y.pr > 0 && y.k === 'guerrero');
    if (provoca) return [provoca.i];
    if (obj === 'cualquiera') return enemigos.map((y) => y.i);
    const adelante = enemigos.filter((y) => y.f === 0);
    return (adelante.length ? adelante : enemigos).map((y) => y.i);
  }

  // Qué puede hacer el que tiene el turno: [{ h, obj, listo, o: [objetivos] }]
  opciones(x = this.actual()) {
    if (!x) return [];
    const c = CLASES[x.k];
    const ops = [{ h: 'r', obj: c.alcance, listo: true }, { h: 'f', obj: c.alcance, listo: true }];
    c.hab.forEach((hab, n) => ops.push({ h: n, obj: hab.obj, listo: x.cd[n] === 0 }));
    for (const op of ops) op.o = this.objetivos(x, op.obj);
    const aliado = this.l.find((y) => y.e === x.e && y.i !== x.i && y.v > 0);
    ops.push({ h: 'cambiar', obj: 'yo', listo: !!aliado, o: [] });
    return ops.filter((op) => op.listo && (op.obj === 'yo' || op.obj === 'todos' || op.o.length));
  }

  // Probabilidad de que `o` esquive un ataque de `a` (tipo: 'rapido' | 'fuerte' | 'hab')
  probEsquiva(a, o, tipo) {
    const ca = CLASES[a.k], co = CLASES[o.k];
    if (tipo === 'rapido') return entre(0.03 + co.esquiva * 0.3 - ca.precision * 0.2, 0, 0.15);
    if (tipo === 'fuerte') return entre(ESQUIVA_FUERTE + co.esquiva - ca.precision, 0.05, 0.8);
    return entre((co.esquiva - ca.precision) / 2, 0, 0.4);
  }

  // Golpe de `a` a `o`. cuerpo: activa la Guardia del que recibe. mult: multiplicador de la flecha.
  // critico: probabilidad (por defecto la de la clase; 0 = nunca). perfecto: la flecha quedó en el centro.
  // Devuelve el daño hecho (0 si lo esquivó).
  golpear(a, o, base, ev, { cuerpo = true, critico, tipo = 'hab', mult = 1, perfecto = false } = {}) {
    if (o.v <= 0) return 0;
    // Evasión (o.ev) asegura esquivar golpes fuertes y habilidades, pero no el ataque rápido
    const usaEvasion = tipo !== 'rapido' && o.ev;
    if (usaEvasion || this.azar() < this.probEsquiva(a, o, tipo)) {
      if (usaEvasion) o.ev = false;
      ev.push({ t: 'esquiva', o: o.i, a: a.i });
      return 0;
    }
    mult *= 0.95 + this.azar() * 0.1;
    if (a.fu > 0) mult *= 1.5;
    if (o.fu > 0) mult *= 1.2;
    if (o.mu >= 0) mult *= 0.5;
    mult *= 1 - CLASES[o.k].defensa;
    // Pasivas que suben el daño
    if (a.k === 'barbaro') mult *= 1 + 0.4 * (1 - a.v / a.m);
    if (a.k === 'asesino' && (o.ve || o.at || o.f === 1)) mult *= 1.3;
    let pc = critico ?? CLASES[a.k].critico;
    if (pc > 0 && perfecto) pc += CRITICO_PERFECTO;
    let crit = pc > 0 && this.azar() < pc;
    if (a.primera && critico !== 0) { a.primera = false; crit = true; }
    if (crit) mult *= 2;
    let d = Math.min(o.v, Math.max(1, Math.round(base * mult)));
    let aliento = false;
    if (d >= o.v && o.aliento && o.v > 1) { o.aliento = false; d = o.v - 1; aliento = true; }
    o.v -= d;
    if (a.e !== o.e) a.dano += d;
    ev.push({ t: 'dano', o: o.i, a: a.i, d, crit: crit || undefined });
    if (aliento) ev.push({ t: 'pasiva', o: o.i, k: 'aliento' });
    if (o.v <= 0) {
      if (a.e !== o.e) a.bajas++;
      this.morir(o, ev);
    } else if (cuerpo && o.gu && a.v > 0) {
      o.gu = false;
      ev.push({ t: 'contra', o: a.i, a: o.i });
      this.golpear(o, a, CONTRAGOLPE, ev, { cuerpo: false, tipo: 'rapido', critico: 0 });
    }
    return d;
  }

  curar(a, o, cant, ev, por) {
    if (o.v <= 0) return;
    const d = Math.min(cant, o.m - o.v);
    if (d <= 0) return;
    o.v += d;
    a.cura += d;
    ev.push({ t: 'cura', o: o.i, a: a.i, d, por });
  }

  // Acción del que tiene el turno. h: 'r' | 'f' (ataques), 0-2 (habilidad) o 'cambiar'. o: luchador objetivo.
  // p: dónde detuvo la flecha (0 a 1). Devuelve los eventos, o null si no vale (no es su turno, en
  // enfriamiento, objetivo no alcanzable…).
  accion(turno, h, o, p = 0.5) {
    const x = this.actual();
    if (!x || x.i !== turno) return null;
    const op = this.opciones(x).find((y) => y.h === h);
    if (!op) return null;
    let blanco = null;
    if (op.obj === 'enemigo' || op.obj === 'cualquiera' || op.obj === 'aliado') {
      if (!op.o.includes(o)) return null;
      blanco = this.l[o];
    }
    const c = CLASES[x.k];
    p = Number.isFinite(p) ? entre(p, 0, 1) : 0.5;
    const hab = typeof h === 'number' ? c.hab[h] : null;
    const usaFlecha = h === 'r' || h === 'f' || (hab && hab.dano);
    const mult = usaFlecha ? multFlecha(p) : 1;
    const ev = [{ t: 'accion', a: x.i, h, o: blanco ? blanco.i : undefined, p: usaFlecha ? Math.round(p * 100) / 100 : undefined }];
    const enemigos = () => this.vivos(1 - x.e);
    const perfecto = usaFlecha && p >= 0.95;
    const dano = (y, base) => this.golpear(x, y, base, ev, { mult, perfecto });

    if (h === 'r') {
      this.golpear(x, blanco, RAPIDO * c.fuerza, ev, { tipo: 'rapido', mult, perfecto });
    } else if (h === 'f') {
      this.golpear(x, blanco, FUERTE * c.fuerza, ev, { tipo: 'fuerte', mult, perfecto });
    } else if (h === 'cambiar') {
      const aliado = this.l.find((y) => y.e === x.e && y.i !== x.i);
      const f = x.f;
      x.f = aliado.f;
      aliado.f = f;
      if (x.f === aliado.f) x.f = 1 - x.f;       // no debería pasar, pero nunca dos en la misma fila
      ev.push({ t: 'cambio', e: x.e });
    } else {
      x.cd[h] = hab.cd + 1;                        // +1: el inicio de su próximo turno ya descuenta uno
      switch (hab.k) {
        case 'escudo':
          if (dano(blanco, 12) > 0 && blanco.v > 0) { blanco.at = true; ev.push({ t: 'efecto', o: blanco.i, e: 'at' }); }
          break;
        case 'provocar':
          x.pr = 2; ev.push({ t: 'efecto', o: x.i, e: 'pr' });
          break;
        case 'muro':
          for (const y of this.vivos(x.e)) { y.mu = x.i; ev.push({ t: 'efecto', o: y.i, e: 'mu' }); }
          break;
        case 'tajo':
          for (const y of enemigos()) dano(y, 15);
          break;
        case 'furia':
          x.fu = 3; ev.push({ t: 'efecto', o: x.i, e: 'fu' });
          break;
        case 'ejecutar':
          dano(blanco, blanco.v / blanco.m < 0.35 ? 44 : 22);
          break;
        case 'estocada': {
          const vivos = enemigos();
          const primero = vivos.find((y) => y.f === 0) || vivos[0];
          if (primero) dano(primero, 22);
          const segundo = vivos.find((y) => y !== primero);
          if (segundo && segundo.v > 0) dano(segundo, 14);
          break;
        }
        case 'empujon': {
          dano(blanco, 10);
          const [a, b] = this.l.filter((y) => y.e !== x.e);
          if (a && b && a.v > 0 && b.v > 0) { const f = a.f; a.f = b.f; b.f = f; ev.push({ t: 'cambio', e: a.e }); }
          break;
        }
        case 'guardia':
          x.gu = true; ev.push({ t: 'efecto', o: x.i, e: 'gu' });
          break;
        case 'veneno':
          if (dano(blanco, 6) > 0 && blanco.v > 0) {
            blanco.ve = { t: VENENO.turnos, d: VENENO.dano, de: x.i };
            ev.push({ t: 'efecto', o: blanco.i, e: 've' });
          }
          break;
        case 'sombra':
          dano(blanco, 24);
          break;
        case 'evasion':
          x.ev = true; ev.push({ t: 'efecto', o: x.i, e: 'ev' });
          break;
        case 'curar':
          this.curar(x, blanco, CURAR, ev);
          break;
        case 'plegaria':
          for (const y of this.vivos(x.e)) {
            this.curar(x, y, PLEGARIA, ev);
            if (y.ve || y.at) { y.ve = null; y.at = false; ev.push({ t: 'efecto', o: y.i, e: 'limpio' }); }
          }
          break;
        case 'juicio':
          dano(blanco, 24);
          break;
      }
    }
    this.turno = -1;
    this.revisarFin();
    return ev;
  }

  // Jugada automática: bots, jugadores desconectados y (con tiempoAgotado) cuando se acaba el tiempo.
  // Devuelve [h, o, p].
  automatica(tiempoAgotado = false) {
    const x = this.actual();
    if (!x) return null;
    if (tiempoAgotado) {
      const o = this.opciones(x).find((op) => op.h === 'r').o;
      return ['r', this.masDebil(o), 0.3];
    }
    // Los bots detienen la flecha al azar (a veces en el centro); el experto, casi siempre cerca del centro
    const p = x.experto ? (this.azar() < 0.35 ? 1 : 0.75 + this.azar() * 0.25) : (this.azar() < 0.12 ? 1 : 0.35 + this.azar() * 0.6);
    const [h, o] = this.decidir(x);
    return [h, o, p];
  }

  masDebil(lista) { return lista.map((i) => this.l[i]).sort((a, b) => a.v - b.v)[0].i; }

  decidir(x) {
    const ops = this.opciones(x);
    const de = (h) => ops.find((op) => op.h === h);
    // Rápido o fuerte contra el más débil: fuerte si no es muy probable que lo esquive
    const ataque = () => {
      const o = this.masDebil(de('r').o);
      const esq = this.probEsquiva(x, this.l[o], 'fuerte');
      return [esq < 0.5 && this.azar() > 0.2 ? 'f' : 'r', o];
    };
    if (this.azar() < (x.experto ? 0.04 : 0.15)) return ataque();

    const enemigos = this.vivos(1 - x.e);
    const aliado = this.vivos(x.e).find((y) => y !== x);
    const vida = x.v / x.m;
    const usar = (n, o) => (de(n) ? [n, o] : null);

    // Muy herido adelante y el compañero entero atrás: cambiar de fila
    if (x.f === 0 && aliado && vida < 0.3 && aliado.v / aliado.m > 0.6 && this.azar() < 0.6) return ['cambiar'];

    let jugada = null;
    switch (x.k) {
      case 'guerrero':
        if (aliado && aliado.v / aliado.m < 0.5) jugada = usar(2);
        if (!jugada && vida > 0.5 && aliado && aliado.v < x.v) jugada = usar(1);
        if (!jugada && de(0)) jugada = usar(0, de(0).o.map((i) => this.l[i]).sort((a, b) => b.vel - a.vel)[0].i);
        break;
      case 'barbaro': {
        const debil = de(2) ? de(2).o.find((i) => this.l[i].v / this.l[i].m < 0.35) : undefined;
        if (debil !== undefined) jugada = usar(2, debil);
        if (!jugada && enemigos.length > 1) jugada = usar(0);
        if (!jugada && vida > 0.5) jugada = usar(1);
        if (!jugada && de(2)) jugada = usar(2, this.masDebil(de(2).o));
        break;
      }
      case 'lancero':
        if (enemigos.length > 1) jugada = usar(0);
        if (!jugada && vida < 0.6 && this.azar() < 0.5) jugada = usar(2);
        if (!jugada && enemigos.length > 1 && de(1)) {
          const atras = enemigos.find((y) => y.f === 1), adelante = enemigos.find((y) => y.f === 0);
          if (atras && adelante && atras.v < adelante.v) jugada = usar(1, de(1).o[0]);
        }
        break;
      case 'asesino':
        if (de(1)) jugada = usar(1, this.masDebil(de(1).o));
        if (!jugada && de(0)) {
          const sin = de(0).o.map((i) => this.l[i]).filter((y) => !y.ve).sort((a, b) => b.v - a.v)[0];
          if (sin) jugada = usar(0, sin.i);
        }
        if (!jugada && vida < 0.5) jugada = usar(2);
        break;
      case 'clerigo': {
        const equipo = this.vivos(x.e);
        const herido = equipo.filter((y) => y.v / y.m < 0.6).sort((a, b) => a.v / a.m - b.v / b.m)[0];
        if (equipo.length > 1 && equipo.every((y) => y.v / y.m < 0.75 || y.ve || y.at)) jugada = usar(1);
        if (!jugada && herido) jugada = usar(0, herido.i);
        if (!jugada && de(2)) jugada = usar(2, this.masDebil(de(2).o));
        break;
      }
    }
    return jugada || ataque();
  }

  foto() {
    return {
      r: this.ronda, t: this.turno, g: this.ganador,
      l: this.l.map((x) => ({
        n: x.n, k: x.k, j: x.jid, e: x.e, f: x.f, v: x.v, m: x.m, cd: x.cd,
        at: x.at || undefined, pr: x.pr || undefined, mu: x.mu >= 0 || undefined, fu: x.fu || undefined,
        ve: x.ve ? x.ve.t : undefined, ev: x.ev || undefined, gu: x.gu || undefined, al: x.aliento || undefined,
        dano: x.dano, cura: x.cura, bajas: x.bajas,
      })),
      op: this.turno >= 0 ? this.opciones().map(({ h, o }) => ({ h, o })) : [],
    };
  }
}
