// Recargas MANUALES: FC Mobile, COD Mobile y Clash Royale. Los tres juegos comparten una sola hoja
// (apps-script/manuales.gs, variable SCRIPT_MANUALES) y este módulo: api/_lib/juegos/index.js carga este
// archivo para los tres y el juego sale de ?juego=.
//
// El cliente elige el paquete, paga por Pago Móvil y deja sus datos de inicio de sesión y su WhatsApp.
// manuales.gs verifica el pago (lo deja "Usado") y anota el pedido en la pestaña del juego; la recarga la
// hace el equipo a mano. Aquí no se compra nada en ningún proveedor.
//
// SEGURIDAD: el cuerpo trae la CONTRASEÑA del cliente. Nunca se escribe en los logs (ni req.body ni el
// payload) y solo viaja a manuales.gs.
import { randomUUID } from 'node:crypto';
import { obtenerIp, minutosBloqueado, registrarFallo } from '../limitador.js';
import { llamarScript, LECTURA_APPS_SCRIPT, conCache, cabecerasCachePrecios } from '../externo.js';
import { PAQUETE_VALIDO, textoParaHoja, faltaConfiguracion, telefonoCliente } from '../validacion.js';

const MENSAJE_SIN_CONFIGURAR = 'Esta tienda no está disponible en este momento. Intenta más tarde.';
// registrar_pedido es idempotente en manuales.gs (el mismo idPedido no duplica la fila ni toma otro pago),
// así que se puede repetir tras un tiempo agotado. Cabe en maxDuration de api/recargar.js (180 s).
const REGISTRO_PEDIDO = { tiempoMs: 40000, intentoMs: 20000, reintentos: 1, reintentarTrasTimeout: true };
const METODO_VALIDO = /^[a-z]{2,20}$/;
// Mismos límites que manuales.gs
const MAX_USUARIO = 100;
const MAX_CLAVE = 100;

