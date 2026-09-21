export default async function handler(req, res) {
  // Solo aceptamos peticiones POST
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

    // Si Google Apps Script responde, pero dice que hubo un error al guardar
    if (data.status === "error") {
      return res.status(200).json({ 
        status: "success", 
        url: "Error de Drive al guardar imagen" 
      });
    }

    // Si todo salió perfecto, devolvemos la URL real de la imagen
    return res.status(200).json(data);

  } catch (error) {
    console.error("Error al subir imagen a Google Drive:", error);
    
    // 🛡️ TRUCO CLAVE: En lugar de arrojar un error 500 que detenga la recarga en el cliente,
    // devolvemos un status 200 simulando éxito con un texto de respaldo.
    return res.status(200).json({ 
      status: "success", 
      url: "Fallo de conexión al subir imagen - Continuó sin comprobante" 
    });
  }
}