// Roblox: precios, códigos de descuento y compra (el Apps Script de GAS_URL, apps-script/roblox.gs,
// verifica el pago y entrega). Lo usan api/juego.js (precios, descuento) y api/recargar.js (recargar).
// Desde 2026-11-14 los códigos viven en Supabase (supabase/roblox.sql): con Supabase activo se manda
// codigosSupabase: true, roblox.gs aparta el pago (status "comprar", productId "SUPABASE") y aquí se toma
// el código (entregarDeSupabase). Sin Supabase, como antes: la pestaña "Codigos" de la hoja y, si no quedan
// y el paquete tiene product_id (fila 3 de PreciosRoblox), Central One (ver comprarEnCentralOne).
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import { obtenerIp, minutosBloqueado, registrarFallo } from '../limitador.js';
import { llamarScript, LECTURA_APPS_SCRIPT, conCache, cabecerasCachePrecios } from '../externo.js';
import { PAQUETE_VALIDO, textoParaHoja, faltaConfiguracion, telefonoCliente } from '../validacion.js';
import { crearAccionDescuento, aplicarDescuentoARecarga, registrarUsoDescuento, precioConDescuento } from '../descuentos.js';
import { porcentajePremio, anotarRecarga, crearAccionFidelidad, conDestacados } from '../fidelidad.js';
import { limpiarMontoVES, formatearVES } from '../recarga-comun.js';
import { catalogo as catalogoCentralOne, datosParaPedido, crearPedidoCentralOne, esperarCodigo } from '../centralone.js';
import { supabaseActivo, rpc } from '../supabase.js';
import { motorPagos, tomarPago, cambiarPago, guardarPorCompletar, completarPago } from '../motor-pagos.js';

// Debe ser menor que maxDuration de api/recargar.js en vercel.json (180 s).
// La compra no se reintenta: el Apps Script de Roblox no tiene idPedido y repetirla podría duplicarla.
const TIEMPO_COMPRA_MS = 45000;
const MENSAJE_SIN_CONFIGURAR = 'La tienda de Roblox no está disponible en este momento. Intenta más tarde.';
// Con esta cantidad de códigos o menos, el paquete se muestra como "¡Últimos!"
const POCOS_CODIGOS = 3;
// Completar un pago insuficiente: la clave que recibe el cliente (la hoja solo guarda su huella SHA-256)
const CLAVE_COMPLEMENTO = /^[A-Za-z0-9_-]{32,64}$/;
const huella = (texto) => createHash('sha256').update(String(texto)).digest('hex');

// Compra en Central One (variable roblox_nuevo, con codes:read; sin ella, como antes: solo los códigos
// guardados). Todo cabe en maxDuration (180 s): la espera del código termina a los 150 s de la compra.
const LIMITE_COMPRA_API_MS = 150000;
const TIEMPO_PEDIDO_CENTRALONE_MS = 30000;
// entregar_api, liberar_api y nota_api de roblox.gs miran el estado de la fila antes de tocar nada:
// repetirlas es seguro
const ESCRITURA_IDEMPOTENTE = { tiempoMs: 20000, intentoMs: 10000, reintentos: 1, reintentarTrasTimeout: true };
const PRODUCTO_VALIDO = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const llaveRoblox = () => (process.env.roblox_nuevo || '').trim();
const PRODUCTO_SUPABASE = 'SUPABASE';

// Clave de un paquete, igual que claveDePaquete de roblox.gs y la columna "paquete" de roblox_codigos:
// "355 Robux" -> "355", "800 Robux EE. UU." -> "800-EEUU"
function claveDePaquete(nombre) {
  const numero = String(nombre || '').replace(/[^0-9]/g, '');
  if (!numero) return '';
  return /EE\.?\s*UU|ESTADOS\s+UNIDOS|UNITED\s+STATES|\bUSA?\b/i.test(String(nombre)) ? `${numero}-EEUU` : numero;
}

// Códigos libres en Supabase por paquete ({ "355": 31 }), 20 s en memoria. null si Supabase no respondió.
async function stockSupabase() {
  try {
    const { datos } = await conCache('roblox:stock:supabase', () => rpc('roblox_stock', {}),
      { frescoMs: 20_000, respaldoMs: 10 * 60_000, esValido: (d) => d && typeof d === 'object' });
    return datos;
  } catch (error) {
    console.error('Roblox: no se pudo leer el stock de códigos en Supabase:', error.message);
    return null;
  }
}

