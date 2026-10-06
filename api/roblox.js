// Este archivo vive en /api/roblox.js dentro de tu proyecto en Vercel
import { obtenerIp, minutosBloqueado, registrarFallo } from './_lib/limitador.js';
import { llamarScript, conCache } from './_lib/externo.js';
import { PAQUETE_VALIDO, textoParaHoja, faltaConfiguracion } from './_lib/validacion.js';

// Debe ser menor que maxDuration de esta función en vercel.json (30 s)
const TIEMPO_COMPRA_MS = 20000;

export default async function handler(req, res) {
  // 1. Configurar los encabezados CORS: solo tu dominio (igual que vercel.json)
  res.setHeader('Access-Control-Allow-Origin', 'https://levelupstore.online');
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
      return faltaConfiguracion(res, ['GAS_URL'], { status: 'error', message: 'La tienda de Roblox no está disponible en este momento. Intenta más tarde.' });
    }

    // 5. Solo se reenvían las dos operaciones que usa la página y sus campos conocidos
    const { tipo, referencia, user, producto, url_capture } = req.body || {};
    let payload;
    let clavesLimite = null;

    if (tipo === 'obtener_precios') {
      payload = { tipo };
    } else if (tipo === 'compra') {
      const usuario = String(user || '').trim();
      if (!/^\d{5}$/.test(String(referencia)) || !/^[A-Za-z0-9_]{2,30}$/.test(usuario) || !PAQUETE_VALIDO.test(String(producto || ''))) {
        return res.status(400).json({ status: 'error', message: 'Datos con formato inválido. Revisa tu usuario y los 5 dígitos de la referencia.' });
      }

      // Antes de consultar la hoja de pagos: ¿esta IP o este usuario acumula demasiados fallos?
      clavesLimite = [`ip:${obtenerIp(req)}`, `jugador:roblox:${usuario.toLowerCase()}`];
      const minutosEspera = await minutosBloqueado(clavesLimite);
      if (minutosEspera > 0) {
        return res.status(429).json({ status: 'error', message: `Demasiados intentos fallidos. Espera ${minutosEspera} minutos para volver a intentar.` });
      }

      payload = { tipo, referencia: String(referencia), user: usuario, producto: String(producto), url_capture: textoParaHoja(url_capture || 'Sin comprobante') };
    } else {
      return res.status(400).json({ status: 'error', message: 'Operación no permitida.' });
    }

    // 6. Precios: lectura con caché en memoria (instantánea y con respaldo si Apps Script falla)
    if (tipo === 'obtener_precios') {
      const { datos } = await conCache('precios:roblox',
        () => llamarScript(scriptUrl, payload, { reintentos: 1 }),
        { esValido: (d) => d?.status === 'success' && d.precios && typeof d.precios === 'object' });
      return res.status(200).json(datos);
    }

    // 7. Compra: Apps Script verifica el pago y la entrega, puede tardar más. Sin reintento
    //    (podría duplicar la compra). Si se agota el tiempo, la compra sigue en Apps Script.
    let data;
    try {
      data = await llamarScript(scriptUrl, payload, { tiempoMs: TIEMPO_COMPRA_MS });
    } catch (error) {
      if (!error.tiempoAgotado) throw error;
      console.error('⚠️ Compra Roblox sin respuesta a tiempo | REF:', payload.referencia);
      return res.status(202).json({ status: 'error', message: 'Fallo técnico momentáneo: tu compra quedó en proceso. Si en 5 minutos no la recibes, escríbenos por WhatsApp.' });
    }

    // Una compra rechazada (pago no encontrado, ya usado, insuficiente...) cuenta como intento fallido.
    // "Fallo técnico" no cuenta: el pago sí existía y quedó en proceso.
    if (clavesLimite && data?.status !== 'success' && !String(data?.message || '').toLowerCase().includes('fallo técnico')) {
      await registrarFallo(clavesLimite);
    }

    // 8. Entregar la respuesta limpia a tu página web de Roblox
    return res.status(200).json(data);

  } catch (error) {
    console.error('Error en el proxy de Vercel para Roblox:', error.message);
    return res.status(error.name === 'ErrorExterno' ? 503 : 500).json({ status: 'error', message: 'Error interno de conexión con el servidor.' });
  }
}