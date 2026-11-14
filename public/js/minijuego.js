// =========================================================================
// MINIJUEGO "LLUVIA DE DIAMANTES" (minijuego.html). Módulo ES.
// Reglas y física: js/lluvia-motor.js (el MISMO archivo que usa el servidor para repetir la partida).
// Aquí solo: pedir la partida al servidor (cobra las fichas y da la semilla), jugarla en pantalla,
// mandar el registro de movimientos al terminar y mostrar lo que el servidor calculó.
// Fichas, ranking y partidas: /api/minijuego (Supabase). Requiere sesión (js/sesion.js agrega el token).
// PRÁCTICA (desde 2026-11-14): "Practicar gratis" juega una partida solo en el teléfono, sin sesión, sin
// gastar fichas y sin mandar nada al servidor: los puntos no cuentan para nada.
// =========================================================================
import {
  W, H, SUELO, COFRE_Y, COFRE_MEDIO, DURACION_S, PASO, OBJETOS, X_MIN, X_MAX,
  partidaNueva, paso, segundos, multiplicador,
} from './lluvia-motor.js?v=2';

const $ = (id) => document.getElementById(id);
// El juego exige sesión: sin ella se va a iniciar sesión y vuelve aquí solo (perfil.js, "entrar=1")
const LOGIN = '/perfil.html?volver=%2Fminijuego.html&entrar=1';
// Sin bucles: si ya se fue a iniciar sesión hace menos de 30 s y el servidor sigue sin aceptar la sesión
// (p. ej. se cerró en otro equipo pero el teléfono la guarda), no se vuelve a redirigir: se muestra
// "Inicia sesión" y ese botón cierra la sesión vieja antes de ir a entrar de nuevo.
function irALogin() {
  let ultimo = 0;
  try { ultimo = Number(sessionStorage.getItem('lluvia_ir_login')) || 0; } catch (e) { /* sin almacenamiento */ }
  if (Date.now() - ultimo < 30000) return mostrarCapa('capaEntrar');
  try { sessionStorage.setItem('lluvia_ir_login', String(Date.now())); } catch (e) { /* sin almacenamiento */ }
  location.replace(LOGIN);
}
const API = '/api/minijuego';
const CAPAS = ['capaCargando', 'capaEntrar', 'capaInicio', 'capaSinFichas', 'capaFin', 'capaError'];

let info = { fichas: 0, costo: 4, bsPorFicha: 780, sesion: false, cierre: null };
let estado = null;          // partida en pantalla (del motor)
let idPartida = '';
let avisoPausaHasta = 0;    // aviso "no salgas del juego" (visibilitychange)
let envioPendiente = null;  // { id, registro, puntos, fin } si falló el envío al terminar (también en el teléfono)
let claveJugar = '';        // una por cada "Jugar": si se corta y se reintenta, el servidor da la MISMA partida
let ocupado = false;
let practica = false;        // partida de práctica en pantalla (no se cobra ni se envía)
const CLAVE_ENVIO = 'lluvia_envio_pendiente';
const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));
const nuevaClave = () => (crypto.randomUUID ? crypto.randomUUID()
  : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)));

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
  $('tutCosto').textContent = info.costo;
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
  const conSesion = !!(window.Sesion && Sesion.hay());
  mostrarCapa('capaCargando');
  try {
    const r = await api(API);
    if (!r.activo) return error('El juego no está disponible por ahora.');
    info = { fichas: r.fichas, costo: r.costo, bsPorFicha: r.bsPorFicha, sesion: r.sesion, cierre: r.cierre };
    pintarFichas(); pintarRanking(r.ranking); cuentaAtras();
    // Sin sesión (o vencida): "Entrar con Google" o "Practicar gratis" (la práctica no necesita cuenta)
    if (!conSesion) return mostrarCapa('capaEntrar');
    if (!r.sesion) return irALogin();   // sesión vencida o no válida
    const guardado = leer(CLAVE_ENVIO, null);
    if (guardado && guardado.id && Array.isArray(guardado.registro)) return enviarResultado(guardado);
    mostrarCapa(info.fichas >= info.costo ? 'capaInicio' : 'capaSinFichas');
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
    practica && ['practica', 'Práctica: no cuenta'],
    !practica && Date.now() < avisoPausaHasta && ['aviso', 'No salgas del juego: una pausa larga anula la partida'],
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
  else if (practica) finPractica();
  else enviarResultado({ id: idPartida, registro: estado.registro, puntos: estado.puntos, fin: estado.fin });
}

// Empieza la partida en pantalla (de verdad o de práctica)
function arrancar(semilla) {
  estado = partidaNueva(semilla);
  destinoX = W / 2; acumulado = 0;
  mostrarCapa(null);
  $('canvas').closest('.juego').classList.toggle('juego--practica', practica);
  pintarHud();
  // En el teléfono, que el juego quede entero a la vista
  $('canvas').closest('.juego').scrollIntoView({ block: 'end', behavior: 'auto' });
  cancelAnimationFrame(animacion);
  ultimo = performance.now();
  animacion = requestAnimationFrame(bucle);
}

// Práctica: semilla al azar en el teléfono; nada de servidor, fichas ni ranking
function practicar() {
  if (ocupado || !$('tutorial').hidden) return;
  if (envioPendiente) return enviarResultado(envioPendiente);   // primero, la partida de verdad sin enviar
  practica = true;
  const n = new Uint32Array(1);
  crypto.getRandomValues(n);
  arrancar(n[0]);
}

