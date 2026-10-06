import { llamarScript } from './_lib/externo.js';
import { faltaConfiguracion } from './_lib/validacion.js';

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

  try {
    // Consulta sin efectos secundarios: 1 reintento rápido dentro de los 8 s
    const data = await llamarScript(URL_VALIDADOR, { id: String(id) }, { reintentos: 1 });

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
