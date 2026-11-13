// =========================================================================
// MINIJUEGO "LLUVIA DE DIAMANTES" (minijuego.html). Módulo ES.
// Reglas y física: js/lluvia-motor.js (el MISMO archivo que usa el servidor para repetir la partida).
// Aquí solo: pedir la partida al servidor (cobra las fichas y da la semilla), jugarla en pantalla,
// mandar el registro de movimientos al terminar y mostrar lo que el servidor calculó.
// Fichas, ranking y partidas: /api/minijuego (Supabase). Requiere sesión (js/sesion.js agrega el token).
// =========================================================================
import {
  W, H, SUELO, COFRE_Y, COFRE_MEDIO, DURACION_S, PASO, OBJETOS, X_MIN, X_MAX,
  partidaNueva, paso, segundos, multiplicador,
} from './lluvia-motor.js?v=1';

const $ = (id) => document.getElementById(id);
const API = '/api/minijuego';
const CAPAS = ['capaCargando', 'capaEntrar', 'capaInicio', 'capaSinFichas', 'capaFin', 'capaError'];

let info = { fichas: 0, costo: 5, bsPorFicha: 780, sesion: false, cierre: null };
let estado = null;          // partida en pantalla (del motor)
let idPartida = '';
let envioPendiente = null;  // { id, registro } si falló el envío al terminar
let ocupado = false;

const leer = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } };
const guardar = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* sin almacenamiento */ } };
const numero = (n) => Number(n || 0).toLocaleString('es-VE');

function mostrarCapa(id) { CAPAS.forEach((c) => { $(c).hidden = c !== id; }); }
function error(texto) { $('errorTexto').textContent = texto; mostrarCapa('capaError'); }

async function api(ruta, cuerpo) {
  const res = await fetch(ruta, cuerpo === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo),
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* sin cuerpo */ }
  if (!data) throw new Error('Sin respuesta');
  data.http = res.status;
  return data;
}

// ------------------------------------------------------------------ fichas y ranking
function pintarFichas() {
  const saldo = info.sesion ? numero(info.fichas) : '–';
  $('saldoFichas').textContent = saldo;
  $('chipFichas').textContent = saldo;
  $('saldoCosto').textContent = `${info.costo} fichas = 1 partida`;
  $('reglaFichas').textContent = `1 ficha por cada ${numero(info.bsPorFicha)} Bs`;
  $('btnJugar').textContent = `Jugar · ${info.costo} fichas`;
  $('sinFichasTexto').textContent = `Tienes ${numero(info.fichas)} de ${info.costo}. Recarga con tu sesión para ganar más.`;
}

function pintarRanking(filas) {
  const lista = $('ranking');
  lista.replaceChildren();
  if (!filas || !filas.length) {
    const li = document.createElement('li');
    li.className = 'ranking-vacio';
    li.textContent = 'Nadie ha jugado esta semana. ¡Sé el primero!';
    lista.append(li);
    return;
  }
  filas.forEach((f) => {
    const li = document.createElement('li');
    if (f.soyYo) li.className = 'tu';
    li.innerHTML = '<span class="pos"></span><span class="nom"></span><span class="pts"></span>';
    li.querySelector('.pos').textContent = f.puesto;
    li.querySelector('.nom').textContent = f.soyYo ? `${f.nombre} (tú)` : f.nombre;
    li.querySelector('.pts').textContent = numero(f.puntos);
    lista.append(li);
  });
}

function cuentaAtras() {
  if (!info.cierre) return;
  let s = Math.max(0, Math.floor((Date.parse(info.cierre) - Date.now()) / 1000));
  const d = Math.floor(s / 86400); s %= 86400;
  const h = Math.floor(s / 3600); s %= 3600;
  $('cuentaAtras').textContent = `${d} d ${h} h ${Math.floor(s / 60)} min`;
}

// Ejemplos con los precios de hoy de Free Fire (si no cargan, la tabla no se muestra)
async function tablaEjemplos() {
  try {
    const res = await fetch('/api/precios');
    const data = await res.json();
    const precio = (p) => Number(String(p.precio || '').replace(/\./g, '').replace(',', '.'));
    const filas = (data.catalogo || []).filter((p) => /^\d+\s+Diamantes$/i.test(String(p.diamantes || '').trim()) && precio(p) > 0).slice(0, 5);
    if (!filas.length) throw new Error('sin paquetes');
    $('tablaFichas').replaceChildren(...filas.map((p) => {
      const tr = document.createElement('tr');
      const fichas = Math.max(1, Math.floor(precio(p) / info.bsPorFicha));
      tr.innerHTML = '<td></td><td></td>';
      tr.children[0].textContent = `${p.diamantes.replace(/\s*Diamantes/i, ' 💎')} · ${numero(precio(p))} Bs`;
      tr.children[1].textContent = `${fichas} ficha${fichas === 1 ? '' : 's'}`;
      return tr;
    }));
  } catch (e) {
    document.querySelector('.tabla-fichas').hidden = true;
  }
}

