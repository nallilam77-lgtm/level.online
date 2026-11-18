// =========================================================================
// Serpientes Neón · el juego en el navegador.
//
// El servidor (juego-servidor/, Cloudflare) decide todo. Aquí solo se dibuja y se manda hacia dónde
// apunta el jugador. Cada cuerpo se rehace con la cabeza que llega en cada paso y la misma función
// recortar() del servidor, así no hace falta mandar los cuerpos enteros 20 veces por segundo.
// =========================================================================
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const ES_LIGERO = document.documentElement.classList.contains('ligero');
  const TACTIL = window.matchMedia && matchMedia('(pointer: coarse)').matches;

  // En la tienda la página la sirve Vercel; el juego corre en Cloudflare. En local, el mismo servidor.
  const SERVIDOR = /(^|\.)levelupstore\.online$/.test(location.hostname)
    ? 'wss://juego.levelupstore.online/ws'
    : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

  // Igual que juego-servidor/src/partida.js
  function recortar(pts, L) {
    let total = 0;
    for (let i = pts.length - 1; i > 0; i--) {
      total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      if (total >= L) {
        if (i - 1 > 0) pts.splice(0, i - 1);
        return;
      }
    }
  }
  const masaDeLargo = (L) => Math.max(0, (L - 40) / 3);

  // Colores desde las variables de juego.css
  const css = getComputedStyle(document.documentElement);
  const color = (n) => css.getPropertyValue(n).trim();
  const COLORES = Array.from({ length: 12 }, (_, i) => color(`--serp-${i}`));
  const C = {
    fondo: color('--mapa-fondo'), rejilla: color('--mapa-rejilla'), fuera: color('--mapa-fuera'), borde: color('--mapa-borde'),
    nombre: color('--mapa-nombre'), ojo: color('--mapa-ojo'), pupila: color('--mapa-pupila'), contorno: color('--mapa-contorno'),
    brillo: color('--mapa-brillo'), tu: color('--minimapa-tu'), otros: color('--minimapa-otros'),
  };

  // ---------------- Estado ----------------
  let ws = null;
  let R = 2000;
  let TICK = 50;
  let yo = null;                     // id de mi serpiente (null = mirando)
  let jugando = false;
  const serpientes = new Map();      // id → { id, nombre, color, pts, L, r, turbo, ant: [x,y], cab: [x,y] }
  const comida = new Map();          // id → [id, x, y, v10, color]
  let ultimoPaso = performance.now();
  let camara = { x: 0, y: 0, zoom: 1 };
  let apuntar = 0;
  let turbo = false;
  let enviado = { a: null, b: null, cuando: 0 };
  let ping = null;
  let jugadores = 0;
  let maxJugadores = 15;
  let reintento = 0;
  let largoFinal = 0;
  let asesino = null;

  const lienzo = $('lienzo');
  const ctx = lienzo.getContext('2d', { alpha: false });
  const mini = $('minimapa');
  const mctx = mini.getContext('2d');
  let ancho = 0;
  let alto = 0;
  let dpr = 1;

  function medir() {
    dpr = Math.min(window.devicePixelRatio || 1, ES_LIGERO ? 1.5 : 2);
    ancho = window.innerWidth;
    alto = window.innerHeight;
    lienzo.width = Math.round(ancho * dpr);
    lienzo.height = Math.round(alto * dpr);
  }
  window.addEventListener('resize', medir);
  medir();

  // ---------------- Conexión ----------------
  function conectar() {
    $('btnJugar').disabled = true;
    $('btnJugar').textContent = 'Conectando…';
    try { ws = new WebSocket(SERVIDOR); } catch (e) { reconectar(); return; }
    ws.addEventListener('open', () => { reintento = 0; mandar({ t: 'p', k: Math.round(performance.now()) }); });
    ws.addEventListener('message', (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch (err) { return; }
      recibir(m);
    });
    ws.addEventListener('close', () => {
      jugando = false;
      yo = null;
      mostrarInicio('Se perdió la conexión. Reconectando…');
      reconectar();
    });
  }

  function reconectar() {
    const espera = Math.min(10000, 1000 * 2 ** reintento++);
    setTimeout(conectar, espera);
  }

  function mandar(m) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(m));
  }

  function recibir(m) {
    if (m.t === 'i') {
      R = m.R;
      TICK = m.tick || 50;
      serpientes.clear();
      comida.clear();
      m.sn.forEach(nuevaSerpiente);
      m.f.forEach((c) => comida.set(c[0], c));
      ultimoPaso = performance.now();
      $('btnJugar').disabled = false;
      $('btnJugar').textContent = largoFinal ? 'Jugar de nuevo' : 'Jugar';
      if (!jugando) $('avisoInicio').textContent = '';
    } else if (m.t === 'u') {
      aplicar(m);
    } else if (m.t === 'tu') {
      yo = m.id;
      jugando = true;
      asesino = null;
      $('capaInicio').hidden = true;
      $('hudEstado').hidden = false;
      $('btnTurbo').hidden = !TACTIL;
    } else if (m.t === 'lleno') {
      mostrarInicio(`La partida está llena (${m.max} jugadores). Intenta en un momento.`);
    } else if (m.t === 'po') {
      ping = Math.round(performance.now() - m.k);
      jugadores = m.j;
      maxJugadores = m.max;
    }
  }

  function nuevaSerpiente(d) {
    const [id, nombre, col, plano, L, r10, bot] = d;
    const pts = [];
    for (let i = 0; i < plano.length; i += 2) pts.push([plano[i], plano[i + 1]]);
    const cab = pts[pts.length - 1] || [0, 0];
    serpientes.set(id, { id, nombre, color: COLORES[col % COLORES.length], pts, L, r: r10 / 10, turbo: false, bot: !!bot,
      ant: cab.slice(), cab: cab.slice() });
  }

  function aplicar(m) {
    m.j.forEach(nuevaSerpiente);
    m.s.forEach(([id, x, y, L, r10, b]) => {
      const s = serpientes.get(id);
      if (!s) return;
      const ultimo = s.pts[s.pts.length - 1];
      s.ant = s.cab;
      s.cab = [x, y];
      if (!ultimo || ultimo[0] !== x || ultimo[1] !== y) s.pts.push([x, y]);
      s.L = L;
      s.r = r10 / 10;
      s.turbo = b === 1;
      recortar(s.pts, L);
    });
    m.m.forEach(([id, quien]) => {
      const s = serpientes.get(id);
      if (id === yo) morir(s, quien);
      serpientes.delete(id);
    });
    m.n.forEach((c) => comida.set(c[0], c));
    m.e.forEach((id) => comida.delete(id));
    ultimoPaso = performance.now();
  }

  function morir(s, quien) {
    largoFinal = s ? Math.floor(masaDeLargo(s.L)) : 0;
    const k = quien && serpientes.get(quien);
    asesino = k ? k.nombre : null;
    jugando = false;
    yo = null;
    let record = 0;
    try { record = Number(localStorage.getItem('serpientes_record')) || 0; } catch (e) { /* sin almacenamiento */ }
    if (largoFinal > record) {
      record = largoFinal;
      try { localStorage.setItem('serpientes_record', String(record)); } catch (e) { /* sin almacenamiento */ }
    }
    $('resLargo').textContent = largoFinal;
    $('resRecord').textContent = record;
    $('resultado').hidden = false;
    // La cámara se queda un momento donde murió antes de mostrar el panel
    setTimeout(() => mostrarInicio(''), 900);
  }

  function mostrarInicio(aviso) {
    if (jugando) return;
    $('capaInicio').hidden = false;
    $('hudEstado').hidden = true;
    $('btnTurbo').hidden = true;
    turbo = false;
    $('textoInicio').textContent = largoFinal
      ? (asesino ? `Te eliminó ${asesino}.` : 'Chocaste con el borde del mapa.')
      : 'Come las luces para crecer. Si tu cabeza toca a otra serpiente, pierdes. Haz que ellas choquen contigo.';
    $('avisoInicio').textContent = aviso || '';
    $('btnJugar').textContent = ws && ws.readyState === 1 ? (largoFinal ? 'Jugar de nuevo' : 'Jugar') : 'Conectando…';
    $('btnJugar').disabled = !(ws && ws.readyState === 1);
  }

  // ---------------- Controles ----------------
  try { $('nombre').value = localStorage.getItem('serpientes_nombre') || ''; } catch (e) { /* sin almacenamiento */ }

  $('formJugar').addEventListener('submit', (e) => {
    e.preventDefault();
    const nombre = $('nombre').value.trim().slice(0, 14);
    try { localStorage.setItem('serpientes_nombre', nombre); } catch (err) { /* sin almacenamiento */ }
    mandar({ t: 'jugar', n: nombre });
  });

  function apuntarA(x, y) {
    apuntar = Math.atan2(y - alto / 2, x - ancho / 2);
  }
  lienzo.addEventListener('mousemove', (e) => apuntarA(e.clientX, e.clientY));
  lienzo.addEventListener('mousedown', () => { turbo = true; });
  window.addEventListener('mouseup', () => { turbo = false; });
  window.addEventListener('keydown', (e) => { if (e.code === 'Space' && jugando) { turbo = true; e.preventDefault(); } });
  window.addEventListener('keyup', (e) => { if (e.code === 'Space') turbo = false; });
  window.addEventListener('blur', () => { turbo = false; });

  // Táctil: el dedo que toca el mapa dirige; el botón ⚡ acelera
  lienzo.addEventListener('touchstart', tocar, { passive: false });
  lienzo.addEventListener('touchmove', tocar, { passive: false });
  function tocar(e) {
    e.preventDefault();
    const t = e.touches[e.touches.length - 1];
    if (t) apuntarA(t.clientX, t.clientY);
  }
  const btnTurbo = $('btnTurbo');
  const turboSi = (e) => { e.preventDefault(); turbo = true; btnTurbo.classList.add('activo'); };
  const turboNo = (e) => { e.preventDefault(); turbo = false; btnTurbo.classList.remove('activo'); };
  btnTurbo.addEventListener('touchstart', turboSi, { passive: false });
  btnTurbo.addEventListener('touchend', turboNo, { passive: false });
  btnTurbo.addEventListener('touchcancel', turboNo, { passive: false });

  // Se manda solo si cambió (y como mucho 10 veces por segundo): cada mensaje cuenta en Cloudflare
  function enviarControl(ahora) {
    if (!jugando || ahora - enviado.cuando < 100) return;
    const giro = enviado.a === null ? 1 : Math.abs(Math.atan2(Math.sin(apuntar - enviado.a), Math.cos(apuntar - enviado.a)));
    if (giro < 0.05 && turbo === enviado.b) return;
    enviado = { a: apuntar, b: turbo, cuando: ahora };
    mandar({ t: 'd', a: Math.round(apuntar * 100) / 100, b: turbo ? 1 : 0 });
  }

  setInterval(() => mandar({ t: 'p', k: Math.round(performance.now()) }), 5000);

  // ---------------- Dibujo ----------------
  function cabezaSuave(s, alfa) {
    return [s.ant[0] + (s.cab[0] - s.ant[0]) * alfa, s.ant[1] + (s.cab[1] - s.ant[1]) * alfa];
  }

  function dibujar(ahora) {
    const alfa = Math.min(1, (ahora - ultimoPaso) / TICK);
    const mia = yo && serpientes.get(yo);

    // Cámara: sigue mi cabeza; mirando, al más largo. El zoom se aleja al crecer.
    let objetivo = [0, 0];
    let r = 10;
    if (mia) { objetivo = cabezaSuave(mia, alfa); r = mia.r; }
    else {
      let mayor = null;
      for (const s of serpientes.values()) if (!mayor || s.L > mayor.L) mayor = s;
      if (mayor && !largoFinal) objetivo = cabezaSuave(mayor, alfa);
      else objetivo = [camara.x, camara.y];
    }
    const zoomQuiero = (Math.min(ancho, alto) / (900 + r * 22)) * (TACTIL ? 1.15 : 1);
    if (mia) { camara.x = objetivo[0]; camara.y = objetivo[1]; }
    else { camara.x += (objetivo[0] - camara.x) * 0.05; camara.y += (objetivo[1] - camara.y) * 0.05; }
    camara.zoom += (zoomQuiero - camara.zoom) * 0.05;
    const z = camara.zoom;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = C.fuera;
    ctx.fillRect(0, 0, ancho, alto);
    ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * (ancho / 2 - camara.x * z), dpr * (alto / 2 - camara.y * z));

    // Vista en coordenadas del mapa (para no dibujar lo que no se ve)
    const vx0 = camara.x - ancho / 2 / z - 40;
    const vx1 = camara.x + ancho / 2 / z + 40;
    const vy0 = camara.y - alto / 2 / z - 40;
    const vy1 = camara.y + alto / 2 / z + 40;

    // Mapa y rejilla
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, Math.PI * 2);
    ctx.fillStyle = C.fondo;
    ctx.fill();
    ctx.save();
    ctx.clip();
    ctx.strokeStyle = C.rejilla;
    ctx.lineWidth = 2;
    ctx.beginPath();
    const paso = 80;
    for (let x = Math.floor(vx0 / paso) * paso; x < vx1; x += paso) { ctx.moveTo(x, vy0); ctx.lineTo(x, vy1); }
    for (let y = Math.floor(vy0 / paso) * paso; y < vy1; y += paso) { ctx.moveTo(vx0, y); ctx.lineTo(vx1, y); }
    ctx.stroke();
    ctx.restore();
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, Math.PI * 2);
    ctx.strokeStyle = C.borde;
    ctx.lineWidth = 8;
    ctx.stroke();

    // Comida: late un poco
    const latido = 1 + Math.sin(ahora / 300) * 0.12;
    for (const c of comida.values()) {
      if (c[1] < vx0 || c[1] > vx1 || c[2] < vy0 || c[2] > vy1) continue;
      const tam = (3 + Math.sqrt(c[3] / 10) * 3.5) * latido;
      ctx.fillStyle = COLORES[c[4] % COLORES.length];
      ctx.globalAlpha = 0.25;
      ctx.beginPath();
      ctx.arc(c[1], c[2], tam * 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(c[1], c[2], tam, 0, Math.PI * 2);
      ctx.fill();
    }

    // Serpientes: las más chicas abajo; la mía siempre encima
    const lista = [...serpientes.values()].sort((a, b) => (a.id === yo) - (b.id === yo) || a.L - b.L);
    for (const s of lista) dibujarSerpiente(s, alfa, vx0, vx1, vy0, vy1);

    dibujarMinimapa(mia);
  }

  function dibujarSerpiente(s, alfa, vx0, vx1, vy0, vy1) {
    const n = s.pts.length;
    if (!n) return;
    const cab = cabezaSuave(s, alfa);
    // ¿Se ve algún pedazo?
    let visible = false;
    for (let i = 0; i < n; i += 4) {
      const p = s.pts[i];
      if (p[0] > vx0 - s.r && p[0] < vx1 + s.r && p[1] > vy0 - s.r && p[1] < vy1 + s.r) { visible = true; break; }
    }
    if (!visible && !(cab[0] > vx0 && cab[0] < vx1 && cab[1] > vy0 && cab[1] < vy1)) return;

    const camino = () => {
      ctx.beginPath();
      ctx.moveTo(s.pts[0][0], s.pts[0][1]);
      for (let i = 1; i < n - 1; i++) ctx.lineTo(s.pts[i][0], s.pts[i][1]);
      ctx.lineTo(cab[0], cab[1]);
    };
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (s.turbo && !ES_LIGERO) { ctx.shadowColor = s.color; ctx.shadowBlur = 25; }
    camino();
    ctx.strokeStyle = C.contorno;
    ctx.lineWidth = s.r * 2 + 4;
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.r * 2;
    ctx.stroke();
    // Brillo a lo largo del lomo
    ctx.strokeStyle = C.brillo;
    ctx.lineWidth = s.r * 0.7;
    ctx.stroke();

    // Ojos mirando hacia donde va
    const ang = Math.atan2(s.cab[1] - s.ant[1], s.cab[0] - s.ant[0]) || 0;
    const dirOjo = s.id === yo ? apuntar : ang;
    for (const lado of [-1, 1]) {
      const ox = cab[0] + Math.cos(ang + lado * 0.7) * s.r * 0.55;
      const oy = cab[1] + Math.sin(ang + lado * 0.7) * s.r * 0.55;
      ctx.fillStyle = C.ojo;
      ctx.beginPath();
      ctx.arc(ox, oy, s.r * 0.36, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = C.pupila;
      ctx.beginPath();
      ctx.arc(ox + Math.cos(dirOjo) * s.r * 0.14, oy + Math.sin(dirOjo) * s.r * 0.14, s.r * 0.18, 0, Math.PI * 2);
      ctx.fill();
    }

    // Nombre
    ctx.fillStyle = C.nombre;
    ctx.font = `800 ${Math.max(12 / camara.zoom, s.r * 0.9)}px Montserrat, sans-serif`;   // al menos 12 px en pantalla
    ctx.textAlign = 'center';
    ctx.fillText(s.nombre, cab[0], cab[1] - s.r - 10);
  }

  function dibujarMinimapa(mia) {
    const w = mini.width;
    const k = (w / 2 - 4) / R;
    mctx.clearRect(0, 0, w, w);
    mctx.strokeStyle = C.borde;
    mctx.globalAlpha = 0.5;
    mctx.lineWidth = 1;
    mctx.beginPath();
    mctx.arc(w / 2, w / 2, w / 2 - 3, 0, Math.PI * 2);
    mctx.stroke();
    mctx.globalAlpha = 1;
    for (const s of serpientes.values()) {
      const grande = s === mia;
      mctx.fillStyle = grande ? C.tu : C.otros;
      mctx.beginPath();
      mctx.arc(w / 2 + s.cab[0] * k, w / 2 + s.cab[1] * k, grande ? 4 : 2, 0, Math.PI * 2);
      mctx.fill();
    }
  }

  // ---------------- Marcadores (4 veces por segundo, no en cada cuadro) ----------------
  function marcadores() {
    const lista = [...serpientes.values()].sort((a, b) => b.L - a.L);
    const ol = $('tabla');
    const filas = lista.slice(0, 10).map((s) => {
      const li = document.createElement('li');
      if (s.id === yo) li.className = 'yo';
      const nombre = document.createElement('span');
      nombre.textContent = s.nombre;
      const largo = document.createElement('b');
      largo.textContent = Math.floor(masaDeLargo(s.L));
      li.append(nombre, largo);
      return li;
    });
    ol.replaceChildren(...filas);
    $('hudJugadores').textContent = jugadores ? `· ${jugadores}/${maxJugadores} en línea` : '';
    const mia = yo && serpientes.get(yo);
    if (mia) {
      $('hudLargo').textContent = Math.floor(masaDeLargo(mia.L));
      $('hudPuesto').textContent = `${lista.indexOf(mia) + 1}/${lista.length}`;
    }
    $('hudPing').textContent = ping === null ? '… ms' : `${ping} ms`;
  }
  setInterval(marcadores, 250);

  function cuadro(ahora) {
    enviarControl(ahora);
    dibujar(ahora);
    requestAnimationFrame(cuadro);
  }

  conectar();
  requestAnimationFrame(cuadro);
})();
