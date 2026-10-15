// Roblox: precios, códigos de descuento y compra (el Apps Script de GAS_URL, apps-script/roblox.gs,
// verifica el pago y entrega). Lo usan api/juego.js (precios, descuento) y api/recargar.js (recargar).
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { obtenerIp, minutosBloqueado, registrarFallo } from '../limitador.js';
import { llamarScript, LECTURA_APPS_SCRIPT, conCache, cabecerasCachePrecios } from '../externo.js';
import { PAQUETE_VALIDO, textoParaHoja, faltaConfiguracion } from '../validacion.js';
import { crearAccionDescuento, aplicarDescuentoARecarga, registrarUsoDescuento } from '../descuentos.js';
import { limpiarMontoVES } from '../recarga-comun.js';

// Debe ser menor que maxDuration de api/recargar.js en vercel.json (180 s).
// La compra no se reintenta: el Apps Script de Roblox no tiene idPedido y repetirla podría duplicarla.
const TIEMPO_COMPRA_MS = 45000;
const MENSAJE_SIN_CONFIGURAR = 'La tienda de Roblox no está disponible en este momento. Intenta más tarde.';
// Con esta cantidad de códigos o menos, el paquete se muestra como "¡Últimos!"
const POCOS_CODIGOS = 3;
// Completar un pago insuficiente: la clave que recibe el cliente (la hoja solo guarda su huella SHA-256)
const CLAVE_COMPLEMENTO = /^[A-Za-z0-9_-]{32,64}$/;
const huella = (texto) => createHash('sha256').update(String(texto)).digest('hex');

// CORS: solo tu dominio (igual que vercel.json)
function cabecerasCors(res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://levelupstore.online');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// El Apps Script de Roblox exige el token si tiene la propiedad TOKEN_VERCEL (es el mismo secreto
// que el de recargas). llamarScript solo lo añade solo para SCRIPT_RECARGAS_URL, así que va aquí.
function conToken(cuerpo) {
  const token = (process.env.SCRIPT_RECARGAS_TOKEN || '').trim();
  return token ? { ...cuerpo, token } : cuerpo;
}

// Precios de la hoja { "50 Robux": 1100, ... }, con caché en memoria (instantánea y con respaldo)
async function obtenerPreciosRoblox(scriptUrl) {
  const { datos } = await conCache('precios:roblox',
    () => llamarScript(scriptUrl, conToken({ tipo: 'obtener_precios' }), LECTURA_APPS_SCRIPT),
    { esValido: (d) => d?.status === 'success' && d.precios && typeof d.precios === 'object' });
  return datos;
}

// Stock de cada paquete para el cliente: nunca la cantidad exacta de códigos del inventario,
// solo 'disponible', 'pocos' o 'agotado'. Sin datos de stock (Apps Script anterior) → {}.
function estadoStock(stock) {
  if (!stock || typeof stock !== 'object') return {};
  const estados = {};
  for (const [producto, cantidad] of Object.entries(stock)) {
    const n = Number(cantidad) || 0;
    estados[producto] = n <= 0 ? 'agotado' : n <= POCOS_CODIGOS ? 'pocos' : 'disponible';
  }
  return estados;
}

// Catálogo en lista para la acción "descuento" (misma caché que la acción precios)
async function catalogoRoblox() {
  const { precios, stock } = await obtenerPreciosRoblox(process.env.GAS_URL);
  const estados = estadoStock(stock);
  return Object.entries(precios).map(([producto, precio]) => ({ producto, precio, ...(estados[producto] && { stock: estados[producto] }) }));
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
    const datos = await obtenerPreciosRoblox(scriptUrl);
    cabecerasCachePrecios(res);
    return res.status(200).json({ status: 'success', precios: datos.precios, stock: estadoStock(datos.stock) });
  } catch (error) {
    console.error('Error al obtener precios de Roblox:', error.message);
    return res.status(error.name === 'ErrorExterno' ? 503 : 500).json({ status: 'error', message: 'Error interno de conexión con el servidor.' });
  }
}

export const acciones = { precios, descuento: crearAccionDescuento('Roblox', catalogoRoblox) };

