export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  // Obtenemos de forma segura el parámetro de juego sin importar si viene por body o query
  let juego = '';
  if (req.body) {
    if (typeof req.body === 'string') {
      try {
        juego = JSON.parse(req.body).juego;
      } catch (e) {}
    } else {
      juego = req.body.juego;
    }
  }
  if (!juego && req.query) {
    juego = req.query.juego;
  }

  // Seleccionamos la URL de Google Script correspondiente de forma estricta
  let URL_GOOGLE_SCRIPT = process.env.SCRIPT_RECARGAS_URL;

  if (juego === 'blood_strike') {
    URL_GOOGLE_SCRIPT = process.env.SCRIPT_BLOOD;
  }

  if (!URL_GOOGLE_SCRIPT) {
    return res.status(500).json({ 
      status: "error", 
      message: `Falta configurar la variable de entorno para ${juego || 'general'} en Vercel.` 
    });
  }

  try {
    const response = await fetch(URL_GOOGLE_SCRIPT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accion: "obtener_precios" })
    });
    
    const textData = await response.text();
    
    // Verificamos que la respuesta comience con formato JSON válido para evitar el error de HTML (<DOCTYPE)
    if (!textData.trim().startsWith('{') && !textData.trim().startsWith('[')) {
      console.error("Respuesta inválida de Google Sheets (No es JSON):", textData);
      return res.status(500).json({ status: "error", message: "La hoja de cálculo respondió con un formato no válido." });
    }

    const data = JSON.parse(textData);
    return res.status(200).json(data);
    
  } catch (error) {
    console.error("Error al procesar la solicitud de precios:", error);
    return res.status(500).json({ status: "error", message: "Error al conectar con la hoja de precios." });
  }
}
