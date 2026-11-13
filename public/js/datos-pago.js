// Datos de Pago Móvil (Supabase: tabla "configuracion", clave "pago_movil"; antes Firestore, hasta
// 2026-11-13). Se leen con la llave PÚBLICA de Supabase por su API REST (sin librería): la tabla deja leer a
// cualquiera solo las filas marcadas "publico" y solo los administradores (admin.html) las cambian.
// La dirección y la llave públicas salen de /api/version?config=1 (la misma configuración que js/sesion.js,
// guardada en sessionStorage). Uso: const datos = await DatosPago.leer();  -> { banco, telefono, cedula } o null
(function () {
  const CLAVE_CONFIG = 'levelup_sesion_config';

  async function configuracion() {
    try {
      const c = JSON.parse(sessionStorage.getItem(CLAVE_CONFIG) || 'null');
      if (c && c.supabaseUrl) return c;
    } catch (e) { /* sigue */ }
    const res = await fetch('/api/version?config=1');
    const c = await res.json();
    try { if (c && c.supabaseUrl) sessionStorage.setItem(CLAVE_CONFIG, JSON.stringify(c)); } catch (e) { /* sin almacenamiento */ }
    return c;
  }

  async function intento() {
    const c = await configuracion();
    if (!c || !c.supabaseUrl || !c.supabaseKey) return null;
    const res = await fetch(`${c.supabaseUrl}/rest/v1/configuracion?clave=eq.pago_movil&select=valor`, {
      headers: { apikey: c.supabaseKey, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const fila = (await res.json())[0];
    const v = (fila && fila.valor) || null;
    if (!v) return null;
    const texto = (x) => String(x == null ? '' : x).slice(0, 60);
    return { banco: texto(v.banco), telefono: texto(v.telefono), cedula: texto(v.cedula) };
  }

  // Devuelve { banco, telefono, cedula } o null si no existe o falla (un reintento: el cliente necesita
  // estos datos para pagar)
  async function leer() {
    try { return await intento(); } catch (e) { /* un reintento */ }
    try { await new Promise((ok) => setTimeout(ok, 800)); return await intento(); } catch (e) { return null; }
  }

  window.DatosPago = { leer };
})();