// Solo los campos que usa la página, nunca la respuesta cruda de Apps Script.
// clave: la del pago por completar; solo se devuelve si roblox.gs guardó el pedido en "por_completar".
function respuestaCompra(data, clave) {
  if (data?.status === 'success') {
    return { status: 'success', code: String(data.code ?? ''), message: String(data.message || '¡Código canjeado con éxito!') };
  }
  return {
    status: 'error',
    message: String(data?.message || 'No pudimos completar la compra. Intenta de nuevo.'),
    ...(data?.insuficiente && { insuficiente: true, montoPagado: Number(data.montoPagado) || 0, precioOficial: Number(data.precioOficial) || 0 }),
    ...(data?.insuficiente && data.porCompletar && clave && {
      tokenComplemento: clave, faltante: Number(data.falta) || 0, horasParaCompletar: Number(data.horas) || 48,
    }),
    ...(data?.agotado && { agotado: true }),
    ...(data?.complementoInvalido && { complementoInvalido: true }),
  };
}

// =========================================================================
// COMPRA (api/recargar.js)
// =========================================================================

export async function recargar(req, res) {
  cabecerasCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ status: 'error', message: 'Método no permitido. Usa POST.' });
  }

  // Segunda (o tercera...) referencia de un pago que no alcanzó
  if (req.body?.tokenComplemento !== undefined) return completarCompra(req, res);

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

    // Código de descuento (opcional): se valida de nuevo aquí y el precio lo calcula el servidor
    // sobre el precio de la hoja. El Apps Script solo acepta un monto menor que su precio.
    let desc = null;
    let montoACobrar;
    if (req.body?.codigoDescuento) {
      let precioLista = 0;
      try {
        const { precios } = await obtenerPreciosRoblox(scriptUrl);
        if (Object.hasOwn(precios, String(producto))) precioLista = limpiarMontoVES(precios[String(producto)]);
      } catch (error) {
        console.error('Roblox: no se pudieron leer los precios para el descuento:', error.message);
        return res.status(503).json({ status: 'error', message: 'No pudimos aplicar tu código de descuento ahora. Intenta de nuevo en un momento.' });
      }
      if (!(precioLista > 0)) {
        return res.status(400).json({ status: 'error', message: 'Ese paquete ya no está disponible. Recarga la página.' });
      }
      const descuento = await aplicarDescuentoARecarga(req.body.codigoDescuento, precioLista);
      if (descuento.error) return res.status(descuento.error.codigo).json(descuento.error.cuerpo);
      ({ desc, precio: montoACobrar } = descuento);
    }

    // Identifica la venta en "movimientos_descuentos" (evita anotar dos veces el mismo uso)
    const idPedido = `rbx-${randomUUID()}`;
    // Si el pago no alcanza, roblox.gs guarda el pedido "por completar" con la huella de esta clave
    // (la clave solo la recibe el cliente, y solo si se guardó)
    const clave = randomBytes(24).toString('base64url');
    const payload = conToken({
      tipo: 'compra', referencia: String(referencia), user: usuario, producto: String(producto),
      url_capture: textoParaHoja(url_capture || 'Sin comprobante'), idPedido, claveHash: huella(clave),
      ...(desc && { montoACobrar, codigoDescuento: desc.codigo }),
    });

    // Apps Script verifica el pago y la entrega, puede tardar más. Sin reintento
    // (podría duplicar la compra). Si se agota el tiempo, la compra sigue en Apps Script.
    let data;
    try {
      data = await llamarScript(scriptUrl, payload, { tiempoMs: TIEMPO_COMPRA_MS });
    } catch (error) {
      if (!error.tiempoAgotado) throw error;
      console.error('⚠️ Compra Roblox sin respuesta a tiempo | REF:', payload.referencia,
        desc ? `| código ${desc.codigo} (${montoACobrar} Bs, pedido ${idPedido}): si se entregó, anotar el uso a mano` : '');
      return res.status(202).json({ status: 'error', message: 'Fallo técnico momentáneo: tu compra quedó en proceso. Si en 5 minutos no la recibes, escríbenos por WhatsApp.' });
    }

    // Una compra rechazada (pago no encontrado, ya usado, insuficiente...) cuenta como intento fallido.
    // "Fallo técnico" no cuenta: el pago sí existía y quedó en proceso.
    if (data?.status !== 'success' && !String(data?.message || '').toLowerCase().includes('fallo técnico')) {
      await registrarFallo(clavesLimite);
    }

    // Compra entregada con código: +1 uso y la comisión del creador (pestaña "Descuentos").
    // Si falla, la compra ya está hecha: queda en los logs de Vercel para anotarlo a mano.
    if (data?.status === 'success' && desc) {
      await registrarUsoDescuento({ codigo: desc.codigo, montoCobrado: montoACobrar, idPedido, idJugador: usuario, juego: 'Roblox' });
    }

    return res.status(200).json(respuestaCompra(data, clave));

  } catch (error) {
    console.error('Error en la compra de Roblox:', error.message);
    return res.status(error.name === 'ErrorExterno' ? 503 : 500).json({ status: 'error', message: 'Error interno de conexión con el servidor.' });
  }
}