// CORS: solo tu dominio (igual que vercel.json)
function cabecerasCors(res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://levelupstore.online');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// Paquetes de Roblox en Supabase (tabla "precios", juego "roblox"; se crean en admin.html → Roblox).
// { precios: { "355 Robux": "3.500,00" }, filas: { "355 Robux": { producto, enStock } }, centralOne, origen }
// 30 s en memoria. null si Supabase no respondió (se usa la hoja).
async function preciosSupabase() {
  try {
    const { datos } = await conCache('precios:roblox:supabase', async () => {
      const [filas, centralOne] = await Promise.all([rpc('precios_de', { p_juego: 'roblox' }), rpc('roblox_central_one', {})]);
      return { filas, centralOne: centralOne === true };
    }, { frescoMs: 30_000, respaldoMs: 10 * 60_000, esValido: (d) => Array.isArray(d?.filas) });
    const precios = {};
    const filas = {};
    for (const f of datos.filas) {
      if (!f.activo || !(Number(f.precio) > 0) || !PAQUETE_VALIDO.test(String(f.paquete))) continue;
      precios[f.paquete] = formatearVES(Number(f.precio));
      filas[f.paquete] = { producto: PRODUCTO_VALIDO.test(String(f.producto || '')) ? f.producto : '', enStock: f.en_stock === true };
    }
    return { status: 'success', precios, filas, centralOne: datos.centralOne, origen: 'supabase' };
  } catch (error) {
    console.error('Roblox: no se pudieron leer los paquetes de Supabase (se usa la hoja):', error.message);
    return null;
  }
}

// Precios { "50 Robux": "1.000,00", ... }: de Supabase si está activo; si no (o falla), de la hoja, con
// caché en memoria (instantánea y con respaldo)
async function obtenerPreciosRoblox(scriptUrl) {
  if (supabaseActivo()) {
    const deSupabase = await preciosSupabase();
    if (deSupabase) return deSupabase;
  }
  const { datos } = await conCache('precios:roblox',
    () => llamarScript(scriptUrl, { tipo: 'obtener_precios' }, LECTURA_APPS_SCRIPT),
    { esValido: (d) => d?.status === 'success' && d.precios && typeof d.precios === 'object' });
  return datos;
}

// Stock de cada paquete para el cliente: nunca la cantidad exacta de códigos del inventario,
// solo 'disponible', 'pocos' o 'agotado'. Sin datos de stock (Apps Script anterior) → {}.
// Sin códigos guardados, un paquete con product_id sigue a la venta si Central One tiene stock.
async function estadoStock({ stock, productos, precios, filas, centralOne } = {}) {
  if (supabaseActivo() && precios && typeof precios === 'object') {
    const libres = await stockSupabase();
    // Sin respuesta de Supabase no se sabe: se deja comprar (si no quedan, la compra libera el pago)
    return Object.fromEntries(Object.keys(precios).map((producto) => {
      if (!libres) return [producto, 'disponible'];
      const n = Number(libres[claveDePaquete(producto)]) || 0;
      if (n > 0) return [producto, n <= POCOS_CODIGOS ? 'pocos' : 'disponible'];
      // Sin códigos: se vende si se compra en Central One (activado, unido a un producto y con stock allí)
      const f = filas?.[producto];
      return [producto, centralOne && llaveRoblox() && f?.producto && f.enStock ? 'disponible' : 'agotado'];
    }));
  }
  if (!stock || typeof stock !== 'object') return {};
  const estados = {};
  for (const [producto, cantidad] of Object.entries(stock)) {
    const n = Number(cantidad) || 0;
    estados[producto] = n <= 0 ? 'agotado' : n <= POCOS_CODIGOS ? 'pocos' : 'disponible';
  }
  const apiKey = llaveRoblox();
  const deCentralOne = Object.keys(estados).filter((p) => estados[p] === 'agotado' && PRODUCTO_VALIDO.test(String(productos?.[p] || '')));
  // Por qué un paquete sin códigos guardados sale "agotado" (solo al log, nunca al cliente)
  if (!productos) console.warn('Roblox: el Apps Script no manda "productos": publicar roblox.gs como Nueva versión');
  else if (!apiKey && deCentralOne.length) console.error('Roblox: falta la variable roblox_nuevo en Vercel: los paquetes de Central One salen agotados');
  if (apiKey && deCentralOne.length) {
    let items = null;
    try {
      items = await catalogoCentralOne(apiKey);
    } catch (error) {
      console.error('Roblox: no se pudo leer el catálogo de Central One para el stock:', error.message);
    }
    for (const p of deCentralOne) {
      const item = items?.find((i) => i?.product_id === productos[p]);
      // Sin catálogo no se sabe: se deja vender (la compra lo comprueba antes de pedir nada)
      if (!items || (item && item.in_stock !== false)) estados[p] = 'disponible';
      else if (!item) console.warn(`Roblox: "${p}" (${productos[p]}) no está en el catálogo de la llave roblox_nuevo: sale agotado`);
    }
  }
  return estados;
}

// Catálogo en lista para la acción "descuento" (misma caché que la acción precios)
async function catalogoRoblox() {
  const datos = await obtenerPreciosRoblox(process.env.GAS_URL);
  const { precios } = datos;
  const estados = await estadoStock(datos);
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
    // Los product_id de Central One (datos.productos) nunca van al navegador
    const stock = await estadoStock(datos);
    // "⭐ Más vendido" / "💰 Mejor precio" por producto (_lib/fidelidad.js)
    const destacados = Object.fromEntries((await conDestacados('roblox', Object.entries(datos.precios)
      .map(([producto, precio]) => ({ producto, precio, ...(stock[producto] && { stock: stock[producto] }) }))))
      .filter((p) => p.etiqueta).map((p) => [p.producto, p.etiqueta]));
    return res.status(200).json({ status: 'success', precios: datos.precios, stock, destacados });
  } catch (error) {
    console.error('Error al obtener precios de Roblox:', error.message);
    return res.status(error.name === 'ErrorExterno' ? 503 : 500).json({ status: 'error', message: 'Error interno de conexión con el servidor.' });
  }
}

