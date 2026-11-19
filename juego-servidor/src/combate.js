// =========================================================================
// Duelo de Acero · el combate 2 vs 2 por turnos (sin red ni relojes: sala.js decide cuándo llamar a cada cosa).
//
// Puestos fijos: 0 = Rojo adelante, 1 = Rojo atrás, 2 = Azul adelante, 3 = Azul atrás.
// Cuerpo a cuerpo: solo se le pega al enemigo de adelante; el de atrás se alcanza cuando el de adelante cae
// o con ataques que lo permiten (básico del Lancero, Sombra, Tajo giratorio, Estocada). "Provocar" obliga a
// los ataques de un objetivo a ir contra el Guerrero.
// Los efectos se cuentan en los turnos del que los tiene (o del que los puso): bajan al EMPEZAR su turno.
// =========================================================================

// obj: 'enemigo' = uno alcanzable · 'cualquiera' = cualquier enemigo (ignora filas) · 'todos' = sin elegir · 'yo' = sin elegir
export const CLASES = {
  guerrero: {
    nombre: 'Guerrero', arma: 'Espada y escudo', vida: 140, vel: 3, basico: 16, alcance: 'enemigo',
    resumen: 'Aguanta mucho y protege a su compañero.',
    hab: [
      { k: 'escudo', n: 'Golpe de escudo', cd: 3, obj: 'enemigo', d: '12 de daño y lo aturde: pierde su próximo turno.' },
      { k: 'provocar', n: 'Provocar', cd: 4, obj: 'yo', d: 'Por 2 rondas los enemigos solo te pueden atacar a ti (estés donde estés).' },
      { k: 'muro', n: 'Muro', cd: 3, obj: 'yo', d: 'Tú y tu compañero reciben la mitad del daño hasta tu próximo turno.' },
    ],
  },
  barbaro: {
    nombre: 'Bárbaro', arma: 'Hacha', vida: 120, vel: 2, basico: 21, alcance: 'enemigo',
    resumen: 'El que más pega, pero es lento.',
    hab: [
      { k: 'tajo', n: 'Tajo giratorio', cd: 3, obj: 'todos', d: '15 de daño a los dos enemigos, sin importar la fila.' },
      { k: 'furia', n: 'Furia', cd: 4, obj: 'yo', d: '+50 % de daño en tus 2 próximos turnos, pero recibes +20 %.' },
      { k: 'ejecutar', n: 'Ejecutar', cd: 3, obj: 'enemigo', d: '22 de daño; el doble (44) si le queda menos del 35 % de vida.' },
    ],
  },
  lancero: {
    nombre: 'Lancero', arma: 'Lanza', vida: 112, vel: 4, basico: 17, alcance: 'cualquiera',
    resumen: 'Su lanza llega a la fila de atrás y desordena al rival.',
    hab: [
      { k: 'estocada', n: 'Estocada', cd: 2, obj: 'todos', d: 'Atraviesa: 22 al enemigo de adelante y 14 al de atrás.' },
      { k: 'empujon', n: 'Empujón', cd: 3, obj: 'enemigo', d: '10 de daño y los dos enemigos cambian de fila.' },
      { k: 'guardia', n: 'Guardia', cd: 3, obj: 'yo', d: 'El próximo que te golpee cuerpo a cuerpo recibe 15 de daño.' },
    ],
  },
  picaro: {
    nombre: 'Pícaro', arma: 'Dagas', vida: 100, vel: 5, basico: 16, alcance: 'enemigo', critico: 0.25,
    resumen: 'Rápido: críticos, veneno y esquivas.',
    hab: [
      { k: 'veneno', n: 'Veneno', cd: 3, obj: 'enemigo', d: '6 de daño y 8 más al inicio de sus 3 próximos turnos.' },
      { k: 'sombra', n: 'Sombra', cd: 2, obj: 'cualquiera', d: '24 de daño a cualquier enemigo, sin importar la fila.' },
      { k: 'evasion', n: 'Evasión', cd: 4, obj: 'yo', d: 'Esquivas el próximo ataque (hasta tu próximo turno).' },
    ],
  },
};
export const NOMBRES_CLASES = Object.keys(CLASES);

