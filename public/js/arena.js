// =========================================================================
// ARENA (arena.html): duelo rápido, torneo pagado, mis partidas, ranking y avisos. juego-servidor/ARENA.md
//   - Configuración e inscripción: /api/juego?accion=arena_config / arena_inscribir (api/_lib/arena.js)
//   - Mis partidas y ranking: Supabase directo (arena_mias con la sesión; arena_ranking_semana es público)
//   - Avisos: Web Push (sw.js los muestra) → /api/juego?accion=arena_push
// Todo lo que viene de la base o del cliente se pinta con textContent.
// =========================================================================
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const el = (tag, clase, texto) => { const e = document.createElement(tag); if (clase) e.className = clase; if (texto !== undefined) e.textContent = texto; return e; };
  const bs = (n) => Number(n).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const hora = (iso) => new Date(iso).toLocaleTimeString('es-VE', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Caracas' });
  const dia = (iso) => {
    const f = (d) => new Date(d).toLocaleDateString('es-VE', { timeZone: 'America/Caracas' });
    return f(iso) === f(Date.now()) ? 'hoy' : f(iso) === f(Date.now() + 86400000) ? 'mañana' : `el ${f(iso)}`;
  };
  const leerSes = (k) => { try { return sessionStorage.getItem(k); } catch (e) { return null; } };
  const guardarSes = (k, v) => { try { if (v === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch (e) { /* sin almacenamiento */ } };
  const NOMBRE_JUEGO = { freefire: 'Free Fire', bloodstrike: 'Blood Strike', mobilelegends: 'Mobile Legends' };

  let config = null;
  let modo = '1v1';
  let juego = null;              // { juego, nombre, paquete, precio, zona }
  let enviando = false;

  const conSesion = () => !!(window.Sesion && window.Sesion.hay());

  // ------------------------------------------------------------------ inicio
  async function iniciar() {
    $('bloqueSesion').hidden = conSesion();
    $('btnRapido').addEventListener('click', (e) => { if (!conSesion()) { e.preventDefault(); $('bloqueSesion').hidden = false; $('bloqueSesion').scrollIntoView({ behavior: 'smooth' }); } });
    const d = window.Sesion && window.Sesion.datos();
    if (d && d.nombre) $('nombreArena').value = (localStorage.getItem('duelo_nombre') || d.nombre.split(' ')[0]).slice(0, 14);
    cargarRanking();
    cargarConfig();
    if (conSesion()) { cargarMias(); setInterval(() => { if (document.visibilityState === 'visible') cargarMias(); }, 30000); prepararAvisos(); }
  }

  // ------------------------------------------------------------------ torneo
  async function cargarConfig() {
    try {
      const r = await (await fetch('/api/juego?accion=arena_config', { cache: 'no-store' })).json();
      if (r.status !== 'success') throw new Error(r.message);
      config = r;
    } catch (e) {
      $('notaTorneo').textContent = 'El torneo no está disponible en este momento. Vuelve más tarde.';
      return;
    }
    if (!config.activo) { $('notaTorneo').textContent = 'El torneo está cerrado por ahora. Mientras, juega duelos rápidos y sube en el ranking.'; return; }
    $('notaTorneo').textContent = 'Paga la inscripción y te emparejamos con un rival del mismo modo y juego. El que gane se lleva el doble.';
    const caja = $('juegos');
    caja.replaceChildren(...config.juegos.map((j) => {
      const b = el('button', 'juego-opcion');
      b.type = 'button';
      b.dataset.juego = j.juego;
      b.append(el('strong', '', j.nombre), el('span', '', `${j.paquete} · ${bs(j.precio)} Bs`));
      b.addEventListener('click', () => elegirJuego(j));
      return b;
    }));
    document.querySelectorAll('.segmento').forEach((b) => b.addEventListener('click', () => {
      modo = b.dataset.modo;
      document.querySelectorAll('.segmento').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      pintarPremio();
    }));
    elegirJuego(config.juegos.find((j) => j.juego === localStorage.getItem('arena_juego')) || config.juegos[0]);
    $('formTorneo').hidden = false;
    pintarPago();
  }

  function elegirJuego(j) {
    juego = j;
    try { localStorage.setItem('arena_juego', j.juego); } catch (e) { /* */ }
    document.querySelectorAll('.juego-opcion').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.juego === j.juego)));
    $('etiquetaId').textContent = `Tu ID de ${j.nombre}`;
    $('campoZona').hidden = !j.zona;
    const guardado = localStorage.getItem('arena_id_' + j.juego);
    if (guardado) $('idJugador').value = guardado;
    $('montoPago').textContent = `${bs(j.precio)} Bs`;
    pintarPremio();
  }

  function pintarPremio() {
    if (!juego) return;
    const quien = modo === '2v2' ? 'Cada jugador del equipo ganador recibe' : 'El ganador recibe';
    $('textoPremio').replaceChildren(`${quien} `, el('strong', '', `2 × ${juego.paquete}`), ` de ${juego.nombre}. Al mejor de 3.`);
  }

  async function pintarPago() {
    const datos = window.DatosPago ? await window.DatosPago.leer() : null;
    const caja = $('datosPago');
    if (!datos) { caja.replaceChildren(el('div', '', 'No pudimos cargar los datos de pago. Escríbenos por WhatsApp.')); return; }
    window.DatosPago.selector(caja, datos, (c) => {
      caja.replaceChildren(...[['Banco', c.banco], ['Teléfono', c.telefono], ['Cédula', c.cedula]].map(([t, v]) => {
        const fila = el('div');
        const copiar = el('button', 'copiar', 'Copiar');
        copiar.type = 'button';
        copiar.addEventListener('click', async () => {
          try { await navigator.clipboard.writeText(t === 'Banco' ? String(v) : String(v).replace(/\D/g, '')); copiar.textContent = '¡Listo!'; } catch (e) { copiar.textContent = 'Cópialo'; }
          setTimeout(() => { copiar.textContent = 'Copiar'; }, 1500);
        });
        fila.append(el('dt', '', t), el('dd', '', v), copiar);
        return fila;
      }));
    });
  }

  function mensaje(texto, tipo) {
    const m = $('mensajeTorneo');
    m.textContent = texto;
    m.className = 'mensaje' + (tipo ? ' mensaje--' + tipo : '');
    m.hidden = !texto;
  }

  $('formTorneo').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (enviando || !juego) return;
    if (!conSesion()) { $('bloqueSesion').hidden = false; $('bloqueSesion').scrollIntoView({ behavior: 'smooth' }); return; }
    const id = $('idJugador').value.trim();
    const zona = $('zona').value.trim();
    const nombre = $('nombreArena').value.trim();
    const referencia = $('referencia').value.trim();
    if (!/^\d{5,15}$/.test(id)) { mensaje(`Escribe tu ID de ${juego.nombre} (solo números).`, 'error'); return; }
    if (juego.zona && !/^\d{2,6}$/.test(zona)) { mensaje('Escribe tu Zona ID (solo números).', 'error'); return; }
    if (!nombre) { mensaje('Escribe tu nombre para la partida.', 'error'); return; }
    if (!/^\d{5}$/.test(referencia)) { mensaje('La referencia son los últimos 5 números del Pago Móvil.', 'error'); return; }
    // El mismo id para los reintentos de esta referencia: si algo falla a mitad, no se cobra dos veces
    const claveId = `arena_insc_${referencia}`;
    let idInscripcion = leerSes(claveId);
    if (!idInscripcion) { idInscripcion = crypto.randomUUID(); guardarSes(claveId, idInscripcion); }
    enviando = true;
    $('btnInscribir').disabled = true;
    $('btnInscribir').textContent = 'Revisando tu pago…';
    mensaje('');
    try {
      const token = await window.Sesion.token();
      const res = await fetch('/api/juego?accion=arena_inscribir', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ idInscripcion, modo, juego: juego.juego, id, zona, nombre, referencia }),
      });
      const r = await res.json();
      if (r.status === 'success') {
        guardarSes(claveId, null);
        try { localStorage.setItem('arena_id_' + juego.juego, id); localStorage.setItem('duelo_nombre', nombre); } catch (err) { /* */ }
        $('referencia').value = '';
        mensaje(r.message, 'ok');
        cargarMias();
        $('bloqueMias').scrollIntoView({ behavior: 'smooth' });
      } else {
        if (!r.reintentar) guardarSes(claveId, null);
        mensaje(r.message || 'No se pudo inscribir. Intenta de nuevo.', 'error');
      }
    } catch (err) {
      mensaje('Sin conexión. Revisa tu internet e intenta de nuevo (no se cobra dos veces).', 'error');
    } finally {
      enviando = false;
      $('btnInscribir').disabled = false;
      $('btnInscribir').textContent = 'Inscribirme';
    }
  });

  // ------------------------------------------------------------------ mis partidas
  async function cliente() { return window.Sesion ? window.Sesion.cliente() : null; }

  async function cargarMias() {
    const c = await cliente();
    if (!c) return;
    const { data, error } = await c.rpc('arena_mias');
    if (error) return;
    const lista = $('listaMias');
    $('bloqueMias').hidden = false;
    if (!data || !data.length) { lista.replaceChildren(el('li', 'vacio', 'Todavía no te has inscrito en un torneo.')); return; }
    lista.replaceChildren(...data.map(tarjetaPartida));
  }

  function tarjetaPartida(p) {
    const li = el('li', 'partida partida--' + p.estado);
    const cabeza = el('div', 'partida-cabeza');
    cabeza.append(el('strong', '', `${p.modo === '2v2' ? '2 vs 2' : '1 vs 1'} · ${NOMBRE_JUEGO[p.juego] || p.juego}`), el('span', 'etiqueta', etiqueta(p)));
    li.append(cabeza);
    const miEquipo = p.puesto >= 2 ? 1 : 0;
    const rivales = (p.jugadores || []).filter((j) => (j.puesto >= 2 ? 1 : 0) !== miEquipo).map((j) => j.nombre);
    const companero = (p.jugadores || []).filter((j) => (j.puesto >= 2 ? 1 : 0) === miEquipo && j.puesto !== p.puesto).map((j) => j.nombre);
    const detalle = [];
    if (p.estado === 'esperando') detalle.push(`Esperando ${p.modo === '2v2' ? 'jugadores' : 'rival'}. Si nadie se inscribe ${dia(p.vence)} a las ${hora(p.vence)}, te enviamos tu ${p.paquete}.`);
    if (p.hora && (p.estado === 'lista' || p.estado === 'jugando')) detalle.push(`Partida ${dia(p.hora)} a las ${hora(p.hora)}. La sala abre 10 minutos antes.`);
    if (rivales.length) detalle.push(`Rival${rivales.length > 1 ? 'es' : ''}: ${rivales.join(', ')}${companero.length ? ` · Compañero: ${companero.join(', ')}` : ''}`);
    if (p.estado === 'terminada' || p.estado === 'cancelada') {
      if (p.resultado === 'gano') detalle.push(`¡Ganaste ${p.marcador || ''}! Premio: 2 × ${p.paquete} → ${entregaTexto(p.entrega)}`);
      else if (p.resultado === 'perdio') detalle.push(`Perdiste ${p.marcador || ''}. ¡La próxima es tuya!`);
      else if (p.resultado === 'reembolso') detalle.push(`${p.motivo || 'Sin partida'}: tu ${p.paquete} → ${entregaTexto(p.entrega)}`);
    }
    if (p.estado === 'revisar') detalle.push('Estamos revisando esta partida. Si tienes dudas, escríbenos por WhatsApp.');
    detalle.push(`ID ${p.id_jugador}`);
    for (const t of detalle) li.append(el('span', 'partida-detalle', t));
    if ((p.estado === 'lista' || p.estado === 'jugando') && p.hora) {
      const abre = Date.parse(p.hora) - 10 * 60000;
      const b = el('a', 'btn btn-chico', Date.now() >= abre ? 'Entrar a la partida' : `Abre a las ${hora(abre)}`);
      b.href = `/juego/?a=${encodeURIComponent(p.partida)}`;
      if (Date.now() < abre) { b.classList.add('desactivado'); b.setAttribute('aria-disabled', 'true'); b.addEventListener('click', (e) => e.preventDefault()); }
      li.append(b);
    }
    return li;
  }

  function etiqueta(p) {
    if (p.estado === 'esperando') return 'Esperando rival';
    if (p.estado === 'lista') return 'Lista';
    if (p.estado === 'jugando') return 'Jugando';
    if (p.estado === 'revisar') return 'En revisión';
    if (p.resultado === 'gano') return '🏆 Ganaste';
    if (p.resultado === 'perdio') return 'Perdiste';
    return 'Devuelta';
  }
  const entregaTexto = (e) => (e === 'entregado' ? 'entregado ✅' : e === 'revisar' ? 'en revisión (te escribimos)' : 'enviándose…');

  // ------------------------------------------------------------------ ranking
  async function cargarRanking() {
    const lista = $('ranking');
    let data;
    try {
      const conf = window.Sesion ? await window.Sesion.config() : null;
      const token = conSesion() ? await window.Sesion.token() : '';
      const res = await fetch(`${conf.supabaseUrl}/rest/v1/rpc/arena_ranking_semana`, {
        method: 'POST', headers: { apikey: conf.supabaseKey, Authorization: 'Bearer ' + (token || conf.supabaseKey), 'Content-Type': 'application/json' }, body: '{}',
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      data = await res.json();
    } catch (e) {
      lista.replaceChildren(el('li', 'vacio', 'No se pudo cargar el ranking.'));
      return;
    }
    if (data.semana) $('semanaRanking').textContent = `desde el lunes ${new Date(data.semana + 'T12:00:00').toLocaleDateString('es-VE')}`;
    if (!data.top || !data.top.length) { lista.replaceChildren(el('li', 'vacio', 'Nadie ha sumado puntos esta semana. ¡Sé el primero!')); }
    else {
      lista.replaceChildren(...data.top.map((f) => {
        const li = el('li', f.yo ? 'yo' : '');
        li.append(el('span', 'puesto', `${f.puesto}.`), el('span', 'nombre', f.nombre), el('span', 'puntos', `${f.puntos} pts`), el('span', 'record', `${f.ganadas}G · ${f.perdidas}P`));
        return li;
      }));
    }
    const yo = data.yo;
    $('miPuesto').hidden = !yo;
    if (yo) $('miPuesto').textContent = `Tu puesto: ${yo.puesto}.º con ${yo.puntos} puntos (${yo.ganadas} ganados, ${yo.perdidas} perdidos).`;
  }

  // ------------------------------------------------------------------ avisos (Web Push)
  const base64aBytes = (b64) => {
    const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  };
  async function prepararAvisos() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      $('notaAvisos').hidden = false;
      $('notaAvisos').textContent = /iPhone|iPad/.test(navigator.userAgent)
        ? 'Para recibir avisos en iPhone, instala la tienda como app (Compartir → Agregar a inicio) y entra desde ahí.'
        : 'Este navegador no muestra avisos: revisa aquí la hora de tus partidas.';
      return;
    }
    const reg = await navigator.serviceWorker.register('/sw.js').catch(() => null);
    if (!reg) return;
    const ya = await reg.pushManager.getSubscription();
    if (ya && Notification.permission === 'granted') { guardarSuscripcion(ya); return; }
    if (Notification.permission === 'denied') { $('notaAvisos').hidden = false; $('notaAvisos').textContent = 'Bloqueaste los avisos: actívalos en los permisos del navegador para saber cuándo es tu partida.'; return; }
    $('btnAvisos').hidden = false;
    $('notaAvisos').hidden = false;
    $('notaAvisos').textContent = 'Activa los avisos y te notificamos cuando tu rival pague y 10 minutos antes de tu partida.';
    $('btnAvisos').addEventListener('click', async () => {
      const permiso = await Notification.requestPermission();
      if (permiso !== 'granted') { $('notaAvisos').textContent = 'Sin permiso no podemos avisarte. Revisa aquí la hora de tus partidas.'; return; }
      try {
        if (!config) await cargarConfig();
        const sus = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64aBytes(config.push) });
        await guardarSuscripcion(sus);
        $('btnAvisos').hidden = true;
        $('notaAvisos').textContent = '✅ Avisos activados en este equipo.';
      } catch (e) {
        $('notaAvisos').textContent = 'No se pudieron activar los avisos en este equipo.';
      }
    });
  }
  async function guardarSuscripcion(sus) {
    const token = await window.Sesion.token();
    await fetch('/api/juego?accion=arena_push', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(sus.toJSON()),
    }).catch(() => {});
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar); else iniciar();
})();
