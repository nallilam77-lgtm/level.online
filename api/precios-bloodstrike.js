export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ status: "error", message: "Método no permitido" });
  }

  const URL_GOOGLE_SCRIPT = process.env.SCRIPT_BLOOD;

  if (!URL_GOOGLE_SCRIPT) {
    return res.status(500).json({ status: "error", message: "Falta configurar la variable SCRIPT_BLOOD en Vercel" });
  }

  try {
    // Cambiamos a método GET enviando la acción por la URL para evitar redirecciones de POST
    const respuesta = await fetch(`${URL_GOOGLE_SCRIPT}?accion=obtener_precios`, {
      method: 'GET'
    });

    const data = await respuesta.json();
    return res.status(200).json(data);

  } catch (error) {
    console.error("Error al obtener precios de Blood Strike:", error);
    return res.status(500).json({ status: "error", message: "Error interno al conectar con Google Sheets" });
  }
}