function finPractica() {
  practica = false;
  $('canvas').closest('.juego').classList.remove('juego--practica');
  $('finTitulo').textContent = estado.fin === 'tiempo' ? '¡Práctica terminada!' : '¡Sin vidas! (práctica)';
  $('finPuntos').textContent = numero(estado.puntos);
  $('finTexto').textContent = 'Era una práctica: no gastó fichas ni cuenta para el ranking.';
  $('btnOtra').textContent = !info.sesion ? 'Entrar para jugar por el premio'
    : info.fichas >= info.costo ? `Jugar en serio · ${info.costo} fichas` : 'Recargar para jugar';
  $('btnOtra').hidden = false;
  mostrarCapa('capaFin');
}

async function jugar() {
  if (ocupado || !$('tutorial').hidden) return;
  if (envioPendiente) return enviarResultado(envioPendiente);
  ocupado = true;
  $('btnJugar').disabled = true; $('btnOtra').disabled = true;
  if (!claveJugar) claveJugar = nuevaClave();
  try {
    // Si se corta la conexión, un reintento con la misma clave: el servidor no cobra dos veces
    let r;
    try { r = await api(`${API}?accion=empezar`, { clave: claveJugar }); }
    catch (e) { await espera(1500); r = await api(`${API}?accion=empezar`, { clave: claveJugar }); }
    if (r.http === 401) return irALogin();
    if (r.status === 'success' || r.sinFichas) claveJugar = '';
    if (r.sinFichas) { info.fichas = r.fichas; info.costo = r.costo; pintarFichas(); return mostrarCapa('capaSinFichas'); }
    if (r.status !== 'success') return error(r.message || 'No se pudo empezar la partida.');
    info.fichas = r.fichas; pintarFichas();
    idPartida = r.id;
    practica = false;
    arrancar(r.semilla);
  } catch (e) {
    // claveJugar se conserva: "Reintentar" recupera la misma partida si ya se había cobrado
    error('Sin conexión. Toca Reintentar: si la partida ya se cobró, no se cobra otra vez.');
  } finally {
    ocupado = false;
    $('btnJugar').disabled = false; $('btnOtra').disabled = false;
  }
}

async function enviarResultado(envio) {
  envioPendiente = envio;
  guardar(CLAVE_ENVIO, envio);   // si se cierra la página o vence la sesión, se envía al volver
  $('finTitulo').textContent = envio.fin === 'tiempo' ? '¡Tiempo!' : '¡Sin vidas!';
  $('finPuntos').textContent = numero(envio.puntos);
  $('finTexto').textContent = 'Comprobando…';
  $('btnOtra').hidden = true;
  mostrarCapa('capaFin');
  try {
    // Hasta 3 intentos (la conexión móvil a veces se corta un momento)
    let r = null;
    for (let intento = 0; intento < 3 && !r; intento++) {
      if (intento) await espera(intento * 2000);
      try { r = await api(`${API}?accion=terminar`, envio); } catch (e) { r = null; }
    }
    if (!r) throw new Error('sin conexión');
    if (r.http === 401) return irALogin();   // la partida queda guardada y se envía al volver
    // Ya terminada (se envió antes) o no existe: no hay nada más que hacer con ella
    if (r.http === 409 || r.http === 404 || r.http === 400) {
      envioPendiente = null; try { localStorage.removeItem(CLAVE_ENVIO); } catch (e) { /* sin almacenamiento */ }
      $('finTexto').textContent = r.http === 409 ? 'Esta partida ya estaba registrada.' : 'No pudimos registrar esta partida.';
      $('btnOtra').textContent = info.fichas >= info.costo ? `Jugar · ${info.costo} fichas` : 'Recargar';
      $('btnOtra').hidden = false;
      return;
    }
    if (r.status !== 'success') throw new Error(r.message || 'falló');
    envioPendiente = null;
    try { localStorage.removeItem(CLAVE_ENVIO); } catch (e) { /* sin almacenamiento */ }
    $('finPuntos').textContent = numero(r.puntos);
    $('finTexto').textContent = !r.valida
      ? (r.motivo || 'Partida no válida: no cuenta.')
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
  if (!info.sesion) return entrarConGoogle();
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
// Salir del juego a mitad de partida (cambiar de app): el juego se detiene, pero si la pausa es larga la
// partida no cuenta (el servidor compara el tiempo real con el del juego). Al volver se avisa.
let salioA = 0;
document.addEventListener('visibilitychange', () => {
  if (!estado || !estado.jugando) return;
  if (document.hidden) { salioA = Date.now(); return; }
  if (salioA && Date.now() - salioA > 1500) avisoPausaHasta = Date.now() + 4000;   // pintarHud lo muestra
  salioA = 0;
});
// Salir a mitad de partida la pierde: se avisa
window.addEventListener('beforeunload', (ev) => { if ((estado && estado.jugando && !practica) || envioPendiente) { ev.preventDefault(); ev.returnValue = ''; } });
$('btnJugar').addEventListener('click', jugar);
$('btnOtra').addEventListener('click', otra);
$('btnReintentar').addEventListener('click', cargar);
// Entrar: si había una sesión vieja guardada, primero se cierra en este teléfono (si no, volvía aquí sin entrar)
async function entrarConGoogle() {
  try { if (window.Sesion && Sesion.hay()) await Sesion.salir(); } catch (e) { /* igual se va a entrar */ }
  location.href = LOGIN;
}
$('btnEntrar').addEventListener('click', (ev) => { ev.preventDefault(); entrarConGoogle(); });
document.querySelectorAll('[data-practicar]').forEach((b) => b.addEventListener('click', practicar));

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
