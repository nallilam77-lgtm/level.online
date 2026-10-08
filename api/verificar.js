import { llamarScript, LECTURA_APPS_SCRIPT } from './_lib/externo.js';
import { faltaConfiguracion } from './_lib/validacion.js';

// IDs ya validados (por instancia de Vercel): el mismo jugador suele verificar su ID varias veces
// mientras compra, y así solo la primera consulta espera a Apps Script. Solo se guardan los válidos.
const VALIDOS_MS = 10 * 60 * 1000;
const MAX_VALIDOS = 5000;
const validados = new Map();

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const { id } = req.body || {};

  // Mismo formato de ID que exige api/recargar.js
  if (!/^\d{5,15}$/.test(String(id ?? ''))) {
    return res.status(400).json({ valid: false, message: "ID con formato inválido. Debe tener entre 5 y 15 números." });
  }

  const URL_VALIDADOR = process.env.SCRIPT_VALIDADOR_URL;
  if (!URL_VALIDADOR) {
    return faltaConfiguracion(res, ["SCRIPT_VALIDADOR_URL"], { valid: false, message: "El validador de IDs no está disponible. Intenta de nuevo en unos minutos." });
  }

  const guardado = validados.get(String(id));
  if (guardado && Date.now() - guardado.momento < VALIDOS_MS) {
    return res.status(200).json({ valid: true, player_name: guardado.player_name });
  }

  try {
    const data = await llamarScript(URL_VALIDADOR, { id: String(id) }, LECTURA_APPS_SCRIPT);
    if (data?.valid === true) {
      validados.delete(String(id));
      validados.set(String(id), { player_name: data.player_name ? String(data.player_name).slice(0, 60) : undefined, momento: Date.now() });
      if (validados.size > MAX_VALIDOS) validados.delete(validados.keys().next().value);
    }

    // Solo se devuelven los campos que usa la página, nunca la respuesta cruda de Apps Script
    return res.status(200).json({
      valid: data?.valid === true,
      player_name: data?.valid === true && data.player_name ? String(data.player_name).slice(0, 60) : undefined
    });
  } catch (error) {
    console.error("Error en verificar.js:", error.message);
    if (error.name === 'ErrorExterno') {
      return res.status(503).json({ valid: false, message: "El validador de IDs está lento. Intenta de nuevo en unos segundos." });
    }
    return res.status(500).json({ valid: false, message: "Error en el servidor" });
  }
}
