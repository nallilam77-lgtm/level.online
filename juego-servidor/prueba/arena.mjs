// Prueba la Arena de punta a punta contra el servidor local, con una tienda simulada (no toca nada real).
// Uso: npm run dev:arena (en otra terminal) y luego node prueba/arena.mjs
//   - Torneo 1 vs 1 al mejor de 3 (dos clientes con sesión de prueba) → la tienda recibe "empezo" y "resultado".
//   - Torneo con un solo jugador presente a la hora + 10 min → gana por ausencia (W.O.).
//   - Un intruso sin sesión no entra; uno con sesión pero no inscrito solo mira.
//   - Duelo rápido: dos en la cola → sala con puntos → la tienda recibe "ranking". Uno solo → bot a los 20 s.
//   - Duelo por fichas: se cobra al empezar (sin fichas no empieza), mejor de 3, el ganador cobra; solo → bot experto.
import http from 'node:http';

const BASE = process.env.BASE || 'ws://localhost:8787';
const SECRETO = 'x'.repeat(64);
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const uuid = () => crypto.randomUUID();
let fallas = 0;
const ok = (cond, texto) => { console.log(`${cond ? '✅' : '❌'} ${texto}`); if (!cond) fallas++; };

// ---------- Tienda simulada (api/juego?accion=arena_*) ----------
const partidas = new Map();
const eventos = [];
const saldos = new Map();            // fichas de la tienda simulada
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.headers['x-arena'] !== SECRETO) { res.writeHead(403); res.end(); return; }
  if (url.searchParams.get('accion') === 'arena_sala') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'success', partida: partidas.get(url.searchParams.get('id')) || null }));
    return;
  }
  let cuerpo = '';
  req.on('data', (d) => { cuerpo += d; });
  req.on('end', () => {
    const e = JSON.parse(cuerpo);
    eventos.push(e);
    let r = { status: 'success' };
    if (e.tipo === 'fichas_cobrar') {
      const faltan = e.jugadores.filter((j) => (saldos.get(j.usuario) || 0) < 2).map((j) => j.usuario);
      if (faltan.length) r = { status: 'success', ok: false, faltan };
      else { e.jugadores.forEach((j) => saldos.set(j.usuario, saldos.get(j.usuario) - 2)); r = { status: 'success', ok: true, costo: 2 }; }
    }
    if (e.tipo === 'fichas_resultado' && e.ganador) saldos.set(e.ganador, saldos.get(e.ganador) + 4);
    if (e.tipo === 'fichas_saldo') r = { status: 'success', fichas: saldos.get(e.usuario) || 0, costo: 2 };
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(r));
  });
}).listen(8790);

// ---------- Un cliente que juega solo ----------
function cliente(nombre, url, jwt) {
  const c = { nombre, ws: new WebSocket(url), est: null, id: null, errores: [], jugadas: 0, perfectos: 0 };
  c.ws.addEventListener('open', () => c.ws.send(JSON.stringify({ t: 'hola', n: nombre, jwt })));
  c.ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.t === 'yo') c.id = m.id;
    else if (m.t === 'error') c.errores.push(m.m);
    else if (m.t === 'pi') c.ws.send(JSON.stringify({ t: 'pa', k: m.k }));
    else if (m.t === 'emparejado') c.emparejado = m;
    else if (m.t === 'flecha') {
      // Detiene la flecha justo en el centro (media pasada) y ataca
      setTimeout(() => { c.ws.send(JSON.stringify({ t: 'accion', h: c.op.h, o: c.op.o[0], ms: m.pasada / 2 })); c.jugadas++; }, m.pasada / 2);
    } else if (m.t === 's') {
      c.est = m;
      const k = m.c;
      if (m.fase === 'combate' && k.t >= 0 && k.l[k.t].j === c.id && m.queda > 0 && c.turnoVisto !== `${m.serie && m.serie.num}-${k.r}-${k.t}`) {
        c.turnoVisto = `${m.serie && m.serie.num}-${k.r}-${k.t}`;
        c.op = k.op.find((o) => o.h === 'f') || k.op[0];
        setTimeout(() => c.ws.send(JSON.stringify({ t: 'flecha', h: c.op.h })), 50);
      }
      if (m.ev) c.perfectos += m.ev.filter((x) => x.t === 'accion' && x.p >= 0.95 && k.l[x.a].j === c.id).length;
    }
  });
  return c;
}
const jwt = (u, n) => `prueba:${u}:${n}`;
// Partidas nuevas en cada corrida (las salas terminadas siguen vivas un rato en el servidor local)
const idSala = () => Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');
const P1 = idSala(), P2 = idSala(), P3 = idSala();
const terminar = async (c, s = 300) => { for (let i = 0; i < s && !(c.est && c.est.fase === 'fin'); i++) await espera(1000); };

