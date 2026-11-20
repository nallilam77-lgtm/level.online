// Simula muchas partidas solo con bots (2 vs 2 y 1 vs 1) para revisar que el combate siempre termina y no se rompe.
// Uso: node prueba/combate.mjs
import { Combate, NOMBRES_CLASES } from '../src/combate.js';

const azarClase = () => NOMBRES_CLASES[Math.floor(Math.random() * NOMBRES_CLASES.length)];

function simular(modo, N) {
  const victorias = { 0: 0, 1: 0, 2: 0 };
  const porClase = Object.fromEntries(NOMBRES_CLASES.map((k) => [k, { jugadas: 0, ganadas: 0 }]));
  let rondas = 0, invalidas = 0, esquivas = 0, rapidos = 0, rapidosEsquivados = 0, curas = 0, criticos = 0, golpes = 0, alientos = 0;
  const puestos = modo === '1v1' ? [{ e: 0, f: 0 }, { e: 1, f: 0 }] : [0, 1, 2, 3].map((i) => ({ e: i < 2 ? 0 : 1, f: i % 2 }));
  for (let p = 0; p < N; p++) {
    const ks = puestos.map(() => azarClase());
    const c = new Combate(ks.map((k, i) => ({ n: 'B' + i, k, ...puestos[i] })));
    c.siguienteTurno();
    for (let pasos = 0; c.ganador === null; pasos++) {
      if (pasos > 1000) throw new Error('la partida no termina');
      const [h, o, pr] = c.automatica(Math.random() < 0.1);
      let ev = c.accion(c.turno, h, o, pr);
      if (!ev) { invalidas++; ev = c.accion(c.turno, 'r', c.opciones().find((x) => x.h === 'r').o[0], 0.5); }
      if (ev[0].h === 'r') { rapidos++; if (ev.some((e) => e.t === 'esquiva' && e.a === ev[0].a)) rapidosEsquivados++; }
      golpes += ev.filter((e) => e.t === 'dano').length;
      criticos += ev.filter((e) => e.t === 'dano' && e.crit).length;
      alientos += ev.filter((e) => e.t === 'pasiva').length;
      esquivas += ev.filter((e) => e.t === 'esquiva').length;
      curas += ev.filter((e) => e.t === 'cura').length;
      // Revisa reglas básicas
      for (const x of c.l) if (x.v < 0 || x.v > x.m) throw new Error('vida fuera de rango');
      if (modo === '2v2') for (const e of [0, 1]) { const fs = c.l.filter((x) => x.e === e).map((x) => x.f).sort().join(); if (fs !== '0,1') throw new Error('filas rotas ' + fs); }
      if (c.ganador === null) c.siguienteTurno();
    }
    JSON.stringify(c.foto());           // que se pueda mandar
    victorias[c.ganador]++;
    rondas += c.ronda;
    ks.forEach((k, i) => { porClase[k].jugadas++; if (c.ganador === puestos[i].e) porClase[k].ganadas++; });
  }
  if (rapidosEsquivados / rapidos > 0.15) throw new Error('el ataque rápido se esquiva demasiado');
  console.log(`\n${modo} · partidas: ${N} · rondas promedio: ${(rondas / N).toFixed(1)} · inválidas de bots: ${invalidas} · esquivas: ${esquivas} · curas: ${curas}`);
  console.log(`Rápidos esquivados: ${((rapidosEsquivados / rapidos) * 100).toFixed(1)} % · críticos: ${((criticos / golpes) * 100).toFixed(1)} % · Último aliento: ${alientos}`);
  console.log('Rojo/Azul/empate:', victorias);
  for (const [k, v] of Object.entries(porClase)) console.log(k.padEnd(9), ((v.ganadas / v.jugadas) * 100).toFixed(1) + ' % de victorias');
}

simular('2v2', 5000);
simular('1v1', 5000);
