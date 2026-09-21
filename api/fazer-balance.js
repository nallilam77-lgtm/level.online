export default async function handler(req, res) {
  // Solo permitimos peticiones GET
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Método no permitido' });
  }

  // Tu llave de FazerCards (lo ideal a futuro es ponerla en las variables de entorno de Vercel, pero así funcionará directo)
  const apiKey = process.env.FAZER_API_KEY || "fc_cb682478a17afc111710344a"; 

  try {
    const respuesta = await fetch("https://api.fazercards.com/api/v2/balance", {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Accept": "application/json"
      }
    });

    const data = await respuesta.json();
    
    // Devolvemos la información al panel
    res.status(200).json({ success: true, balance: data });

  } catch (error) {
    res.status(500).json({ success: false, error: error.toString() });
  }
}