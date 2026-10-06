import { llamarScript } from './_lib/externo.js';
import { textoParaHoja } from './_lib/validacion.js';

const TIPOS_IMAGEN = /^image\/(png|jpe?g|webp|gif|heic|heif)$/;

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
  if (!req.body || typeof req.body.base64 !== 'string' || !req.body.base64) {
    return res.status(200).json({ status: "success", url: "Imagen vacía o no recibida" });
  }

  // Sin Apps Script configurado la compra sigue, solo que sin comprobante guardado
  if (!process.env.SCRIPT_RECARGAS_URL) {
    console.error("❌ Falta la variable de entorno SCRIPT_RECARGAS_URL (subir-imagen)");
    return res.status(200).json({ status: "success", url: "Servidor sin configurar - Continuó sin comprobante" });
  }

  try {
    // 2. EL TRUCO PARA EVITAR QUE VERCEL MATE LA FUNCIÓN (TIMEOUT)
    // Le damos a Google Drive un máximo de 8 segundos para responder.
    // Sin reintento: cada llamada crea un archivo nuevo en Drive.
    const data = await llamarScript(process.env.SCRIPT_RECARGAS_URL, {
      accion: "subir_imagen",
      base64: req.body.base64,
      nombre: textoParaHoja(req.body.nombre || "comprobante", 100),
      mimeType: TIPOS_IMAGEN.test(String(req.body.mimeType)) ? req.body.mimeType : "image/jpeg"
    });

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
    console.error("Error al subir imagen a Google Drive:", error.message);

    // Si el error fue provocado porque pasaron los 8 segundos (nuestro cronómetro)
    if (error.tiempoAgotado) {
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