// ---------- 1. Torneo 1 vs 1, mejor de 3 ----------
const ana = uuid(), beto = uuid();
partidas.set(P1, { id: P1, modo: '1v1', estado: 'lista', hora: new Date(Date.now() + 60000).toISOString(),
  jugadores: [{ usuario: ana, nombre: 'Ana', puesto: 0 }, { usuario: beto, nombre: 'Beto', puesto: 2 }] });
const intruso = cliente('Intruso', `${BASE}/ws?a=${P1}`, 'basura');
const a = cliente('Ana', `${BASE}/ws?a=${P1}`, jwt(ana, 'Ana'));
await espera(800);
ok(intruso.errores.length === 1, 'Sin sesión no entra: ' + intruso.errores[0]);
ok(a.est && a.est.fase === 'sala' && a.est.tipo === 'arena', 'Ana entra a la sala del torneo y espera');
const mira = cliente('Mirón', `${BASE}/ws?a=${P1}`, jwt(uuid(), 'Miron'));
const b = cliente('Beto', `${BASE}/ws?a=${P1}`, jwt(beto, 'Beto'));
await espera(4500);
ok(a.est.fase === 'combate', 'Con los dos dentro empieza solo (fase: ' + a.est.fase + ')');
ok(mira.est && mira.est.jug.find((j) => j.id === mira.id).p === -1, 'El no inscrito solo mira');
ok(eventos.some((e) => e.tipo === 'empezo' && e.partida === P1), 'La tienda supo que empezó');
await terminar(a);
const res1 = eventos.find((e) => e.tipo === 'resultado' && e.partida === P1);
ok(a.est.fase === 'fin' && a.est.serie.fin && res1, `Serie terminada: ganó ${['Rojo (Ana)', 'Azul (Beto)'][res1 && res1.ganador]} ${res1 && res1.marcador}`);
ok(res1 && /^2-[01]$|^[01]-2$/.test(res1.marcador), 'Al mejor de 3 (marcador ' + (res1 && res1.marcador) + ')');
ok(a.perfectos + b.perfectos > 0, `La flecha en el centro cuenta como perfecta (${a.perfectos + b.perfectos} perfectos)`);
[a, b, mira, intruso].forEach((c) => c.ws.close());

// ---------- 2. Ausencia ----------
const carla = uuid();
partidas.set(P2, { id: P2, modo: '1v1', estado: 'lista', hora: new Date(Date.now() - 11 * 60000).toISOString(),
  jugadores: [{ usuario: uuid(), nombre: 'Falta', puesto: 0 }, { usuario: carla, nombre: 'Carla', puesto: 2 }] });
const cc = cliente('Carla', `${BASE}/ws?a=${P2}`, jwt(carla, 'Carla'));
await espera(4000);
const res2 = eventos.find((e) => e.tipo === 'resultado' && e.partida === P2);
ok(res2 && res2.ganador === 1 && res2.marcador === 'W.O.', 'Rival ausente: gana Carla por W.O.');
cc.ws.close();

// ---------- 3. Sala que aún no abre ----------
partidas.set(P3, { id: P3, modo: '1v1', estado: 'lista', hora: new Date(Date.now() + 60 * 60000).toISOString(), jugadores: [] });
const temprano = cliente('Temprano', `${BASE}/ws?a=${P3}`, jwt(uuid(), 'T'));
await espera(800);
ok(/abre 10 minutos antes/.test(temprano.errores[0] || ''), 'Antes de tiempo: ' + temprano.errores[0]);

// ---------- 4. Duelo rápido ----------
const dani = uuid(), eva = uuid();
const q1 = cliente('Dani', `${BASE}/cola`, jwt(dani, 'Dani'));
await espera(500);
const q2 = cliente('Eva', `${BASE}/cola`, jwt(eva, 'Eva'));
await espera(1000);
ok(q1.emparejado && q2.emparejado && q1.emparejado.s === q2.emparejado.s && !q1.emparejado.bot, 'La cola empareja a los dos en la misma sala');
const d = cliente('Dani', `${BASE}/ws?s=${q1.emparejado.s}`, jwt(dani, 'Dani'));
const e2 = cliente('Eva', `${BASE}/ws?s=${q2.emparejado.s}`, jwt(eva, 'Eva'));
await terminar(d);
const rk = eventos.find((x) => x.tipo === 'ranking');
ok(rk && [dani, eva].includes(rk.ganador.usuario) && rk.ganador.usuario !== rk.perdedor.usuario, `Puntos para ${rk && rk.ganador.nombre}`);
[d, e2].forEach((c) => c.ws.close());
const solo = cliente('Solo', `${BASE}/cola`, jwt(uuid(), 'Solo'));
await espera(21500);
ok(solo.emparejado && solo.emparejado.bot, 'Solo en la cola: a los 20 s, contra un bot');

