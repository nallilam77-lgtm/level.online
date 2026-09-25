// Este archivo vive en /api/roblox.js dentro de tu proyecto en Vercel

export default async function handler(req, res) {
  // 1. Configurar los encabezados CORS para permitir peticiones desde tu web
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // 2. Manejar la petición "preflight" (OPTIONS)
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // 3. Bloquear métodos que no sean POST
  if (req.method !== 'POST') {
    return res.status(405).json({ status: 'error', message: 'Método no permitido. Usa POST.' });
  }

  try {
    // 4. Obtener la URL secreta de Google Apps Script desde las variables de entorno de Vercel
    const scriptUrl = process.env.GAS_URL;

    if (!scriptUrl) {
      console.error("Falta la variable de entorno GAS_URL");
      return res.status(500).json({ status: 'error', message: 'Error de configuración del servidor.' });
    }

    // 5. Reenviar el cuerpo exacto (req.body) tal cual a Google Apps Script
    // Esto enviará correctamente { tipo: "obtener_precios" } o { tipo: "compra", ... }
    const googleResponse = await fetch(scriptUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(req.body)
    });

    // 6. Leer la respuesta devuelta por Google Apps Script
    const data = await googleResponse.json();

    // 7. Entregar la respuesta limpia a tu página web de Roblox
    return res.status(200).json(data);

  } catch (error) {
    console.error('Error en el proxy de Vercel para Roblox:', error);
    return res.status(500).json({ status: 'error', message: 'Error interno de conexión con el servidor.' });
  }
}