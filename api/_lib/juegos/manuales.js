// Recargas MANUALES: FC Mobile, COD Mobile y Clash Royale. Los tres juegos comparten una sola hoja
// (apps-script/manuales.gs, variable SCRIPT_MANUALES) y este módulo: api/_lib/juegos/index.js carga este
// archivo para los tres y el juego sale de ?juego=.
//
// El cliente elige el paquete, paga por Pago Móvil y deja sus datos de inicio de sesión y su WhatsApp.
// manuales.gs verifica el pago (lo deja "Usado") y anota el pedido en la pestaña del juego; la recarga la
// hace el equipo a mano. Aquí no se compra nada en ningún proveedor.
//
// Códigos de descuento: la misma tabla "Descuentos" de la hoja de Free Fire que las otras tiendas
// (_lib/descuentos.js). El precio con descuento se calcula aquí sobre el precio de la hoja y manuales.gs
// solo lo acepta si es menor que su precio. Si el pago alcanzó, el uso (+1 uso y la comisión del creador)
// se anota con registrar_uso_descuento; si no alcanzó, la nota del pedido avisa que hay que anotarlo a mano.
//
// SEGURIDAD: el cuerpo trae la CONTRASEÑA del cliente. Nunca se escribe en los logs (ni req.body ni el
// payload) y solo viaja a manuales.gs.
import { motorPagos, tomarPago, cambiarPago } from '../motor-pagos.js';
import { randomUUID } from 'node:crypto';
import { obtenerIp, minutosBloqueado, registrarFallo, permitirUso } from '../limitador.js';
import { anotarRecarga, conDestacados } from '../fidelidad.js';
import { actualizarEstado } from '../historial.js';
import { llamarScript, LECTURA_APPS_SCRIPT, conCache, cabecerasCachePrecios } from '../externo.js';
import { PAQUETE_VALIDO, textoParaHoja, faltaConfiguracion, telefonoCliente } from '../validacion.js';
import { crearAccionDescuento, aplicarDescuentoARecarga, registrarUsoDescuento } from '../descuentos.js';
import { limpiarMontoVES } from '../recarga-comun.js';

// Nombre con el que cada venta con código se anota en "movimientos_descuentos" (y se ve en el panel del creador)
const NOMBRES = { fcmobile: 'FC Mobile', codmobile: 'COD Mobile', clashroyale: 'Clash Royale' };
// manuales.gs acepta montoACobrar desde la versión 2: con una anterior cobraría el precio completo
const VERSION_CON_DESCUENTO = 2;
const MENSAJE_SIN_DESCUENTO = 'Los códigos de descuento aún no están disponibles en esta tienda. Quita el código para comprar.';

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
    const cliente = juegoParaCliente(juego);
    // "⭐ Más vendido" / "💰 Mejor precio" (_lib/fidelidad.js)
    return res.status(200).json({ status: 'success', ...cliente, catalogo: await conDestacados(String(req.query.juego), cliente.catalogo) });
  } catch (error) {
    console.error(`Error al obtener precios de ${req.query.juego}:`, error.message);
    return res.status(error.name === 'ErrorExterno' ? 503 : 500).json({ status: 'error', message: 'Error interno de conexión con el servidor.' });
  }
}

// Catálogo del juego ya limpio + la versión de manuales.gs (misma caché que la acción precios)
async function catalogoConVersion(scriptUrl, juego) {
  const datos = await leerCatalogos(scriptUrl);
  const delJuego = datos.juegos[juego];
  return { version: Number(datos.version) || 0, catalogo: delJuego && typeof delJuego === 'object' ? juegoParaCliente(delJuego).catalogo : [] };
}

// POST { codigo } -> catálogo del juego con los precios ya descontados (js/descuento.js)
async function descuento(req, res) {
  cabecerasCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const juego = String(req.query.juego);
  const scriptUrl = process.env.SCRIPT_MANUALES;
  if (!scriptUrl) return faltaConfiguracion(res, ['SCRIPT_MANUALES'], { status: 'error', valido: false, message: MENSAJE_SIN_CONFIGURAR });
  try {
    const { version } = await catalogoConVersion(scriptUrl, juego);
    if (version < VERSION_CON_DESCUENTO) {
      console.error(`Manuales: manuales.gs v${version} no acepta códigos de descuento: publicarlo como Nueva versión (v${VERSION_CON_DESCUENTO})`);
      return res.status(200).json({ status: 'success', valido: false, message: 'Los códigos de descuento aún no están disponibles en esta tienda.' });
    }
  } catch (error) {
    console.error(`Error al leer el catálogo de ${juego} para un código:`, error.message);
    return res.status(503).json({ status: 'error', valido: false, message: 'No pudimos validar el código. Intenta de nuevo en unos segundos.' });
  }
  return crearAccionDescuento(NOMBRES[juego], async () => conDestacados(juego, (await catalogoConVersion(scriptUrl, juego)).catalogo))(req, res);
}

