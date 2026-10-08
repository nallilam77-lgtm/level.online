import { llamarScript, LECTURA_APPS_SCRIPT, conCache, catalogoValido, cabecerasCachePrecios } from './_lib/externo.js';
import { faltaConfiguracion } from './_lib/validacion.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ status: "error", message: "Método no permitido" });

  const URL_GOOGLE_SCRIPT = process.env.SCRIPT_RECARGAS_URL;
  if (!URL_GOOGLE_SCRIPT) {
    return faltaConfiguracion(res, ["SCRIPT_RECARGAS_URL"], { status: "error", message: "Error al conectar con la hoja de precios." });
  }

  try {
    // Lectura sin efectos secundarios (20 s con 1 reintento). Con copia en caché el cliente no espera.
    const { datos } = await conCache('precios:ff',
      () => llamarScript(URL_GOOGLE_SCRIPT, { accion: "obtener_precios" }, LECTURA_APPS_SCRIPT),
      { esValido: catalogoValido });
    cabecerasCachePrecios(res);
    return res.status(200).json(datos);
  } catch (error) {
    console.error("Error al obtener precios de Free Fire:", error.message);
    return res.status(503).json({ status: "error", message: "Error al conectar con la hoja de precios." });
  }
}