export const acciones = {
  precios, descuento: crearAccionDescuento('Roblox', catalogoRoblox),
  fidelidad: crearAccionFidelidad('roblox', async () => conDestacados('roblox', await catalogoRoblox())),
};

// Libro diario: cada venta entregada se anota en "Exitosas" (roblox.gs, tipo registrar_venta) después de
// responder. Los pagos y los códigos están en Supabase: la hoja solo guarda lo que se vendió.
function anotarVentaEnHoja(scriptUrl, venta) {
  waitUntil(llamarScript(scriptUrl, { tipo: 'registrar_venta', ...venta }, { tiempoMs: 25000 })
    .then((r) => { if (r?.status !== 'success') throw new Error(r?.message || 'respuesta sin éxito'); })
    .catch((error) => console.error(`⚠️ Roblox: venta ${venta.idPedido} entregada pero NO anotada en "Exitosas" `
      + `(${venta.usuario} · ${venta.paquete} · ${venta.precio} Bs · ref ${venta.referencia}): ${error.message}`)));
}

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
  const inicio = Date.now();
  cabecerasCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ status: 'error', message: 'Método no permitido. Usa POST.' });
  }

  // Segunda (o tercera...) referencia de un pago que no alcanzó
  if (req.body?.tokenComplemento !== undefined) return completarCompra(req, res, inicio);

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
    let precioLista = 0;
    // Con Supabase: el paquete tiene que existir y estar a la venta; su precio va a roblox.gs (precioOficial)
    let paqueteSupabase = null;
    if (supabaseActivo()) {
      const datosPrecios = await obtenerPreciosRoblox(scriptUrl);
      if (datosPrecios.origen === 'supabase') {
        if (!Object.hasOwn(datosPrecios.precios, String(producto))) {
          return res.status(400).json({ status: 'error', message: 'Ese paquete ya no está disponible. Recarga la página.' });
        }
        precioLista = limpiarMontoVES(datosPrecios.precios[String(producto)]);
        paqueteSupabase = { ...datosPrecios.filas[String(producto)], centralOne: datosPrecios.centralOne };
      }
    }
    // Premio de cliente fiel (_lib/fidelidad.js): solo sin código. roblox.gs acepta montoACobrar sin código.
    let premio = 0;
    if (!req.body?.codigoDescuento) {
      premio = await porcentajePremio({ juego: 'roblox', firma: req.body?.premioFidelidad });
      if (premio) {
        try {
          const { precios } = await obtenerPreciosRoblox(scriptUrl);
          if (Object.hasOwn(precios, String(producto))) precioLista = limpiarMontoVES(precios[String(producto)]);
        } catch (error) {
          console.error('Roblox: no se pudieron leer los precios para el premio de cliente fiel:', error.message);
        }
        const conPremio = precioLista > 0 ? precioConDescuento(precioLista, { tipo: 'porcentaje', valor: premio }) : 0;
        if (conPremio > 0 && conPremio < precioLista) montoACobrar = conPremio; else premio = 0;
      }
    }
    if (req.body?.codigoDescuento) {
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
    const payload = {
      tipo: 'compra', referencia: String(referencia), user: usuario, producto: String(producto),
      url_capture: textoParaHoja(url_capture || 'Sin comprobante'), idPedido, claveHash: huella(clave),
      ...(montoACobrar !== undefined && { montoACobrar }),
      ...(desc && { codigoDescuento: desc.codigo }),
      // WhatsApp opcional ("+58…" o vacío): roblox.gs lo anota en "Exitosas", "por_completar" y "pedidos_api"
      telefono: telefonoCliente(req.body?.telefono),
      // Sin códigos guardados, roblox.gs reserva el pago y responde "comprar" (solo si hay llave)
      ...(llaveRoblox() && { api: true }),
      // Códigos en Supabase: roblox.gs aparta el pago y el código se toma aquí (entregarDeSupabase)
      ...(supabaseActivo() && { codigosSupabase: true }),
      ...(paqueteSupabase && precioLista > 0 && { precioOficial: precioLista }),
    };

    // Pagos en Supabase (interruptor del panel): todo aquí, sin Apps Script (compraConSupabase)
    let data;
    const cobroSupabase = (await motorPagos()) === 'supabase';
    if (cobroSupabase && !paqueteSupabase) {
      // Pagos en Supabase pero sin sus paquetes (Supabase no respondió): nunca se cobra con la hoja
      return res.status(503).json({ status: 'error', message: 'Fallo técnico momentáneo: tu pago no se usó. Intenta de nuevo en un minuto.' });
    }
    if (cobroSupabase) {
      data = await compraConSupabase({ idPedido, referencia: String(referencia), usuario, paquete: String(producto),
        precio: montoACobrar ?? precioLista, claveHash: huella(clave), codigoDescuento: desc?.codigo || '',
        telefono: telefonoCliente(req.body?.telefono) });
      if (data?.status === 'success') {
        anotarVentaEnHoja(scriptUrl, { idPedido, usuario, paquete: String(producto), referencia: (data.referencias || []).join(' + '),
          codigo: data.code, url_capture: payload.url_capture, precio: montoACobrar ?? precioLista,
          codigoDescuento: desc?.codigo || '', telefono: payload.telefono });
      }
    } else try {
      // Apps Script verifica el pago y la entrega, puede tardar más. Sin reintento
      // (podría duplicar la compra). Si se agota el tiempo, la compra sigue en Apps Script.
      data = await llamarScript(scriptUrl, payload, { tiempoMs: TIEMPO_COMPRA_MS });
    } catch (error) {
      if (!error.tiempoAgotado) throw error;
      console.error('⚠️ Compra Roblox sin respuesta a tiempo | REF:', payload.referencia,
        desc ? `| código ${desc.codigo} (${montoACobrar} Bs, pedido ${idPedido}): si se entregó, anotar el uso a mano` : '');
      return res.status(202).json({ status: 'error', message: 'Fallo técnico momentáneo: tu compra quedó en proceso. Si en 5 minutos no la recibes, escríbenos por WhatsApp.' });
    }
    if (data?.status === 'comprar') {
      data = data.productId === PRODUCTO_SUPABASE
        ? await entregarDeSupabase({ scriptUrl, idPedido, paquete: String(producto), usuario, inicio, respaldo: paqueteSupabase })
        : await comprarEnCentralOne({ scriptUrl, idPedido, productId: data.productId, usuario, inicio });
    }

    // Pago encontrado (entregado o insuficiente): +1 compra de la cuenta, el premio se gasta y +1 venta del producto
    if (data?.status === 'success' || data?.insuficiente) {
      anotarRecarga({ juego: 'roblox', cuenta: usuario.toLowerCase(), paquete: String(producto), idPedido, premio, precioLista, precio: montoACobrar ?? precioLista });
    }

    // Una compra rechazada (pago no encontrado, ya usado, insuficiente...) cuenta como intento fallido.
    // "Fallo técnico" no cuenta: el pago sí existía y quedó en proceso. Tampoco lo que falló en Central One.
    if (data?.status !== 'success' && !data?.sinCulpa && !String(data?.message || '').toLowerCase().includes('fallo técnico')) {
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
async function completarCompra(req, res, inicio) {
  try {
    const clave = String(req.body?.tokenComplemento ?? '');
    // Desde el perfil (api/recargar.js ya comprobó que el pedido es de esa cuenta): la huella guardada
    const hashPerfil = typeof req.claveHashPerfil === 'string' ? req.claveHashPerfil : '';
    const referencia = String(req.body?.referencia ?? '');
    if ((!hashPerfil && !CLAVE_COMPLEMENTO.test(clave)) || !/^\d{5}$/.test(referencia)) {
      return res.status(400).json({ status: 'error', message: 'Escribe los últimos 5 dígitos de la referencia del pago que hiciste para completar.' });
    }
    const scriptUrl = process.env.GAS_URL;
    if (!scriptUrl) {
      return faltaConfiguracion(res, ['GAS_URL'], { status: 'error', message: MENSAJE_SIN_CONFIGURAR });
    }

    const claveHash = hashPerfil || huella(clave);
    // Intentos fallidos por IP y por clave (frena probar referencias al azar)
    const clavesLimite = [`ip:${obtenerIp(req)}`, `completar:roblox:${claveHash.slice(0, 24)}`];
    const minutosEspera = await minutosBloqueado(clavesLimite);
    if (minutosEspera > 0) {
      return res.status(429).json({ status: 'error', message: `Demasiados intentos fallidos. Espera ${minutosEspera} minutos para volver a intentar.` });
    }

    const idPedido = `rbx-${randomUUID()}`;
    let data;
    if ((await motorPagos()) === 'supabase') {
      data = await completarConSupabase({ idPedido, claveHash, referencia });
      if (data?.status === 'success') {
        anotarVentaEnHoja(scriptUrl, { idPedido, usuario: String(data.usuario || ''), paquete: String(data.paquete || ''),
          referencia: (data.referencias || []).join(' + '), codigo: data.code, url_capture: 'Sin comprobante (pago completado)',
          precio: Number(data.precio) || 0, codigoDescuento: data.codigoDescuento || '', telefono: telefonoCliente(req.body?.telefono) });
      }
    } else try {
      data = await llamarScript(scriptUrl, {
        tipo: 'completar', claveHash, referencia, idPedido, ...(llaveRoblox() && { api: true }),
        ...(supabaseActivo() && { codigosSupabase: true }),
        // Si en el primer pago no dejó WhatsApp, roblox.gs usa este
        telefono: telefonoCliente(req.body?.telefono),
      }, { tiempoMs: TIEMPO_COMPRA_MS });
    } catch (error) {
      if (!error.tiempoAgotado) throw error;
      console.error(`⚠️ Completar pago de Roblox sin respuesta a tiempo | REF: ${referencia} | pedido ${idPedido} | clave ${claveHash.slice(0, 12)}…: revisar "por_completar" y "Exitosas"`);
      return res.status(202).json({ status: 'error', message: 'Fallo técnico momentáneo: tu compra quedó en proceso. Si en 5 minutos no la recibes, escríbenos por WhatsApp con tus referencias.' });
    }

    if (data?.status === 'comprar') {
      const datosPrecios = data.productId === PRODUCTO_SUPABASE ? await obtenerPreciosRoblox(scriptUrl).catch(() => null) : null;
      const respaldo = datosPrecios?.origen === 'supabase' && datosPrecios.filas[String(data.paquete || '')]
        ? { ...datosPrecios.filas[String(data.paquete || '')], centralOne: datosPrecios.centralOne } : null;
      data = data.productId === PRODUCTO_SUPABASE
        ? await entregarDeSupabase({ scriptUrl, idPedido, paquete: String(data.paquete || ''), usuario: String(data.usuario || ''), inicio, respaldo })
        : await comprarEnCentralOne({ scriptUrl, idPedido, productId: data.productId, usuario: String(data.usuario || ''), inicio });
    }

    if (data?.status !== 'success' && !data?.insuficiente && !data?.sinCulpa) await registrarFallo(clavesLimite);

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

// =========================================================================
// PAGOS EN SUPABASE (interruptor "pagos_motor" del panel; _lib/motor-pagos.js). La compra entera pasa aquí:
// apartar el pago → si no alcanza, "por completar" → código de Supabase → pago usado. Sin Apps Script.
// Devuelve lo mismo que roblox.gs para respuestaCompra.
// =========================================================================
async function compraConSupabase({ idPedido, referencia, usuario, paquete, precio, claveHash, codigoDescuento, telefono }) {
  const pago = await tomarPago(referencia, idPedido, 'roblox');
  if (!pago.encontrado) return { status: 'error', message: pago.message };
  if (pago.monto < precio - 0.5) {
    const g = await guardarPorCompletar({ idPedido, referencia: pago.referencia, claveHash, precio, pagado: pago.monto, juego: 'roblox',
      datos: { usuario, paquete, codigoDescuento, telefono } });
    const falta = Math.round((precio - pago.monto) * 100) / 100;
    return {
      status: 'error', insuficiente: true, montoPagado: pago.monto, precioOficial: precio,
      ...(g?.status === 'success' && { porCompletar: true, falta, horas: 48 }),
      message: `Pago insuficiente: encontramos ${formatearVES(pago.monto)} Bs, pero este paquete cuesta ${formatearVES(precio)} Bs.`
        + (g?.status === 'success' ? ` Faltan ${formatearVES(falta)} Bs: paga la diferencia y escribe la nueva referencia para completar tu compra.` : ''),
    };
  }
  return entregarCodigoSupabase({ idPedido, paquete, usuario, referencias: [pago.referencia], liberar: pago.referencia });
}

// Código de Supabase para un pago ya apartado. Sin códigos: el pago se libera (compra nueva) o queda guardado
// para que el administrador lo entregue (pago completado: se avisa como en roblox.gs).
async function entregarCodigoSupabase({ idPedido, paquete, usuario, referencias, liberar }) {
  let codigo = null;
  try {
    codigo = await rpc('roblox_tomar_codigo', { p_paquete: claveDePaquete(paquete), p_id_pedido: idPedido, p_usuario: usuario });
  } catch (error) {
    console.error(`❌ Roblox (Supabase), pedido ${idPedido}: no se pudo tomar un código: ${error.message}`);
  }
  if (typeof codigo !== 'string' || !codigo) {
    if (liberar) {
      await cambiarPago(liberar, 'verificado', { soloSi: 'en_proceso' }).catch(() => {});
      return { status: 'error', agotado: true, sinCulpa: true, message: '⚠️ Este paquete se acaba de agotar. Tu pago no se usó: elige otro paquete o escríbenos por WhatsApp.' };
    }
    return { status: 'error', agotado: true, sinCulpa: true, message: '⚠️ Este paquete se agotó justo ahora. Tu pago anterior sigue guardado: escríbenos por WhatsApp y te lo entregamos.' };
  }
  for (const ref of referencias) await cambiarPago(ref, 'usado', { idPedido }).catch((e) => console.error(`🚨 Roblox: código entregado pero el pago …${String(ref).slice(-5)} no se pudo marcar usado: ${e.message}`));
  return { status: 'success', code: codigo, referencias, message: '¡Código canjeado con éxito!' };
}

async function completarConSupabase({ idPedido, claveHash, referencia }) {
  const r = await completarPago(claveHash, referencia, idPedido, 'roblox');
  if (!r?.valido) return { status: 'error', complementoInvalido: true, message: String(r?.message || 'No encontramos este pago por completar.') };
  if (!r.encontrado) return { status: 'error', message: r.message };
  if (!r.completo) {
    const falta = Number(r.falta) || 0;
    return { status: 'error', insuficiente: true, porCompletar: true, montoPagado: Number(r.pagadoTotal) || 0, precioOficial: Number(r.precio) || 0,
      falta, horas: 48, message: `Pago insuficiente: con este pago llevas ${formatearVES(Number(r.pagadoTotal) || 0)} Bs y faltan ${formatearVES(falta)} Bs. Paga la diferencia y escribe la nueva referencia.` };
  }
  const datos = await entregarCodigoSupabase({ idPedido, paquete: String(r.paquete || ''), usuario: String(r.usuario || ''), referencias: r.referencias || [] });
  return { ...datos, usuario: r.usuario, paquete: r.paquete, precio: r.precio, codigoDescuento: r.codigoDescuento };
}

/**
 * Códigos en Supabase: roblox.gs ya dejó el pago "En proceso\" y el pedido en "pedidos_api" (productId
 * "SUPABASE"). Se toma un código (roblox_tomar_codigo: uno por pedido; repetirlo da el mismo) y:
 *  - hay código   → entregar_api: pago(s) "Usado", venta en "Exitosas" y el código para el cliente.
 *  - no quedan    → liberar_api: el pago vuelve a "Verificado" y el cliente ve "Agotado".
 *  - no responde  → se reintenta una vez; si sigue sin responder, el pago se libera (sin código no hay venta).
 *  - no quedan y está activado "comprar en Central One" (admin.html → Roblox) y el paquete está unido a un
 *    producto → comprarEnCentralOne (mismo pedido en "pedidos_api": entregar_api / liberar_api igual).
 */
async function entregarDeSupabase({ scriptUrl, idPedido, paquete, usuario, inicio = Date.now(), respaldo = null }) {
  const avisar = (tipo, datos) => llamarScript(scriptUrl, { tipo, idPedido, ...datos }, ESCRITURA_IDEMPOTENTE)
    .catch((error) => ({ status: 'error', message: error.message }));
  const clave = claveDePaquete(paquete);
  let codigo = null;
  let fallo = '';
  for (let intento = 0; intento < 2 && codigo === null; intento++) {
    try {
      codigo = await rpc('roblox_tomar_codigo', { p_paquete: clave, p_id_pedido: idPedido, p_usuario: usuario });
      fallo = '';
      if (codigo === null) break;          // no quedan códigos de ese paquete
    } catch (error) {
      fallo = error.message;
    }
  }
  // Sin códigos en Supabase (y Supabase sí respondió): Central One, si está activado para este paquete
  if ((typeof codigo !== 'string' || !codigo) && !fallo && respaldo?.centralOne && respaldo.producto && llaveRoblox()) {
    console.info(`Roblox, pedido ${idPedido}: sin códigos de ${clave} Robux en Supabase → se compra en Central One`);
    return comprarEnCentralOne({ scriptUrl, idPedido, productId: respaldo.producto, usuario, inicio });
  }
  if (typeof codigo !== 'string' || !codigo) {
    const motivo = fallo ? `Supabase no respondió (${fallo.slice(0, 120)})` : `sin códigos de ${clave} Robux en Supabase`;
    console.error(`❌ Roblox, pedido ${idPedido}: ${motivo} → se libera el pago.`);
    const r = await avisar('liberar_api', { motivo: textoParaHoja(motivo, 400) });
    if (r?.status !== 'success') {
      console.error(`🚨 Roblox: no se pudo liberar el pago del pedido ${idPedido} (${r?.message}): sigue "En proceso". Revisar "pedidos_api".`);
      return { status: 'error', sinCulpa: true, message: 'Fallo técnico momentáneo: no pudimos completar tu compra y tu pago quedó en revisión. Escríbenos por WhatsApp con tu referencia.' };
    }
    return fallo
      ? { status: 'error', sinCulpa: true, message: 'Fallo técnico momentáneo: tu pago no se usó. Intenta de nuevo en un minuto.' }
      : { status: 'error', agotado: true, sinCulpa: true, message: '⚠️ Este paquete se acaba de agotar. Tu pago no se usó: elige otro paquete o escríbenos por WhatsApp.' };
  }

  const entrega = await avisar('entregar_api', { codigo, ordenCentralOne: PRODUCTO_SUPABASE, enPagina: true });
  if (entrega?.status !== 'success') {
    // El código ya es de este pedido: el cliente lo recibe igual
    console.error(`🚨 Roblox: código entregado en la página pero NO anotado en la hoja (pedido ${idPedido}, usuario ${usuario}): ${entrega?.message}. Marcar el pago "Usado" y anotar la venta a mano.`);
  }
  return {
    status: 'success', code: codigo, message: '¡Código canjeado con éxito!',
    usuario: entrega?.usuario, precio: entrega?.precio, codigoDescuento: entrega?.codigoDescuento,
  };
}

/**
 * Sin códigos guardados: roblox.gs ya dejó el pago "En proceso" y el pedido en la pestaña "pedidos_api"
 * (respondió status "comprar" con el product_id). Aquí se compra el código en Central One y:
 *  - llegó el código    → entregar_api: pago(s) "Usado", venta en "Exitosas" y el código para el cliente.
 *  - no se compró       → liberar_api: el pago vuelve a "Verificado" (el cliente puede usarlo en otro paquete).
 *  - no se sabe o tarda → el pago sigue "En proceso"; el aviso de Central One (api/centralone-webhook.js)
 *                         anota el código y "pedidos_api" dice que hay que enviarlo por WhatsApp.
 * La Idempotency-Key es el idPedido: repetir el pedido nunca compra dos códigos.
 * Devuelve lo mismo que roblox.gs para respuestaCompra (sinCulpa: no cuenta como intento fallido).
 */
async function comprarEnCentralOne({ scriptUrl, idPedido, productId, usuario, inicio }) {
  const apiKey = llaveRoblox();
  const avisar = (tipo, datos) => llamarScript(scriptUrl, { tipo, idPedido, ...datos }, ESCRITURA_IDEMPOTENTE)
    .catch((error) => ({ status: 'error', message: error.message }));
  const enProceso = async (nota) => {
    const r = await avisar('nota_api', { texto: textoParaHoja(nota, 400) });
    if (r?.status !== 'success') console.error(`⚠️ Roblox: no se pudo anotar en "pedidos_api" el pedido ${idPedido}: ${nota}`);
    return { status: 'error', sinCulpa: true, message: 'Fallo técnico momentáneo: tu compra quedó en proceso. Si en 5 minutos no recibes tu código, escríbenos por WhatsApp.' };
  };
  // No se compró nada: el pago vuelve a quedar libre
  const noComprado = async (motivo) => {
    console.error(`❌ Roblox (Central One), pedido ${idPedido}: ${motivo} → se libera el pago.`);
    const r = await avisar('liberar_api', { motivo: textoParaHoja(motivo, 400) });
    if (r?.status !== 'success') {
      console.error(`🚨 Roblox: no se pudo liberar el pago del pedido ${idPedido} (${r?.message}): sigue "En proceso". Revisar "pedidos_api".`);
      return { status: 'error', sinCulpa: true, message: 'Fallo técnico momentáneo: no pudimos completar tu compra y tu pago quedó en revisión. Escríbenos por WhatsApp con tu referencia.' };
    }
    return { status: 'error', agotado: true, sinCulpa: true, message: '⚠️ Este paquete se acaba de agotar. Tu pago no se usó: elige otro paquete o escríbenos por WhatsApp.' };
  };

  if (!apiKey) return noComprado('falta la variable roblox_nuevo en Vercel');
  if (!PRODUCTO_VALIDO.test(String(productId || ''))) return noComprado(`product_id inválido en la fila 3 de PreciosRoblox ("${String(productId).slice(0, 60)}")`);

  // ¿Sigue en el catálogo y con stock? (antes de gastar saldo)
  const datos = await datosParaPedido({ apiKey, productId, idJugador: usuario });
  if (datos.error) return noComprado(datos.error);

  const orden = await crearPedidoCentralOne({
    apiKey, productId, payload: datos.payload, idempotencia: idPedido, nota: `Level Up ${idPedido}`, tiempoMs: TIEMPO_PEDIDO_CENTRALONE_MS,
  });
  if (orden.tipo === 'rechazo') {
    if (orden.codigo === 'insufficient_balance') console.error('🚨 Central One: SIN SALDO para comprar códigos de Roblox. Recargar saldo en el portal.');
    return noComprado(orden.motivo);
  }
  if (orden.tipo === 'incierto') {
    console.error(`⚠️ Roblox (Central One), pedido ${idPedido}: ${orden.motivo}`);
    return enProceso(`SIN CONFIRMAR: ${orden.motivo} Buscar en el portal de Central One la nota "Level Up ${idPedido}": si existe, el código llega solo por el aviso.`);
  }

  const { id: idOrden, referencia } = orden.orden;
  console.info(`✅ Central One aceptó el pedido ${referencia} (${orden.orden.total}) de Roblox para ${usuario}`);
  const espera = await esperarCodigo({ apiKey, idOrden, limite: inicio + LIMITE_COMPRA_API_MS });
  if (espera.fallo) return noComprado(`${espera.fallo}, pedido ${referencia}`);
  if (!espera.codigo) {
    console.error(`⚠️ Roblox: pedido ${referencia} pagado en Central One pero ${espera.pendiente}`);
    return enProceso(`PAGADO en Central One (pedido ${referencia}) pero ${espera.pendiente}: el código llega por el aviso. ENVIARLO POR WHATSAPP.`);
  }

  const entrega = await avisar('entregar_api', { codigo: espera.codigo, ordenCentralOne: referencia, enPagina: true });
  if (entrega?.status !== 'success') {
    // El código ya está comprado con el pago del cliente: lo recibe igual
    console.error(`🚨 Roblox: código entregado en la página pero NO anotado (pedido ${idPedido}, Central One ${referencia}, usuario ${usuario}): ${entrega?.message}. Marcar el pago "Usado" y anotar la venta a mano.`);
  }
  return {
    status: 'success', code: espera.codigo, message: '¡Código canjeado con éxito!',
    // Para anotar el uso del código de descuento al completar un pago (no llegan al cliente)
    usuario: entrega?.usuario, precio: entrega?.precio, codigoDescuento: entrega?.codigoDescuento,
  };
}
