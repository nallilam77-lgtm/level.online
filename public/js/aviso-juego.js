// =========================================================================
// AVISO DE LA TIENDA (las 7 tiendas). El administrador lo escribe en admin.html → Ajustes →
// "Avisos en las tiendas" y elige para qué juego es (o "todas"). Se guarda en Supabase:
// configuracion "avisos_juegos" (publico) = { <juego>|todas: { titulo, texto, activo, id } }.
// Al entrar a la tienda sale una ventana con el aviso del juego (y el de "todas", si hay); con
// "Entendido" no vuelve a salir en esa visita (sessionStorage con el id: un aviso nuevo sí sale).
// Uso: <script src="/js/aviso-juego.js?v=1" data-juego="freefire" defer></script>
// Estilos en css/aviso-juego.css (se carga solo si hay aviso). Sin aviso o sin Supabase: no hace nada.
// =========================================================================
(function () {
  const script = document.currentScript;
  const JUEGO = script && script.dataset.juego;
  const CLAVE_CONFIG = 'levelup_sesion_config';   // la misma que js/sesion.js y js/datos-pago.js
  const CLAVE_VISTO = 'levelup_aviso_juego_visto';
  const CSS = '/css/aviso-juego.css?v=1';
  if (!JUEGO) return;

  // Se pinta con textContent: basta con quitar caracteres de control y cortar el largo
  const limpio = (v, max) => String(v || '').replace(/[\u0000-\u0009\u000b-\u001f]/g, ' ').trim().slice(0, max);

  async function configuracion() {
    try {
      const c = JSON.parse(sessionStorage.getItem(CLAVE_CONFIG) || 'null');
      if (c && c.supabaseUrl) return c;
    } catch (e) { /* sigue */ }
    const c = await (await fetch('/api/version?config=1')).json();
    try { sessionStorage.setItem(CLAVE_CONFIG, JSON.stringify(c)); } catch (e) { /* sin almacenamiento */ }
    return c;
  }

  async function leerAvisos() {
    const c = await configuracion();
    if (!c || !c.supabaseUrl || !c.supabaseKey) return [];
    const res = await fetch(`${c.supabaseUrl}/rest/v1/configuracion?select=valor&clave=eq.avisos_juegos`, {
      headers: { apikey: c.supabaseKey, Accept: 'application/json' },
    });
    if (!res.ok) return [];
    const valor = ((await res.json())[0] || {}).valor || {};
    return [valor[JUEGO], valor.todas]
      .filter((a) => a && a.activo && limpio(a.texto, 600))
      .map((a) => ({ id: String(a.id || ''), titulo: limpio(a.titulo, 80) || 'Aviso', texto: limpio(a.texto, 600) }));
  }

  function vistos() {
    try { return JSON.parse(sessionStorage.getItem(CLAVE_VISTO) || '[]'); } catch (e) { return []; }
  }
  function marcarVisto(ids) {
    try { sessionStorage.setItem(CLAVE_VISTO, JSON.stringify([...new Set([...vistos(), ...ids])].slice(-20))); } catch (e) { /* sin almacenamiento */ }
  }

  function cargarCss() {
    return new Promise((listo) => {
      const l = document.createElement('link');
      l.rel = 'stylesheet';
      l.href = CSS;
      l.onload = l.onerror = listo;
      document.head.appendChild(l);
    });
  }

  function mostrar(avisos) {
    const fondo = document.createElement('div');
    fondo.className = 'aviso-juego-fondo';
    const caja = document.createElement('div');
    caja.className = 'aviso-juego';
    caja.setAttribute('role', 'dialog');
    caja.setAttribute('aria-modal', 'true');
    caja.setAttribute('aria-labelledby', 'avisoJuegoTitulo');
    avisos.forEach((a, i) => {
      const h = document.createElement('h2');
      h.className = 'aviso-juego-titulo';
      if (i === 0) h.id = 'avisoJuegoTitulo';
      h.textContent = a.titulo;
      const p = document.createElement('p');
      p.className = 'aviso-juego-texto';
      p.textContent = a.texto;
      caja.append(h, p);
    });
    const boton = document.createElement('button');
    boton.type = 'button';
    boton.className = 'aviso-juego-boton';
    boton.textContent = 'Entendido';
    caja.append(boton);
    fondo.append(caja);

    const yaHabiaModal = document.body.classList.contains('modal-abierto');
    const cerrar = () => {
      marcarVisto(avisos.map((a) => a.id));
      fondo.remove();
      document.removeEventListener('keydown', alTeclado);
      if (!yaHabiaModal) document.body.classList.remove('modal-abierto');
    };
    const alTeclado = (ev) => { if (ev.key === 'Escape') cerrar(); };
    boton.addEventListener('click', cerrar);
    fondo.addEventListener('click', (ev) => { if (ev.target === fondo) cerrar(); });
    document.addEventListener('keydown', alTeclado);
    document.body.classList.add('modal-abierto');   // oculta WhatsApp y el mini anuncio mientras está abierto
    document.body.append(fondo);
    boton.focus();
  }

  async function iniciar() {
    try {
      const ya = vistos();
      const avisos = (await leerAvisos()).filter((a) => !ya.includes(a.id));
      if (!avisos.length) return;
      await cargarCss();
      mostrar(avisos);
    } catch (e) { /* sin aviso: la tienda sigue igual */ }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar);
  else iniciar();
})();
