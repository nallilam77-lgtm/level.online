// 1. EL TRUCO PARA EVITAR QUE SE CONGELE POR EL PESO DE LA IMAGEN
// Aumentamos el límite de recepción a 4MB (Vercel permite un máximo de 4.5MB en plan gratuito)
export const config = {
  api: {
    bodyParser: {
      sizeLimit: '4mb',
    },
  },
};

export default async function handler(req, res) {
  // Solo aceptamos peticiones POST
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
  
  // Si por alguna razón llega vacío, lo dejamos pasar sin romper la app
  if (!req.body || !req.body.base64) {
    return res.status(200).json({ status: "success", url: "Imagen vacía o no recibida" });
  }

  try {
    // 2. EL TRUCO PARA EVITAR QUE VERCEL MATE LA FUNCIÓN (TIMEOUT)
    // Le damos a Google Drive un máximo de 8 segundos para responder.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(process.env.SCRIPT_RECARGAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accion: "subir_imagen",
        base64: req.body.base64,
        nombre: req.body.nombre,
        mimeType: req.body.mimeType
      }),
      signal: controller.signal // Atamos el cronómetro a la petición
    });
    
    // Si Drive respondió a tiempo, apagamos el cronómetro
    clearTimeout(timeoutId);

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
    
    // Si el error fue provocado porque pasaron los 8 segundos (nuestro cronómetro)
    if (error.name === 'AbortError') {
      return res.status(200).json({ 
        status: "success", 
        url: "Drive tardó demasiado en responder - Continuó sin comprobante" 
      });
    }
    
    // Si fue cualquier otro error de conexión (lo que tú ya tenías)
    return res.status(200).json({ 
      status: "success", 
      url: "Fallo de conexión al subir imagen - Continuó sin comprobante" 
    });
  }
}