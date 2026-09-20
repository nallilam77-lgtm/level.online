export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
  
  try {
    const response = await fetch(process.env.SCRIPT_RECARGAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accion: "subir_imagen",
        base64: req.body.base64,
        nombre: req.body.nombre,
        mimeType: req.body.mimeType
      })
    });
    const data = await response.json();
    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({ status: "error", message: "Error al subir imagen" });
  }
}