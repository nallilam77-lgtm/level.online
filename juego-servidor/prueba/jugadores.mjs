// Prueba de carga: conecta N jugadores que se mueven al azar y revisa que el servidor aguante y que cada
// navegador rehaga los cuerpos igual que el servidor.
// Uso: node prueba/jugadores.mjs [url] [jugadores] [segundos]
//      node prueba/jugadores.mjs ws://127.0.0.1:8787/ws 15 20

const URL_WS = process.argv[2] || 'ws://127.0.0.1:8787/ws';
const N = Number(process.argv[3]) || 15;
const SEGUNDOS = Number(process.argv[4]) || 20;

function recortar(pts, L) {
  let total = 0;
  for (let i = pts.length - 1; i > 0; i--) {
    total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (total >= L) { if (i - 1 > 0) pts.splice(0, i - 1); return; }
  }
}

const resultados = [];
function jugador(n) {
  return new Promise((listo) => {
    const ws = new WebSocket(URL_WS);
    const r = { n, mensajes: 0, bytes: 0, muertes: 0, entradas: 0, lleno: false, errores: 0, maxGap: 0, serpientes: new Map(), yo: null };
    let ultimo = 0;
    let ang = Math.random() * 6.28;
    ws.onmessage = (e) => {
      r.mensajes++;
      r.bytes += e.data.length;
      const m = JSON.parse(e.data);
      const ahora = Date.now();
      if (m.t === 'u') { if (ultimo) r.maxGap = Math.max(r.maxGap, ahora - ultimo); ultimo = ahora; }
      if (m.t === 'i') {
        m.sn.forEach(([id, , , plano]) => { const p = []; for (let i = 0; i < plano.length; i += 2) p.push([plano[i], plano[i + 1]]); r.serpientes.set(id, p); });
        ws.send(JSON.stringify({ t: 'jugar', n: 'Prueba' + n }));
      } else if (m.t === 'tu') { r.yo = m.id; r.entradas++; }
      else if (m.t === 'lleno') r.lleno = true;
      else if (m.t === 'u') {
        m.j.forEach(([id, , , plano]) => { const p = []; for (let i = 0; i < plano.length; i += 2) p.push([plano[i], plano[i + 1]]); r.serpientes.set(id, p); });
        m.s.forEach(([id, x, y, L]) => {
          const p = r.serpientes.get(id);
          if (!p) { r.errores++; return; }
          const u = p[p.length - 1];
          if (!u || u[0] !== x || u[1] !== y) p.push([x, y]);
          recortar(p, L);
        });
        m.m.forEach(([id]) => {
          if (id === r.yo) { r.muertes++; r.yo = null; setTimeout(() => ws.send(JSON.stringify({ t: 'jugar', n: 'Prueba' + n })), 500); }
          r.serpientes.delete(id);
        });
      }
    };
    const giro = setInterval(() => {
      if (ws.readyState !== 1 || !r.yo) return;
      ang += (Math.random() - 0.5) * 1.2;
      ws.send(JSON.stringify({ t: 'd', a: Math.round(ang * 100) / 100, b: Math.random() < 0.1 ? 1 : 0 }));
    }, 150);
    ws.onerror = () => { r.errores++; };
    setTimeout(() => {
      clearInterval(giro);
      r.largos = [...r.serpientes.values()].map((p) => p.length);
      ws.close();
      resultados.push(r);
      listo();
    }, SEGUNDOS * 1000);
  });
}

await Promise.all(Array.from({ length: N }, (_, i) => jugador(i + 1)));
const total = resultados.reduce((s, r) => s + r.bytes, 0);
console.log(`Jugadores: ${N} · ${SEGUNDOS}s`);
console.log(`Mensajes por jugador: ${Math.round(resultados[0].mensajes / SEGUNDOS)}/s · KB/s por jugador: ${(total / N / SEGUNDOS / 1024).toFixed(1)}`);
console.log(`Mayor espera entre pasos (ms): ${Math.max(...resultados.map((r) => r.maxGap))}`);
console.log(`Muertes: ${resultados.reduce((s, r) => s + r.muertes, 0)} · Entradas: ${resultados.reduce((s, r) => s + r.entradas, 0)} · Llenos: ${resultados.filter((r) => r.lleno).length} · Errores: ${resultados.reduce((s, r) => s + r.errores, 0)}`);
// Todos deben ver los mismos cuerpos (mismo número de puntos por serpiente)
const a = JSON.stringify(resultados[0].largos.slice().sort());
const iguales = resultados.every((r) => JSON.stringify(r.largos.slice().sort()) === a);
console.log(`Todos ven los mismos cuerpos: ${iguales ? 'sí' : 'NO'}`);
process.exit(0);
