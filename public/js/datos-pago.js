// Datos de Pago Móvil que ven los clientes (las 7 tiendas y el perfil).
// Desde 2026-11-15 salen de Supabase: configuracion "pago_movil" (publico), que es la cuenta ACTIVA que se
// elige en admin.html → Pagos → "Pago Móvil que ven los clientes" (hay dos guardadas y se usa una).
// Si Supabase no responde, se usa la copia vieja de Firestore (configuracion/pago_movil) para que la
// página nunca quede sin datos de pago. Sin SDK: un fetch a la API REST (la página no espera librerías).
(function () {
  const CLAVE_CONFIG = 'levelup_sesion_config';   // la misma que js/sesion.js (URL y llave pública de Supabase)
  const PROYECTO = 'levelupstore-87d4d';
  const CLAVE_WEB = 'AIzaSyBIdEh_HzzB8dnzG8qkPQYOIo2kSb_F6xQ'; // clave pública de la app web de Firebase
  const URL_FIRESTORE = `https://firestore.googleapis.com/v1/projects/${PROYECTO}/databases/(default)/documents/configuracion/pago_movil?key=${CLAVE_WEB}`;

  // Las tiendas pintan estos datos con innerHTML: solo letras, números, espacios y . - ( ) /
  const limpio = (v) => String(v ?? '').replace(/[^\p{L}\p{N} .\-()/]/gu, '').trim().slice(0, 60);
  const completo = (d) => (d && d.banco && d.telefono && d.cedula ? d : null);

  async function configuracion() {
    try {
      const c = JSON.parse(sessionStorage.getItem(CLAVE_CONFIG) || 'null');
      if (c && c.supabaseUrl) return c;
    } catch (e) { /* sigue */ }
    const c = await (await fetch('/api/version?config=1')).json();
    try { sessionStorage.setItem(CLAVE_CONFIG, JSON.stringify(c)); } catch (e) { /* sin almacenamiento */ }
    return c;
  }

  async function deSupabase() {
    const c = await configuracion();
    if (!c || !c.supabaseUrl || !c.supabaseKey) return null;
    const res = await fetch(`${c.supabaseUrl}/rest/v1/configuracion?select=valor&clave=eq.pago_movil`, {
      headers: { apikey: c.supabaseKey, Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const v = ((await res.json())[0] || {}).valor || {};
    return completo({ banco: limpio(v.banco), telefono: limpio(v.telefono), cedula: limpio(v.cedula) });
  }

  async function deFirestore() {
    const res = await fetch(URL_FIRESTORE);
    if (!res.ok) return null;
    const campos = (await res.json()).fields || {};
    const texto = (nombre) => limpio(campos[nombre] ? (campos[nombre].stringValue ?? campos[nombre].integerValue ?? '') : '');
    return completo({ banco: texto('banco'), telefono: texto('telefono'), cedula: texto('cedula') });
  }

  // Devuelve { banco, telefono, cedula } o null si no hay forma de leerlos
  async function leer() {
    try {
      const d = await deSupabase();
      if (d) return d;
    } catch (e) { /* Supabase no respondió: copia de Firestore */ }
    try {
      return await deFirestore();
    } catch (e) {
      return null;
    }
  }

  window.DatosPago = { leer };
})();
