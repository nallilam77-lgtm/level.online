export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  // Capturamos el juego tanto si viene por body (POST) como por query (GET)
  const juego = req.body?.juego || req.query?.juego;
  
  // Asignamos la URL según el juego solicitado
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
    
    const data = await response.json();
    return res.status(200).json(data);
    
  } catch (error) {
    console.error("Error al conectar con Google Sheets:", error);
    return res.status(500).json({ status: "error", message: "Error al conectar con la hoja de precios." });
  }
}
