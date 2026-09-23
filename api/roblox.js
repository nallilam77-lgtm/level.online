// Este archivo vive en /api/roblox.js dentro de tu proyecto en Vercel

export default async function handler(req, res) {
  // 1. Configurar los encabezados CORS para permitir que tu dominio haga peticiones
  res.setHeader('Access-Control-Allow-Origin', '*'); // O pon 'https://www.levelupstore.online' para más seguridad
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // 2. Manejar la petición "preflight" (OPTIONS) que hacen los navegadores por seguridad
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // 3. Bloquear peticiones que no sean POST
  if (req.method !== 'POST') {
    return res.status(405).json({ status: 'error', message: 'Método no permitido. Usa POST.' });
  }

  try {
    // 4. Obtener la URL secreta de Google Apps Script (que configuraste en Vercel Environment Variables)
    // Asegúrate de que la variable en Vercel se llame exactamente GAS_URL
    const scriptUrl = process.env.GAS_URL;

    if (!scriptUrl) {
      console.error("Falta la variable de entorno GAS_URL");
      return res.status(500).json({ status: 'error', message: 'Error de configuración del servidor.' });
    }

    // 5. Enviar la petición a Google Apps Script
    const googleResponse = await fetch(scriptUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      // Pasamos exactamente el mismo cuerpo (body) que recibimos de tu página HTML
      body: JSON.stringify(req.body)
    });

    // 6. Leer la respuesta de Google
    const data = await googleResponse.json();

    // 7. Devolver la respuesta a tu página HTML
    return res.status(200).json(data);

  } catch (error) {
    console.error('Error en el proxy de Vercel:', error);
    return res.status(500).json({ status: 'error', message: 'Error interno de conexión con la base de datos.' });
  }
}