// ---------- 5. Duelo por fichas ----------
const fede = uuid(), gabi = uuid(), pobre = uuid();
saldos.set(fede, 5); saldos.set(gabi, 2); saldos.set(pobre, 1);
const f2 = cliente('Pobre', `${BASE}/cola?modo=fichas`, jwt(pobre, 'Pobre'));
await espera(900);
ok(/No tienes fichas suficientes/.test(f2.errores[0] || '') && !f2.emparejado, 'Sin fichas no entra a la cola: ' + f2.errores[0]);
ok(saldos.get(pobre) === 1, 'A nadie se le cobró');
const g1 = cliente('Fede', `${BASE}/cola?modo=fichas`, jwt(fede, 'Fede'));
await espera(400);
const g2 = cliente('Gabi', `${BASE}/cola?modo=fichas`, jwt(gabi, 'Gabi'));
await espera(900);
const ga = cliente('Fede', `${BASE}/ws?s=${g1.emparejado.s}`, jwt(fede, 'Fede'));
const gb = cliente('Gabi', `${BASE}/ws?s=${g2.emparejado.s}`, jwt(gabi, 'Gabi'));
await espera(2500);
ok(ga.est && ga.est.fase === 'combate' && saldos.get(fede) === 3 && saldos.get(gabi) === 0, 'Empieza y cobra 2 a cada uno');
await terminar(ga);
const rf = eventos.find((x) => x.tipo === 'fichas_resultado' && x.sala === g1.emparejado.s);
ok(rf && [fede, gabi].includes(rf.ganador) && /^2-[01]$|^[01]-2$/.test(`${ga.est.serie.gan[0]}-${ga.est.serie.gan[1]}`),
  `Mejor de 3 (${ga.est.serie.gan[0]}-${ga.est.serie.gan[1]}): el ganador cobra → Fede ${saldos.get(fede)}, Gabi ${saldos.get(gabi)}`);
ok(saldos.get(fede) + saldos.get(gabi) === 7, 'Las fichas no se crean ni se pierden entre personas (5 + 2 = 7)');
[ga, gb].forEach((c) => c.ws.close());
const sola = cliente('Fede', `${BASE}/cola?modo=fichas`, jwt(fede, 'Fede'));
await espera(21500);
ok(sola.emparejado && sola.emparejado.bot, 'Solo en la cola de fichas: contra el bot experto');
const sb = cliente('Fede', `${BASE}/ws?s=${sola.emparejado.s}`, jwt(fede, 'Fede'));
await espera(2500);
ok(sb.est && sb.est.c && /^Maestr/.test(sb.est.c.l[1].n), 'El rival es un bot experto: ' + (sb.est && sb.est.c && sb.est.c.l[1].n));
await terminar(sb);
const rb = eventos.find((x) => x.tipo === 'fichas_resultado' && x.sala === sola.emparejado.s);
ok(rb && (rb.ganador === fede || rb.ganador === null), `Contra el bot: ${rb && rb.ganador ? 'ganó Fede (+4)' : 'ganó el bot'}`);
sb.ws.close();

// ---------- 6. Duelo abandonado: nadie vuelve en 30 s → la máquina lo termina y se reporta ----------
const huye = uuid();
saldos.set(huye, 4);
const h1 = cliente('Huye', `${BASE}/cola?modo=fichas`, jwt(huye, 'Huye'));
await espera(21500);
const hs = h1.emparejado && h1.emparejado.s;
const h2 = cliente('Huye', `${BASE}/ws?s=${hs}`, jwt(huye, 'Huye'));
h2.jugar = false;
await espera(2500);
ok(saldos.get(huye) === 2 && h2.est && h2.est.fase === 'combate', 'Empezó contra el bot y cobró 2');
h2.ws.close();
await espera(34000);
const rh = eventos.find((x) => x.tipo === 'fichas_resultado' && x.sala === hs);
ok(!!rh, `Abandonado: a los 30 s la máquina terminó la serie y avisó (${rh ? (rh.ganador ? 'ganó el jugador' : 'ganó el bot') : 'sin aviso'})`);

console.log(fallas ? `\n${fallas} prueba(s) fallaron` : '\nTodo bien');
process.exit(fallas ? 1 : 0);