async function cargar() {
  mostrarCapa('capaCargando');
  try {
    const r = await api(API);
    if (!r.activo) return error('El juego no está disponible por ahora.');
    info = { fichas: r.fichas, costo: r.costo, bsPorFicha: r.bsPorFicha, sesion: r.sesion, cierre: r.cierre };
    pintarFichas(); pintarRanking(r.ranking); cuentaAtras();
    if (!r.sesion) mostrarCapa('capaEntrar');
    else mostrarCapa(info.fichas >= info.costo ? 'capaInicio' : 'capaSinFichas');
  } catch (e) {
    error('No pudimos conectar con el juego. Revisa tu conexión.');
  }
}

// ------------------------------------------------------------------ dibujo
const canvas = $('canvas');
let ctx = canvas.getContext('2d');   // let: el tutorial lo cambia un momento para dibujar los íconos
const css = getComputedStyle(document.documentElement);
const color = (v) => css.getPropertyValue(v).trim();
const C = {
  gema: color('--gema'), oro: color('--gema-oro'), bomba: color('--bomba'),
  granada: color('--granada'), cegadora: color('--cegadora'), escudo: color('--escudo'), lento: color('--lento'), rapido: color('--rapido'),
  texto: color('--text-main'), cian: color('--accent-cyan'), neon: color('--accent-neon'), fondo: color('--bg-deep'),
};
const ligero = document.documentElement.classList.contains('ligero');
(function ajustarLienzo() {
  const dpr = Math.min(window.devicePixelRatio || 1, ligero ? 1.5 : 2);
  canvas.width = W * dpr; canvas.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
})();

function gema(x, y, r, c, giro) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(Math.sin(giro) * 0.25);
  ctx.beginPath(); ctx.moveTo(0, -r); ctx.lineTo(r, -r * 0.2); ctx.lineTo(0, r); ctx.lineTo(-r, -r * 0.2); ctx.closePath();
  ctx.fillStyle = c; ctx.fill();
  ctx.beginPath(); ctx.moveTo(-r, -r * 0.2); ctx.lineTo(r, -r * 0.2); ctx.moveTo(0, -r); ctx.lineTo(-r * 0.35, -r * 0.2); ctx.lineTo(0, r); ctx.lineTo(r * 0.35, -r * 0.2); ctx.closePath();
  ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = 1.2; ctx.stroke();
  ctx.restore();
}
function circulo(x, y, r, relleno, borde) {
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
  if (relleno) { ctx.fillStyle = relleno; ctx.fill(); }
  if (borde) { ctx.strokeStyle = borde; ctx.lineWidth = 3; ctx.stroke(); }
}
function chevrones(x, y, c, abajo) {
  ctx.strokeStyle = c; ctx.lineWidth = 2.5; ctx.lineJoin = 'round';
  const s = abajo ? 1 : -1;
  [-4, 3].forEach((d) => { ctx.beginPath(); ctx.moveTo(x - 6, y + d * s - 3 * s); ctx.lineTo(x, y + d * s + 3 * s); ctx.lineTo(x + 6, y + d * s - 3 * s); ctx.stroke(); });
}
function granada(o, cuerpo, franja) {
  circulo(o.x, o.y, o.r, cuerpo);
  ctx.fillStyle = franja; ctx.fillRect(o.x - o.r + 2, o.y - 2, (o.r - 2) * 2, 4);
  ctx.fillStyle = C.texto; ctx.fillRect(o.x - 3, o.y - o.r - 5, 6, 6);
  ctx.strokeStyle = C.texto; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(o.x + 6, o.y - o.r - 3, 3, 0, Math.PI * 2); ctx.stroke();
}
function dibujarObjeto(o) {
  switch (o.tipo) {
    case 'gema': return gema(o.x, o.y, o.r, C.gema, o.giro);
    case 'oro': return gema(o.x, o.y, o.r, C.oro, o.giro);
    case 'bomba':
      circulo(o.x, o.y, o.r, C.bomba);
      ctx.strokeStyle = C.texto; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(o.x + 6, o.y - o.r + 2); ctx.lineTo(o.x + 10, o.y - o.r - 6); ctx.stroke();
      ctx.fillStyle = C.oro; ctx.fillRect(o.x + 9, o.y - o.r - 9, 3, 3);
      return;
    case 'granada': return granada(o, C.granada, C.fondo);
    case 'cegadora': return granada(o, C.cegadora, C.oro);
    case 'escudo':
      ctx.beginPath();
      ctx.moveTo(o.x, o.y - o.r); ctx.lineTo(o.x + o.r, o.y - o.r * 0.5); ctx.lineTo(o.x + o.r * 0.7, o.y + o.r * 0.5); ctx.lineTo(o.x, o.y + o.r);
      ctx.lineTo(o.x - o.r * 0.7, o.y + o.r * 0.5); ctx.lineTo(o.x - o.r, o.y - o.r * 0.5); ctx.closePath();
      ctx.fillStyle = 'rgba(56,189,248,0.25)'; ctx.fill(); ctx.strokeStyle = C.escudo; ctx.lineWidth = 2.5; ctx.stroke();
      return;
    case 'lento': circulo(o.x, o.y, o.r, null, C.lento); return chevrones(o.x, o.y, C.lento, true);
    case 'rapido': circulo(o.x, o.y, o.r, null, C.rapido); return chevrones(o.x, o.y, C.rapido, false);
  }
}