/**
 * Completar un pago insuficiente: POST { tokenComplemento, referencia (últimos 5 del nuevo pago) }.
 * Todo ocurre en roblox.gs con su candado (tipo "completar"): el usuario, el paquete y el precio
 * salen de la pestaña "por_completar" (el navegador no puede cambiarlos), y si ya alcanza, el código
 * se reserva ANTES de gastar el pago nuevo. Igual que la compra, nunca se reintenta.
 */
async function completarCompra(req, res) {
  try {
    const clave = String(req.body?.tokenComplemento ?? '');
    const referencia = String(req.body?.referencia ?? '');
    if (!CLAVE_COMPLEMENTO.test(clave) || !/^\d{5}$/.test(referencia)) {
      return res.status(400).json({ status: 'error', message: 'Escribe los últimos 5 dígitos de la referencia del pago que hiciste para completar.' });
    }
    const scriptUrl = process.env.GAS_URL;
    if (!scriptUrl) {
      return faltaConfiguracion(res, ['GAS_URL'], { status: 'error', message: MENSAJE_SIN_CONFIGURAR });
    }

    const claveHash = huella(clave);
    // Intentos fallidos por IP y por clave (frena probar referencias al azar)
    const clavesLimite = [`ip:${obtenerIp(req)}`, `completar:roblox:${claveHash.slice(0, 24)}`];
    const minutosEspera = await minutosBloqueado(clavesLimite);
    if (minutosEspera > 0) {
      return res.status(429).json({ status: 'error', message: `Demasiados intentos fallidos. Espera ${minutosEspera} minutos para volver a intentar.` });
    }

    const idPedido = `rbx-${randomUUID()}`;
    let data;
    try {
      data = await llamarScript(scriptUrl, conToken({ tipo: 'completar', claveHash, referencia, idPedido }), { tiempoMs: TIEMPO_COMPRA_MS });
    } catch (error) {
      if (!error.tiempoAgotado) throw error;
      console.error(`⚠️ Completar pago de Roblox sin respuesta a tiempo | REF: ${referencia} | pedido ${idPedido} | clave ${claveHash.slice(0, 12)}…: revisar "por_completar" y "Exitosas"`);
      return res.status(202).json({ status: 'error', message: 'Fallo técnico momentáneo: tu compra quedó en proceso. Si en 5 minutos no la recibes, escríbenos por WhatsApp con tus referencias.' });
    }

    if (data?.status !== 'success' && !data?.insuficiente) await registrarFallo(clavesLimite);

    // Entregado con código de descuento: +1 uso y la comisión del creador (pestaña "Descuentos")
    if (data?.status === 'success' && data.codigoDescuento) {
      await registrarUsoDescuento({
        codigo: String(data.codigoDescuento), montoCobrado: limpiarMontoVES(data.precio), idPedido,
        idJugador: String(data.usuario || ''), juego: 'Roblox',
      });
    }

    return res.status(200).json(respuestaCompra(data, clave));
  } catch (error) {
    console.error('Error al completar un pago de Roblox:', error.message);
    return res.status(error.name === 'ErrorExterno' ? 503 : 500).json({ status: 'error', message: 'Error interno de conexión con el servidor.' });
  }
}
