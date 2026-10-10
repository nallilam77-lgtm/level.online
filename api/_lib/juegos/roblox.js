// Roblox: precios y compra (el Apps Script de GAS_URL verifica el pago y entrega).
// Lo usan api/juego.js (acción precios) y api/recargar.js (recargar).
import { obtenerIp, minutosBloqueado, registrarFallo } from '../limitador.js';
import { llamarScript, LECTURA_APPS_SCRIPT, conCache, cabecerasCachePrecios } from '../externo.js';
import { PAQUETE_VALIDO, textoParaHoja, faltaConfiguracion } from '../validacion.js';

// Debe ser menor que maxDuration de api/recargar.js en vercel.json (180 s).
// La compra no se reintenta: el Apps Script de Roblox no tiene idPedido y repetirla podría duplicarla.
const TIEMPO_COMPRA_MS = 45000;
const MENSAJE_SIN_CONFIGURAR = 'La tienda de Roblox no está disponible en este momento. Intenta más tarde.';

// CORS: solo tu dominio (igual que vercel.json)
function cabecerasCors(res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://levelupstore.online');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// =========================================================================
// ACCIONES DE api/juego.js
// =========================================================================

async function precios(req, res) {
  cabecerasCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ status: 'error', message: 'Método no permitido' });
  }

  const scriptUrl = process.env.GAS_URL;
  if (!scriptUrl) {
    return faltaConfiguracion(res, ['GAS_URL'], { status: 'error', message: MENSAJE_SIN_CONFIGURAR });
  }

  try {
    // Lectura con caché en memoria (instantánea y con respaldo si Apps Script falla)
    const { datos } = await conCache('precios:roblox',
      () => llamarScript(scriptUrl, { tipo: 'obtener_precios' }, LECTURA_APPS_SCRIPT),
      { esValido: (d) => d?.status === 'success' && d.precios && typeof d.precios === 'object' });
    cabecerasCachePrecios(res);
    return res.status(200).json(datos);
  } catch (error) {
    console.error('Error al obtener precios de Roblox:', error.message);
    return res.status(error.name === 'ErrorExterno' ? 503 : 500).json({ status: 'error', message: 'Error interno de conexión con el servidor.' });
  }
}

export const acciones = { precios };

// =========================================================================
// COMPRA (api/recargar.js)
// =========================================================================

export async function recargar(req, res) {
  cabecerasCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ status: 'error', message: 'Método no permitido. Usa POST.' });
  }

  const { tipo, referencia, user, producto, url_capture } = req.body || {};
  // COMPATIBILIDAD TEMPORAL: la página anterior pedía los precios con POST /api/roblox
  // { tipo: "obtener_precios" }, que vercel.json redirige aquí. Quitar junto con esa redirección.
  if (tipo === 'obtener_precios') return precios(req, res);
  if (tipo !== undefined && tipo !== 'compra') {
    return res.status(400).json({ status: 'error', message: 'Operación no permitida.' });
  }

  try {
    const scriptUrl = process.env.GAS_URL;
    if (!scriptUrl) {
      return faltaConfiguracion(res, ['GAS_URL'], { status: 'error', message: MENSAJE_SIN_CONFIGURAR });
    }

    // Solo se reenvían los campos conocidos
    const usuario = String(user || '').trim();
    if (!/^\d{5}$/.test(String(referencia)) || !/^[A-Za-z0-9_]{2,30}$/.test(usuario) || !PAQUETE_VALIDO.test(String(producto || ''))) {
      return res.status(400).json({ status: 'error', message: 'Datos con formato inválido. Revisa tu usuario y los 5 dígitos de la referencia.' });
    }

    // Antes de consultar la hoja de pagos: ¿esta IP o este usuario acumula demasiados fallos?
    const clavesLimite = [`ip:${obtenerIp(req)}`, `jugador:roblox:${usuario.toLowerCase()}`];
    const minutosEspera = await minutosBloqueado(clavesLimite);
    if (minutosEspera > 0) {
      return res.status(429).json({ status: 'error', message: `Demasiados intentos fallidos. Espera ${minutosEspera} minutos para volver a intentar.` });
    }

    const payload = { tipo: 'compra', referencia: String(referencia), user: usuario, producto: String(producto), url_capture: textoParaHoja(url_capture || 'Sin comprobante') };

    // Apps Script verifica el pago y la entrega, puede tardar más. Sin reintento
    // (podría duplicar la compra). Si se agota el tiempo, la compra sigue en Apps Script.
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
    if (data?.status !== 'success' && !String(data?.message || '').toLowerCase().includes('fallo técnico')) {
      await registrarFallo(clavesLimite);
    }

    return res.status(200).json(data);

  } catch (error) {
    console.error('Error en la compra de Roblox:', error.message);
    return res.status(error.name === 'ErrorExterno' ? 503 : 500).json({ status: 'error', message: 'Error interno de conexión con el servidor.' });
  }
}
