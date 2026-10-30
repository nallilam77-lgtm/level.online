import { llamarScript, ESCRITURA_APPS_SCRIPT } from './_lib/externo.js';
import { textoParaHoja } from './_lib/validacion.js';
import { obtenerIp, permitirUso } from './_lib/limitador.js';

const TIPOS_IMAGEN = /^image\/(png|jpe?g|webp|gif|heic|heif)$/;

// ¿Los primeros bytes son de una imagen de verdad? (el "mimeType" lo escribe el navegador y se puede falsear)
// PNG, JPEG, GIF, WEBP (RIFF…WEBP) y HEIC/HEIF (…ftyp + marca de imagen)
function esImagen(base64) {
  const datos = base64.includes(',') ? base64.slice(base64.indexOf(',') + 1) : base64;
  const b = Buffer.from(datos.slice(0, 64), 'base64');
  const texto = (inicio, fin) => b.subarray(inicio, fin).toString('latin1');
  return (b[0] === 0x89 && texto(1, 4) === 'PNG')
    || (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
    || texto(0, 4) === 'GIF8'
    || (texto(0, 4) === 'RIFF' && texto(8, 12) === 'WEBP')
    || (texto(4, 8) === 'ftyp' && /^(hei[cxsm]|hev[cx]|mif1|msf1|avif)$/.test(texto(8, 12)));
}

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

  // Lo que no es una imagen no llega a Drive. Como en los demás fallos, la compra sigue y el motivo
  // queda en la hoja en lugar de la URL del comprobante
  if (!esImagen(req.body.base64)) {
    return res.status(200).json({ status: "success", url: "El archivo no era una imagen - Continuó sin comprobante" });
  }

  // Frena que alguien llene el Drive subiendo archivos sin parar
  const minutosEspera = await permitirUso(`subida:${obtenerIp(req)}`);
  if (minutosEspera > 0) {
    return res.status(200).json({ status: "success", url: "Demasiadas subidas desde esta conexión - Continuó sin comprobante" });
  }

  // Sin Apps Script configurado la compra sigue, solo que sin comprobante guardado
  if (!process.env.SCRIPT_RECARGAS_URL) {
    console.error("❌ Falta la variable de entorno SCRIPT_RECARGAS_URL (subir-imagen)");
    return res.status(200).json({ status: "success", url: "Servidor sin configurar - Continuó sin comprobante" });
  }

  try {
    // 2. EL TRUCO PARA EVITAR QUE VERCEL MATE LA FUNCIÓN (TIMEOUT)
    // Le damos a Google Drive un máximo de 20 segundos para responder (maxDuration 30 en vercel.json).
    // Sin reintento: cada llamada crea un archivo nuevo en Drive.
    const data = await llamarScript(process.env.SCRIPT_RECARGAS_URL, {
      accion: "subir_imagen",
      base64: req.body.base64,
      nombre: textoParaHoja(req.body.nombre || "comprobante", 100),
      mimeType: TIPOS_IMAGEN.test(String(req.body.mimeType)) ? req.body.mimeType : "image/jpeg"
    }, ESCRITURA_APPS_SCRIPT);

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

    // Si el error fue provocado porque pasaron los 20 segundos (nuestro cronómetro)
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