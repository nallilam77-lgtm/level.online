// =========================================================================
// Último en Pie · el juego en el navegador.
//
// El servidor (juego-servidor/, Cloudflare) decide todo: impactos, vida, munición, zona y ganador. Aquí se
// dibuja y se manda hacia dónde se mueve, apunta y si dispara. El propio jugador se mueve al instante
// (predicción) y se va corrigiendo con lo que dice el servidor; a los demás se les suaviza el movimiento.
//
// Arte y sonidos: Kenney "Desert Shooter Pack" (CC0, img/LICENCIA-kenney.txt). Pixel art a escala ×3.
// =========================================================================
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const ES_LIGERO = document.documentElement.classList.contains('ligero');
  const TACTIL = window.matchMedia && matchMedia('(pointer: coarse)').matches;

  // En la tienda la página la sirve Vercel; el juego corre en Cloudflare. En local, el mismo servidor.
  const BASE = /(^|\.)levelupstore\.online$/.test(location.hostname) ? 'https://juego.levelupstore.online' : location.origin;
  // El juego es privado: el enlace trae ?c=<código> (se crea en admin.html → Minijuego). Se recuerda en
  // este navegador para que al recargar no haga falta el enlace otra vez.
  const parametros = new URLSearchParams(location.search);
  let CODIGO = parametros.get('c') || '';
  try {
    if (CODIGO) localStorage.setItem('ultimo_enlace', CODIGO);
    else CODIGO = localStorage.getItem('ultimo_enlace') || '';
  } catch (e) { /* sin almacenamiento */ }
  const ESPERA = parametros.get('espera');   // solo en local: ?espera=3 acorta la espera
  const urlSala = () => `${BASE.replace(/^http/, 'ws')}/ws?c=${encodeURIComponent(CODIGO)}${ESPERA ? '&espera=' + encodeURIComponent(ESPERA) : ''}`;
  let privado = false;                        // el enlace no sirve (o no hay)

  // ---------------- Igual que juego-servidor/src/partida.js ----------------
  let L = 2400;
  let R = 22;
  let TICK = 50;
  const VEL = 11;
  const ARMAS = [
    { nombre: 'Pistola', cargador: 12, sprite: 0, largo: 16, sonido: 'tiroPistola' },
    { nombre: 'Subfusil', cargador: 30, sprite: 2, largo: 22, sonido: 'tiroSubfusil' },
    { nombre: 'Escopeta', cargador: 5, sprite: 4, largo: 26, sonido: 'tiroEscopeta' },
    { nombre: 'Rifle', cargador: 24, sprite: 5, largo: 30, sonido: 'tiroRifle' },
    { nombre: 'Francotirador', cargador: 5, sprite: 3, largo: 36, sonido: 'tiroFranco' },
  ];
  const BOTIQUIN = 10;
  const CHALECO = 11;
  const OB = { CAJAS: 0, BARRIL: 1, MURO: 2, ARBOL: 3, ROCA: 4 };
  function empujarFuera(o, lista) {
    for (const [x, y, w, h] of lista) {
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
  function mover(o, mx, my, lista, factor) {
    const l = Math.hypot(mx, my);
    if (l > 1) { mx /= l; my /= l; }
    o.x += mx * VEL * factor;
    o.y += my * VEL * factor;
    empujarFuera(o, lista);
  }
  const dentroDeCaja = (x, y) => cajas.some(([cx, cy, w, h]) => x >= cx && x <= cx + w && y >= cy && y <= cy + h);

  // ---------------- Colores (variables de juego.css) ----------------
  const css = getComputedStyle(document.documentElement);
  const v = (n) => css.getPropertyValue(n).trim();
  const COLORES = Array.from({ length: 12 }, (_, i) => v(`--color-${i}`));
  const C = {};
  ['mapa-fuera', 'zona-fuera', 'zona-borde', 'zona-objetivo', 'mapa-nombre', 'mapa-contorno', 'mapa-bala', 'mapa-bala-borde',
    'mapa-impacto', 'mapa-fogonazo', 'mapa-vida', 'mapa-vida-fondo', 'mapa-escudo', 'mapa-sombra', 'mapa-tu', 'dano-otro',
    'dano-mio', 'brillo-arma', 'brillo-botiquin', 'brillo-chaleco', 'palanca', 'palanca-borde', 'minimapa-tu',
    'minimapa-caja', 'minimapa-arbol'].forEach((k) => { C[k.replace(/-(\w)/g, (_, l) => l.toUpperCase())] = v(`--${k}`); });

  // ---------------- Sprites ----------------
  const ESCALA = 3;
  const HOJAS = {
    jugadores: { src: 'img/jugadores.png', t: 24, cols: 4 },
    criaturas: { src: 'img/criaturas.png', t: 24, cols: 4 },
    armas: { src: 'img/armas-pixel.png', t: 24, cols: 10 },
    mapa: { src: 'img/mapa.png', t: 16, cols: 18 },
  };
  for (const h of Object.values(HOJAS)) {
    h.img = new Image();
    h.img.onload = () => { h.lista = true; if (h === HOJAS.mapa) prepararSuelo(); };
    h.img.src = h.src;
  }
  // 8 aspectos: 4 de "jugadores" y 4 de "criaturas" (fila de la hoja)
  const ASPECTOS = [['jugadores', 0], ['jugadores', 1], ['jugadores', 2], ['jugadores', 3],
    ['criaturas', 3], ['criaturas', 2], ['criaturas', 1], ['criaturas', 0]];
  const TILE = {
    suelo: [73, 157, 158, 175, 176, 73, 73],
    adornos: [58, 58, 44, 44, 39, 81, 82, 84, 85, 60, 61],
    cajas: [220, 221], barriles: [202, 203], rocas: [76],
    muroGris: [144, 145, 146], muroRojo: [147, 148, 149],
    arboles: [80, 62, 63, 57, 75],
    botiquin: 222, chaleco: 227, valla: 232,
  };

  function dibujarTile(hoja, idx, dx, dy, dw, dh) {
    const h = HOJAS[hoja];
    if (!h.lista) return false;
    const sx = (idx % h.cols) * (h.t + 1);   // las hojas traen 1 px de separación (así no se cuela el vecino)
    const sy = Math.floor(idx / h.cols) * (h.t + 1);
    ctx.drawImage(h.img, sx, sy, h.t, h.t, dx, dy, dw, dh);
    return true;
  }

  let patronSuelo = null;
  function prepararSuelo() {
    const c = document.createElement('canvas');
    c.width = 128; c.height = 128;
    const g = c.getContext('2d');
    const azar = aleatorio(7);
    const h = HOJAS.mapa;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const idx = TILE.suelo[Math.floor(azar() * TILE.suelo.length)];
      g.drawImage(h.img, (idx % h.cols) * 17, Math.floor(idx / h.cols) * 17, 16, 16, x * 16, y * 16, 16, 16);
    }
    patronSuelo = ctx.createPattern(c, 'repeat');
  }

  // Mismo azar en todos los navegadores para los adornos (sale de la semilla del mapa)
  function aleatorio(semilla) {
    let a = semilla >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const hash = (x, y, k = 0) => Math.abs(Math.imul(x * 73856093 ^ y * 19349663 ^ k * 83492791, 2654435761)) % 1000;

  // ---------------- Sonidos ----------------
  const ARCHIVOS = {
    tiroPistola: 'shoot-a', tiroSubfusil: 'shoot-c', tiroEscopeta: 'shoot-g', tiroRifle: 'shoot-e', tiroFranco: 'shoot-h',
    golpe: 'hurt-a', acierto: 'hurt-c', recoger: 'coin-a', baja: 'explosion-a', perder: 'lose-a', ganar: 'coin-d',
    salto: 'jump-a', recargar: 'move-a', clic: 'select-a',
  };
  const sonido = {
    ctx: null, buffers: {}, activo: true, esteCuadro: 0,
    iniciar() {
      if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
      try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return; }
      for (const [k, f] of Object.entries(ARCHIVOS)) {
        fetch(`sonidos/${f}.ogg`).then((r) => r.arrayBuffer())
          .then((b) => new Promise((ok, mal) => this.ctx.decodeAudioData(b, ok, mal)))
          .then((buf) => { this.buffers[k] = buf; }).catch(() => { /* formato no soportado: sin ese sonido */ });
      }
    },
    tocar(k, volumen = 1) {
      if (!this.activo || !this.ctx || !this.buffers[k] || volumen <= 0.02 || this.esteCuadro >= 5) return;
      this.esteCuadro++;
      const s = this.ctx.createBufferSource();
      s.buffer = this.buffers[k];
      const g = this.ctx.createGain();
      g.gain.value = Math.min(1, volumen) * 0.6;
      s.connect(g).connect(this.ctx.destination);
      s.start();
    },
    // Más bajo mientras más lejos de mí
    cerca(k, x, y, volumen = 1) {
      const d = Math.hypot(x - camara.x, y - camara.y);
      this.tocar(k, volumen * Math.max(0, 1 - d / 1100));
    },
  };
  try { sonido.activo = localStorage.getItem('ultimo_sonido') !== 'no'; } catch (e) { /* sin almacenamiento */ }

  // ---------------- Estado ----------------
  let ws = null;
  let reintento = 0;
  let yo = null;                      // mi id en la sala (se da al tocar "Jugar")
  let anotado = false;                // pedí entrar a la próxima partida
  let estado = { s: 'espera', t: null, n: 0, c: 0, v: 0, g: null, max: 15 };
  let cajas = [];
  let adornos = [];
  const items = new Map();            // id → [id, x, y, tipo]
  const jugadores = new Map();
  const balas = new Map();            // id → { x, y, dx, dy, vel, alcance, t0, dueno }
  const efectos = [];                 // impactos, fogonazos y números de daño
  const cuerpos = [];                 // eliminados tirados en el piso
  let zona = null;                    // [cx, cy, r, tx, ty, tr, segundos, cerrando, daño]
  let zonaAnt = null;
  let ultimoPaso = performance.now();
  let ping = 80;
  let enPartida = false;
  let resultado = null;
  let asesinoId = null;
  const feed = [];
  let temblor = 0;
  let aviso = null;                   // { texto, t0 } en el centro ("Eliminaste a …")

  const pred = { x: 0, y: 0, lista: false };
  const historia = [];

  const teclas = new Set();
  let apuntar = 0;
  let disparando = false;
  let raton = { x: -100, y: -100 };
  let enviado = { x: null, y: null, a: null, f: null, cuando: 0 };
  const palancas = { mover: null, apuntar: null };

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
  async function conectar() {
    pintarPanel();
    // Primero: ¿el enlace sirve? (si no, no tiene sentido intentar conectarse)
    try {
      const r = await (await fetch(`${BASE}/acceso?c=${encodeURIComponent(CODIGO)}`, { cache: 'no-store' })).json();
      if (!r.ok && !r.error) {
        privado = true;
        try { localStorage.removeItem('ultimo_enlace'); } catch (e) { /* sin almacenamiento */ }
        pintarPanel();
        return;
      }
    } catch (e) { reconectar(); return; }
    try { ws = new WebSocket(urlSala()); } catch (e) { reconectar(); return; }
    ws.addEventListener('open', () => { reintento = 0; mandar({ t: 'p', k: Math.round(performance.now()) }); });
    ws.addEventListener('message', (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch (err) { return; }
      recibir(m);
    });
    ws.addEventListener('close', () => {
      if (privado) return;
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
    cuerpos.length = 0;
    d.jugadores.forEach(([id, nombre, col, bot, vivo, bajas]) => {
      jugadores.set(id, { id, nombre, color: COLORES[col % COLORES.length], aspecto: ASPECTOS[col % ASPECTOS.length], bot: !!bot,
        vivo: !!vivo, bajas, x: 0, y: 0, a: 0, vida: 100, escudo: 0, arma: 0, mun: 12, recargando: false, ant: null, cab: null,
        mira: 1, paso: 0, golpe: 0 });
    });
    // Adornos del piso: mismos en todos los navegadores, fuera de los obstáculos
    adornos = [];
    const azar = aleatorio(d.semilla || 1);
    for (let i = 0; i < 150; i++) {
      const x = azar() * L;
      const y = azar() * L;
      const tile = TILE.adornos[Math.floor(azar() * TILE.adornos.length)];
      if (cajas.some(([cx, cy, w, h]) => x > cx - 40 && x < cx + w + 40 && y > cy - 40 && y < cy + h + 40)) continue;
      adornos.push([x, y, tile]);
    }
  }

  function actualizarJugadores(lista) {
    const ahora = performance.now();
    for (const [id, x, y, a100, vida, escudo, arma, mun, recargando] of lista) {
      const j = jugadores.get(id);
      if (!j) continue;
      j.ant = j.cab || [x, y];
      j.cab = [x, y];
      j.x = x; j.y = y;
      j.a = a100 / 100;
      const perdio = (j.vida + j.escudo) - (vida + escudo);
      if (perdio > 0.5 && j.cab) {
        j.golpe = ahora;
        efectos.push({ tipo: 'dano', x: x + (Math.random() * 20 - 10), y: y - 40, valor: Math.round(perdio), mio: id === yo, t0: ahora });
        if (id === yo) { temblor = ahora; sonido.tocar('golpe', 0.8); }
      }
      if (id === yo) {
        if (vida > j.vida || escudo > j.escudo || (arma !== j.arma && arma !== 0)) sonido.tocar('recoger', 0.7);
        if (recargando && !j.recargando) sonido.tocar('recargar', 0.6);
      }
      j.vida = vida; j.escudo = escudo; j.arma = arma; j.mun = mun; j.recargando = recargando === 1;
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
      asesinoId = null;
      feed.length = 0;
      if (yo && jugadores.has(yo)) { anotado = false; enPartida = true; sonido.tocar('salto', 0.7); }
      else enPartida = false;
    }
    if (m.p) actualizarJugadores(m.p);
    if (m.z) { zonaAnt = zona; zona = m.z; }
    if (m.b) m.b.forEach(([id, x, y, a1000, vel, alcance, arma, dueno]) => {
      const a = a1000 / 1000;
      balas.set(id, { x, y, dx: Math.cos(a), dy: Math.sin(a), vel, alcance, t0: ahora, dueno });
      const d = jugadores.get(dueno);
      if (d) d.disparo = ahora;
      if (!efectos.some((e) => e.tipo === 'fogonazo' && e.dueno === dueno && ahora - e.t0 < 30)) {
        efectos.push({ tipo: 'fogonazo', x, y, a, dueno, t0: ahora });
        if (ARMAS[arma]) sonido.cerca(ARMAS[arma].sonido, x, y, dueno === yo ? 0.9 : 0.6);
      }
    });
    if (m.x) m.x.forEach(([id, quien]) => {
      const b = balas.get(id);
      if (!b) return;
      const recorrido = Math.min(b.alcance, b.vel * (ahora - b.t0) / TICK);
      efectos.push({ tipo: 'impacto', x: b.x + b.dx * recorrido, y: b.y + b.dy * recorrido, carne: !!quien, t0: ahora });
      if (quien && b.dueno === yo) { efectos.push({ tipo: 'marca', t0: ahora }); sonido.tocar('acierto', 0.5); }
      balas.delete(id);
    });
    if (m.ia) m.ia.forEach((it) => items.set(it[0], it));
    if (m.ir) m.ir.forEach((id) => items.delete(id));
    if (m.k) m.k.forEach(([asesino, victima, arma]) => baja(asesino, victima, arma));
    if (m.e) {
      const antes = estado.s;
      estado = m.e;
      if (antes !== 'fin' && estado.s === 'fin' && estado.g && estado.g.id === yo) sonido.tocar('ganar', 1);
      if (antes !== 'espera' && estado.s === 'espera') {
        jugadores.clear(); items.clear(); cajas = []; adornos = []; balas.clear(); cuerpos.length = 0; zona = null; enPartida = false;
      }
      pintarPanel();
    }
    ultimoPaso = ahora;
  }

  function baja(asesino, victima, arma) {
    const vj = jugadores.get(victima);
    const aj = jugadores.get(asesino);
    if (vj) {
      vj.vivo = false;
      if (vj.cab) cuerpos.push({ x: vj.cab[0], y: vj.cab[1], aspecto: vj.aspecto, mira: vj.mira, t0: performance.now() });
    }
    if (aj && aj !== vj) aj.bajas++;
    let texto;
    if (arma === -1) texto = `<b>${esc(vj ? vj.nombre : '?')}</b> se desconectó`;
    else if (arma === -2 || !aj) texto = `La zona eliminó a <b>${esc(vj ? vj.nombre : '?')}</b>`;
    else texto = `<b>${esc(aj.nombre)}</b> → <b>${esc(vj ? vj.nombre : '?')}</b> · ${ARMAS[arma] ? ARMAS[arma].nombre : ''}`;
    feed.unshift({ texto, mia: victima === yo || asesino === yo, t0: performance.now() });
    feed.length = Math.min(feed.length, 5);
    if (asesino === yo && victima !== yo && arma >= 0) {
      aviso = { texto: `Eliminaste a ${vj ? vj.nombre : '?'}`, t0: performance.now() };
      sonido.tocar('baja', 0.8);
    }
    if (victima === yo) {
      enPartida = false;
      asesinoId = aj && aj !== vj ? asesino : null;
      const vivos = [...jugadores.values()].filter((j) => j.vivo).length;
      resultado = { puesto: vivos + 1, bajas: vj ? vj.bajas : 0, asesino: aj && aj !== vj ? aj.nombre : null, arma, zona: arma === -2 };
      sonido.tocar('perder', 0.9);
      setTimeout(pintarPanel, 900);
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
    const mostrar = (cosas) => {
      $('campoNombre').hidden = !cosas.nombre;
      $('controles').hidden = !cosas.controles;
      $('resultado').hidden = !cosas.resultado;
      $('tablaFinal').hidden = !cosas.tabla;
      btn.hidden = !cosas.boton;
    };
    $('hudEstado').hidden = !enPartida && estado.s !== 'partida';
    $('hudVida').hidden = !enPartida;
    $('btnRecargar').hidden = !enPartida || !TACTIL;
    if (enPartida) { capa.hidden = true; return; }
    capa.hidden = false;
    capa.classList.toggle('capa--mirar', estado.s === 'partida' || estado.s === 'fin');
    btn.disabled = !conectado();

    if (privado) {
      titulo.innerHTML = 'Juego <span>privado</span>';
      texto.innerHTML = 'Para jugar necesitas un <strong>enlace de invitación</strong> de Level Up. Pídeselo a quien te invitó.<br><br>Si ya tenías uno, puede que haya vencido.';
      $('avisoPanel').textContent = '';
      mostrar({});
      return;
    }
    if (!conectado()) {
      titulo.innerHTML = 'Último <span>en Pie</span>';
      texto.textContent = 'Conectando con la partida…';
      btn.textContent = 'Conectando…';
      mostrar({ nombre: true, controles: true, boton: true });
      return;
    }
    const hayTabla = estado.s === 'fin' && Array.isArray(estado.tabla) && estado.tabla.length > 0;
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
    if (hayTabla) {
      // En pantallas chicas: top 5 y mi fila, para que el botón quede a la vista
      let filas = estado.tabla.slice(0, ancho < 600 ? 5 : 10);
      const mia = estado.tabla.find((f) => f[0] === yo);
      if (mia && !filas.includes(mia)) filas = filas.concat([mia]);
      $('tablaFinal').innerHTML = filas.map(([id, nombre, puesto, bajas]) =>
        `<li class="${id === yo ? 'yo' : ''}"><span>${puesto ? '#' + puesto : 'En pie'}</span><b>${esc(nombre)}</b><span>${bajas} ${bajas === 1 ? 'baja' : 'bajas'}</span></li>`).join('');
    }

    let espera = '';
    if (estado.s === 'espera') espera = estado.t ? `La partida empieza en <strong>${estado.t} s</strong>. ${estado.n} de ${estado.max} anotados; si faltan, entran bots.` : 'Esperando jugadores…';
    else if (estado.s === 'partida') espera = `Partida en curso: <strong>${estado.v} vivos</strong>. Entras en la siguiente.`;
    else espera = 'La siguiente partida se arma en unos segundos.';

    if (anotado) {
      if (!resultado && !(estado.s === 'fin' && estado.g)) texto.innerHTML = espera;
      else texto.innerHTML += `<br>${espera}`;
      mostrar({ resultado: !!resultado, tabla: hayTabla, boton: false });
    } else {
      btn.textContent = resultado || estado.s === 'fin' ? 'Siguiente partida' : 'Jugar';
      if (!resultado && estado.s !== 'fin' && estado.s !== 'espera') texto.innerHTML += `<br><br>${espera}`;
      mostrar({ nombre: !resultado && estado.s !== 'fin', controles: !resultado && estado.s !== 'partida' && estado.s !== 'fin', resultado: !!resultado, tabla: hayTabla, boton: true });
    }
  }

  // ---------------- Controles ----------------
  try { $('nombre').value = localStorage.getItem('ultimo_nombre') || ''; } catch (e) { /* sin almacenamiento */ }

  $('formJugar').addEventListener('submit', (e) => {
    e.preventDefault();
    sonido.iniciar();
    sonido.tocar('clic', 0.6);
    const nombre = $('nombre').value.trim().slice(0, 14);
    try { localStorage.setItem('ultimo_nombre', nombre); } catch (err) { /* sin almacenamiento */ }
    mandar({ t: 'jugar', n: nombre });
    anotado = true;
    resultado = null;
    pintarPanel();
  });

  function pintarSonido() {
    $('btnSonido').setAttribute('aria-pressed', String(sonido.activo));
    $('btnSonido').classList.toggle('apagado', !sonido.activo);
    $('btnSonido').setAttribute('aria-label', sonido.activo ? 'Silenciar' : 'Activar sonido');
  }
  $('btnSonido').addEventListener('click', () => {
    sonido.activo = !sonido.activo;
    sonido.iniciar();
    try { localStorage.setItem('ultimo_sonido', sonido.activo ? 'si' : 'no'); } catch (e) { /* sin almacenamiento */ }
    pintarSonido();
  });
  pintarSonido();

  const MOVER = { KeyW: [0, -1], ArrowUp: [0, -1], KeyS: [0, 1], ArrowDown: [0, 1], KeyA: [-1, 0], ArrowLeft: [-1, 0], KeyD: [1, 0], ArrowRight: [1, 0] };
  window.addEventListener('keydown', (e) => {
    if (e.target && e.target.tagName === 'INPUT') return;
    if (MOVER[e.code]) { teclas.add(e.code); e.preventDefault(); }
    if (e.code === 'KeyE' && enPartida) mandar({ t: 'c' });
    if (e.code === 'KeyR' && enPartida) mandar({ t: 'r' });
  });
  window.addEventListener('keyup', (e) => teclas.delete(e.code));
  window.addEventListener('blur', () => { teclas.clear(); disparando = false; });

  function apuntarA(x, y) { raton = { x, y }; apuntar = Math.atan2(y - alto / 2, x - ancho / 2); }
  lienzo.addEventListener('mousemove', (e) => apuntarA(e.clientX, e.clientY));
  lienzo.addEventListener('mousedown', (e) => { apuntarA(e.clientX, e.clientY); disparando = true; sonido.iniciar(); });
  window.addEventListener('mouseup', () => { disparando = false; });
  lienzo.addEventListener('contextmenu', (e) => e.preventDefault());

  // Celular: dos palancas. Mitad izquierda = moverse; mitad derecha = apuntar y disparar.
  const ZONA_MUERTA = 14;
  const RADIO_PALANCA = 56;
  lienzo.addEventListener('touchstart', (e) => {
    e.preventDefault();
    sonido.iniciar();
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
  $('btnRecargar').addEventListener('click', () => mandar({ t: 'r' }));

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
    let f = disparando;
    if (TACTIL) {
      f = false;
      const pa = palancas.apuntar;
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
    sonido.esteCuadro = 0;
    const c = leerControles();
    const mio = yo && jugadores.get(yo);
    if (enPartida && pred.lista) {
      const antes = [pred.x, pred.y];
      mover(pred, c.mx, c.my, cajas, dt / TICK);
      if (mio) mio.caminando = Math.hypot(pred.x - antes[0], pred.y - antes[1]) > 0.3;
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

    // Cámara: sobre mí; eliminado, sobre quien me eliminó; si no, el vivo más cercano
    let foco;
    const asesino = asesinoId && jugadores.get(asesinoId);
    if (mio && enPartida) foco = posicion(mio, alfa);
    else if (asesino && asesino.vivo && asesino.cab) foco = posicion(asesino, alfa);
    else {
      let mejor = null;
      let dm = Infinity;
      for (const j of jugadores.values()) {
        if (!j.vivo || !j.cab) continue;
        const d = Math.hypot(j.x - camara.x, j.y - camara.y);
        if (d < dm) { dm = d; mejor = j; }
      }
      foco = mejor ? posicion(mejor, alfa) : [L / 2, L / 2];
    }
    if (mio && enPartida) { camara.x = foco[0]; camara.y = foco[1]; }
    else { camara.x += (foco[0] - camara.x) * 0.06; camara.y += (foco[1] - camara.y) * 0.06; }
    const zoomQuiero = !cajas.length ? Math.min(ancho, alto) / 1400 : Math.min(ancho, alto) / (TACTIL ? 640 : 880);
    camara.zoom += (zoomQuiero - camara.zoom) * 0.08;
    const z = camara.zoom;
    let tx = 0;
    let ty = 0;
    if (ahora - temblor < 160) { tx = (Math.random() - 0.5) * 10; ty = (Math.random() - 0.5) * 10; }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = C.mapaFuera;
    ctx.fillRect(0, 0, ancho, alto);
    ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * (ancho / 2 - camara.x * z + tx), dpr * (alto / 2 - camara.y * z + ty));
    ctx.imageSmoothingEnabled = false;
    const vx0 = camara.x - ancho / 2 / z - 80;
    const vx1 = camara.x + ancho / 2 / z + 80;
    const vy0 = camara.y - alto / 2 / z - 80;
    const vy1 = camara.y + alto / 2 / z + 80;
    const seVe = (x, y, m = 0) => x > vx0 - m && x < vx1 + m && y > vy0 - m && y < vy1 + m;
    const T = 16 * ESCALA;

    // Suelo de arena
    if (patronSuelo) {
      ctx.save();
      ctx.scale(ESCALA, ESCALA);
      ctx.fillStyle = patronSuelo;
      ctx.fillRect(0, 0, L / ESCALA, L / ESCALA);
      ctx.restore();
    }
    // Adornos (no chocan)
    for (const [x, y, tile] of adornos) if (seVe(x, y, T)) dibujarTile('mapa', tile, x - T / 2, y - T / 2, T, T);
    // Valla alrededor del mapa
    for (let x = 0; x < L; x += T) {
      if (x + T < vx0 || x > vx1) continue;
      if (vy0 < T) dibujarTile('mapa', TILE.valla, x, -T + 10, T, T);
      if (vy1 > L - T) dibujarTile('mapa', TILE.valla, x, L - 10, T, T);
    }

    // Cuerpos de los eliminados (se desvanecen)
    for (let i = cuerpos.length - 1; i >= 0; i--) {
      const c = cuerpos[i];
      const edad = ahora - c.t0;
      if (edad > 12000) { cuerpos.splice(i, 1); continue; }
      if (!seVe(c.x, c.y, 60)) continue;
      ctx.globalAlpha = edad > 9000 ? 1 - (edad - 9000) / 3000 : 1;
      dibujarPersonaje(c.aspecto, 3, c.x, c.y, c.mira);
      ctx.globalAlpha = 1;
    }

    // Botín en el piso: flota un poco con un brillo debajo
    const flota = Math.sin(ahora / 260) * 3;
    for (const [, x, y, tipo] of items.values()) {
      if (!seVe(x, y, 40)) continue;
      const brillo = tipo <= 4 ? C.brilloArma : tipo === BOTIQUIN ? C.brilloBotiquin : C.brilloChaleco;
      ctx.fillStyle = brillo;
      ctx.beginPath();
      ctx.ellipse(x, y + 10, 22, 9, 0, 0, Math.PI * 2);
      ctx.fill();
      if (tipo <= 4) dibujarTile('armas', ARMAS[tipo].sprite, x - 36, y - 40 + flota, 72, 72);
      else dibujarTile('mapa', tipo === BOTIQUIN ? TILE.botiquin : TILE.chaleco, x - 20, y - 24 + flota, 40, 40);
    }

    // Obstáculos bajos (cajas, barriles, muros, rocas)
    for (const o of cajas) {
      const [x, y, w, h, tipo] = o;
      if (x > vx1 || x + w < vx0 || y - T > vy1 || y + h + T < vy0 || tipo === OB.ARBOL) continue;
      dibujarObstaculo(o);
    }

    // Jugadores (de arriba hacia abajo, para que el de adelante tape al de atrás)
    const vivos = [...jugadores.values()].filter((j) => j.vivo && j.cab);
    const pos = new Map(vivos.map((j) => [j.id, posicion(j, alfa)]));
    vivos.sort((a, b) => pos.get(a.id)[1] - pos.get(b.id)[1]);
    for (const j of vivos) {
      const [x, y] = pos.get(j.id);
      if (!seVe(x, y, 80)) continue;
      dibujarJugador(j, x, y, ahora);
    }

    // Copas de los árboles: encima de los jugadores (si estoy debajo, se vuelve transparente)
    const yoPos = mio && enPartida ? pos.get(yo) : null;
    for (const o of cajas) {
      if (o[4] !== OB.ARBOL) continue;
      const [x, y, w, h] = o;
      if (x > vx1 + 40 || x + w < vx0 - 40 || y - 80 > vy1 || y + h < vy0) continue;
      const debajo = yoPos && Math.abs(yoPos[0] - (x + w / 2)) < 46 && yoPos[1] < y + h && yoPos[1] > y - 70;
      if (debajo) ctx.globalAlpha = 0.45;
      dibujarObstaculo(o);
      ctx.globalAlpha = 1;
    }

    // Balas
    for (const [id, b] of balas) {
      const recorrido = b.vel * (ahora - b.t0) / TICK;
      if (recorrido > b.alcance) { balas.delete(id); continue; }
      const x = b.x + b.dx * recorrido;
      const y = b.y + b.dy * recorrido;
      if (dentroDeCaja(x, y)) { balas.delete(id); continue; }
      if (!seVe(x, y)) continue;
      const cola = Math.min(recorrido, 18);
      ctx.lineCap = 'round';
      ctx.strokeStyle = C.mapaBalaBorde;
      ctx.lineWidth = 7;
      ctx.beginPath();
      ctx.moveTo(x - b.dx * cola, y - b.dy * cola);
      ctx.lineTo(x, y);
      ctx.stroke();
      ctx.strokeStyle = C.mapaBala;
      ctx.lineWidth = 3.5;
      ctx.stroke();
    }

    dibujarEfectos(ahora);

    // Zona: afuera en rojo; el próximo círculo en blanco
    const zn = zonaAhora(alfa);
    if (zn) {
      ctx.fillStyle = C.zonaFuera;
      ctx.beginPath();
      ctx.rect(vx0 - 100, vy0 - 100, vx1 - vx0 + 200, vy1 - vy0 + 200);
      ctx.arc(zn[0], zn[1], Math.max(0, zn[2]), 0, Math.PI * 2, true);
      ctx.fill('evenodd');
      ctx.strokeStyle = C.zonaBorde;
      ctx.lineWidth = 6 + Math.sin(ahora / 200) * 2;
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

    // ---- En la pantalla (no en el mapa) ----
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
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
    // Mira del mouse (se agranda un instante al acertar)
    if (!TACTIL && enPartida) {
      const marca = efectos.find((e) => e.tipo === 'marca' && ahora - e.t0 < 160);
      const tam = marca ? 60 : 48;
      dibujarTile('armas', 25, raton.x - tam / 2, raton.y - tam / 2, tam, tam);
    }
    if (aviso && ahora - aviso.t0 < 1800) {
      ctx.globalAlpha = Math.min(1, (1800 - (ahora - aviso.t0)) / 400);
      ctx.font = '900 22px Montserrat, sans-serif';
      ctx.textAlign = 'center';
      ctx.lineWidth = 5;
      ctx.strokeStyle = C.mapaContorno;
      ctx.strokeText(aviso.texto, ancho / 2, alto * 0.3);
      ctx.fillStyle = C.mapaTu;
      ctx.fillText(aviso.texto, ancho / 2, alto * 0.3);
      ctx.globalAlpha = 1;
    }

    dibujarMinimapa(zn);
  }

  function dibujarObstaculo([x, y, w, h, tipo]) {
    const T = 16 * ESCALA;
    if (tipo === OB.CAJAS) {
      for (let cy = y; cy < y + h; cy += T) for (let cx = x; cx < x + w; cx += T) {
        dibujarTile('mapa', TILE.cajas[hash(cx, cy) % 2], cx, cy, T, T);
      }
    } else if (tipo === OB.BARRIL) {
      dibujarTile('mapa', TILE.barriles[hash(x, y) % 2], x + w / 2 - T / 2, y + h - T + 4, T, T);
    } else if (tipo === OB.MURO) {
      const piezas = hash(x, y) % 3 === 0 ? TILE.muroRojo : TILE.muroGris;
      const n = Math.round(w / T);
      for (let i = 0; i < n; i++) dibujarTile('mapa', i === 0 ? piezas[0] : i === n - 1 ? piezas[2] : piezas[1], x + i * T, y + h - T, T, T);
    } else if (tipo === OB.ARBOL) {
      const t = 16 * 4;
      dibujarTile('mapa', TILE.arboles[hash(x, y) % TILE.arboles.length], x + w / 2 - t / 2, y + h - t + 6, t, t);
    } else if (tipo === OB.ROCA) {
      dibujarTile('mapa', TILE.rocas[0], x + w / 2 - T / 2, y + h - T + 6, T, T);
    }
  }

  // Personaje de 24 px a escala ×3 (72 de lado), parado sobre su sombra
  function dibujarPersonaje(aspecto, cuadro, x, y, mira) {
    const [hoja, fila] = aspecto;
    const h = HOJAS[hoja];
    if (!h.lista) return false;
    const t = 24 * ESCALA;
    ctx.save();
    ctx.translate(x, y - 14);
    if (mira < 0) ctx.scale(-1, 1);
    ctx.drawImage(h.img, cuadro * 25, fila * 25, 24, 24, -t / 2, -t / 2, t, t);
    ctx.restore();
    return true;
  }

  function dibujarJugador(j, x, y, ahora) {
    const soy = j.id === yo && enPartida;
    const a = soy ? apuntar : j.a;
    j.mira = Math.cos(a) < 0 ? -1 : 1;
    // Sombra (y un aro verde debajo de mí, para encontrarme rápido)
    ctx.fillStyle = C.mapaSombra;
    ctx.beginPath();
    ctx.ellipse(x, y + 18, 20, 8, 0, 0, Math.PI * 2);
    ctx.fill();
    if (soy) {
      ctx.strokeStyle = C.mapaTu;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.ellipse(x, y + 18, 26, 11, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (j.escudo > 0) {
      ctx.strokeStyle = C.mapaEscudo;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.ellipse(x, y + 18, soy ? 31 : 24, soy ? 14 : 10, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    const camina = soy ? j.caminando : j.cab && j.ant && Math.hypot(j.cab[0] - j.ant[0], j.cab[1] - j.ant[1]) > 1;
    const golpeado = ahora - j.golpe < 120;
    const cuadro = golpeado ? 2 : camina ? Math.floor(ahora / 150) % 2 : 0;
    const arma = ARMAS[j.arma] || ARMAS[0];
    const apuntaArriba = Math.sin(a) < -0.3;
    if (apuntaArriba) dibujarArma(j, arma, x, y, a, ahora);     // el arma queda detrás del cuerpo
    if (!dibujarPersonaje(j.aspecto, cuadro, x, y, j.mira)) {
      ctx.fillStyle = j.color;
      ctx.beginPath();
      ctx.arc(x, y, R, 0, Math.PI * 2);
      ctx.fill();
    }
    if (golpeado) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.35;
      dibujarPersonaje(j.aspecto, cuadro, x, y, j.mira);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }
    if (!apuntaArriba) dibujarArma(j, arma, x, y, a, ahora);

    // Nombre y vida (la mía va abajo en la pantalla)
    if (!soy) {
      const tam = Math.max(12 / camara.zoom, 13);
      ctx.font = `800 ${tam}px Montserrat, sans-serif`;
      ctx.textAlign = 'center';
      ctx.lineWidth = 4;
      ctx.strokeStyle = C.mapaContorno;
      ctx.strokeText(j.nombre, x, y - 62);
      ctx.fillStyle = C.mapaNombre;
      ctx.fillText(j.nombre, x, y - 62);
      ctx.fillStyle = C.mapaVidaFondo;
      ctx.fillRect(x - 24, y - 56, 48, 7);
      ctx.fillStyle = j.color;
      ctx.fillRect(x - 23, y - 55, 46 * j.vida / 100, 5);
      if (j.escudo > 0) { ctx.fillStyle = C.mapaEscudo; ctx.fillRect(x - 23, y - 51, 46 * j.escudo / 100, 2); }
    }
  }

  function dibujarArma(j, arma, x, y, a, ahora) {
    const hx = x + j.mira * 4;
    const hy = y - 4;
    const retroceso = j.disparo && ahora - j.disparo < 70 ? -5 : 0;
    ctx.save();
    ctx.translate(hx, hy);
    ctx.rotate(a);
    if (j.mira < 0) ctx.scale(1, -1);
    dibujarTile('armas', arma.sprite, -36 + 14 + retroceso, -36, 72, 72);
    ctx.restore();
  }

  function dibujarEfectos(ahora) {
    for (let i = efectos.length - 1; i >= 0; i--) {
      const e = efectos[i];
      const edad = ahora - e.t0;
      if (e.tipo === 'fogonazo') {
        if (edad > 70) { efectos.splice(i, 1); continue; }
        const d = jugadores.get(e.dueno);
        const largo = d ? (ARMAS[d.arma] || ARMAS[0]).largo : 16;
        const fx = e.x + Math.cos(e.a) * (largo - 26);
        const fy = e.y + Math.sin(e.a) * (largo - 26) - 4;
        ctx.fillStyle = C.mapaFogonazo;
        ctx.globalAlpha = 1 - edad / 70;
        ctx.beginPath();
        ctx.arc(fx, fy, 9 + Math.random() * 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      } else if (e.tipo === 'impacto') {
        if (edad > 220) { efectos.splice(i, 1); continue; }
        const k = edad / 220;
        ctx.fillStyle = e.carne ? C.danoOtro : C.mapaImpacto;
        ctx.globalAlpha = 1 - k;
        for (let p = 0; p < 4; p++) {
          const ang = p * 1.7 + e.t0;
          ctx.fillRect(e.x + Math.cos(ang) * k * 18 - 2, e.y + Math.sin(ang) * k * 18 - 2, 5, 5);
        }
        ctx.globalAlpha = 1;
      } else if (e.tipo === 'dano') {
        if (edad > 800) { efectos.splice(i, 1); continue; }
        const k = edad / 800;
        ctx.globalAlpha = 1 - k * k;
        ctx.font = '900 20px Montserrat, sans-serif';
        ctx.textAlign = 'center';
        ctx.lineWidth = 4;
        ctx.strokeStyle = C.mapaContorno;
        ctx.strokeText(e.valor, e.x, e.y - k * 30);
        ctx.fillStyle = e.mio ? C.danoMio : C.danoOtro;
        ctx.fillText(e.valor, e.x, e.y - k * 30);
        ctx.globalAlpha = 1;
      } else if (edad > 200) efectos.splice(i, 1);
    }
  }

  function dibujarMinimapa(zn) {
    const w = mini.width;
    const k = w / L;
    mctx.clearRect(0, 0, w, w);
    if (!cajas.length) return;
    for (const [x, y, cw, ch, tipo] of cajas) {
      mctx.fillStyle = tipo === OB.ARBOL ? C.minimapaArbol : C.minimapaCaja;
      mctx.fillRect(x * k, y * k, Math.max(2, cw * k), Math.max(2, ch * k));
    }
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
    // Solo me veo yo (a los demás hay que buscarlos)
    if (enPartida && pred.lista) {
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
      const arma = ARMAS[mio.arma] || ARMAS[0];
      $('hudArma').textContent = arma.nombre;
      $('hudMunicion').textContent = mio.recargando ? 'Recargando…' : `${mio.mun} / ${arma.cargador}`;
      $('hudMunicion').classList.toggle('vacio', mio.recargando || mio.mun <= Math.ceil(arma.cargador / 5));
    }
    let piso = null;
    if (mio && enPartida && pred.lista && mio.arma !== 0) {
      for (const [, x, y, tipo] of items.values()) {
        if (tipo <= 4 && tipo !== mio.arma && Math.hypot(x - mio.x, y - mio.y) < 40 + R) { piso = tipo; break; }
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