// Lo que la página necesita para mostrar las clases (sin funciones)
export function infoClases() {
  const info = {};
  for (const [k, c] of Object.entries(CLASES)) {
    info[k] = {
      nombre: c.nombre, arma: c.arma, vida: c.vida, vel: c.vel, resumen: c.resumen,
      basico: { n: 'Ataque', obj: c.alcance, d: `${c.basico} de daño${c.critico ? ' (25 % de crítico: el doble)' : ''}${c.alcance === 'cualquiera' ? '. Llega a la fila de atrás' : ''}.` },
      hab: c.hab.map(({ n, cd, obj, d }) => ({ n, cd, obj, d })),
    };
  }
  return info;
}

export const RONDAS_MAX = 40;        // por si nadie cae: gana quien conserve más vida
const VENENO = { turnos: 3, dano: 8 };
const CONTRAGOLPE = 15;

const equipoDe = (puesto) => (puesto < 2 ? 0 : 1);

export class Combate {
  // luchadores: 4 en orden de puesto → { n, k, jid (id del jugador o null si es bot) }
  constructor(luchadores, azar = Math.random) {
    this.azar = azar;
    this.l = luchadores.map((x, i) => {
      const c = CLASES[x.k] || CLASES.guerrero;
      return {
        i, n: x.n, k: CLASES[x.k] ? x.k : 'guerrero', jid: x.jid || null,
        e: equipoDe(i), f: i % 2, v: c.vida, m: c.vida, vel: c.vel,
        cd: [0, 0, 0], at: false, pr: 0, mu: -1, fu: 0, ve: null, ev: false, gu: false,
        dano: 0, bajas: 0, desempate: azar(),
      };
    });
    this.ronda = 0;
    this.orden = [];
    this.turno = -1;        // puesto que está jugando (-1 = entre turnos)
    this.ganador = null;    // 0 Rojo · 1 Azul · 2 empate
  }

  vivos(e) { return this.l.filter((x) => x.v > 0 && (e === undefined || x.e === e)); }
  actual() { return this.turno >= 0 ? this.l[this.turno] : null; }

