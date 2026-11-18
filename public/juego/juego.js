// =========================================================================
// Último en Pie · el juego en el navegador.
//
// El servidor (juego-servidor/, Cloudflare) decide todo: impactos, vida, zona y ganador. Aquí se dibuja
// y se manda hacia dónde se mueve, apunta y si dispara. El propio jugador se mueve al instante (predicción)
// y se va corrigiendo con lo que dice el servidor; a los demás se les suaviza el movimiento.
// =========================================================================
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const ES_LIGERO = document.documentElement.classList.contains('ligero');
  const TACTIL = window.matchMedia && matchMedia('(pointer: coarse)').matches;

  // En la tienda la página la sirve Vercel; el juego corre en Cloudflare. En local, el mismo servidor.
  const SERVIDOR = /(^|\.)levelupstore\.online$/.test(location.hostname)
    ? 'wss://juego.levelupstore.online/ws'
    : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws${location.search}`;   // en local, ?espera=3 acorta la espera

  // Igual que juego-servidor/src/partida.js
  let L = 2400;
  let R = 22;
  let TICK = 50;
  const VEL = 11;
  const ARMAS = [
    { nombre: 'Pistola', corto: 'PIS', canon: 14 },
    { nombre: 'Subfusil', corto: 'SMG', canon: 18 },
    { nombre: 'Escopeta', corto: 'ESC', canon: 20 },
    { nombre: 'Rifle', corto: 'RIF', canon: 24 },
    { nombre: 'Francotirador', corto: 'FRT', canon: 32 },
  ];
  const BOTIQUIN = 10;
  const CHALECO = 11;
  function empujarFuera(o, cajas) {
    for (const [x, y, w, h] of cajas) {
      const cx = Math.max(x, Math.min(o.x, x + w));
      const cy = Math.max(y, Math.min(o.y, y + h));
      const dx = o.x - cx;
      const dy = o.y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 >= R * R) continue;
      if (d2 === 0) {
        const lados = [o.x - x, x + w - o.x, o.y - y, y + h - o.y];
        const m = Math.min(...lados);
        if (m === lados[0]) o.x = x - R; else if (m === lados[1]) o.x = x + w + R;
        else if (m === lados[2]) o.y = y - R; else o.y = y + h + R;
      } else {
        const d = Math.sqrt(d2);
        o.x = cx + (dx / d) * R;
        o.y = cy + (dy / d) * R;
      }
    }
    o.x = Math.max(R, Math.min(L - R, o.x));
    o.y = Math.max(R, Math.min(L - R, o.y));
  }
  function mover(o, mx, my, cajas, factor) {
    const l = Math.hypot(mx, my);
    if (l > 1) { mx /= l; my /= l; }
    o.x += mx * VEL * factor;
    o.y += my * VEL * factor;
    empujarFuera(o, cajas);
  }
  const dentroDeCaja = (x, y) => cajas.some(([cx, cy, w, h]) => x >= cx && x <= cx + w && y >= cy && y <= cy + h);

  // Colores desde las variables de juego.css
  const css = getComputedStyle(document.documentElement);
  const v = (n) => css.getPropertyValue(n).trim();
  const COLORES = Array.from({ length: 12 }, (_, i) => v(`--color-${i}`));
  const C = {};
  ['mapa-fuera', 'mapa-suelo', 'mapa-rejilla', 'mapa-caja', 'mapa-caja-borde', 'mapa-caja-luz', 'zona-fuera', 'zona-borde',
    'zona-objetivo', 'mapa-nombre', 'mapa-contorno', 'mapa-canon', 'mapa-bala', 'mapa-impacto', 'mapa-vida', 'mapa-vida-fondo',
    'mapa-escudo', 'item-arma', 'item-botiquin', 'item-chaleco', 'item-texto', 'palanca', 'palanca-borde', 'minimapa-tu',
    'minimapa-otros'].forEach((k) => { C[k.replace(/-(\w)/g, (_, l) => l.toUpperCase())] = v(`--${k}`); });

  // ---------------- Estado ----------------
  let ws = null;
  let reintento = 0;
  let yo = null;                      // mi id en la sala (se da al tocar "Jugar")
  let anotado = false;                // pedí entrar a la próxima partida
  let estado = { s: 'espera', t: null, n: 0, c: 0, v: 0, g: null, max: 15 };
  let cajas = [];
  const items = new Map();            // id → [id, x, y, tipo]
  const jugadores = new Map();        // id → { id, nombre, color, bot, vivo, bajas, x, y, a, vida, escudo, arma, ant, cab }
  const balas = new Map();            // id → { x, y, dx, dy, vel, alcance, t0 }
  const destellos = [];               // impactos: { x, y, t0 }
  const golpes = new Map();           // id del jugador golpeado → hora
  let zona = null;                    // [cx, cy, r, tx, ty, tr, segundos, cerrando, daño]
  let zonaAnt = null;
  let ultimoPaso = performance.now();
  let ping = 80;
  let enPartida = false;              // estoy vivo en la partida en curso
  let resultado = null;               // cómo me fue: { puesto, bajas, asesino, arma }
  const feed = [];                    // últimas bajas: { texto, mia, t0 }

  // Predicción del propio jugador
  const pred = { x: 0, y: 0, lista: false };
  const historia = [];                // { t, x, y }

  // Controles
  const teclas = new Set();
  let apuntar = 0;
  let disparando = false;
  let enviado = { x: null, y: null, a: null, f: null, cuando: 0 };
  const palancas = { mover: null, apuntar: null };   // { id, ox, oy, x, y }

  const lienzo = $('lienzo');
  const ctx = lienzo.getContext('2d', { alpha: false });
  const mini = $('minimapa');
  const mctx = mini.getContext('2d');
  let ancho = 0;
  let alto = 0;
  let dpr = 1;
  const camara = { x: 1200, y: 1200, zoom: 0.6 };

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
    pintarPanel();
    try { ws = new WebSocket(SERVIDOR); } catch (e) { reconectar(); return; }
    ws.addEventListener('open', () => { reintento = 0; });
    ws.addEventListener('message', (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch (err) { return; }
      recibir(m);
    });
    ws.addEventListener('close', () => {
      yo = null;
      anotado = false;
      enPartida = false;
      $('avisoPanel').textContent = 'Se perdió la conexión. Reconectando…';
      pintarPanel();
      reconectar();
    });
  }
  function reconectar() { setTimeout(conectar, Math.min(10000, 1000 * 2 ** reintento++)); }
  function mandar(m) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); }

  function recibir(m) {
    if (m.t === 'i') {
      L = m.L; R = m.R; TICK = m.tick || 50;
      estado = m.e;
      if (m.mapa) cargarMapa(m.mapa);
      if (m.p) actualizarJugadores(m.p);
      zona = m.z;
      zonaAnt = m.z;
      $('avisoPanel').textContent = '';
      pintarPanel();
    } else if (m.t === 'u') {
      aplicar(m);
    } else if (m.t === 'yo') {
      yo = m.id;
    } else if (m.t === 'po') {
      ping = Math.max(1, Math.round(performance.now() - m.k));
    }
  }

  function cargarMapa(d) {
    cajas = d.cajas;
    items.clear();
    d.items.forEach((it) => items.set(it[0], it));
    jugadores.clear();
    balas.clear();
    d.jugadores.forEach(([id, nombre, col, bot, vivo, bajas]) => {
      jugadores.set(id, { id, nombre, color: COLORES[col % COLORES.length], bot: !!bot, vivo: !!vivo, bajas, x: 0, y: 0, a: 0,
        vida: 100, escudo: 0, arma: 0, ant: null, cab: null });
    });
  }

  function actualizarJugadores(lista) {
    for (const [id, x, y, a100, vida, escudo, arma] of lista) {
      const j = jugadores.get(id);
      if (!j) continue;
      j.ant = j.cab || [x, y];
      j.cab = [x, y];
      j.x = x; j.y = y;
      j.a = a100 / 100;
      if (vida < j.vida) golpes.set(id, performance.now());
      j.vida = vida; j.escudo = escudo; j.arma = arma;
      if (id === yo) corregirPrediccion(x, y);
    }
  }

  function corregirPrediccion(x, y) {
    if (!pred.lista) { pred.x = x; pred.y = y; pred.lista = true; historia.length = 0; return; }
    // El servidor va "atrasado" un viaje de ida y vuelta: se compara con dónde estaba yo en ese momento
    const cuando = performance.now() - ping - TICK / 2;
    let h = historia[0];
    for (const e of historia) { if (e.t <= cuando) h = e; else break; }
    if (!h) { pred.x = x; pred.y = y; return; }
    const ex = x - h.x;
    const ey = y - h.y;
    if (Math.hypot(ex, ey) > 120) { pred.x = x; pred.y = y; historia.length = 0; return; }
    pred.x += ex * 0.15;
    pred.y += ey * 0.15;
    for (const e of historia) { e.x += ex * 0.15; e.y += ey * 0.15; }
  }

  function aplicar(m) {
    const ahora = performance.now();
    if (m.ini) {
      cargarMapa(m.ini);
      pred.lista = false;
      resultado = null;
      feed.length = 0;
      if (yo && jugadores.has(yo)) { anotado = false; enPartida = true; }
      else enPartida = false;
    }
    if (m.p) actualizarJugadores(m.p);
    if (m.z) { zonaAnt = zona; zona = m.z; }
    if (m.b) m.b.forEach(([id, x, y, a1000, vel, alcance]) => {
      const a = a1000 / 1000;
      balas.set(id, { x, y, dx: Math.cos(a), dy: Math.sin(a), vel, alcance, t0: ahora });
    });
    if (m.x) m.x.forEach(([id, quien]) => {
      const b = balas.get(id);
      if (b) {
        const recorrido = Math.min(b.alcance, b.vel * (ahora - b.t0) / TICK);
        if (quien) destellos.push({ x: b.x + b.dx * recorrido, y: b.y + b.dy * recorrido, t0: ahora });
        balas.delete(id);
      }
    });
    if (m.ia) m.ia.forEach((it) => items.set(it[0], it));
    if (m.ir) m.ir.forEach((id) => items.delete(id));
    if (m.k) m.k.forEach(([asesinoId, victimaId, arma]) => baja(asesinoId, victimaId, arma));
    if (m.e) {
      const antes = estado.s;
      estado = m.e;
      if (antes !== 'espera' && estado.s === 'espera') { jugadores.clear(); items.clear(); cajas = []; balas.clear(); zona = null; enPartida = false; }
      pintarPanel();
    }
    ultimoPaso = ahora;
  }

  function baja(asesinoId, victimaId, arma) {
    const v = jugadores.get(victimaId);
    const a = jugadores.get(asesinoId);
    if (v) v.vivo = false;
    if (a && a !== v) a.bajas++;
    let texto;
    if (arma === -1) texto = `<b>${esc(v ? v.nombre : '?')}</b> se desconectó`;
    else if (arma === -2 || !a) texto = `La zona eliminó a <b>${esc(v ? v.nombre : '?')}</b>`;
    else texto = `<b>${esc(a.nombre)}</b> → <b>${esc(v ? v.nombre : '?')}</b> · ${ARMAS[arma] ? ARMAS[arma].nombre : ''}`;
    feed.unshift({ texto, mia: victimaId === yo || asesinoId === yo, t0: performance.now() });
    feed.length = Math.min(feed.length, 5);
    if (victimaId === yo) {
      enPartida = false;
      const vivos = [...jugadores.values()].filter((j) => j.vivo).length;
      resultado = { puesto: vivos + 1, bajas: v ? v.bajas : 0, asesino: a && a !== v ? a.nombre : null, arma, zona: arma === -2 };
      setTimeout(pintarPanel, 700);
    }
  }

  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---------------- Paneles ----------------
  const conectado = () => ws && ws.readyState === 1;

  function pintarPanel() {
    const capa = $('capa');
    const btn = $('btnJugar');
    const titulo = $('panelTitulo');
    const texto = $('panelTexto');
    const res = $('resultado');
    const mostrar = (cosas) => {
      $('campoNombre').hidden = !cosas.nombre;
      $('controles').hidden = !cosas.controles;
      res.hidden = !cosas.resultado;
      btn.hidden = !cosas.boton;
    };
    $('hudEstado').hidden = !enPartida && estado.s !== 'partida';
    $('hudVida').hidden = !enPartida;
    if (enPartida) { capa.hidden = true; return; }
    capa.hidden = false;
    capa.classList.toggle('capa--mirar', estado.s === 'partida' || estado.s === 'fin');
    btn.disabled = !conectado();

    if (!conectado()) {
      titulo.innerHTML = 'Último <span>en Pie</span>';
      texto.textContent = 'Conectando con la partida…';
      btn.textContent = 'Conectando…';
      mostrar({ nombre: true, controles: true, boton: true });
      return;
    }
    if (estado.s === 'fin' && estado.g) {
      const gane = estado.g.id === yo;
      titulo.innerHTML = gane ? '¡Último <span>en Pie!</span>' : 'Fin de la <span>partida</span>';
      texto.innerHTML = gane ? `Ganaste con <strong>${estado.g.bajas}</strong> bajas.` : `Ganó <strong>${esc(estado.g.nombre)}</strong> con ${estado.g.bajas} bajas.`;
      if (gane) resultado = { puesto: 1, bajas: estado.g.bajas };
    } else if (resultado) {
      titulo.innerHTML = resultado.puesto === 1 ? '¡Último <span>en Pie!</span>' : 'Te <span>eliminaron</span>';
      texto.innerHTML = resultado.zona ? 'Te quedaste fuera de la zona.'
        : resultado.asesino ? `Te eliminó <strong>${esc(resultado.asesino)}</strong>${ARMAS[resultado.arma] ? ' con ' + ARMAS[resultado.arma].nombre : ''}.` : 'Quedaste fuera.';
    } else if (anotado) {
      titulo.innerHTML = 'Ya estás <span>anotado</span>';
    } else {
      titulo.innerHTML = 'Último <span>en Pie</span>';
      texto.textContent = 'Caes con una pistola. Recoge armas, botiquines y chalecos, escóndete detrás de las cajas y no te quedes fuera de la zona. El último vivo gana.';
    }
    if (resultado) {
      $('resPuesto').textContent = `#${resultado.puesto}`;
      $('resBajas').textContent = resultado.bajas;
    }

    // Debajo: qué pasa con la próxima partida
    let espera = '';
    if (estado.s === 'espera') espera = estado.t ? `La partida empieza en <strong>${estado.t} s</strong>. ${estado.n} de ${estado.max} anotados; si faltan, entran bots.` : 'Esperando jugadores…';
    else if (estado.s === 'partida') espera = `Partida en curso: <strong>${estado.v} vivos</strong>. Entras en la siguiente.`;
    else espera = 'La siguiente partida se arma en unos segundos.';

    if (anotado) {
      if (!resultado && !(estado.s === 'fin' && estado.g)) texto.innerHTML = espera;
      else texto.innerHTML += `<br>${espera}`;
      mostrar({ resultado: !!resultado, boton: false });
    } else {
      btn.textContent = resultado || estado.s === 'fin' ? 'Siguiente partida' : 'Jugar';
      if (!resultado && estado.s !== 'fin' && estado.s !== 'espera') texto.innerHTML += `<br><br>${espera}`;
      mostrar({ nombre: !resultado && estado.s !== 'fin', controles: !resultado && estado.s !== 'partida' && estado.s !== 'fin', resultado: !!resultado, boton: true });
    }
  }

  // ---------------- Controles ----------------
  try { $('nombre').value = localStorage.getItem('ultimo_nombre') || ''; } catch (e) { /* sin almacenamiento */ }

  $('formJugar').addEventListener('submit', (e) => {
    e.preventDefault();
    const nombre = $('nombre').value.trim().slice(0, 14);
    try { localStorage.setItem('ultimo_nombre', nombre); } catch (err) { /* sin almacenamiento */ }
    mandar({ t: 'jugar', n: nombre });
    anotado = true;
    resultado = null;
    pintarPanel();
  });

  const MOVER = { KeyW: [0, -1], ArrowUp: [0, -1], KeyS: [0, 1], ArrowDown: [0, 1], KeyA: [-1, 0], ArrowLeft: [-1, 0], KeyD: [1, 0], ArrowRight: [1, 0] };
  window.addEventListener('keydown', (e) => {
    if (e.target && e.target.tagName === 'INPUT') return;
    if (MOVER[e.code]) { teclas.add(e.code); e.preventDefault(); }
    if (e.code === 'KeyE' && enPartida) mandar({ t: 'c' });
  });
  window.addEventListener('keyup', (e) => teclas.delete(e.code));
  window.addEventListener('blur', () => { teclas.clear(); disparando = false; });

  function apuntarA(x, y) { apuntar = Math.atan2(y - alto / 2, x - ancho / 2); }
  lienzo.addEventListener('mousemove', (e) => apuntarA(e.clientX, e.clientY));
  lienzo.addEventListener('mousedown', (e) => { apuntarA(e.clientX, e.clientY); disparando = true; });
  window.addEventListener('mouseup', () => { disparando = false; });
  lienzo.addEventListener('contextmenu', (e) => e.preventDefault());

  // Celular: dos palancas. Mitad izquierda = moverse; mitad derecha = apuntar y disparar.
  const ZONA_MUERTA = 14;
  const RADIO_PALANCA = 56;
  lienzo.addEventListener('touchstart', (e) => {
    e.preventDefault();
    for (const t of e.changedTouches) {
      const lado = t.clientX < ancho / 2 ? 'mover' : 'apuntar';
      if (!palancas[lado]) palancas[lado] = { id: t.identifier, ox: t.clientX, oy: t.clientY, x: t.clientX, y: t.clientY };
    }
  }, { passive: false });
  lienzo.addEventListener('touchmove', (e) => {
    e.preventDefault();
    for (const t of e.changedTouches) {
      for (const p of Object.values(palancas)) if (p && p.id === t.identifier) { p.x = t.clientX; p.y = t.clientY; }
    }
  }, { passive: false });
  const soltar = (e) => {
    for (const t of e.changedTouches) {
      for (const k of Object.keys(palancas)) if (palancas[k] && palancas[k].id === t.identifier) palancas[k] = null;
    }
  };
  lienzo.addEventListener('touchend', soltar);
  lienzo.addEventListener('touchcancel', soltar);

  $('btnCambiar').addEventListener('click', () => mandar({ t: 'c' }));

  function leerControles() {
    let mx = 0;
    let my = 0;
    for (const k of teclas) { mx += MOVER[k][0]; my += MOVER[k][1]; }
    const pm = palancas.mover;
    if (pm) {
      const dx = pm.x - pm.ox;
      const dy = pm.y - pm.oy;
      const d = Math.hypot(dx, dy);
      if (d > ZONA_MUERTA) { const k = Math.min(1, d / RADIO_PALANCA) / d; mx = dx * k; my = dy * k; }
    }
    const pa = palancas.apuntar;
    let f = disparando;
    if (TACTIL) {
      f = false;
      if (pa) {
        const dx = pa.x - pa.ox;
        const dy = pa.y - pa.oy;
        if (Math.hypot(dx, dy) > ZONA_MUERTA) { apuntar = Math.atan2(dy, dx); f = true; }
      }
    }
    return { mx: Math.round(mx * 100) / 100, my: Math.round(my * 100) / 100, f };
  }

  // Se manda solo si cambió (como mucho 10 veces por segundo): cada mensaje cuenta en Cloudflare
  function enviarControl(ahora, c) {
    if (!enPartida) return;
    const cambioDisparo = c.f !== enviado.f;
    if (ahora - enviado.cuando < (cambioDisparo ? 50 : 100)) return;
    const giro = enviado.a === null ? 1 : Math.abs(Math.atan2(Math.sin(apuntar - enviado.a), Math.cos(apuntar - enviado.a)));
    if (!cambioDisparo && c.mx === enviado.x && c.my === enviado.y && giro < 0.04) return;
    enviado = { x: c.mx, y: c.my, a: apuntar, f: c.f, cuando: ahora };
    mandar({ t: 'd', x: c.mx, y: c.my, a: Math.round(apuntar * 100) / 100, f: c.f ? 1 : 0 });
  }

  setInterval(() => mandar({ t: 'p', k: Math.round(performance.now()) }), 3000);

  // ---------------- Dibujo ----------------
  function posicion(j, alfa) {
    if (j.id === yo && enPartida && pred.lista) return [pred.x, pred.y];
    if (!j.cab) return [j.x, j.y];
    return [j.ant[0] + (j.cab[0] - j.ant[0]) * alfa, j.ant[1] + (j.cab[1] - j.ant[1]) * alfa];
  }

  function zonaAhora(alfa) {
    if (!zona) return null;
    if (!zonaAnt) return zona;
    const k = Math.min(1, alfa / 2);   // llega cada 2 pasos
    return [0, 1, 2].map((i) => zonaAnt[i] + (zona[i] - zonaAnt[i]) * k);
  }

  let anteriorCuadro = performance.now();
  function cuadro(ahora) {
    const dt = Math.min(100, ahora - anteriorCuadro);
    anteriorCuadro = ahora;
    const c = leerControles();
    // Predicción: mi jugador se mueve ya, sin esperar al servidor
    if (enPartida && pred.lista) {
      mover(pred, c.mx, c.my, cajas, dt / TICK);
      historia.push({ t: ahora, x: pred.x, y: pred.y });
      while (historia.length && historia[0].t < ahora - 1000) historia.shift();
    }
    enviarControl(ahora, c);
    dibujar(ahora);
    requestAnimationFrame(cuadro);
  }

  function dibujar(ahora) {
    const alfa = Math.min(1, (ahora - ultimoPaso) / TICK);
    const mio = yo && jugadores.get(yo);

    // Cámara: sobre mí; si no juego, sobre quien me eliminó o el más cercano vivo
    let foco = null;
    if (mio && enPartida) foco = posicion(mio, alfa);
    else {
      const vivos = [...jugadores.values()].filter((j) => j.vivo && j.cab);
      if (vivos.length) {
        let mejor = vivos[0];
        let dm = Infinity;
        for (const j of vivos) { const d = Math.hypot(j.x - camara.x, j.y - camara.y); if (d < dm) { dm = d; mejor = j; } }
        foco = posicion(mejor, alfa);
      } else foco = [L / 2, L / 2];
    }
    if (mio && enPartida) { camara.x = foco[0]; camara.y = foco[1]; }
    else { camara.x += (foco[0] - camara.x) * 0.06; camara.y += (foco[1] - camara.y) * 0.06; }
    const zoomQuiero = estado.s === 'espera' && !cajas.length ? Math.min(ancho, alto) / L : Math.min(ancho, alto) / (TACTIL ? 760 : 1000);
    camara.zoom += (zoomQuiero - camara.zoom) * 0.08;
    const z = camara.zoom;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = C.mapaFuera;
    ctx.fillRect(0, 0, ancho, alto);
    ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * (ancho / 2 - camara.x * z), dpr * (alto / 2 - camara.y * z));
    const vx0 = camara.x - ancho / 2 / z - 60;
    const vx1 = camara.x + ancho / 2 / z + 60;
    const vy0 = camara.y - alto / 2 / z - 60;
    const vy1 = camara.y + alto / 2 / z + 60;
    const seVe = (x, y, m = 0) => x > vx0 - m && x < vx1 + m && y > vy0 - m && y < vy1 + m;

    // Suelo y rejilla
    ctx.fillStyle = C.mapaSuelo;
    ctx.fillRect(0, 0, L, L);
    ctx.strokeStyle = C.mapaRejilla;
    ctx.lineWidth = 2;
    ctx.beginPath();
    const paso = 100;
    for (let x = Math.max(0, Math.floor(vx0 / paso) * paso); x <= Math.min(L, vx1); x += paso) { ctx.moveTo(x, Math.max(0, vy0)); ctx.lineTo(x, Math.min(L, vy1)); }
    for (let y = Math.max(0, Math.floor(vy0 / paso) * paso); y <= Math.min(L, vy1); y += paso) { ctx.moveTo(Math.max(0, vx0), y); ctx.lineTo(Math.min(L, vx1), y); }
    ctx.stroke();

    // Botín en el piso
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const [, x, y, tipo] of items.values()) {
      if (!seVe(x, y, 30)) continue;
      if (tipo <= 4) {
        ctx.fillStyle = C.itemArma;
        redondo(x - 22, y - 13, 44, 26, 7);
        ctx.fill();
        ctx.fillStyle = C.itemTexto;
        ctx.font = '900 13px Montserrat, sans-serif';
        ctx.fillText(ARMAS[tipo].corto, x, y + 1);
      } else {
        ctx.fillStyle = tipo === BOTIQUIN ? C.itemBotiquin : C.itemChaleco;
        ctx.beginPath();
        ctx.arc(x, y, 15, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = C.itemTexto;
        ctx.font = '900 16px Montserrat, sans-serif';
        ctx.fillText(tipo === BOTIQUIN ? '+' : 'E', x, y + 1);
      }
    }

    // Cajas (cubren de las balas)
    for (const [x, y, w, h] of cajas) {
      if (x > vx1 || x + w < vx0 || y > vy1 || y + h < vy0) continue;
      ctx.fillStyle = C.mapaCaja;
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = C.mapaCajaBorde;
      ctx.lineWidth = 4;
      ctx.strokeRect(x + 2, y + 2, w - 4, h - 4);
      ctx.strokeStyle = C.mapaCajaLuz;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x + 4, y + 4);
      ctx.lineTo(x + w - 4, y + 4);
      ctx.stroke();
    }

    // Jugadores
    for (const j of jugadores.values()) {
      if (!j.vivo || !j.cab) continue;
      const [x, y] = posicion(j, alfa);
      if (!seVe(x, y, 60)) continue;
      const a = j.id === yo && enPartida ? apuntar : j.a;
      // Cañón
      ctx.strokeStyle = C.mapaCanon;
      ctx.lineWidth = j.arma === 2 ? 11 : 8;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(a) * (R + ARMAS[j.arma].canon), y + Math.sin(a) * (R + ARMAS[j.arma].canon));
      ctx.stroke();
      // Cuerpo
      ctx.fillStyle = j.color;
      ctx.beginPath();
      ctx.arc(x, y, R, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = j.escudo > 0 ? C.mapaEscudo : C.mapaContorno;
      ctx.lineWidth = j.escudo > 0 ? 5 : 4;
      ctx.stroke();
      const golpe = golpes.get(j.id);
      if (golpe && ahora - golpe < 150) {
        ctx.strokeStyle = C.mapaImpacto;
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.arc(x, y, R + 4, 0, Math.PI * 2);
        ctx.stroke();
      }
      // Nombre y vida (la mía va abajo en la pantalla)
      if (j.id !== yo || !enPartida) {
        const tam = Math.max(12 / z, 13);
        ctx.font = `800 ${tam}px Montserrat, sans-serif`;
        ctx.fillStyle = C.mapaNombre;
        ctx.fillText(j.nombre, x, y - R - 12 - tam * 0.6);
        ctx.fillStyle = C.mapaVidaFondo;
        ctx.fillRect(x - 24, y - R - 12, 48, 6);
        ctx.fillStyle = C.mapaVida;
        ctx.fillRect(x - 24, y - R - 12, 48 * j.vida / 100, 6);
      }
    }

    // Balas
    ctx.strokeStyle = C.mapaBala;
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (const [id, b] of balas) {
      const recorrido = b.vel * (ahora - b.t0) / TICK;
      if (recorrido > b.alcance) { balas.delete(id); continue; }
      const x = b.x + b.dx * recorrido;
      const y = b.y + b.dy * recorrido;
      if (dentroDeCaja(x, y)) { balas.delete(id); continue; }
      if (!seVe(x, y)) continue;
      const cola = Math.min(recorrido, 22);
      ctx.moveTo(x - b.dx * cola, y - b.dy * cola);
      ctx.lineTo(x, y);
    }
    ctx.stroke();
    for (let i = destellos.length - 1; i >= 0; i--) {
      const d = destellos[i];
      const k = (ahora - d.t0) / 200;
      if (k >= 1) { destellos.splice(i, 1); continue; }
      ctx.globalAlpha = 1 - k;
      ctx.fillStyle = C.mapaImpacto;
      ctx.beginPath();
      ctx.arc(d.x, d.y, 6 + k * 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // Zona: afuera en rojo; el próximo círculo en blanco
    const zn = zonaAhora(alfa);
    if (zn) {
      ctx.fillStyle = C.zonaFuera;
      ctx.beginPath();
      ctx.rect(vx0 - 100, vy0 - 100, vx1 - vx0 + 200, vy1 - vy0 + 200);
      ctx.arc(zn[0], zn[1], Math.max(0, zn[2]), 0, Math.PI * 2, true);
      ctx.fill('evenodd');
      ctx.strokeStyle = C.zonaBorde;
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.arc(zn[0], zn[1], Math.max(0, zn[2]), 0, Math.PI * 2);
      ctx.stroke();
      if (zona[5] < zn[2] - 5) {
        ctx.strokeStyle = C.zonaObjetivo;
        ctx.lineWidth = 3;
        ctx.setLineDash([18, 14]);
        ctx.beginPath();
        ctx.arc(zona[3], zona[4], zona[5], 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // Palancas táctiles (en la pantalla, no en el mapa)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (TACTIL && enPartida) for (const p of Object.values(palancas)) {
      if (!p) continue;
      ctx.fillStyle = C.palanca;
      ctx.strokeStyle = C.palancaBorde;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.ox, p.oy, RADIO_PALANCA, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      const dx = p.x - p.ox;
      const dy = p.y - p.oy;
      const d = Math.hypot(dx, dy);
      const k = d > RADIO_PALANCA ? RADIO_PALANCA / d : 1;
      ctx.beginPath();
      ctx.arc(p.ox + dx * k, p.oy + dy * k, 24, 0, Math.PI * 2);
      ctx.fill();
    }

    dibujarMinimapa(zn, mio);
  }

  function redondo(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function dibujarMinimapa(zn, mio) {
    const w = mini.width;
    const k = w / L;
    mctx.clearRect(0, 0, w, w);
    if (!cajas.length) return;
    mctx.fillStyle = C.mapaCajaBorde;
    for (const [x, y, cw, ch] of cajas) mctx.fillRect(x * k, y * k, Math.max(1, cw * k), Math.max(1, ch * k));
    if (zn) {
      mctx.strokeStyle = C.zonaBorde;
      mctx.lineWidth = 2;
      mctx.beginPath();
      mctx.arc(zn[0] * k, zn[1] * k, Math.max(0, zn[2] * k), 0, Math.PI * 2);
      mctx.stroke();
      mctx.strokeStyle = C.zonaObjetivo;
      mctx.lineWidth = 1;
      mctx.beginPath();
      mctx.arc(zona[3] * k, zona[4] * k, zona[5] * k, 0, Math.PI * 2);
      mctx.stroke();
    }
    // Solo me veo yo (los demás no salen en el mapa: hay que buscarlos)
    if (mio && enPartida && pred.lista) {
      mctx.fillStyle = C.minimapaTu;
      mctx.beginPath();
      mctx.arc(pred.x * k, pred.y * k, 4, 0, Math.PI * 2);
      mctx.fill();
    }
  }

  // ---------------- Marcadores (4 veces por segundo) ----------------
  function marcadores() {
    const mio = yo && jugadores.get(yo);
    const vivos = [...jugadores.values()].filter((j) => j.vivo).length;
    $('hudVivos').textContent = vivos || estado.v || 0;
    $('hudBajas').textContent = mio ? mio.bajas : 0;
    const zt = $('hudZona');
    if (zona) {
      const fuera = mio && enPartida && pred.lista && Math.hypot(pred.x - zona[0], pred.y - zona[1]) > zona[2];
      zt.textContent = fuera ? `¡Fuera de la zona! −${zona[8]}/s` : zona[7] ? 'La zona se está cerrando' : `La zona se cierra en ${zona[6]} s`;
      zt.classList.toggle('peligro', !!fuera || !!zona[7]);
    } else zt.textContent = '';
    if (mio) {
      $('barraVida').style.width = `${mio.vida}%`;
      $('barraVida').parentElement.classList.toggle('baja', mio.vida <= 30);
      $('textoVida').textContent = mio.vida;
      $('barraEscudo').style.width = `${mio.escudo}%`;
      $('hudArma').textContent = ARMAS[mio.arma].nombre;
    }
    // ¿Hay un arma distinta en el piso? (el servidor usa el mismo alcance)
    let piso = null;
    if (mio && enPartida && pred.lista) {
      for (const [, x, y, tipo] of items.values()) {
        if (tipo <= 4 && tipo !== mio.arma && mio.arma !== 0 && Math.hypot(x - mio.x, y - mio.y) < 40 + R) { piso = tipo; break; }
      }
    }
    $('btnCambiar').hidden = piso === null;
    if (piso !== null) $('armaPiso').textContent = ARMAS[piso].nombre + (TACTIL ? '' : ' (E)');
    const ahora = performance.now();
    $('listaBajas').innerHTML = feed.filter((f) => ahora - f.t0 < 6000).map((f) => `<li class="${f.mia ? 'mia' : ''}">${f.texto}</li>`).join('');
    const banner = $('banner');
    if (enPartida && zona && zona[6] <= 5 && !zona[7] && zona[6] > 0) { banner.hidden = false; banner.textContent = `La zona se cierra en ${zona[6]} s`; }
    else banner.hidden = true;
    if (!enPartida && !$('capa').hidden) pintarPanel();
  }
  setInterval(marcadores, 250);

  conectar();
  requestAnimationFrame(cuadro);
})();
