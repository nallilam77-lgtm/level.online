// =========================================================================
// Duelo de Acero · el juego en el navegador (2 vs 2 o 1 vs 1 por turnos).
//
// El servidor (juego-servidor/, Cloudflare) decide todo: turnos, daño, efectos y ganador. Aquí se muestra la
// sala, se elige puesto y clase, y en el combate se manda la acción elegida; lo que pasa (ev) se anima.
// En los ataques sale una flecha que va y viene: mientras más cerca del centro la detengas, más daño (p: 0 a 1).
// Entrada: ?c=<código> (solo el del administrador, desde el panel → "Crear partida", que agrega &nueva=1) para
// CREAR una sala, o ?s=<sala> (enlace que comparte el creador) para entrar a ella. Los personajes son pixel art dibujado aquí mismo (sin imágenes).
// =========================================================================
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const el = (etiqueta, clase, texto) => {
    const e = document.createElement(etiqueta);
    if (clase) e.className = clase;
    if (texto !== undefined) e.textContent = texto;
    return e;
  };
  const estilos = getComputedStyle(document.documentElement);
  const color = (n) => estilos.getPropertyValue('--' + n).trim();
  const guardar = (k, v) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* sin almacenamiento */ } };
  const leer = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const guardarSesion = (k, v) => { try { sessionStorage.setItem(k, v); } catch (e) { /* sin almacenamiento */ } };
  const leerSesion = (k) => { try { return sessionStorage.getItem(k); } catch (e) { return null; } };

  // En la tienda la página la sirve Vercel; el juego corre en Cloudflare. En local, el mismo servidor.
  const BASE = /(^|\.)levelupstore\.online$/.test(location.hostname) ? 'https://juego.levelupstore.online' : location.origin;
  const LOCAL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  const parametros = new URLSearchParams(location.search);
  let CODIGO = parametros.get('c') || '';
  if (CODIGO) guardar('duelo_enlace', CODIGO);
  else CODIGO = leer('duelo_enlace') || leer('ultimo_enlace') || '';
  let salaId = /^[a-z2-9]{10}$/.test(parametros.get('s') || '') ? parametros.get('s') : '';

  const EQUIPOS = ['Rojo', 'Azul'];
  const FILAS = ['Adelante', 'Atrás'];
  const NOMBRE_EFECTO = { at: 'Aturdido', pr: 'Provoca', mu: 'Muro', fu: 'Furia', ve: 'Veneno', ev: 'Evasión', gu: 'Guardia' };
  const TURNO_MS = 25000;                        // como en juego-servidor/src/sala.js
  const ARMAS = 'espadas, hachas, lanzas, dagas y mazas';
  // Igual que multFlecha() de juego-servidor/src/combate.js
  const multFlecha = (p) => (p >= 0.95 ? 1.5 : 0.4 + 0.95 * Math.min(1, Math.max(0, p)));

  // ---------------- Sonidos (Kenney, CC0) ----------------
  const ARCHIVOS = { golpe: 'hurt-a', golpe2: 'hurt-c', critico: 'explosion-a', efecto: 'coin-a', ganar: 'coin-d', perder: 'lose-a', esquiva: 'jump-a', mover: 'move-a', clic: 'select-a' };
  const sonido = {
    ctx: null, buffers: {}, activo: leer('duelo_sonido') !== 'no',
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
      if (!this.activo || !this.ctx || !this.buffers[k]) return;
      const s = this.ctx.createBufferSource();
      s.buffer = this.buffers[k];
      const g = this.ctx.createGain();
      g.gain.value = volumen * 0.6;
      s.connect(g).connect(this.ctx.destination);
      s.start();
    },
  };
  function pintarSonido() {
    const b = $('btnSonido');
    b.classList.toggle('apagado', !sonido.activo);
    b.setAttribute('aria-pressed', String(sonido.activo));
    b.setAttribute('aria-label', sonido.activo ? 'Silenciar' : 'Activar sonido');
  }
  $('btnSonido').addEventListener('click', () => {
    sonido.activo = !sonido.activo;
    guardar('duelo_sonido', sonido.activo ? 'si' : 'no');
    sonido.iniciar();
    pintarSonido();
  });
  pintarSonido();

  // ---------------- Pixel art ----------------
  // 16 × 20 píxeles mirando a la derecha; se les pone contorno (18 × 22) y el equipo Azul se dibuja volteado.
  const ANCHO_PJ = 18, ALTO_PJ = 22;
  const cacheSprites = new Map();
  function sprite(k, equipo, blanco = false) {
    const clave = `${k}-${equipo}-${blanco}`;
    if (cacheSprites.has(clave)) return cacheSprites.get(clave);
    const P = {
      piel: color('pj-piel'), pielS: color('pj-piel-sombra'), pelo: color('pj-pelo'), barba: color('pj-barba'), ojo: color('pj-ojo'),
      acero: color('pj-acero'), aceroC: color('pj-acero-claro'), aceroO: color('pj-acero-oscuro'), madera: color('pj-madera'),
      oro: color('pj-oro'), pantalon: color('pj-pantalon'), bota: color('pj-bota'),
      eq: color(equipo ? 'azul' : 'rojo'), eqO: color(equipo ? 'azul-oscuro' : 'rojo-oscuro'),
    };
    const m = Array.from({ length: 20 }, () => Array(16).fill(null));
    const r = (x, y, w, h, c) => { for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) if (j >= 0 && j < 20 && i >= 0 && i < 16) m[j][i] = c; };
    const p = (x, y, c) => r(x, y, 1, 1, c);

    // Cuerpo común: piernas, botas, torso, cabeza y brazos
    r(6, 15, 2, 3, P.pantalon); r(9, 15, 2, 3, P.pantalon);
    r(5, 18, 3, 2, P.bota); r(9, 18, 3, 2, P.bota);
    r(5, 9, 6, 6, P.eq); r(5, 13, 6, 1, P.bota); p(8, 13, P.oro);
    r(6, 4, 4, 5, P.piel); r(6, 8, 4, 1, P.pielS); p(9, 6, P.ojo);
    r(4, 10, 1, 3, P.eqO); p(4, 13, P.piel);
    r(11, 10, 1, 2, P.eq); p(11, 12, P.piel);

    if (k === 'guerrero') {
      r(5, 2, 6, 3, P.acero); r(5, 5, 1, 3, P.acero); r(6, 2, 4, 1, P.aceroC); p(7, 1, P.eq); p(8, 1, P.eq); p(8, 0, P.eq);
      r(5, 9, 6, 2, P.aceroO);                                    // hombreras
      r(1, 9, 4, 6, P.acero); r(1, 9, 1, 6, P.aceroO); r(2, 11, 2, 2, P.eq);   // escudo
      r(12, 2, 1, 9, P.aceroC); p(12, 1, P.aceroC); r(11, 11, 3, 1, P.oro); p(12, 12, P.madera);  // espada
    } else if (k === 'barbaro') {
      r(4, 9, 8, 6, P.eq); r(4, 9, 1, 3, P.piel); r(11, 9, 1, 3, P.piel); r(6, 9, 4, 1, P.piel);
      r(5, 2, 6, 2, P.barba); r(5, 4, 1, 4, P.barba); r(6, 8, 4, 2, P.barba); p(9, 7, P.barba);
      p(4, 1, P.aceroC); p(11, 1, P.aceroC); r(5, 2, 6, 1, P.aceroO);            // cuernos y casco
      r(12, 4, 1, 11, P.madera); r(13, 3, 2, 5, P.acero); r(15, 2, 1, 7, P.aceroC);   // hacha
    } else if (k === 'lancero') {
      r(6, 2, 4, 2, P.acero); p(7, 1, P.acero); p(8, 1, P.aceroC); r(5, 4, 1, 2, P.acero);
      r(2, 9, 2, 8, P.eqO);                                       // capa
      r(12, 3, 1, 17, P.madera); p(12, 0, P.aceroC); r(11, 1, 3, 1, P.acero); p(12, 2, P.acero); r(11, 4, 3, 1, P.eq);  // lanza
    } else if (k === 'asesino') {
      r(5, 2, 6, 3, P.eqO); r(5, 5, 1, 4, P.eqO); r(6, 1, 3, 1, P.eqO);         // capucha
      r(6, 7, 4, 2, P.ojo);                                       // pañuelo
      r(5, 9, 6, 6, P.eqO); r(6, 9, 4, 4, P.eq);
      r(12, 9, 1, 3, P.aceroC); p(12, 12, P.madera);              // daga delantera
      r(3, 12, 1, 3, P.acero); p(4, 13, P.piel);                  // daga trasera
    } else if (k === 'clerigo') {
      r(4, 9, 8, 8, P.eq); r(7, 9, 2, 8, P.aceroC); r(4, 16, 8, 1, P.eqO);   // túnica con franja blanca
      r(6, 1, 4, 3, P.aceroC); r(7, 0, 2, 1, P.aceroC); r(7, 1, 2, 2, P.oro); // mitra con marca dorada
      r(5, 4, 1, 3, P.aceroC);
      r(1, 10, 3, 4, P.madera); r(2, 11, 1, 2, P.oro);            // libro
      r(12, 6, 1, 7, P.madera); r(11, 3, 3, 3, P.acero); p(12, 2, P.aceroC); p(12, 4, P.aceroC);  // maza
    }

    const c = document.createElement('canvas');
    c.width = ANCHO_PJ; c.height = ALTO_PJ;
    const g = c.getContext('2d');
    const contorno = color('pj-contorno');
    const lleno = (i, j) => j >= 0 && j < 20 && i >= 0 && i < 16 && m[j][i];
    for (let j = -1; j <= 20; j++) {
      for (let i = -1; i <= 16; i++) {
        let col = lleno(i, j) ? m[j][i] : null;
        if (!col && (lleno(i - 1, j) || lleno(i + 1, j) || lleno(i, j - 1) || lleno(i, j + 1))) col = contorno;
        if (!col) continue;
        g.fillStyle = blanco ? color('pj-acero-claro') : col;
        g.fillRect(i + 1, j + 1, 1, 1);
      }
    }
    cacheSprites.set(clave, c);
    return c;
  }
  function miniatura(canvas, k, equipo) {
    canvas.width = ANCHO_PJ; canvas.height = ALTO_PJ;
    const g = canvas.getContext('2d');
    g.clearRect(0, 0, ANCHO_PJ, ALTO_PJ);
    if (equipo) { g.translate(ANCHO_PJ, 0); g.scale(-1, 1); }
    g.drawImage(sprite(k, equipo), 0, 0);
  }

  // ---------------- Estado ----------------
  let ws = null;
  let yo = null;
  let tok = null;
  let clases = null;            // info de clases que manda el servidor
  let est = null;               // último estado { fase, jug, c, … }
  let entrado = false;          // ya tocó "Entrar"/"Crear sala"
  let fatal = false;            // la sala no existe / enlace malo: no reconectar
  let reintento = 0;
  let crear = false;
  let elegida = null;           // acción elegida en mi turno: { h, obj }
  let enviado = false;          // ya mandé mi acción (esperando al servidor)
  let leyendo = null;           // fuera de mi turno: habilidad tocada para leer qué hace
  let finTurno = 0;             // performance.now() en que se acaba el turno
  let finMostrado = false;

  const tokKey = (s) => 'duelo_tok_' + s;
  const nombre = () => $('nombre').value.trim().slice(0, 14) || 'Jugador';
  $('nombre').value = leer('duelo_nombre') || leer('ultimo_nombre') || '';

  function mostrar(pantalla) {
    for (const id of ['pantallaInicio', 'pantallaSala', 'pantallaCombate']) $(id).hidden = id !== pantalla;
    if (pantalla === 'pantallaCombate') { medir(); arrancarDibujo(); }
  }

  // ---------------- Entrada ----------------
  function aviso(texto) { $('avisoInicio').textContent = texto || ''; }
  function botonEntrar(texto, activo) { const b = $('btnEntrar'); b.textContent = texto; b.disabled = !activo; }

  async function preparar() {
    mostrar('pantallaInicio');
    if (salaId) {
      $('textoInicio').innerHTML = `Te invitaron a una sala de <strong>Duelo de Acero</strong>: combate por turnos con ${ARMAS}.`;
      botonEntrar('Entrar a la sala', true);
      // Recargó la página: vuelve directo a su puesto
      if (leerSesion(tokKey(salaId)) && $('nombre').value) entrar();
      return;
    }
    if (!CODIGO && !LOCAL) {
      $('textoInicio').textContent = 'Para jugar necesitas el enlace de una sala. Pídeselo a quien te invitó.';
      $('campoNombre').hidden = true;
      $('btnEntrar').hidden = true;
      return;
    }
    $('textoInicio').innerHTML = 'Crea una sala y pásale el enlace a tus amigos. <strong>Tú decides cuándo empieza</strong>; los puestos vacíos los juegan bots.';
    // Desde el panel ("Crear partida") llega con nueva=1: si ya hay nombre guardado, la sala se crea sola
    const listo = () => { botonEntrar('Crear sala', true); if (parametros.get('nueva') === '1' && $('nombre').value) entrar(); };
    if (LOCAL) { listo(); return; }
    botonEntrar('Revisando tu enlace…', false);
    try {
      const r = await (await fetch(`${BASE}/acceso?c=${encodeURIComponent(CODIGO)}`, { cache: 'no-store' })).json();
      if (r.ok) { listo(); return; }
      if (!r.error) {
        guardar('duelo_enlace', null);
        $('textoInicio').textContent = 'Este enlace no sirve para crear partidas. Para jugar, pide el enlace de una sala a quien te invitó.';
        $('campoNombre').hidden = true; $('btnEntrar').hidden = true;
        return;
      }
    } catch (e) { /* sin conexión: se deja intentar igual */ }
    botonEntrar('Crear sala', true);
    aviso('No se pudo revisar el enlace. Revisa tu conexión e inténtalo.');
  }

  $('formEntrar').addEventListener('submit', (e) => { e.preventDefault(); entrar(); });
  function entrar() {
    if (entrado) return;
    entrado = true;
    guardar('duelo_nombre', nombre());
    sonido.iniciar();
    crear = !salaId;
    if (salaId) tok = leerSesion(tokKey(salaId));
    botonEntrar('Conectando…', false);
    aviso('');
    conectar();
  }

  function conectar() {
    const url = crear
      ? `${BASE.replace(/^http/, 'ws')}/ws?c=${encodeURIComponent(CODIGO)}&crear=1`
      : `${BASE.replace(/^http/, 'ws')}/ws?s=${salaId}`;
    try { ws = new WebSocket(url); } catch (e) { reconectar(); return; }
    const este = ws;
    ws.addEventListener('open', () => { reintento = 0; mandar({ t: 'hola', n: nombre(), tok: tok || undefined }); });
    ws.addEventListener('message', (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch (err) { return; }
      recibir(m);
    });
    ws.addEventListener('close', () => {
      if (ws !== este) return;
      ws = null;
      if (fatal) return;
      reconectar();
    });
  }

  function reconectar() {
    if (fatal || !entrado) return;
    reintento++;
    if (reintento > 8) { fallo('Se perdió la conexión. Recarga la página para volver.'); return; }
    avisoCentro('Reconectando…');
    if (!est) botonEntrar('Reconectando…', false);
    setTimeout(() => { if (!ws) conectar(); }, Math.min(5000, 600 * reintento));
  }

  function fallo(texto) {
    fatal = true;
    entrado = false;
    try { if (ws) ws.close(); } catch (e) { /* ya cerrada */ }
    ws = null;
    est = null;
    if (salaId) guardarSesion(tokKey(salaId), '');
    mostrar('pantallaInicio');
    $('capaFin').hidden = true;
    $('campoNombre').hidden = true;
    $('btnEntrar').hidden = true;
    $('textoInicio').textContent = '';
    aviso(texto);
  }

  function mandar(m) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); }
  setInterval(() => mandar({ t: 'p', k: 1 }), 25000);   // mantiene viva la conexión en el celular
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && entrado && !fatal && !ws) { reintento = 0; conectar(); }
  });

  function recibir(m) {
    if (m.t === 'error') { fallo(m.m); return; }
    if (m.t === 'yo') {
      yo = m.id;
      tok = m.tok;
      if (!clases) { clases = m.clases; pintarClases(); }
      return;
    }
    if (m.t !== 's') return;
    if (m.sala && m.sala !== salaId) {
      salaId = m.sala;
      crear = false;          // si se reconecta, entra a ESTA sala
      history.replaceState(null, '', `${location.pathname}?s=${salaId}`);
    }
    if (tok) guardarSesion(tokKey(salaId), tok);
    avisoCentro('');
    const antes = est;
    est = m;
    if (m.fase === 'sala') {
      finMostrado = false;
      $('capaFin').hidden = true;
      mostrar('pantallaSala');
      pintarSala();
      return;
    }
    if (!antes || antes.fase === 'sala') { reiniciarCombate(); mostrar('pantallaCombate'); }
    actualizarCombate(m);
    if (m.ev) animar(m.ev);
    if (m.fase === 'fin') mostrarFin(antes && antes.fase === 'combate' ? 1600 : 0);
  }

  // ---------------- Sala de espera ----------------
  const jugadorEn = (p) => est.jug.find((j) => j.p === p);
  const miJugador = () => est && est.jug.find((j) => j.id === yo);
  const nombreAnfitrion = () => { const a = est.jug.find((j) => j.id === est.anf); return a ? a.n : 'el anfitrión'; };

  function pintarSala() {
    const enlace = `${location.origin}${location.pathname}?s=${est.sala}`;
    $('enlaceSala').value = enlace;
    $('btnWhatsapp').href = `https://wa.me/?text=${encodeURIComponent('¡Ven a jugar Duelo de Acero conmigo! Entra a mi sala: ' + enlace)}`;

    // Orden en pantalla como en el combate: Rojo (atrás, adelante) VS Azul (adelante, atrás); en 1 vs 1, uno por lado
    const uno = est.modo === '1v1';
    const orden = uno ? [[0], [2]] : [[1, 0], [2, 3]];
    document.querySelectorAll('.puestos').forEach((caja) => {
      const equipo = Number(caja.dataset.equipo);
      caja.classList.toggle('puestos--uno', uno);
      caja.replaceChildren(...orden[equipo].map((p) => tarjetaPuesto(p, equipo)));
    });
    document.querySelectorAll('.btn-modo').forEach((b) => {
      const activo = b.dataset.modo === est.modo;
      b.classList.toggle('elegido', activo);
      b.setAttribute('aria-pressed', String(activo));
      b.disabled = est.anf !== yo;
    });
    $('notaModo').textContent = est.anf === yo
      ? (uno ? 'Duelo de uno contra uno. Si nadie se sienta enfrente, juegas contra un bot.' : 'Dos equipos de dos: uno adelante y otro atrás.')
      : `${nombreAnfitrion()} elige el modo.`;

    const yoJ = miJugador();
    const sentado = yoJ && yoJ.p >= 0;
    $('notaClases').textContent = sentado ? 'Tu compañero y los rivales ven tu clase. Puedes cambiarla hasta que empiece.' : 'Siéntate en un puesto para elegir clase.';
    document.querySelectorAll('.clase').forEach((b) => {
      b.disabled = !sentado;
      b.classList.toggle('elegida', !!sentado && b.dataset.k === yoJ.k);
      b.setAttribute('aria-pressed', String(!!sentado && b.dataset.k === yoJ.k));
      const lienzo = b.querySelector('canvas');
      miniatura(lienzo, b.dataset.k, sentado && yoJ.p >= 2 ? 1 : 0);
    });

    const mirando = est.jug.filter((j) => j.p < 0);
    $('textoGente').textContent = mirando.length ? `Mirando: ${mirando.map((j) => j.n).join(', ')}` : '';
    const libres = (uno ? [0, 2] : [0, 1, 2, 3]).filter((p) => !jugadorEn(p)).length;
    const soyAnf = est.anf === yo;
    $('btnEmpezar').hidden = !soyAnf;
    $('btnEmpezar').disabled = false;
    $('btnEmpezar').textContent = libres ? `Empezar partida (${libres} ${libres === 1 ? 'bot' : 'bots'})` : 'Empezar partida';
    $('textoEsperando').textContent = soyAnf ? '' : `Esperando a que ${nombreAnfitrion()} empiece la partida…`;
  }

  function tarjetaPuesto(p, equipo) {
    const j = jugadorEn(p);
    const libre = !j;
    const caja = el(libre ? 'button' : 'div', 'puesto' + (libre ? '' : ' ocupado') + (j && j.id === yo ? ' mio' : ''));
    if (libre) {
      caja.type = 'button';
      caja.addEventListener('click', () => { sonido.tocar('clic'); mandar({ t: 'puesto', p }); });
      caja.setAttribute('aria-label', est.modo === '1v1' ? `Sentarme en ${EQUIPOS[equipo]}` : `Sentarme en ${EQUIPOS[equipo]} ${FILAS[p % 2].toLowerCase()}`);
    }
    caja.append(el('span', 'puesto-fila', est.modo === '1v1' ? 'Luchador' : FILAS[p % 2]));
    const lienzo = el('canvas');
    miniatura(lienzo, j ? j.k : 'guerrero', equipo);
    if (libre) lienzo.style.opacity = '0.25';
    caja.append(lienzo);
    if (j) {
      caja.append(el('span', 'puesto-nombre', j.n + (j.id === yo ? ' (tú)' : '')));
      const info = el('span', 'puesto-clase', clases && clases[j.k] ? clases[j.k].nombre : '');
      if (!j.on) info.append(' · ', el('span', 'fuera', 'sin conexión'));
      caja.append(info);
      if (j.id === est.anf) caja.append(el('span', 'etiqueta-anf', 'ANFITRIÓN'));
    } else {
      caja.append(el('span', 'puesto-nombre', 'Libre'), el('span', 'puesto-libre', 'Sentarme aquí'));
    }
    return caja;
  }

  function pintarClases() {
    const caja = $('clases');
    caja.replaceChildren();
    for (const [k, c] of Object.entries(clases)) {
      const b = el('button', 'clase');
      b.type = 'button';
      b.dataset.k = k;
      const lienzo = el('canvas');
      miniatura(lienzo, k, 0);
      const cabeza = el('div', 'clase-cabeza');
      cabeza.append(el('strong', '', c.nombre), el('span', '', c.arma));
      cabeza.append(el('span', '', c.resumen));
      // Atributos fijos de la clase (no se pueden cambiar)
      const attr = el('dl', 'atributos');
      const signo = (n) => (n > 0 ? '+' + n : n < 0 ? '−' + -n : '0');
      for (const [t, v] of [['Vida', c.vida], ['Velocidad', c.vel], ['Fuerza', c.attr.fuerza + ' %'], ['Defensa', c.attr.defensa + ' %'], ['Esquiva', c.attr.esquiva + ' %'], ['Precisión', signo(c.attr.precision)], ['Crítico', c.attr.critico + ' %']]) {
        const d = el('div');
        d.append(el('dt', '', t), el('dd', '', String(v)));
        attr.append(d);
      }
      cabeza.append(attr);
      const lista = el('ul');
      const item = (h) => { const li = el('li'); li.append(el('b', '', h.n), h.cd ? ` (cada ${h.cd + 1} turnos): ` : ': ', h.d); return li; };
      const pasiva = el('li', 'pasiva');
      pasiva.append(el('b', '', `Pasiva · ${c.pasiva.n}: `), c.pasiva.d);
      lista.append(pasiva, item(c.rapido), item(c.fuerte), ...c.hab.map(item));
      b.append(lienzo, cabeza, lista);
      b.addEventListener('click', () => { sonido.tocar('clic'); mandar({ t: 'clase', k }); });
      caja.append(b);
    }
  }

  $('btnCopiar').addEventListener('click', async (e) => {
    const b = e.currentTarget;
    try { await navigator.clipboard.writeText($('enlaceSala').value); b.textContent = '¡Copiado!'; }
    catch (err) { $('enlaceSala').select(); b.textContent = 'Cópialo'; }
    setTimeout(() => { b.textContent = 'Copiar'; }, 2000);
  });
  document.querySelectorAll('.btn-modo').forEach((b) => b.addEventListener('click', () => {
    if (!est || est.anf !== yo || b.dataset.modo === est.modo) return;
    sonido.tocar('clic');
    mandar({ t: 'modo', m: b.dataset.modo });
  }));
  $('btnEmpezar').addEventListener('click', (e) => { e.currentTarget.disabled = true; sonido.iniciar(); mandar({ t: 'empezar' }); });
  $('btnOtra').addEventListener('click', (e) => { e.currentTarget.disabled = true; mandar({ t: 'otra' }); });

  // ---------------- Combate: lienzo ----------------
  // Escenario en 128 × 72 píxeles "gordos"; nombres, barras y números se dibujan encima a resolución real.
  const AW = 128, AH = 72, PISO = 60;
  const POS_X = [[46, 22], [82, 106]];          // [equipo][fila]
  const lienzo = $('lienzo');
  const ctx = lienzo.getContext('2d');
  const pix = document.createElement('canvas');
  pix.width = AW; pix.height = AH;
  const px = pix.getContext('2d');
  let fondo = null;
  let escala = 1, dpr = 1;
  let dibujando = false;
  const vis = [];                                // por puesto: posición, vida mostrada, animaciones
  const flotantes = [];                          // textos que suben
  let temblor = 0;

  function medir() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const ancho = lienzo.clientWidth || 320;
    lienzo.width = Math.round(ancho * dpr);
    lienzo.height = Math.round(ancho * dpr * 9 / 16);
    escala = lienzo.width / AW;
  }
  window.addEventListener('resize', () => { if (!$('pantallaCombate').hidden) medir(); });

  function crearFondo() {
    const c = document.createElement('canvas');
    c.width = AW; c.height = AH;
    const g = c.getContext('2d');
    g.fillStyle = color('arena-cielo'); g.fillRect(0, 0, AW, AH);
    // Muro de piedra
    g.fillStyle = color('arena-muro'); g.fillRect(0, 10, AW, PISO - 22);
    g.fillStyle = color('arena-junta');
    for (let y = 10; y < PISO - 12; y += 6) {
      g.fillRect(0, y, AW, 1);
      for (let x = ((y / 6) % 2) * 6; x < AW; x += 12) g.fillRect(x, y, 1, 6);
    }
    g.fillStyle = color('arena-muro-luz');
    for (let y = 11; y < PISO - 12; y += 6) for (let x = ((y / 6) % 2) * 6 + 1; x < AW; x += 12) if ((x * 7 + y) % 5 === 0) g.fillRect(x, y, 10, 1);
    // Almenas
    g.fillStyle = color('arena-muro');
    for (let x = 0; x < AW; x += 10) g.fillRect(x, 6, 6, 4);
    // Piso
    g.fillStyle = color('arena-piso'); g.fillRect(0, PISO - 12, AW, AH - PISO + 12);
    g.fillStyle = color('arena-piso-luz'); g.fillRect(0, PISO - 12, AW, 1);
    g.fillStyle = color('arena-piso-raya');
    for (let y = PISO - 6; y < AH; y += 6) g.fillRect(0, y, AW, 1);
    for (let x = 0; x < AW; x += 16) g.fillRect(x + ((x / 16) % 2) * 8, PISO - 11, 1, AH);
    // Antorchas
    g.fillStyle = color('arena-antorcha');
    for (const x of [12, 64, 116]) g.fillRect(x, 24, 2, 7);
    return c;
  }

  function reiniciarCombate() {
    vis.length = 0;
    flotantes.length = 0;
    $('registro').replaceChildren();
    elegida = null;
    enviado = false;
    finMostrado = false;
    $('capaFin').hidden = true;
  }

  function arrancarDibujo() {
    if (dibujando) return;
    dibujando = true;
    requestAnimationFrame(cuadro);
  }

  function cuadro(ahora) {
    if ($('pantallaCombate').hidden) { dibujando = false; return; }
    dibujar(ahora);
    actualizarReloj(ahora);
    requestAnimationFrame(cuadro);
  }

  function prepararVis(c, conAnimacion) {
    c.l.forEach((x, i) => {
      if (!vis[i]) vis[i] = { x: POS_X[x.e][x.f], hp: x.v, meta: x.v, muerto: x.v <= 0, caida: 0, golpe: 0, ataque: null, brillo: 0 };
      if (!conAnimacion) { vis[i].meta = x.v; vis[i].muerto = x.v <= 0; }
    });
  }

  function dibujar(ahora) {
    if (!est || !est.c) return;
    if (!fondo) fondo = crearFondo();
    const c = est.c;
    px.imageSmoothingEnabled = false;
    px.drawImage(fondo, 0, 0);
    // Fuego de las antorchas
    for (const x of [12, 64, 116]) {
      const f = Math.sin(ahora / 120 + x) > 0;
      px.fillStyle = color('arena-luz'); px.fillRect(x - 3, 17 + (f ? 0 : 1), 8, 8);
      px.fillStyle = color('arena-fuego'); px.fillRect(x - 1, 20, 4, 4);
      px.fillStyle = color('arena-fuego-luz'); px.fillRect(x + (f ? 0 : 1), 19 + (f ? 0 : 1), 2, 3);
    }

    const objetivosValidos = objetivosElegibles();
    // Primero los de atrás, para que los de adelante queden encima
    const orden = c.l.map((x, i) => i).sort((a, b) => c.l[b].f - c.l[a].f);
    for (const i of orden) {
      const x = c.l[i], v = vis[i];
      if (!v) continue;
      const meta = POS_X[x.e][x.f];
      v.x += (meta - v.x) * 0.15;
      v.hp += (v.meta - v.hp) * 0.15;
      let dx = 0;
      if (v.ataque) {
        const t = (ahora - v.ataque.t0) / 520;
        if (t >= 1) v.ataque = null;
        else if (t >= 0) dx = (v.ataque.hasta - v.x) * Math.sin(Math.PI * t) * 0.85;
      }
      const golpeado = ahora - v.golpe < 160;
      const sacudida = golpeado ? (Math.round(ahora / 40) % 2 ? 1 : -1) : 0;
      const bx = Math.round(v.x + dx + sacudida);
      // Sombra y marca de turno
      px.fillStyle = color('arena-sombra');
      px.fillRect(bx - 6, PISO - 1, 12, 2);
      if (c.t === i && est.fase === 'combate') {
        px.fillStyle = color('marca-turno');
        const a = 7 + Math.round(Math.sin(ahora / 200));
        px.fillRect(bx - a, PISO, a * 2, 1);
        px.fillRect(bx - a + 2, PISO + 1, a * 2 - 4, 1);
      }
      if (objetivosValidos.includes(i)) {
        px.fillStyle = color('marca-objetivo');
        px.fillRect(bx - 7, PISO, 14, 1);
      }
      const spr = sprite(x.k, x.e, golpeado && Math.round(ahora / 60) % 2 === 0);
      px.save();
      if (v.muerto) {
        v.caida = Math.min(1, v.caida + 0.06);
        px.globalAlpha = 1 - v.caida * 0.55;
        px.translate(bx, PISO);
        px.rotate((x.e ? 1 : -1) * v.caida * Math.PI / 2);
        if (x.e) px.scale(-1, 1);
        px.drawImage(spr, -ANCHO_PJ / 2, -ALTO_PJ + 1);
      } else {
        const salto = Math.round(Math.sin(ahora / 300 + i) * 0.6);
        px.translate(bx, PISO + salto);
        if (x.e) px.scale(-1, 1);
        px.drawImage(spr, -ANCHO_PJ / 2, -ALTO_PJ + 1);
      }
      px.restore();
    }

    // Al lienzo real (con temblor tras los golpes fuertes)
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    const tiembla = temblor > ahora ? (Math.random() - 0.5) * escala : 0;
    ctx.drawImage(pix, tiembla, 0, lienzo.width, lienzo.height);

    // Encima: nombres, barras, efectos, flechas y números
    const s = escala;
    const fuente = Math.max(10 * dpr, s * 3.4);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    for (let i = 0; i < c.l.length; i++) {
      const x = c.l[i], v = vis[i];
      if (!v) continue;
      const cx = v.x * s;
      const arriba = (PISO - ALTO_PJ - 3) * s;
      ctx.globalAlpha = v.muerto ? 0.5 : 1;
      // Nombre
      ctx.font = `800 ${fuente}px Montserrat, sans-serif`;
      ctx.lineWidth = Math.max(2, fuente / 4);
      ctx.strokeStyle = color('contorno-lienzo');
      ctx.fillStyle = x.j && x.j === yo ? color('accent-neon') : color(x.e ? 'azul' : 'rojo');
      const n = x.n.length > 9 && s < 5 ? x.n.slice(0, 8) + '…' : x.n;
      ctx.strokeText(n, cx, arriba - fuente * 0.9);
      ctx.fillText(n, cx, arriba - fuente * 0.9);
      // Vida
      const bw = 18 * s, bh = Math.max(4 * dpr, s * 1.5);
      ctx.fillStyle = color('vida-fondo');
      ctx.fillRect(cx - bw / 2, arriba - bh / 2 - fuente * 0.4, bw, bh);
      const pct = Math.max(0, v.hp / x.m);
      ctx.fillStyle = color(pct > 0.5 ? 'vida' : pct > 0.25 ? 'vida-media' : 'vida-baja');
      ctx.fillRect(cx - bw / 2, arriba - bh / 2 - fuente * 0.4, bw * pct, bh);
      ctx.font = `800 ${fuente * 0.8}px Montserrat, sans-serif`;
      ctx.fillStyle = color('texto-lienzo');
      ctx.strokeText(`${Math.max(0, Math.round(v.hp))}`, cx, arriba + fuente * 0.75);
      ctx.fillText(`${Math.max(0, Math.round(v.hp))}`, cx, arriba + fuente * 0.75);
      // Efectos (debajo de los pies)
      if (!v.muerto) {
        const efectos = Object.keys(NOMBRE_EFECTO).filter((k) => x[k]);
        ctx.font = `800 ${fuente * 0.72}px Montserrat, sans-serif`;
        efectos.slice(0, 2).forEach((k, n2) => {
          const texto = k === 've' ? `Veneno ${x.ve}` : NOMBRE_EFECTO[k];
          ctx.fillStyle = color('efecto-' + k);
          ctx.strokeText(texto, cx, (PISO + 5) * s + n2 * fuente * 0.85);
          ctx.fillText(texto, cx, (PISO + 5) * s + n2 * fuente * 0.85);
        });
        if (x.at) {                                   // estrellitas de aturdido
          ctx.fillStyle = color('efecto-at');
          for (let k = 0; k < 3; k++) {
            const a = ahora / 300 + k * 2.1;
            ctx.fillRect(cx + Math.cos(a) * 5 * s - s / 2, (PISO - ALTO_PJ + 1) * s + Math.sin(a) * s - s / 2, s, s);
          }
        }
      }
      // Flecha sobre los objetivos que puedo elegir
      if (objetivosValidos.includes(i)) {
        const y0 = arriba - fuente * 2.4 + Math.sin(ahora / 150) * s;
        ctx.fillStyle = color('marca-objetivo');
        ctx.beginPath();
        ctx.moveTo(cx - 3 * s, y0 - 3 * s); ctx.lineTo(cx + 3 * s, y0 - 3 * s); ctx.lineTo(cx, y0); ctx.closePath();
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    // Textos que suben
    for (let k = flotantes.length - 1; k >= 0; k--) {
      const f = flotantes[k];
      const t = (ahora - f.t0) / f.dura;
      if (t < 0) continue;
      if (t >= 1) { flotantes.splice(k, 1); continue; }
      const v = vis[f.o];
      if (!v) continue;
      ctx.globalAlpha = t > 0.7 ? (1 - t) / 0.3 : 1;
      const tam = fuente * (f.grande ? 1.6 : 1.05);
      ctx.font = `900 ${tam}px Montserrat, sans-serif`;
      ctx.lineWidth = Math.max(3, tam / 4);
      ctx.strokeStyle = color('contorno-lienzo');
      ctx.fillStyle = color(f.color);
      const y = (PISO - 12) * s - t * 10 * s - f.fila * tam;
      ctx.strokeText(f.texto, v.x * s, y);
      ctx.fillText(f.texto, v.x * s, y);
      ctx.globalAlpha = 1;
    }
  }

  // Tocar a un luchador en el lienzo = elegirlo como objetivo
  lienzo.addEventListener('click', (e) => {
    const validos = objetivosElegibles();
    if (!validos.length) return;
    const r = lienzo.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * AW;
    const y = ((e.clientY - r.top) / r.height) * AH;
    let mejor = null, dist = 14;
    for (const i of validos) {
      const d = Math.abs(vis[i].x - x) + (y < PISO - ALTO_PJ - 8 || y > PISO + 6 ? 10 : 0);
      if (d < dist) { dist = d; mejor = i; }
    }
    if (mejor !== null) usar(mejor);
  });

  // ---------------- Combate: turno y botones ----------------
  const miLuchador = () => (est && est.c ? est.c.l.findIndex((x) => x.j === yo) : -1);
  const esMiTurno = () => !!est && est.fase === 'combate' && est.c.t >= 0 && est.c.l[est.c.t].j === yo;
  // Info de una acción: 'r' (ataque rápido), 'f' (golpe fuerte), 0-2 (habilidad) o 'cambiar'
  const infoDe = (k, h) => (h === 'r' ? clases[k].rapido : h === 'f' ? clases[k].fuerte : h === 'cambiar'
    ? { n: 'Cambiar de fila', obj: 'yo', d: 'Cambias de fila con tu compañero (gasta tu turno).' } : clases[k].hab[h]);
  const objDe = (k, h) => infoDe(k, h).obj;
  const nombreDe = (k, h) => infoDe(k, h).n;
  const conObjetivo = (obj) => obj === 'enemigo' || obj === 'cualquiera' || obj === 'aliado';
  function objetivosElegibles() {
    if (!elegida || enviado || flecha || !esMiTurno()) return [];
    const op = est.c.op.find((o) => o.h === elegida.h);
    return op && conObjetivo(elegida.obj) ? op.o : [];
  }

  function actualizarCombate(m) {
    const c = m.c;
    prepararVis(c, !!m.ev);
    if (!esMiTurno()) { elegida = null; enviado = false; cerrarFlecha(); }
    const actor = c.t >= 0 ? c.l[c.t] : null;
    const t = $('textoTurno');
    t.replaceChildren();
    if (m.fase === 'fin') t.textContent = 'Combate terminado';
    else if (!actor) t.textContent = `Ronda ${c.r}`;
    else if (actor.j === yo) t.append(el('span', 'tu-turno', '¡Tu turno!'), ` · Ronda ${c.r}`);
    else {
      const jug = actor.j && m.jug.find((j) => j.id === actor.j);
      t.append('Turno de ', el('span', actor.e ? 'azul' : 'rojo', actor.n), !actor.j ? ' (bot)' : jug && !jug.on ? ' (sin conexión, juega solo)' : '', ` · Ronda ${c.r}`);
    }
    finTurno = m.queda > 0 ? performance.now() + m.queda : 0;
    $('reloj').hidden = !finTurno;
    pintarAcciones();
  }

  function actualizarReloj(ahora) {
    if (!finTurno) return;
    const queda = Math.max(0, finTurno - ahora);
    $('relojBarra').style.transform = `scaleX(${queda / TURNO_MS})`;
    $('reloj').classList.toggle('poco', queda < 6000);
  }

  function pintarAcciones() {
    const caja = $('botonesAccion');
    const i = miLuchador();
    $('acciones').hidden = i < 0;
    if (i < 0) return;
    const x = est.c.l[i];
    const turno = esMiTurno() && !enviado && !flecha;
    const ops = turno ? est.c.op : [];
    caja.replaceChildren();
    const acciones = est.c.l.length > 2 ? ['r', 'f', 0, 1, 2, 'cambiar'] : ['r', 'f', 0, 1, 2];
    const pasiva = clases[x.k].pasiva;
    $('pasivaAccion').replaceChildren(el('b', '', `Pasiva · ${pasiva.n}: `), pasiva.d, x.k === 'guerrero' && !x.al && x.v > 0 ? ' (ya la usó)' : '');
    for (const h of acciones) {
      const b = el('button', 'btn-accion' + (h === 'cambiar' ? ' btn-accion--ancho' : '') + (elegida && elegida.h === h ? ' elegida' : ''));
      b.type = 'button';
      const disponible = ops.some((o) => o.h === h);
      // Fuera de turno se pueden tocar para leerlas (no hacen nada)
      b.disabled = x.v <= 0 || (turno && !disponible);
      if (!turno) b.classList.add('solo-leer');
      if (!turno && leyendo === h) b.classList.add('elegida');
      b.append(nombreDe(x.k, h));
      if (typeof h === 'number') {
        const espera = x.cd[h];
        b.append(el('small', '', espera > 0 ? `Lista en ${espera} ${espera === 1 ? 'turno' : 'turnos'}` : 'Lista'));
      } else if (h === 'r' || h === 'f') {
        b.append(el('small', '', `${infoDe(x.k, h).d.split('.')[0]}${h === 'r' ? ' · casi no se esquiva' : ' · se esquiva'}`));
      }
      b.addEventListener('click', () => elegir(h));
      caja.append(b);
    }
    const detalle = $('detalleAccion');
    const obj = $('objetivos');
    obj.replaceChildren();
    obj.hidden = true;
    if (x.v <= 0) { detalle.textContent = 'Caíste. Mira cómo termina tu compañero.'; return; }
    if (!turno) {
      if (flecha) detalle.textContent = '¡Detén la flecha en el centro!';
      else if (enviado) detalle.textContent = 'Enviado…';
      else if (leyendo !== null) detalle.replaceChildren(el('b', '', nombreDe(x.k, leyendo) + ': '), descripcion(x.k, leyendo));
      else detalle.textContent = 'Espera tu turno. Toca una habilidad para leer qué hace.';
      return;
    }
    if (!elegida) { detalle.textContent = 'Elige qué hacer.'; return; }
    detalle.replaceChildren(el('b', '', nombreDe(x.k, elegida.h) + ': '), descripcion(x.k, elegida.h));
    obj.hidden = false;
    if (conObjetivo(elegida.obj)) {
      const op = est.c.op.find((o) => o.h === elegida.h);
      for (const o of op ? op.o : []) {
        const y = est.c.l[o];
        const b = el('button', 'btn-objetivo' + (elegida.obj === 'aliado' ? ' btn-objetivo--aliado' : ''));
        b.type = 'button';
        const fila = est.c.l.length > 2 ? `${FILAS[y.f]} · ` : '';
        b.append(o === i ? `${y.n} (tú)` : y.n, el('small', '', `${fila}${y.v} de ${y.m} de vida`));
        b.addEventListener('click', () => usar(o));
        obj.append(b);
      }
    } else {
      const b = el('button', 'btn-objetivo', `Usar ${nombreDe(x.k, elegida.h)}`);
      b.type = 'button';
      b.style.gridColumn = '1 / -1';
      b.addEventListener('click', () => usar());
      obj.append(b);
    }
  }

  function descripcion(k, h) {
    const info = infoDe(k, h);
    return info.dano ? `${info.d} El daño depende de dónde detengas la flecha.` : info.d;
  }

  function elegir(h) {
    if (!esMiTurno()) { leyendo = leyendo === h ? null : h; pintarAcciones(); return; }
    if (enviado) return;
    leyendo = null;
    const k = est.c.l[est.c.t].k;
    sonido.tocar('clic', 0.6);
    elegida = { h, obj: objDe(k, h) };
    pintarAcciones();
  }

  function usar(o) {
    if (!elegida || !esMiTurno() || enviado || flecha) return;
    const { h } = elegida;
    const k = est.c.l[est.c.t].k;
    if (infoDe(k, h).dano) {
      // Ataque: primero la flecha; el daño depende de dónde la detenga
      abrirFlecha(h, (p) => enviar(h, o, p));
      pintarAcciones();
    } else {
      enviar(h, o);
    }
  }

  function enviar(h, o, p) {
    if (!esMiTurno()) return;
    mandar({ t: 'accion', h, o, p });
    enviado = true;
    elegida = null;
    pintarAcciones();
    // Si el servidor no la aceptó (llegó tarde o no valía), se puede volver a elegir
    setTimeout(() => { if (enviado && esMiTurno()) { enviado = false; pintarAcciones(); } }, 3000);
  }

  // ---------------- Flecha de precisión (estilo barra de ataque) ----------------
  // Va y viene sobre la barra; en el golpe fuerte va más rápido. Si no la detienes en 3 pasadas, se detiene
  // sola donde esté. p = 1 en el centro, 0 en los bordes.
  const PASADA_MS = { r: 950, f: 620 };          // lo que tarda en cruzar la barra (habilidades: 800)
  let flecha = null;                             // { t0, pasada, listo, fin }
  function abrirFlecha(h, listo) {
    flecha = { t0: performance.now(), pasada: PASADA_MS[h] || 800, listo, fin: false };
    $('flechaResultado').textContent = '';
    $('flechaTitulo').textContent = h === 'f' ? '¡Golpe fuerte! Detén la flecha en el centro' : '¡Detén la flecha en el centro!';
    $('flecha').hidden = false;
    $('flecha').classList.remove('detenida');
    $('btnFlecha').disabled = false;
    $('btnFlecha').focus({ preventScroll: true });
    requestAnimationFrame(moverFlecha);
  }
  function posFlecha(ahora) {
    const t = Math.max(0, ahora - flecha.t0) / flecha.pasada;
    const ida = t % 2;
    return { x: ida < 1 ? ida : 2 - ida, vueltas: t };
  }
  function moverFlecha(ahora) {
    if (!flecha || flecha.fin) return;
    const { x, vueltas } = posFlecha(ahora);
    $('flechaMarca').style.left = `${x * 100}%`;
    if (vueltas >= 3) { detenerFlecha(); return; }
    requestAnimationFrame(moverFlecha);
  }
  function detenerFlecha() {
    if (!flecha || flecha.fin) return;
    flecha.fin = true;
    const { x } = posFlecha(performance.now());
    $('flechaMarca').style.left = `${x * 100}%`;
    const p = Math.max(0, 1 - Math.abs(x - 0.5) * 2);
    const m = multFlecha(p).toFixed(1).replace('.', ',');
    $('flechaResultado').textContent = p >= 0.95 ? `¡PERFECTO! ×${m}` : p >= 0.7 ? `¡Bien! ×${m}` : p >= 0.4 ? `Regular ×${m}` : `Flojo ×${m}`;
    $('flecha').classList.add('detenida');
    $('btnFlecha').disabled = true;
    sonido.tocar(p >= 0.95 ? 'critico' : 'clic', p >= 0.95 ? 0.6 : 0.8);
    if (p >= 0.95 && navigator.vibrate) navigator.vibrate(80);
    flecha.listo(Math.round(p * 1000) / 1000);
    setTimeout(cerrarFlecha, 700);
  }
  function cerrarFlecha() {
    if (!flecha) return;
    flecha = null;
    $('flecha').hidden = true;
    if (est && est.c) pintarAcciones();
  }
  $('flecha').addEventListener('pointerdown', (e) => { e.preventDefault(); detenerFlecha(); });
  document.addEventListener('keydown', (e) => {
    if (flecha && !flecha.fin && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); detenerFlecha(); }
  });

  // ---------------- Animación de lo que pasó ----------------
  function flotante(o, texto, colorVar, t0, extra = {}) {
    const fila = flotantes.filter((f) => f.o === o && Math.abs(f.t0 - t0) < 400).length;
    flotantes.push({ o, texto, color: colorVar, t0, dura: 1100, fila, ...extra });
  }
  function luego(ms, fn) { setTimeout(fn, ms); }

  function animar(ev) {
    const c = est.c;
    const ahora = performance.now();
    let t = 0;                     // ms desde ahora
    let impacto = 0;
    const metas = new Map();       // puesto → cuándo mostrar su vida nueva
    for (const e of ev) {
      if (e.t === 'accion') {
        const a = c.l[e.a], v = vis[e.a];
        const k = a.k;
        const obj = objDe(k, e.h);
        const ataca = obj !== 'yo' && obj !== 'aliado';
        if (e.h !== 'r') flotante(e.a, nombreDe(k, e.h), 'accent-cyan', ahora + t, { dura: 1300 });
        if (e.p >= 0.95) flotante(e.a, '¡Perfecto!', 'accent-neon', ahora + t, { dura: 1300 });
        if (ataca) {
          const blanco = e.o !== undefined ? e.o : c.l.findIndex((y) => y.e !== a.e && y.f === 0);
          const destino = vis[blanco >= 0 ? blanco : 0].x + (a.e ? 12 : -12);
          if (v) v.ataque = { t0: ahora + t, hasta: destino };
          impacto = t + 230;
        } else {
          impacto = t + 150;
          luego(t, () => sonido.tocar(e.h === 'cambiar' ? 'mover' : 'efecto', 0.7));
        }
        t = impacto;
      } else if (e.t === 'dano') {
        const cuando = t;
        metas.set(e.o, cuando);
        flotante(e.o, e.crit ? `¡${e.d}!` : `-${e.d}`, e.crit ? 'critico' : 'dano', ahora + cuando, { grande: !!e.crit });
        luego(cuando, () => {
          if (vis[e.o]) vis[e.o].golpe = performance.now();
          sonido.tocar(e.crit ? 'critico' : Math.random() < 0.5 ? 'golpe' : 'golpe2', e.crit ? 0.8 : 1);
          if (e.crit || e.d >= 30) temblor = performance.now() + 200;
        });
        t += 170;
      } else if (e.t === 'esquiva') {
        flotante(e.o, '¡Esquiva!', 'efecto-ev', ahora + t);
        luego(t, () => sonido.tocar('esquiva'));
        t += 170;
      } else if (e.t === 'cura') {
        const cuando = t;
        metas.set(e.o, cuando);
        flotante(e.o, `+${e.d}`, 'vida', ahora + cuando, { grande: e.d >= 25 });
        luego(cuando, () => sonido.tocar('efecto', 0.8));
        t += 170;
      } else if (e.t === 'pasiva') {
        flotante(e.o, '¡Último aliento!', 'warning', ahora + t, { grande: true });
        luego(t, () => { sonido.tocar('efecto'); temblor = performance.now() + 200; });
        t += 200;
      } else if (e.t === 'contra') {
        flotante(e.a, '¡Contragolpe!', 'efecto-gu', ahora + t);
        t += 120;
      } else if (e.t === 'cae') {
        const cuando = t + 100;
        metas.set(e.o, Math.max(metas.get(e.o) || 0, cuando));
        luego(cuando, () => { if (vis[e.o]) { vis[e.o].muerto = true; vis[e.o].caida = 0; } });
        flotante(e.o, 'Cayó', 'vida-baja', ahora + cuando);
        t += 200;
      } else if (e.t === 'efecto') {
        if (e.e === 'at' || e.e === 've') flotante(e.o, NOMBRE_EFECTO[e.e], 'efecto-' + e.e, ahora + t);
        if (e.e === 'limpio') flotante(e.o, 'Purificado', 'efecto-mu', ahora + t);
      } else if (e.t === 'veneno') {
        metas.set(e.o, t);
        flotante(e.o, `-${e.d}`, 'efecto-ve', ahora + t);
        luego(t, () => { if (vis[e.o]) vis[e.o].golpe = performance.now(); sonido.tocar('golpe2', 0.6); });
        t += 300;
      } else if (e.t === 'aturdido') {
        flotante(e.o, 'Pierde el turno', 'efecto-at', ahora + t);
        t += 300;
      } else if (e.t === 'tiempo') {
        flotante(e.o, 'Se acabó el tiempo', 'warning', ahora + t);
      } else if (e.t === 'cambio') {
        luego(t, () => sonido.tocar('mover', 0.6));
      } else if (e.t === 'turno' && c.l[e.o] && c.l[e.o].j === yo) {
        luego(t, () => { sonido.tocar('clic'); if (navigator.vibrate) navigator.vibrate(60); });
      }
    }
    // La barra de vida baja cuando llega el golpe (no antes)
    c.l.forEach((x, i) => {
      const v = vis[i];
      if (!v) return;
      if (metas.has(i)) luego(metas.get(i), () => { v.meta = x.v; });
      else v.meta = x.v;
      if (x.v <= 0 && !metas.has(i)) v.muerto = true;
      if (x.v > 0) v.muerto = false;
    });
    anotar(ev);
  }

  // Registro de texto ("Ana · Tajo giratorio: Bot Toro -15, Bot Lobo -14")
  function anotar(ev) {
    const c = est.c;
    const lista = $('registro');
    const nombreB = (i) => el('b', c.l[i].e ? 'azul' : 'rojo', c.l[i].n);
    let li = null;
    let partes = 0;
    const agregar = (...cosas) => { if (partes++) li.append(', '); li.append(...cosas); };
    const nueva = () => { li = el('li'); partes = 0; lista.prepend(li); return li; };
    for (const e of ev) {
      if (e.t === 'accion') {
        nueva().append(nombreB(e.a), ` · ${nombreDe(c.l[e.a].k, e.h)}`);
        if (e.p >= 0.95) li.append(' ', el('span', 'perfecto', '¡perfecto!'));
        li.append(': ');
      } else if (e.t === 'dano' && li) {
        agregar(nombreB(e.o), ' ', el('span', e.crit ? 'crit' : 'num', `-${e.d}${e.crit ? ' (crítico)' : ''}`));
      } else if (e.t === 'cura' && li) {
        agregar(nombreB(e.o), ' ', el('span', 'cura', `+${e.d}`));
      } else if (e.t === 'esquiva' && li) {
        agregar(nombreB(e.o), ' esquivó');
      } else if (e.t === 'contra' && li) {
        agregar(nombreB(e.a), ' contraatacó');
      } else if (e.t === 'pasiva' && li) {
        agregar(nombreB(e.o), ' resistió con 1 de vida (Último aliento)');
      } else if (e.t === 'cae') {
        if (!li) nueva();
        agregar(nombreB(e.o), ' cayó');
      } else if (e.t === 'efecto' && li) {
        if (e.e === 'at' || e.e === 've') agregar(nombreB(e.o), ` ${NOMBRE_EFECTO[e.e].toLowerCase()}`);
        if (e.e === 'limpio') agregar(nombreB(e.o), ' purificado');
      } else if (e.t === 'veneno') {
        nueva().append('Veneno: ', nombreB(e.o), ' ', el('span', 'num', `-${e.d}`));
      } else if (e.t === 'aturdido') {
        nueva().append(nombreB(e.o), ' está aturdido y pierde el turno');
      } else if (e.t === 'tiempo') {
        nueva().append(nombreB(e.o), ' se quedó sin tiempo');
        li = null;
      }
    }
    // Quita el ": " de las acciones sin efectos visibles (Provocar, Muro…)
    for (const item of lista.children) if (item.lastChild && item.lastChild.nodeType === 3 && item.lastChild.textContent === ': ') item.lastChild.remove();
    while (lista.children.length > 30) lista.lastChild.remove();
  }

  function avisoCentro(texto) {
    const a = $('avisoCentro');
    a.textContent = texto;
    a.hidden = !texto;
  }

  // ---------------- Fin ----------------
  function mostrarFin(espera) {
    if (finMostrado) return;
    finMostrado = true;
    setTimeout(() => {
      if (!est || est.fase !== 'fin') return;
      const c = est.c;
      const i = miLuchador();
      const miEquipo = i >= 0 ? c.l[i].e : null;
      const titulo = $('tituloFin');
      titulo.className = '';
      if (c.g === 2) titulo.textContent = 'Empate';
      else if (miEquipo === null) titulo.textContent = `Ganó el equipo ${EQUIPOS[c.g]}`;
      else if (c.g === miEquipo) { titulo.textContent = '¡Victoria!'; titulo.className = 'gana'; sonido.tocar('ganar'); }
      else { titulo.textContent = 'Derrota'; titulo.className = 'pierde'; sonido.tocar('perder', 0.7); }
      const rondas = `${c.r} ${c.r === 1 ? 'ronda' : 'rondas'}`;
      const ganadorSolo = c.l.length === 2 && c.g !== 2 ? c.l.find((x) => x.e === c.g).n : null;
      $('textoFin').textContent = c.g === 2 ? 'Nadie cayó y quedaron con la misma vida.' : ganadorSolo ? `${ganadorSolo} se quedó con la arena en ${rondas}.` : `El equipo ${EQUIPOS[c.g]} se quedó con la arena en ${rondas}.`;
      const cuerpo = $('tablaFin');
      cuerpo.replaceChildren();
      [...c.l].sort((a, b) => b.dano - a.dano).forEach((x) => {
        const tr = el('tr', x.j === yo ? 'yo' : '');
        const td = el('td');
        td.append(el('span', x.e ? 'azul' : 'rojo', x.n), ` · ${clases[x.k].nombre}${x.j ? '' : ' (bot)'}`);
        tr.append(td, el('td', '', String(x.dano)), el('td', '', String(x.cura || 0)), el('td', '', String(x.bajas)));
        cuerpo.append(tr);
      });
      const soyAnf = est.anf === yo;
      $('btnOtra').hidden = !soyAnf;
      $('btnOtra').disabled = false;
      $('notaOtra').textContent = soyAnf ? 'Vuelven todos a la sala con los mismos puestos.' : `Esperando a que ${nombreAnfitrion()} prepare otra partida…`;
      $('capaFin').hidden = false;
    }, espera);
  }

  preparar();
})();
