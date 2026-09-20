export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  try {
    const { accion, referencia, monto, fila } = req.body;

    const response = await fetch(process.env.SCRIPT_RECARGAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tokenSecreto: "LevelUpMaster2026_Key",
        accion: accion || "verificar_pago",
        referencia,
        monto,
        fila
      })
    });

    const data = await response.json();
    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({ status: "error", message: "Error al comunicar con la hoja de pagos" });
  }
}