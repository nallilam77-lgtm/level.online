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
    console.error("❌ Falta la variable de entorno SCRIPT_VALIDADOR_URL");
    return res.status(500).json({ valid: false, message: "Error en el servidor" });
  }

  try {
    const response = await fetch(URL_VALIDADOR, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: String(id) })
    });
    const data = await response.json();

    // Solo se devuelven los campos que usa la página, nunca la respuesta cruda de Apps Script
    return res.status(200).json({
      valid: data?.valid === true,
      player_name: data?.valid === true && data.player_name ? String(data.player_name).slice(0, 60) : undefined
    });
  } catch (error) {
    console.error("Error en verificar.js:", error.message);
    return res.status(500).json({ valid: false, message: "Error en el servidor" });
  }
}