function cabecerasCors(res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://levelupstore.online');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// Catálogos de los tres juegos en una sola consulta (una caché para todos)
async function leerCatalogos(scriptUrl) {
  const { datos } = await conCache('precios:manuales',
    () => llamarScript(scriptUrl, { accion: 'obtener_precios' }, LECTURA_APPS_SCRIPT),
    { esValido: (d) => d?.status === 'success' && d.juegos && typeof d.juegos === 'object' });
  return datos;
}

// Solo los campos que usa la página, como texto
function juegoParaCliente(juego) {
  const metodos = (Array.isArray(juego.metodos) ? juego.metodos : [])
    .filter((m) => METODO_VALIDO.test(String(m?.id || '')))
    .map((m) => ({ id: String(m.id), nombre: String(m.nombre || m.id), clave: m.clave !== false, telefono: m.telefono === true }));
  const catalogo = (Array.isArray(juego.catalogo) ? juego.catalogo : [])
    .filter((p) => PAQUETE_VALIDO.test(String(p?.paquete || '')) && p.precio)
    .map((p) => ({ paquete: String(p.paquete), precio: String(p.precio) }));
  return { nombre: String(juego.nombre || ''), metodos, catalogo };
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
  const scriptUrl = process.env.SCRIPT_MANUALES;
  if (!scriptUrl) return faltaConfiguracion(res, ['SCRIPT_MANUALES'], { status: 'error', message: MENSAJE_SIN_CONFIGURAR });

  try {
    const datos = await leerCatalogos(scriptUrl);
    const juego = datos.juegos[String(req.query.juego)];
    if (!juego || typeof juego !== 'object') {
      console.error(`Manuales: manuales.gs no trae el juego "${req.query.juego}"`);
      return res.status(503).json({ status: 'error', message: MENSAJE_SIN_CONFIGURAR });
    }
    cabecerasCachePrecios(res);
    return res.status(200).json({ status: 'success', ...juegoParaCliente(juego) });
  } catch (error) {
    console.error(`Error al obtener precios de ${req.query.juego}:`, error.message);
    return res.status(error.name === 'ErrorExterno' ? 503 : 500).json({ status: 'error', message: 'Error interno de conexión con el servidor.' });
  }
}

export const acciones = { precios };

// =========================================================================
// PEDIDO (api/recargar.js)
// POST { paquete, referencia, metodo, usuario, clave, telefono, url_capture }
// → { status: 'success', insuficiente, precio, pagado, falta } o { status: 'error', message }
// =========================================================================

export async function recargar(req, res) {
  cabecerasCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ status: 'error', message: 'Método no permitido. Usa POST.' });
  }
  const juego = String(req.query.juego);

  try {
    const scriptUrl = process.env.SCRIPT_MANUALES;
    if (!scriptUrl) return faltaConfiguracion(res, ['SCRIPT_MANUALES'], { status: 'error', message: MENSAJE_SIN_CONFIGURAR });

    // Solo se reenvían los campos conocidos. La contraseña NO se recorta (los espacios cuentan).
    const { paquete, referencia, metodo, url_capture } = req.body || {};
    const usuario = String(req.body?.usuario ?? '').trim();
    const clave = typeof req.body?.clave === 'string' ? req.body.clave : '';
    const telefono = telefonoCliente(req.body?.telefono);
    if (!/^\d{5}$/.test(String(referencia)) || !PAQUETE_VALIDO.test(String(paquete || '')) || !METODO_VALIDO.test(String(metodo || ''))) {
      return res.status(400).json({ status: 'error', message: 'Datos con formato inválido. Revisa el paquete y los 5 dígitos de la referencia.' });
    }
    if (usuario.length < 3 || usuario.length > MAX_USUARIO || clave.length > MAX_CLAVE || /[\u0000-\u001f\u007f]/.test(usuario + clave)) {
      return res.status(400).json({ status: 'error', message: 'Revisa el correo (o usuario) y la contraseña de tu cuenta.' });
    }
    if (!telefono) {
      return res.status(400).json({ status: 'error', message: 'Escribe un número de WhatsApp venezolano válido: por ahí te escribimos si hace falta.' });
    }

    // Antes de consultar la hoja de pagos: ¿esta IP o esta cuenta acumula demasiados fallos?
    const clavesLimite = [`ip:${obtenerIp(req)}`, `manual:${juego}:${usuario.toLowerCase()}`];
    const minutosEspera = await minutosBloqueado(clavesLimite);
    if (minutosEspera > 0) {
      return res.status(429).json({ status: 'error', message: `Demasiados intentos fallidos. Espera ${minutosEspera} minutos para volver a intentar.` });
    }

    const idPedido = `man-${randomUUID()}`;
    let data;
    try {
      data = await llamarScript(scriptUrl, {
        accion: 'registrar_pedido', juego, idPedido, paquete: String(paquete), referencia: String(referencia),
        metodo: String(metodo), usuario, clave, telefono, comprobante: textoParaHoja(url_capture || 'Sin comprobante'),
      }, REGISTRO_PEDIDO);
    } catch (error) {
      if (!error.tiempoAgotado) throw error;
      console.error(`⚠️ Pedido manual de ${juego} sin respuesta a tiempo | REF: ${referencia} | pedido ${idPedido}: revisar la pestaña del juego`);
      return res.status(202).json({ status: 'error', message: 'Fallo técnico momentáneo: tu pedido quedó en revisión. Si en 10 minutos no te escribimos, escríbenos por WhatsApp con tu referencia.' });
    }

    if (data?.status === 'success' && data.registrado) {
      return res.status(200).json({
        status: 'success', insuficiente: data.insuficiente === true,
        precio: String(data.precio || ''), pagado: String(data.pagado || ''), falta: String(data.falta || ''),
      });
    }
    // Pago no encontrado, ya usado, paquete que ya no existe...: cuenta como intento fallido
    if (data?.status === 'success') {
      await registrarFallo(clavesLimite);
      return res.status(200).json({ status: 'error', message: String(data.message || 'No pudimos registrar tu pedido.') });
    }
    if (data?.ocupado) return res.status(503).json({ status: 'error', message: String(data.message) });
    console.error(`Pedido manual de ${juego} rechazado por manuales.gs: ${data?.message}`);
    return res.status(502).json({ status: 'error', message: 'No pudimos registrar tu pedido. Intenta de nuevo en un momento.' });
  } catch (error) {
    console.error(`Error en el pedido manual de ${juego}:`, error.message);
    return res.status(error.name === 'ErrorExterno' ? 503 : 500).json({ status: 'error', message: 'Error interno de conexión con el servidor.' });
  }
}
