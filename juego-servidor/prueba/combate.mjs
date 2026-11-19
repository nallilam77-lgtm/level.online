// Simula muchas partidas solo con bots para revisar que el combate siempre termina y no se rompe.
// Uso: node prueba/combate.mjs
import { Combate, NOMBRES_CLASES } from '../src/combate.js';

const victorias = { 0: 0, 1: 0, 2: 0 };
const porClase = Object.fromEntries(NOMBRES_CLASES.map((k) => [k, { jugadas: 0, ganadas: 0 }]));
let rondas = 0, invalidas = 0;
const N = 5000;
for (let p = 0; p < N; p++) {
  const ks = [0, 1, 2, 3].map(() => NOMBRES_CLASES[Math.floor(Math.random() * 4)]);
  const c = new Combate(ks.map((k, i) => ({ n: 'B' + i, k })));
  c.siguienteTurno();
  for (let pasos = 0; c.ganador === null; pasos++) {
    if (pasos > 1000) throw new Error('la partida no termina');
    const [h, o] = c.automatica(Math.random() < 0.1);
    const ev = c.accion(c.turno, h, o);
    if (!ev) { invalidas++; c.accion(c.turno, 'b', c.opciones().find((x) => x.h === 'b').o[0]); }
    // Revisa reglas básicas
    for (const x of c.l) if (x.v < 0 || x.v > x.m) throw new Error('vida fuera de rango');
    for (const e of [0, 1]) { const fs = c.l.filter((x) => x.e === e).map((x) => x.f).sort().join(); if (fs !== '0,1') throw new Error('filas rotas ' + fs); }
    if (c.ganador === null) c.siguienteTurno();
  }
  // JSON de la foto: que se pueda mandar
  JSON.stringify(c.foto());
  victorias[c.ganador]++;
  rondas += c.ronda;
  ks.forEach((k, i) => { porClase[k].jugadas++; if (c.ganador === (i < 2 ? 0 : 1)) porClase[k].ganadas++; });
}
console.log('Partidas:', N, '· rondas promedio:', (rondas / N).toFixed(1), '· jugadas inválidas de bots:', invalidas);
console.log('Rojo/Azul/empate:', victorias);
for (const [k, v] of Object.entries(porClase)) console.log(k.padEnd(9), ((v.ganadas / v.jugadas) * 100).toFixed(1) + ' % de victorias');
