export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  // Detectamos si la petición viene de Blood Strike o de Free Fire
  const juego = req.body?.juego || req.query?.juego;
  
  // Usamos SCRIPT_BLOOD si es Blood Strike, o la variable original para Free Fire
  const URL_GOOGLE_SCRIPT = juego === 'blood_strike' 
    ? process.env.SCRIPT_BLOOD 
    : process.env.SCRIPT_RECARGAS_URL;

  if (!URL_GOOGLE_SCRIPT) {
    return res.status(500).json({ status: "error", message: "Falta configurar la variable de entorno en Vercel." });
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
    return res.status(500).json({ status: "error", message: "Error al conectar con la hoja de precios." });
  }
}