function dibujar() {
  const e = estado;
  ctx.clearRect(0, 0, W, H);
  ctx.save();
  if (e && e.sacudida > 0) ctx.translate((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8);
  ctx.fillStyle = 'rgba(148,163,184,0.25)';
  const vel = e ? (e.rapido > 0 ? 60 : e.lento > 0 ? 8 : 20) : 20;
  for (let i = 0; i < 30; i++) ctx.fillRect((i * 97) % W, (i * 53 + (e ? segundos(e) * vel : 0)) % H, 2, 2);
  ctx.fillStyle = 'rgba(148,163,184,0.12)'; ctx.fillRect(0, SUELO, W, H - SUELO);
  if (e) {
    e.objetos.forEach(dibujarObjeto);
    e.explosiones.forEach((x) => {
      const p = x.t / 0.4, c = C[x.k] || C.granada;
      ctx.globalAlpha = 1 - p; circulo(x.x, x.y, x.radio * (0.3 + 0.7 * p), null, c);
      ctx.globalAlpha = (1 - p) * 0.25; circulo(x.x, x.y, x.radio * (0.3 + 0.7 * p), c);
      ctx.globalAlpha = 1;
    });
    const grad = ctx.createLinearGradient(e.x - COFRE_MEDIO, 0, e.x + COFRE_MEDIO, 0);
    grad.addColorStop(0, C.cian); grad.addColorStop(1, C.neon);
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.roundRect ? ctx.roundRect(e.x - COFRE_MEDIO, COFRE_Y, COFRE_MEDIO * 2, 16, 6) : ctx.rect(e.x - COFRE_MEDIO, COFRE_Y, COFRE_MEDIO * 2, 16); ctx.fill();
    ctx.fillStyle = 'rgba(15,23,42,0.6)'; ctx.fillRect(e.x - 5, COFRE_Y + 4, 10, 7);
    if (e.escudo > 0) {
      ctx.globalAlpha = e.escudo < 1.5 ? 0.4 + 0.4 * Math.sin(segundos(e) * 20) : 0.9;
      ctx.strokeStyle = C.escudo; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(e.x, COFRE_Y + 10, COFRE_MEDIO + 12, Math.PI * 1.1, Math.PI * 1.9); ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.font = '900 16px Montserrat, sans-serif'; ctx.textAlign = 'center';
    e.textos.forEach((t) => { ctx.globalAlpha = Math.max(0, t.vida / 0.8); ctx.fillStyle = C[t.k] || C.texto; ctx.fillText(t.t, t.x, t.y); });
    ctx.globalAlpha = 1;
  }
  ctx.restore();
  if (e && e.ciego > 0) {   // destello de la cegadora
    ctx.globalAlpha = Math.min(1, e.ciego / 0.08) * 0.97;
    ctx.fillStyle = C.cegadora; ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = 1;
  }
}

function pintarHud() {
  const e = estado;
  $('hudPuntos').textContent = numero(e.puntos);
  $('hudTiempo').textContent = Math.max(0, Math.ceil(DURACION_S - segundos(e)));
  $('hudVidas').textContent = '♥'.repeat(Math.max(0, e.vidas)) || '0';
  $('hudCombo').textContent = 'x' + multiplicador(e);
  const activos = [
    e.escudo > 0 && ['escudo', `Escudo ${Math.ceil(e.escudo)} s`],
    e.lento > 0 && ['lento', `Lento ${Math.ceil(e.lento)} s`],
    e.rapido > 0 && ['rapido', `Rápido ×2 ${Math.ceil(e.rapido)} s`],
  ].filter(Boolean);
  const html = activos.map(([k, t]) => `<span class="efecto efecto--${k}">${t}</span>`).join('');
  if ($('efectos').innerHTML !== html) $('efectos').innerHTML = html;
}

// ------------------------------------------------------------------ partida
let ultimo = 0, animacion = 0, acumulado = 0, destinoX = W / 2;
const teclas = { izq: false, der: false };

function destino() {
  if (teclas.izq) destinoX -= 460 * PASO;
  if (teclas.der) destinoX += 460 * PASO;
  destinoX = Math.max(X_MIN, Math.min(X_MAX, destinoX));
  return Math.round(destinoX);
}

function bucle(t) {
  acumulado += Math.min(0.1, Math.max(0, (t - ultimo) / 1000));   // pestaña en segundo plano: no "salta"
  ultimo = t;
  while (estado.jugando && acumulado >= PASO) { paso(estado, destino()); acumulado -= PASO; }
  pintarHud();
  dibujar();
  if (estado.jugando) animacion = requestAnimationFrame(bucle);
  else enviarResultado({ id: idPartida, registro: estado.registro });
}

async function jugar() {
  if (ocupado || !$('tutorial').hidden) return;
  if (envioPendiente) return enviarResultado(envioPendiente);
  ocupado = true;
  $('btnJugar').disabled = true; $('btnOtra').disabled = true;
  try {
    const r = await api(`${API}?accion=empezar`, {});
    if (r.http === 401) { info.sesion = false; return mostrarCapa('capaEntrar'); }
    if (r.sinFichas) { info.fichas = r.fichas; info.costo = r.costo; pintarFichas(); return mostrarCapa('capaSinFichas'); }
    if (r.status !== 'success') return error(r.message || 'No se pudo empezar la partida.');
    info.fichas = r.fichas; pintarFichas();
    idPartida = r.id;
    estado = partidaNueva(r.semilla);
    destinoX = W / 2; acumulado = 0;
    mostrarCapa(null);
    pintarHud();
    // En el teléfono, que el juego quede entero a la vista
    $('canvas').closest('.juego').scrollIntoView({ block: 'end', behavior: 'auto' });
    cancelAnimationFrame(animacion);
    ultimo = performance.now();
    animacion = requestAnimationFrame(bucle);
  } catch (e) {
    error('No pudimos empezar la partida (tus fichas no se cobraron si no llegó a empezar). Intenta otra vez.');
  } finally {
    ocupado = false;
    $('btnJugar').disabled = false; $('btnOtra').disabled = false;
  }
}

async function enviarResultado(envio) {
  envioPendiente = envio;
  const fin = estado && estado.fin === 'tiempo' ? '¡Tiempo!' : '¡Sin vidas!';
  $('finTitulo').textContent = fin;
  $('finPuntos').textContent = numero(estado ? estado.puntos : 0);
  $('finTexto').textContent = 'Comprobando…';
  $('btnOtra').hidden = true;
  mostrarCapa('capaFin');
  try {
    const r = await api(`${API}?accion=terminar`, envio);
    if (r.status !== 'success') throw new Error(r.message || 'falló');
    envioPendiente = null;
    $('finPuntos').textContent = numero(r.puntos);
    $('finTexto').textContent = !r.valida
      ? 'Partida no válida: no cuenta.'
      : (r.puntos >= r.mejor && r.puntos > 0
        ? `¡Nuevo récord! Puesto ${r.puesto}.`
        : `Tu récord: ${numero(r.mejor)}${r.puesto ? ` · puesto ${r.puesto}` : ''}.`);
    pintarRanking(r.ranking);
    $('btnOtra').textContent = info.fichas >= info.costo ? `Otra · ${info.costo} fichas` : 'Recargar';
  } catch (e) {
    // La partida queda guardada en el teléfono: el botón vuelve a intentar el envío
    $('finTexto').textContent = 'No se pudo enviar. Revisa tu conexión.';
    $('btnOtra').textContent = 'Enviar otra vez';
  }
  $('btnOtra').hidden = false;
}

function otra() {
  if (envioPendiente) return enviarResultado(envioPendiente);
  if (info.fichas < info.costo) { window.location.href = 'index.html'; return; }
  jugar();
}

// Controles: dedo / ratón sobre el área de juego y flechas
function moverA(ev) {
  if (!estado || !estado.jugando) return;
  const caja = canvas.getBoundingClientRect();
  destinoX = ((ev.clientX - caja.left) / caja.width) * W;
}
canvas.addEventListener('pointerdown', (ev) => { moverA(ev); if (canvas.setPointerCapture) canvas.setPointerCapture(ev.pointerId); });
canvas.addEventListener('pointermove', moverA);
window.addEventListener('keydown', (ev) => {
  if (!$('tutorial').hidden || !estado || !estado.jugando) return;
  if (ev.key === 'ArrowLeft' || ev.key === 'a') { teclas.izq = true; ev.preventDefault(); }
  if (ev.key === 'ArrowRight' || ev.key === 'd') { teclas.der = true; ev.preventDefault(); }
});
window.addEventListener('keyup', (ev) => {
  if (ev.key === 'ArrowLeft' || ev.key === 'a') teclas.izq = false;
  if (ev.key === 'ArrowRight' || ev.key === 'd') teclas.der = false;
});
// Salir a mitad de partida la pierde: se avisa
window.addEventListener('beforeunload', (ev) => { if ((estado && estado.jugando) || envioPendiente) { ev.preventDefault(); ev.returnValue = ''; } });
$('btnJugar').addEventListener('click', jugar);
$('btnOtra').addEventListener('click', otra);
$('btnReintentar').addEventListener('click', cargar);

// ------------------------------------------------------------------ tutorial
const GUIA = [
  ['gema', 'Diamante', '+10'],
  ['oro', 'Dorado', '+50'],
  ['bomba', 'Bomba', '−1 vida'],
  ['granada', 'Granada', '−1 vida, zigzag'],
  ['cegadora', 'Cegadora', 'Te ciega un instante'],
  ['escudo', 'Escudo', 'Aguanta 1 golpe.', true],
  ['lento', 'Lento', 'Todo más lento.', true],
  ['rapido', 'Rápido', 'Puntos ×2.', true],
];
GUIA.forEach(([tipo, nombre, efecto, raro]) => {
  const li = document.createElement('li');
  const icono = document.createElement('canvas');
  icono.width = 80; icono.height = 80; icono.setAttribute('aria-hidden', 'true');
  const principal = ctx;
  ctx = icono.getContext('2d'); ctx.scale(2, 2);
  dibujarObjeto({ tipo, x: 20, y: 22, r: OBJETOS[tipo].r, giro: 0 });
  ctx = principal;
  const txt = document.createElement('span');
  const b = document.createElement('strong'); b.textContent = nombre;
  txt.append(b, document.createTextNode(efecto + ' '));
  if (raro) { const r = document.createElement('span'); r.className = 'raro'; r.textContent = 'Raro.'; txt.append(r); }
  li.append(icono, txt);
  $('tutObjetos').append(li);
});

let focoPrevio = null;
function abrirTutorial() { focoPrevio = document.activeElement; $('tutorial').hidden = false; $('btnTutorialOk').focus(); }
function cerrarTutorial() {
  $('tutorial').hidden = true;
  guardar('lluvia_tutorial_visto', true);
  if (focoPrevio && focoPrevio.focus) focoPrevio.focus();
}
document.querySelectorAll('[data-ayuda]').forEach((b) => b.addEventListener('click', abrirTutorial));
$('btnTutorialOk').addEventListener('click', cerrarTutorial);
$('tutorial').addEventListener('click', (ev) => { if (ev.target === $('tutorial')) cerrarTutorial(); });
window.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && !$('tutorial').hidden) cerrarTutorial(); });
if (!leer('lluvia_tutorial_visto', false)) abrirTutorial();

// ------------------------------------------------------------------ arranque
dibujar();
pintarFichas();
cargar().then(tablaEjemplos);
setInterval(cuentaAtras, 30000);
