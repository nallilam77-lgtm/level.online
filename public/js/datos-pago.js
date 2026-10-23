// Datos de Pago Móvil (Firestore: configuracion/pago_movil) leídos por la API REST de Firestore.
// Reemplaza al SDK de Firebase en las tiendas: ~300 KB menos de JavaScript y la página no espera
// esa descarga para mostrar el catálogo. Mismas reglas de seguridad que el SDK (lectura sin sesión).
(function () {
  const PROYECTO = 'levelupstore-87d4d';
  const CLAVE_WEB = 'AIzaSyBIdEh_HzzB8dnzG8qkPQYOIo2kSb_F6xQ'; // clave pública de la app web (la misma que usaba el SDK)
  const URL = `https://firestore.googleapis.com/v1/projects/${PROYECTO}/databases/(default)/documents/configuracion/pago_movil?key=${CLAVE_WEB}`;

  // Devuelve { banco, telefono, cedula } o null si no existe o falla
  async function leer() {
    try {
      const res = await fetch(URL);
      if (!res.ok) return null;
      const campos = (await res.json()).fields || {};
      const texto = (nombre) => (campos[nombre] ? String(campos[nombre].stringValue ?? campos[nombre].integerValue ?? '') : '');
      return { banco: texto('banco'), telefono: texto('telefono'), cedula: texto('cedula') };
    } catch (e) {
      return null;
    }
  }

  window.DatosPago = { leer };
})();
