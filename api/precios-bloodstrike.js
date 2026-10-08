import { pedirJSON, LECTURA_APPS_SCRIPT, conCache, catalogoValido, cabecerasCachePrecios } from './_lib/externo.js';
import { faltaConfiguracion } from './_lib/validacion.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ status: "error", message: "Método no permitido" });
  }

  const URL_GOOGLE_SCRIPT = process.env.SCRIPT_BLOOD;
  if (!URL_GOOGLE_SCRIPT) {
    return faltaConfiguracion(res, ["SCRIPT_BLOOD"], { status: "error", message: "Error interno al conectar con Google Sheets" });
  }

  try {
    // GET con la acción en la URL para evitar redirecciones de POST.
    // Lectura sin efectos secundarios (20 s con 1 reintento). Con copia en caché el cliente no espera.
    const { datos } = await conCache('precios:bs',
      () => pedirJSON(`${URL_GOOGLE_SCRIPT}?accion=obtener_precios`, { metodo: 'GET', ...LECTURA_APPS_SCRIPT }),
      { esValido: catalogoValido });
    cabecerasCachePrecios(res);
    return res.status(200).json(datos);
  } catch (error) {
    console.error("Error al obtener precios de Blood Strike:", error.message);
    return res.status(503).json({ status: "error", message: "Error interno al conectar con Google Sheets" });
  }
}