  revisarFin() {
    if (this.ganador !== null) return true;
    const rojo = this.vivos(0).length, azul = this.vivos(1).length;
    if (!rojo || !azul) this.ganador = rojo ? 0 : azul ? 1 : 2;
    else if (this.ronda > RONDAS_MAX) {
      const pct = (e) => this.l.filter((x) => x.e === e).reduce((s, x) => s + x.v / x.m, 0);
      const a = pct(0), b = pct(1);
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

  // A quién puede atacar `x` con un ataque de tipo obj
  objetivos(x, obj) {
    if (obj === 'yo' || obj === 'todos') return [];
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
    const ops = [{ h: 'b', obj: c.alcance, listo: true }];
    c.hab.forEach((hab, n) => ops.push({ h: n, obj: hab.obj, listo: x.cd[n] === 0 }));
    for (const op of ops) op.o = this.objetivos(x, op.obj);
    const aliado = this.l.find((y) => y.e === x.e && y.i !== x.i && y.v > 0);
    ops.push({ h: 'cambiar', obj: 'yo', listo: !!aliado, o: [] });
    return ops.filter((op) => op.listo && (op.obj === 'yo' || op.obj === 'todos' || op.o.length));
  }

  // Golpe de `a` a `o`. cuerpo: activa la Guardia del que recibe. Devuelve el daño hecho.
  golpear(a, o, base, ev, { cuerpo = true, critico = 0 } = {}) {
    if (o.v <= 0) return 0;
    if (o.ev) {
      o.ev = false;
      ev.push({ t: 'esquiva', o: o.i, a: a.i });
      return 0;
    }
    let mult = 0.9 + this.azar() * 0.2;
    if (a.fu > 0) mult *= 1.5;
    if (o.fu > 0) mult *= 1.2;
    if (o.mu >= 0) mult *= 0.5;
    const crit = critico > 0 && this.azar() < critico;
    if (crit) mult *= 2;
    const d = Math.min(o.v, Math.max(1, Math.round(base * mult)));
    o.v -= d;
    if (a.e !== o.e) a.dano += d;
    ev.push({ t: 'dano', o: o.i, a: a.i, d, crit: crit || undefined });
    if (o.v <= 0) {
      if (a.e !== o.e) a.bajas++;
      this.morir(o, ev);
    } else if (cuerpo && o.gu && a.v > 0) {
      o.gu = false;
      ev.push({ t: 'contra', o: a.i, a: o.i });
      this.golpear(o, a, CONTRAGOLPE, ev, { cuerpo: false });
    }
    return d;
  }

  // Acción del que tiene el turno. h: 'b' (ataque), 0-2 (habilidad) o 'cambiar'. o: puesto objetivo.
  // Devuelve los eventos, o null si no vale (no es su turno, en enfriamiento, objetivo no alcanzable…).
  accion(puesto, h, o) {
    const x = this.actual();
    if (!x || x.i !== puesto) return null;
    const op = this.opciones(x).find((y) => y.h === h);
    if (!op) return null;
    let blanco = null;
    if (op.obj === 'enemigo' || op.obj === 'cualquiera') {
      if (!op.o.includes(o)) return null;
      blanco = this.l[o];
    }
    const c = CLASES[x.k];
    const ev = [{ t: 'accion', a: x.i, h, o: blanco ? blanco.i : undefined }];
    const enemigos = () => this.vivos(1 - x.e);

    if (h === 'b') {
      this.golpear(x, blanco, c.basico, ev, { critico: c.critico || 0 });
    } else if (h === 'cambiar') {
      const aliado = this.l.find((y) => y.e === x.e && y.i !== x.i);
      const f = x.f;
      x.f = aliado.f;
      aliado.f = f;
      if (x.f === aliado.f) x.f = 1 - x.f;       // no debería pasar, pero nunca dos en la misma fila
      ev.push({ t: 'cambio', e: x.e });
    } else {
      const hab = c.hab[h];
      x.cd[h] = hab.cd + 1;                        // +1: el inicio de su próximo turno ya descuenta uno
      switch (hab.k) {
        case 'escudo':
          if (this.golpear(x, blanco, 12, ev) > 0 && blanco.v > 0) { blanco.at = true; ev.push({ t: 'efecto', o: blanco.i, e: 'at' }); }
          break;
        case 'provocar':
          x.pr = 2; ev.push({ t: 'efecto', o: x.i, e: 'pr' });
          break;
        case 'muro':
          for (const y of this.vivos(x.e)) { y.mu = x.i; ev.push({ t: 'efecto', o: y.i, e: 'mu' }); }
          break;
        case 'tajo':
          for (const y of enemigos()) this.golpear(x, y, 15, ev);
          break;
        case 'furia':
          x.fu = 3; ev.push({ t: 'efecto', o: x.i, e: 'fu' });
          break;
        case 'ejecutar':
          this.golpear(x, blanco, blanco.v / blanco.m < 0.35 ? 44 : 22, ev);
          break;
        case 'estocada': {
          const vivos = enemigos();
          const primero = vivos.find((y) => y.f === 0) || vivos[0];
          if (primero) this.golpear(x, primero, 22, ev);
          const segundo = vivos.find((y) => y !== primero);
          if (segundo && segundo.v > 0) this.golpear(x, segundo, 14, ev);
          break;
        }
        case 'empujon': {
          this.golpear(x, blanco, 10, ev);
          const [p, q] = this.l.filter((y) => y.e !== x.e);
          if (p.v > 0 && q.v > 0) { const f = p.f; p.f = q.f; q.f = f; ev.push({ t: 'cambio', e: p.e }); }
          break;
        }
        case 'guardia':
          x.gu = true; ev.push({ t: 'efecto', o: x.i, e: 'gu' });
          break;
        case 'veneno':
          if (this.golpear(x, blanco, 6, ev) > 0 && blanco.v > 0) {
            blanco.ve = { t: VENENO.turnos, d: VENENO.dano, de: x.i };
            ev.push({ t: 'efecto', o: blanco.i, e: 've' });
          }
          break;
        case 'sombra':
          this.golpear(x, blanco, 24, ev);
          break;
        case 'evasion':
          x.ev = true; ev.push({ t: 'efecto', o: x.i, e: 'ev' });
          break;
      }
    }
    this.turno = -1;
    this.revisarFin();
    return ev;
  }

  // Jugada automática: bots, jugadores desconectados y (con soloAtaque) cuando se acaba el tiempo
  automatica(soloAtaque = false) {
    const x = this.actual();
    if (!x) return null;
    const ops = this.opciones(x);
    const de = (h) => ops.find((op) => op.h === h);
    const masDebil = (lista) => lista.map((i) => this.l[i]).sort((a, b) => a.v - b.v)[0].i;
    const ataque = () => ['b', masDebil(de('b').o)];
    if (soloAtaque || this.azar() < 0.15) return ataque();

    const enemigos = this.vivos(1 - x.e);
    const aliado = this.vivos(x.e).find((y) => y !== x);
    const vida = x.v / x.m;
    const usar = (n, o) => (de(n) ? [n, o === undefined ? undefined : o] : null);

    // Muy herido adelante y el compañero entero atrás: cambiar de fila
    if (x.f === 0 && aliado && vida < 0.3 && aliado.v / aliado.m > 0.6 && this.azar() < 0.6) return ['cambiar'];

    let jugada = null;
    switch (x.k) {
      case 'guerrero':
        if (aliado && aliado.v / aliado.m < 0.5) jugada = usar(2);
        if (!jugada && vida > 0.5 && aliado && aliado.v < x.v) jugada = usar(1);
        if (!jugada && de(0)) jugada = usar(0, enemigos.filter((y) => de(0).o.includes(y.i)).sort((a, b) => b.vel - a.vel)[0].i);
        break;
      case 'barbaro': {
        const debil = de(2) ? de(2).o.find((i) => this.l[i].v / this.l[i].m < 0.35) : undefined;
        if (debil !== undefined) jugada = usar(2, debil);
        if (!jugada && enemigos.length > 1) jugada = usar(0);
        if (!jugada && vida > 0.5) jugada = usar(1);
        if (!jugada && de(2)) jugada = usar(2, masDebil(de(2).o));
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
      case 'picaro':
        if (de(1)) jugada = usar(1, masDebil(de(1).o));
        if (!jugada && de(0)) {
          const sin = de(0).o.map((i) => this.l[i]).filter((y) => !y.ve).sort((a, b) => b.v - a.v)[0];
          if (sin) jugada = usar(0, sin.i);
        }
        if (!jugada && vida < 0.5) jugada = usar(2);
        break;
    }
    return jugada || ataque();
  }

  foto() {
    return {
      r: this.ronda, t: this.turno, g: this.ganador,
      l: this.l.map((x) => ({
        n: x.n, k: x.k, j: x.jid, e: x.e, f: x.f, v: x.v, m: x.m, cd: x.cd,
        at: x.at || undefined, pr: x.pr || undefined, mu: x.mu >= 0 || undefined, fu: x.fu || undefined,
        ve: x.ve ? x.ve.t : undefined, ev: x.ev || undefined, gu: x.gu || undefined,
        dano: x.dano, bajas: x.bajas,
      })),
      op: this.turno >= 0 ? this.opciones().map(({ h, o }) => ({ h, o })) : [],
    };
  }
}
