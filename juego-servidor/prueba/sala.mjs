// Prueba la sala de punta a punta con `npm run dev` corriendo: el anfitrión crea la sala, entra un invitado
// con el enlace, se sientan, el anfitrión empieza, los dos juegan (el invitado se desconecta a mitad y vuelve)
// y al final el anfitrión pide otra partida. Uso: node prueba/sala.mjs
const BASE = process.env.BASE || 'ws://localhost:8787';
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

function jugador(nombre, url, tok) {
  const j = { nombre, ws: new WebSocket(url), est: null, id: null, tok: null, errores: [] };
  j.ws.addEventListener('open', () => j.ws.send(JSON.stringify({ t: 'hola', n: nombre, tok })));
  j.ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.t === 'yo') { j.id = m.id; j.tok = m.tok; }
    else if (m.t === 's') {
      j.est = m;
      const c = m.c;
      // Si es mi turno, juego la primera opción con su primer objetivo
      if (m.fase === 'combate' && c.t >= 0 && c.l[c.t].j === j.id && m.queda > 0 && !j.jugando) {
        j.jugando = true;
        setTimeout(() => {
          const op = c.op[Math.floor(Math.random() * c.op.length)];
          j.ws.send(JSON.stringify({ t: 'accion', h: op.h, o: op.o[0] }));
          j.jugadas = (j.jugadas || 0) + 1;
          j.jugando = false;
        }, 100);
      }
    } else if (m.t === 'error') j.errores.push(m.m);
  });
  return j;
}

const a = jugador('Anfitrion', `${BASE}/ws?crear=1`);
await espera(800);
const sala = a.est.sala;
console.log('Sala creada:', sala, '· anfitrión:', a.est.anf === a.id, '· puesto:', a.est.jug[0].p);
let b = jugador('Invitado', `${BASE}/ws?s=${sala}`);
await espera(600);
console.log('Invitado en puesto', b.est.jug.find((x) => x.id === b.id).p);
b.ws.send(JSON.stringify({ t: 'clase', k: 'picaro' }));
b.ws.send(JSON.stringify({ t: 'empezar' }));          // no es anfitrión: no debe empezar
await espera(300);
console.log('Fase tras empezar del invitado:', a.est.fase);
const malo = jugador('Intruso', `${BASE}/ws?s=zzzzzzzzzz`);
await espera(500);
console.log('Sala inexistente:', malo.errores);

a.ws.send(JSON.stringify({ t: 'empezar' }));
await espera(500);
console.log('Fase:', a.est.fase, '· luchadores:', a.est.c.l.map((x) => `${x.n}(${x.k}${x.j ? '' : ',bot'})`).join(' '));
await espera(4000);
// El invitado se cae y vuelve con su tok
const tok = b.tok;
b.ws.close();
await espera(3000);
console.log('Invitado desconectado:', a.est.jug.find((x) => x.n === 'Invitado').on === false);
b = jugador('Invitado', `${BASE}/ws?s=${sala}`, tok);
await espera(800);
console.log('Invitado volvió con el mismo id:', b.id === a.est.jug.find((x) => x.n === 'Invitado').id, '· jugadores:', a.est.jug.length);

for (let i = 0; i < 120 && a.est.fase !== 'fin'; i++) await espera(1000);
console.log('Fin:', a.est.fase, '· ganó:', ['Rojo', 'Azul', 'empate'][a.est.c.g], '· rondas:', a.est.c.r, '· jugadas anfitrión:', a.jugadas, '· invitado:', b.jugadas);
a.ws.send(JSON.stringify({ t: 'otra' }));
await espera(500);
console.log('Otra partida → fase:', a.est.fase, '· puestos:', a.est.jug.map((x) => `${x.n}:${x.p}:${x.k}`).join(' '));
a.ws.close(); b.ws.close();
process.exit(0);
