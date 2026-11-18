// Prueba de carga: conecta N jugadores que se anotan, se mueven, apuntan y disparan al azar. Revisa que el
// servidor aguante, cuánto pesa cada mensaje y que la partida termine y vuelva a empezar.
// Uso: node prueba/jugadores.mjs [url] [jugadores] [segundos]
//      node prueba/jugadores.mjs ws://127.0.0.1:8787/ws?espera=3 15 60      (con `npm run dev`)

const URL_WS = process.argv[2] || 'ws://127.0.0.1:8787/ws?espera=3';
const N = Number(process.argv[3]) || 15;
const SEGUNDOS = Number(process.argv[4]) || 60;

const resultados = [];
const estados = new Set();
let partidas = 0;
let ganadores = [];

function jugador(n) {
  return new Promise((listo) => {
    const ws = new WebSocket(URL_WS);
    const r = { n, mensajes: 0, bytes: 0, maxBytes: 0, enviados: 0, maxGap: 0, errores: 0, muertes: 0, bajas: 0, yo: null, vivo: false };
    let ultimo = 0;
    const anotarse = () => { ws.send(JSON.stringify({ t: 'jugar', n: 'Prueba' + n })); r.enviados++; };
    ws.onmessage = (e) => {
      r.mensajes++;
      r.bytes += e.data.length;
      r.maxBytes = Math.max(r.maxBytes, e.data.length);
      const m = JSON.parse(e.data);
      const ahora = Date.now();
      if (m.t === 'u') { if (ultimo) r.maxGap = Math.max(r.maxGap, ahora - ultimo); ultimo = ahora; }
      if (m.t === 'i') anotarse();
      else if (m.t === 'yo') r.yo = m.id;
      else if (m.t === 'u') {
        if (m.ini) {
          r.vivo = m.ini.jugadores.some((j) => j[0] === r.yo);
          if (n === 1) partidas++;
        }
        if (m.k) m.k.forEach(([a, v]) => {
          if (v === r.yo) { r.muertes++; r.vivo = false; setTimeout(anotarse, 1000); }
          if (a === r.yo) r.bajas++;
        });
        if (m.e) {
          estados.add(m.e.s);
          if (n === 1 && m.e.s === 'fin' && m.e.g && !ganadores.includes(m.e.g.nombre + '#' + partidas)) ganadores.push(m.e.g.nombre + '#' + partidas);
          if (m.e.s === 'fin' && r.vivo) { r.vivo = false; setTimeout(anotarse, 500); }
        }
      }
    };
    let ang = Math.random() * 6.28;
    const control = setInterval(() => {
      if (ws.readyState !== 1 || !r.vivo) return;
      ang += (Math.random() - 0.5) * 1.5;
      ws.send(JSON.stringify({ t: 'd', x: Math.round(Math.cos(ang) * 100) / 100, y: Math.round(Math.sin(ang) * 100) / 100, a: Math.round(ang * 100) / 100, f: Math.random() < 0.6 ? 1 : 0 }));
      r.enviados++;
      if (Math.random() < 0.05) { ws.send(JSON.stringify({ t: 'c' })); r.enviados++; }
    }, 120);
    ws.onerror = () => { r.errores++; };
    setTimeout(() => {
      clearInterval(control);
      ws.close();
      resultados.push(r);
      listo();
    }, SEGUNDOS * 1000);
  });
}

await Promise.all(Array.from({ length: N }, (_, i) => jugador(i + 1)));
const total = resultados.reduce((s, r) => s + r.bytes, 0);
const enviados = resultados.reduce((s, r) => s + r.enviados, 0);
console.log(`Jugadores: ${N} · ${SEGUNDOS}s`);
console.log(`Recibe por jugador: ${(total / N / SEGUNDOS / 1024).toFixed(1)} KB/s · mensaje más grande: ${Math.max(...resultados.map((r) => r.maxBytes))} B`);
console.log(`Manda por jugador: ${(enviados / N / SEGUNDOS).toFixed(1)} mensajes/s`);
console.log(`Mayor espera entre pasos (ms): ${Math.max(...resultados.map((r) => r.maxGap))}`);
console.log(`Partidas empezadas: ${partidas} · ganadores: ${ganadores.join(', ') || '-'} · estados vistos: ${[...estados].join(', ')}`);
console.log(`Muertes: ${resultados.reduce((s, r) => s + r.muertes, 0)} · bajas hechas: ${resultados.reduce((s, r) => s + r.bajas, 0)} · errores: ${resultados.reduce((s, r) => s + r.errores, 0)}`);
process.exit(0);