// Estado de cada pedido para la página (columna "estado" de la pestaña del juego)
const ESTADOS_PEDIDO = ['pendiente', 'en_proceso', 'completado', 'incompleto', 'problema'];
const ID_PEDIDO_MANUAL = /^man-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// manuales.gs responde estado_pedido desde la versión 3
const VERSION_CON_ESTADO = 3;

/**
 * Seguimiento del pedido (js/mis-recargas.js lo consulta cada 30 s mientras la página está abierta):
 * POST { idPedido } -> { status, estado } con estado = pendiente | en_proceso | completado | incompleto |
 * problema | desconocido. El idPedido (UUID que solo recibió el cliente) hace de llave: no expone nada más.
 */
async function estado(req, res) {
  cabecerasCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ status: 'error', message: 'Método no permitido' });
  const juego = String(req.query.juego);
  const idPedido = String(req.body?.idPedido ?? '');
  if (!ID_PEDIDO_MANUAL.test(idPedido)) return res.status(400).json({ status: 'error', message: 'Pedido inválido.' });
  const scriptUrl = process.env.SCRIPT_MANUALES;
  if (!scriptUrl) return faltaConfiguracion(res, ['SCRIPT_MANUALES'], { status: 'error', message: MENSAJE_SIN_CONFIGURAR });

  const minutos = await permitirUso(`estado:${obtenerIp(req)}`);
  if (minutos > 0) return res.status(429).json({ status: 'error', message: `Espera ${minutos} minutos.` });

  try {
    const { version } = await catalogoConVersion(scriptUrl, juego);
    if (version < VERSION_CON_ESTADO) return res.status(200).json({ status: 'success', estado: 'desconocido' });
    // Copia de 20 s por pedido: dos pestañas abiertas no duplican la consulta
    const { datos } = await conCache(`estado:${idPedido}`,
      () => llamarScript(scriptUrl, { accion: 'estado_pedido', juego, idPedido }, LECTURA_APPS_SCRIPT),
      { frescoMs: 20000, respaldoMs: 0, esValido: (d) => d?.status === 'success' });
    const valor = String(datos.estado || '');
    // Perfil del cliente con sesión (Supabase): el estado nuevo le llega en vivo
    if (datos.encontrado && ESTADOS_PEDIDO.includes(valor)) actualizarEstado(idPedido, valor);
    return res.status(200).json({ status: 'success', estado: datos.encontrado && ESTADOS_PEDIDO.includes(valor) ? valor : 'desconocido' });
  } catch (error) {
    console.error(`Manuales: no se pudo leer el estado del pedido (${juego}):`, error.message);
    return res.status(503).json({ status: 'error', message: 'No pudimos consultar tu pedido ahora.' });
  }
}

