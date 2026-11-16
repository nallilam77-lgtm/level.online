// =========================================================================
// TIENDA EN MANTENIMIENTO. El administrador lo enciende en admin.html → Ajustes → "Tienda en
// mantenimiento": configuracion "mantenimiento" (publico) = { activo, desde }.
//   - En el inicio, las tiendas, canjear y minijuego: si está encendido, lleva a /mantenimiento.html.
//   - En /mantenimiento.html: si ya está apagado, vuelve al inicio.
// Para mirar la tienda durante el mantenimiento: abrir cualquier página con ?probar=1 (vale hasta
// cerrar la pestaña). Si Supabase no responde, no hace nada (la tienda nunca queda bloqueada por esto).
// Uso: <script src="/js/mantenimiento.js?v=1" async></script> en el <head>.
// =========================================================================
(function () {
  const CLAVE_CONFIG = 'levelup_sesion_config';   // la misma que js/sesion.js y js/datos-pago.js
  const CLAVE_SALTAR = 'levelup_saltar_mantenimiento';
  const PAGINA = '/mantenimiento.html';
  const enMantenimiento = /\/mantenimiento(\.html)?$/.test(location.pathname);

  try {
    if (/[?&]probar=1(&|$)/.test(location.search)) sessionStorage.setItem(CLAVE_SALTAR, '1');
    if (!enMantenimiento && sessionStorage.getItem(CLAVE_SALTAR)) return;
  } catch (e) { /* sin almacenamiento: se revisa igual */ }

  async function configuracion() {
    try {
      const c = JSON.parse(sessionStorage.getItem(CLAVE_CONFIG) || 'null');
      if (c && c.supabaseUrl) return c;
    } catch (e) { /* sigue */ }
    const c = await (await fetch('/api/version?config=1')).json();
    try { sessionStorage.setItem(CLAVE_CONFIG, JSON.stringify(c)); } catch (e) { /* sin almacenamiento */ }
    return c;
  }

  (async function revisar() {
    try {
      const c = await configuracion();
      if (!c || !c.supabaseUrl || !c.supabaseKey) return;
      const res = await fetch(`${c.supabaseUrl}/rest/v1/configuracion?select=valor&clave=eq.mantenimiento`, {
        headers: { apikey: c.supabaseKey, Accept: 'application/json' },
      });
      if (!res.ok) return;
      const valor = ((await res.json())[0] || {}).valor;
      const activo = !!(valor && valor.activo === true);
      if (activo && !enMantenimiento) location.replace(PAGINA);
      else if (!activo && enMantenimiento) location.replace('/');
    } catch (e) { /* Supabase no respondió: la página sigue igual */ }
  })();
})();