export const acciones = { precios, descuento, estado };

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

    // Código de descuento (opcional): se vuelve a consultar la tabla y el precio sale del de la hoja,
    // ANTES de tocar el pago. Sin código, manuales.gs cobra su precio.
    let desc = null;
    let montoACobrar = null;
    if (req.body?.codigoDescuento) {
      let catalogo;
      try {
        catalogo = await catalogoConVersion(scriptUrl, juego);
      } catch (error) {
        console.error(`Manuales: no se pudieron leer los precios de ${juego} para el descuento:`, error.message);
        return res.status(503).json({ status: 'error', message: 'No pudimos aplicar tu código de descuento ahora. Intenta de nuevo en un momento.' });
      }
      if (catalogo.version < VERSION_CON_DESCUENTO) return res.status(400).json({ status: 'error', message: MENSAJE_SIN_DESCUENTO });
      const item = catalogo.catalogo.find((p) => p.paquete === String(paquete));
      const precioLista = item ? limpiarMontoVES(item.precio) : 0;
      if (!(precioLista > 0)) {
        return res.status(400).json({ status: 'error', message: 'Ese paquete ya no está disponible. Recarga la página.' });
      }
      const resultado = await aplicarDescuentoARecarga(req.body.codigoDescuento, precioLista);
      if (resultado.error) return res.status(resultado.error.codigo).json(resultado.error.cuerpo);
      // Un monto fijo mayor que el precio no se aplica a ese paquete: se cobra completo y no cuenta como uso
      if (resultado.desc && resultado.precio < precioLista) ({ desc, precio: montoACobrar } = resultado);
    }

    const idPedido = `man-${randomUUID()}`;
    // Pagos en Supabase (interruptor del panel, _lib/motor-pagos.js): el pago se aparta aquí y manuales.gs
    // solo anota el pedido (recibe pagoSupabase y no busca en la hoja)
    let pagoSupabase = null;
    if ((await motorPagos()) === 'supabase') {
      const pago = await tomarPago(String(referencia), idPedido, juego);
      if (!pago.encontrado) {
        await registrarFallo(clavesLimite);
        return res.status(200).json({ status: 'error', message: pago.message });
      }
      pagoSupabase = { referencia: pago.referencia, monto: pago.monto };
    }
    let data;
    try {
      data = await llamarScript(scriptUrl, {
        accion: 'registrar_pedido', juego, idPedido, paquete: String(paquete), referencia: String(referencia),
        metodo: String(metodo), usuario, clave, telefono, comprobante: textoParaHoja(url_capture || 'Sin comprobante'),
        ...(desc && { montoACobrar, codigoDescuento: desc.codigo }),
        ...(pagoSupabase && { pagoSupabase }),
      }, REGISTRO_PEDIDO);
      // Con el pedido anotado el pago queda usado; si la hoja lo rechazó (datos de la cuenta, paquete…), se libera
      if (pagoSupabase && data?.status === 'success') {
        if (data.registrado) await cambiarPago(pagoSupabase.referencia, 'usado', { idPedido });
        else await cambiarPago(pagoSupabase.referencia, 'verificado', { soloSi: 'en_proceso' });
      }
    } catch (error) {
      // Sin respuesta: no se sabe si se anotó, así que el pago no vuelve a estar libre (se revisa a mano)
      if (pagoSupabase) await cambiarPago(pagoSupabase.referencia, 'usado', { idPedido }).catch(() => {});
      if (!error.tiempoAgotado) throw error;
      console.error(`⚠️ Pedido manual de ${juego} sin respuesta a tiempo | REF: ${referencia} | pedido ${idPedido}: revisar la pestaña del juego` +
        (desc ? ` | código ${desc.codigo} (${montoACobrar} Bs): si el pedido se anotó, anotar el uso a mano en "Descuentos"` : ''));
      return res.status(202).json({ status: 'error', message: 'Fallo técnico momentáneo: tu pedido quedó en revisión. Si en 10 minutos no te escribimos, escríbenos por WhatsApp con tu referencia.' });
    }

    if (data?.status === 'success' && data.registrado) {
      await anotarUsoDelCodigo({ scriptUrl, juego, idPedido, telefono, data });
      // +1 venta del paquete ("Más vendido"); sin cuenta: las tiendas manuales no tienen premio de cliente fiel
      if (!data.repetido) anotarRecarga({ juego, cuenta: null, paquete: String(paquete), idPedido });
      return res.status(200).json({
        status: 'success', insuficiente: data.insuficiente === true,
        precio: String(data.precio || ''), pagado: String(data.pagado || ''), falta: String(data.falta || ''),
        // Para seguir el estado del pedido desde la página (js/mis-recargas.js)
        idPedido,
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

// Pedido anotado con código: +1 uso y la comisión del creador en la hoja de Free Fire (registrar_uso_descuento
// no repite un pedido ya anotado). Solo si el pago alcanzó (si no, manuales.gs ya dejó el aviso en la nota)
// y si manuales.gs aceptó el precio con descuento (data.codigoDescuento). Si falla, el aviso va a la nota del
// pedido para anotarlo a mano. Nunca cambia la respuesta al cliente: su pedido ya está guardado.
async function anotarUsoDelCodigo({ scriptUrl, juego, idPedido, telefono, data }) {
  const codigo = String(data.codigoDescuento || '');
  if (!codigo || data.insuficiente === true) return;
  const montoCobrado = limpiarMontoVES(data.precio);
  const anotado = await registrarUsoDescuento({ codigo, montoCobrado, idPedido, idJugador: `WhatsApp ${telefono}`, juego: NOMBRES[juego] });
  if (anotado) return;
  console.error(`🚨 Manuales: no se anotó el uso del código ${codigo} (${montoCobrado} Bs, ${juego}, pedido ${idPedido}). Anotarlo a mano en "Descuentos".`);
  try {
    await llamarScript(scriptUrl, {
      accion: 'nota_pedido', juego, idPedido,
      nota: `El uso del código ${codigo} NO se pudo anotar en "Descuentos": anótalo a mano (venta de ${data.precio} Bs)`,
    }, { tiempoMs: 15000, reintentos: 1, reintentarTrasTimeout: true });
  } catch (error) {
    console.error(`Manuales: tampoco se pudo dejar la nota en el pedido ${idPedido}:`, error.message);
  }
}
