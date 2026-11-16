// Roblox: precios, códigos de descuento y compra. Lo usan api/juego.js (precios, descuento) y api/recargar.js
// (recargar). TODO EN SUPABASE desde 2026-11-16 (antes el Apps Script de GAS_URL, apps-script/roblox.gs):
//   - Paquetes y precios: tabla "precios" (juego roblox; admin.html → Roblox / Precios).
//   - Códigos guardados: supabase/roblox.sql (roblox_tomar_codigo: uno por pedido; repetirlo da el mismo).
//   - Pago: _lib/motor-pagos.js (apartar → usado; si no alcanza, "por completar" con la huella de una clave).
//   - Sin códigos guardados y con "comprar en Central One" activado (admin.html → Roblox) y el paquete unido a
//     un producto: se compra el código en Central One (llave roblox_nuevo, con codes:read).
//   - Las ventas quedan en la tabla "recargas" (Panel → Pedidos; antes la pestaña "Exitosas").
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { obtenerIp, minutosBloqueado, registrarFallo } from '../limitador.js';
import { conCache, cabecerasCachePrecios, ErrorExterno } from '../externo.js';
import { PAQUETE_VALIDO, telefonoCliente } from '../validacion.js';
import { crearAccionDescuento, aplicarDescuentoARecarga, registrarUsoDescuento, precioConDescuento } from '../descuentos.js';
import { porcentajePremio, anotarRecarga, crearAccionFidelidad, conDestacados } from '../fidelidad.js';
import { formatearVES } from '../recarga-comun.js';
import { datosParaPedido, crearPedidoCentralOne, esperarCodigo } from '../centralone.js';
import { supabaseActivo, rpc } from '../supabase.js';
import { notaParaHistorial, pedidoDeEntrega } from '../historial.js';
import { MARGEN_BS, motorPagos, tomarPago, cambiarPago, guardarPorCompletar, completarPago } from '../motor-pagos.js';

const MENSAJE_SIN_CONFIGURAR = 'La tienda de Roblox no está disponible en este momento. Intenta más tarde.';
// Con esta cantidad de códigos o menos, el paquete se muestra como "¡Últimos!"
const POCOS_CODIGOS = 3;
// Completar un pago insuficiente: la clave que recibe el cliente (Supabase solo guarda su huella SHA-256)
const CLAVE_COMPLEMENTO = /^[A-Za-z0-9_-]{32,64}$/;
const huella = (texto) => createHash('sha256').update(String(texto)).digest('hex');

// Compra en Central One: todo cabe en maxDuration de api/recargar.js (180 s): la espera del código termina a
// los 150 s de empezar la compra. La compra solo se repite con la MISMA Idempotency-Key (el idPedido).
const LIMITE_COMPRA_API_MS = 150000;
const TIEMPO_PEDIDO_CENTRALONE_MS = 30000;
const PRODUCTO_VALIDO = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const llaveRoblox = () => (process.env.roblox_nuevo || '').trim();

// Clave de un paquete, igual que la columna "paquete" de roblox_codigos:
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

// Paquetes de Roblox en Supabase (tabla "precios", juego "roblox").
// { precios: { "355 Robux": "3.500,00" }, filas: { "355 Robux": { producto, enStock } }, centralOne }
// 30 s en memoria (y la copia anterior hasta 10 min si Supabase no responde). Lanza si no hay nada.
async function obtenerPreciosRoblox() {
  if (!supabaseActivo()) throw new ErrorExterno('Supabase no está configurado');
  const { datos } = await conCache('precios:roblox:supabase', async () => {
    const [filas, centralOne] = await Promise.all([rpc('precios_de', { p_juego: 'roblox' }), rpc('roblox_central_one', {})]);
    return { filas, centralOne: centralOne === true };
  }, { frescoMs: 30_000, respaldoMs: 10 * 60_000, esValido: (d) => Array.isArray(d?.filas) });
  const precios = {};
  const filas = {};
  for (const f of datos.filas) {
    if (!f.activo || !(Number(f.precio) > 0) || !PAQUETE_VALIDO.test(String(f.paquete))) continue;
    precios[f.paquete] = formatearVES(Number(f.precio));
    filas[f.paquete] = { producto: PRODUCTO_VALIDO.test(String(f.producto || '')) ? f.producto : '', enStock: f.en_stock === true, precio: Number(f.precio) };
  }
  return { status: 'success', precios, filas, centralOne: datos.centralOne };
}

// Stock de cada paquete para el cliente: nunca la cantidad exacta de códigos del inventario, solo
// 'disponible', 'pocos' o 'agotado'. Sin códigos, se vende si se compra en Central One (activado, unido a
// un producto y con stock allí).
async function estadoStock({ precios, filas, centralOne }) {
  const libres = await stockSupabase();
  return Object.fromEntries(Object.keys(precios).map((producto) => {
    // Sin respuesta de Supabase no se sabe: se deja comprar (si no quedan, la compra libera el pago)
    if (!libres) return [producto, 'disponible'];
    const n = Number(libres[claveDePaquete(producto)]) || 0;
    if (n > 0) return [producto, n <= POCOS_CODIGOS ? 'pocos' : 'disponible'];
    const f = filas?.[producto];
    return [producto, centralOne && llaveRoblox() && f?.producto && f.enStock ? 'disponible' : 'agotado'];
  }));
}

// Catálogo en lista para la acción "descuento" (misma caché que la acción precios)
async function catalogoRoblox() {
  const datos = await obtenerPreciosRoblox();
  const estados = await estadoStock(datos);
  return Object.entries(datos.precios).map(([producto, precio]) => ({ producto, precio, ...(estados[producto] && { stock: estados[producto] }) }));
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
  try {
    const datos = await obtenerPreciosRoblox();
    cabecerasCachePrecios(res);
    // Los product_id de Central One nunca van al navegador
    const stock = await estadoStock(datos);
    // "⭐ Más vendido" / "💰 Mejor precio" por producto (_lib/fidelidad.js)
    const destacados = Object.fromEntries((await conDestacados('roblox', Object.entries(datos.precios)
      .map(([producto, precio]) => ({ producto, precio, ...(stock[producto] && { stock: stock[producto] }) }))))
      .filter((p) => p.etiqueta).map((p) => [p.producto, p.etiqueta]));
    return res.status(200).json({ status: 'success', precios: datos.precios, stock, destacados });
  } catch (error) {
    console.error('Error al obtener precios de Roblox:', error.message);
    return res.status(503).json({ status: 'error', message: 'Error interno de conexión con el servidor.' });
  }
}

export const acciones = {
  precios, descuento: crearAccionDescuento('Roblox', catalogoRoblox),
  fidelidad: crearAccionFidelidad('roblox', async () => conDestacados('roblox', await catalogoRoblox())),
};

// Solo los campos que usa la página.
// clave: la del pago por completar; solo se devuelve si el pedido quedó guardado "por completar".
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

  const { tipo, referencia, user, producto } = req.body || {};
  // COMPATIBILIDAD TEMPORAL: la página anterior pedía los precios con POST /api/roblox
  // { tipo: "obtener_precios" }, que vercel.json redirige aquí. Quitar junto con esa redirección.
  if (tipo === 'obtener_precios') return precios(req, res);
  if (tipo !== undefined && tipo !== 'compra') {
    return res.status(400).json({ status: 'error', message: 'Operación no permitida.' });
  }

  try {
    if (!supabaseActivo()) return res.status(503).json({ status: 'error', message: MENSAJE_SIN_CONFIGURAR });

    const usuario = String(user || '').trim();
    if (!/^\d{5}$/.test(String(referencia)) || !/^[A-Za-z0-9_]{2,30}$/.test(usuario) || !PAQUETE_VALIDO.test(String(producto || ''))) {
      return res.status(400).json({ status: 'error', message: 'Datos con formato inválido. Revisa tu usuario y los 5 dígitos de la referencia.' });
    }

    // ¿Esta IP o este usuario acumula demasiados fallos?
    const clavesLimite = [`ip:${obtenerIp(req)}`, `jugador:roblox:${usuario.toLowerCase()}`];
    const minutosEspera = await minutosBloqueado(clavesLimite);
    if (minutosEspera > 0) {
      return res.status(429).json({ status: 'error', message: `Demasiados intentos fallidos. Espera ${minutosEspera} minutos para volver a intentar.` });
    }

    // El paquete tiene que existir y estar a la venta; el precio sale del servidor
    let datosPrecios;
    try {
      datosPrecios = await obtenerPreciosRoblox();
    } catch (error) {
      console.error('Roblox: no se pudieron leer los paquetes:', error.message);
      return res.status(503).json({ status: 'error', message: 'Fallo técnico momentáneo: tu pago no se usó. Intenta de nuevo en un minuto.' });
    }
    const fila = datosPrecios.filas[String(producto)];
    if (!fila) return res.status(400).json({ status: 'error', message: 'Ese paquete ya no está disponible. Recarga la página.' });
    const precioLista = fila.precio;
    const respaldo = { producto: fila.producto, enStock: fila.enStock, centralOne: datosPrecios.centralOne };

    // Premio de cliente fiel (_lib/fidelidad.js): solo sin código
    let desc = null;
    let montoACobrar;
    let premio = 0;
    if (!req.body?.codigoDescuento) {
      premio = await porcentajePremio({ juego: 'roblox', firma: req.body?.premioFidelidad });
      if (premio) {
        const conPremio = precioConDescuento(precioLista, { tipo: 'porcentaje', valor: premio });
        if (conPremio > 0 && conPremio < precioLista) montoACobrar = conPremio; else premio = 0;
      }
    } else {
      // Código de descuento (opcional): se valida de nuevo aquí, antes de tocar el pago
      const descuento = await aplicarDescuentoARecarga(req.body.codigoDescuento, precioLista);
      if (descuento.error) return res.status(descuento.error.codigo).json(descuento.error.cuerpo);
      ({ desc, precio: montoACobrar } = descuento);
    }

    const idPedido = req.idPedidoForzado || `rbx-${randomUUID()}`;   // forzado: recarga repetida al aprobar un pago a mano
    // Si el pago no alcanza, el pedido queda "por completar" con la huella de esta clave (la clave solo la
    // recibe el cliente, y solo si se guardó)
    const clave = randomBytes(24).toString('base64url');
    const telefono = telefonoCliente(req.body?.telefono);
    await motorPagos();
    const data = await compraConSupabase({ idPedido, referencia: String(referencia), usuario, paquete: String(producto),
      precio: montoACobrar ?? precioLista, claveHash: huella(clave), codigoDescuento: desc?.codigo || '', telefono, respaldo, inicio });

    // Pago encontrado (entregado o insuficiente): +1 compra de la cuenta, el premio se gasta y +1 venta del producto
    if (data?.status === 'success' || data?.insuficiente || data?.pendiente) {
      anotarRecarga({ juego: 'roblox', cuenta: usuario.toLowerCase(), paquete: String(producto), idPedido, premio, precioLista, precio: montoACobrar ?? precioLista });
    }

    // Una compra rechazada (pago no encontrado, ya usado...) cuenta como intento fallido. No cuentan: lo que
    // falló de nuestro lado (sinCulpa) ni el pago insuficiente (el pago existe, solo falta completarlo).
    if (data?.status !== 'success' && !data?.insuficiente && !data?.sinCulpa) await registrarFallo(clavesLimite);

    // Entregado con código: el uso y la comisión los cuenta Supabase (recarga "completado"); con el libro
    // diario de las hojas encendido, también la pestaña "Descuentos"
    if (data?.status === 'success' && desc) {
      await registrarUsoDescuento({ codigo: desc.codigo, montoCobrado: montoACobrar, idPedido, idJugador: usuario, juego: 'Roblox' });
    }

    return res.status(data?.pendiente ? 202 : 200).json(respuestaCompra(data, clave));
  } catch (error) {
    console.error('Error en la compra de Roblox:', error.message);
    return res.status(error.name === 'ErrorExterno' ? 503 : 500).json({ status: 'error', message: 'Error interno de conexión con el servidor.' });
  }
}

/**
 * Completar un pago insuficiente: POST { tokenComplemento, referencia (últimos 5 del nuevo pago) }.
 * El usuario, el paquete y el precio salen de "pagos_por_completar" (el navegador no puede cambiarlos).
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
    if (!supabaseActivo()) return res.status(503).json({ status: 'error', message: MENSAJE_SIN_CONFIGURAR });

    const claveHash = hashPerfil || huella(clave);
    // Intentos fallidos por IP y por clave (frena probar referencias al azar)
    const clavesLimite = [`ip:${obtenerIp(req)}`, `completar:roblox:${claveHash.slice(0, 24)}`];
    const minutosEspera = await minutosBloqueado(clavesLimite);
    if (minutosEspera > 0) {
      return res.status(429).json({ status: 'error', message: `Demasiados intentos fallidos. Espera ${minutosEspera} minutos para volver a intentar.` });
    }

    await motorPagos();
    const idPedido = `rbx-${randomUUID()}`;
    const data = await completarConSupabase({ idPedido, claveHash, referencia, telefono: telefonoCliente(req.body?.telefono), inicio });

    if (data?.status !== 'success' && !data?.insuficiente && !data?.sinCulpa) await registrarFallo(clavesLimite);

    if (data?.status === 'success' && data.codigoDescuento) {
      await registrarUsoDescuento({
        codigo: String(data.codigoDescuento), montoCobrado: Number(data.precio) || 0, idPedido,
        idJugador: String(data.usuario || ''), juego: 'Roblox',
      });
    }

    return res.status(data?.pendiente ? 202 : 200).json(respuestaCompra(data, clave));
  } catch (error) {
    console.error('Error al completar un pago de Roblox:', error.message);
    return res.status(error.name === 'ErrorExterno' ? 503 : 500).json({ status: 'error', message: 'Error interno de conexión con el servidor.' });
  }
}

// =========================================================================
// COBRO Y ENTREGA (Supabase): apartar el pago → si no alcanza, "por completar" → código guardado o, sin
// códigos, Central One → pago usado.
// =========================================================================
async function compraConSupabase({ idPedido, referencia, usuario, paquete, precio, claveHash, codigoDescuento, telefono, respaldo, inicio }) {
  const pago = await tomarPago(referencia, idPedido, 'roblox', precio);
  if (!pago.encontrado) return { status: 'error', message: pago.message };
  if (pago.monto < precio - MARGEN_BS) {
    let g;
    try {
      g = await guardarPorCompletar({ idPedido, referencia: pago.referencia, claveHash, precio, pagado: pago.monto, juego: 'roblox',
        datos: { usuario, paquete, codigoDescuento, telefono } });
    } catch (error) {
      // Sin esto el pago quedaba "en proceso" para siempre ("Otro cliente está procesando esta referencia")
      return noEntregado({ idPedido, motivo: `no se pudo guardar el pago por completar (${error.message.slice(0, 120)})`, liberar: pago.referencia, falloTecnico: true });
    }
    const falta = Math.round((precio - pago.monto) * 100) / 100;
    return {
      status: 'error', insuficiente: true, montoPagado: pago.monto, precioOficial: precio,
      ...(g?.status === 'success' && { porCompletar: true, falta, horas: 48 }),
      message: `Pago insuficiente: encontramos ${formatearVES(pago.monto)} Bs, pero este paquete cuesta ${formatearVES(precio)} Bs.`
        + (g?.status === 'success' ? ` Faltan ${formatearVES(falta)} Bs: paga la diferencia y escribe la nueva referencia para completar tu compra.` : ''),
    };
  }
  return entregarCodigo({ idPedido, paquete, usuario, referencias: [pago.referencia], liberar: pago.referencia, respaldo, telefono, inicio });
}

async function completarConSupabase({ idPedido, claveHash, referencia, telefono, inicio }) {
  const r = await completarPago(claveHash, referencia, idPedido, 'roblox');
  if (!r?.valido) return { status: 'error', complementoInvalido: true, message: String(r?.message || 'No encontramos este pago por completar.') };
  if (!r.encontrado) return { status: 'error', message: r.message };
  if (!r.completo) {
    const falta = Number(r.falta) || 0;
    return { status: 'error', insuficiente: true, porCompletar: true, montoPagado: Number(r.pagadoTotal) || 0, precioOficial: Number(r.precio) || 0,
      falta, horas: 48, message: `Pago insuficiente: con este pago llevas ${formatearVES(Number(r.pagadoTotal) || 0)} Bs y faltan ${formatearVES(falta)} Bs. Paga la diferencia y escribe la nueva referencia.` };
  }
  // La fila del pedido original toma este id (código guardado o pedido de Central One): así la encuentra el webhook
  pedidoDeEntrega(idPedido);
  const paquete = String(r.paquete || '');
  let respaldo = null;
  try {
    const datosPrecios = await obtenerPreciosRoblox();
    const f = datosPrecios.filas[paquete];
    if (f) respaldo = { producto: f.producto, enStock: f.enStock, centralOne: datosPrecios.centralOne };
  } catch (error) {
    console.error(`Roblox: no se pudieron leer los paquetes al completar el pedido ${idPedido}:`, error.message);
  }
  const datos = await entregarCodigo({ idPedido, paquete, usuario: String(r.usuario || ''), referencias: r.referencias || [],
    respaldo, telefono: telefono || String(r.telefono || ''), inicio });
  return { ...datos, usuario: r.usuario, paquete: r.paquete, precio: r.precio, codigoDescuento: r.codigoDescuento };
}

// Pago(s) ya apartado(s): un código guardado o, sin códigos, Central One. Sin código el pago se libera (compra
// nueva: `liberar`) o queda guardado para que el administrador lo entregue (pago completado).
async function entregarCodigo({ idPedido, paquete, usuario, referencias, liberar, respaldo, telefono, inicio }) {
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
  if (typeof codigo === 'string' && codigo) {
    await usarPagos(referencias, idPedido);
    return { status: 'success', code: codigo, message: '¡Código canjeado con éxito!' };
  }
  // Sin códigos (y Supabase sí respondió): Central One, si está activado para este paquete
  if (!fallo && respaldo?.centralOne && respaldo.producto && llaveRoblox()) {
    console.info(`Roblox, pedido ${idPedido}: sin códigos de ${clave} Robux en Supabase → se compra en Central One`);
    return comprarEnCentralOne({ idPedido, productId: respaldo.producto, usuario, referencias, liberar, telefono, inicio });
  }
  const motivo = fallo ? `Supabase no respondió (${fallo.slice(0, 120)})` : `sin códigos de ${clave} Robux`;
  return noEntregado({ idPedido, motivo, liberar, falloTecnico: !!fallo });
}

// Todos los pagos del pedido quedan usados (un pago completado trae varios)
async function usarPagos(referencias, idPedido) {
  for (const ref of referencias) {
    await cambiarPago(ref, 'usado', { idPedido }).catch((e) =>
      console.error(`🚨 Roblox: pedido ${idPedido} entregado pero el pago …${String(ref).slice(-5)} no se pudo marcar usado: ${e.message}`));
  }
}

// No se entregó nada: una compra nueva libera su pago; un pago completado queda guardado (WhatsApp)
async function noEntregado({ idPedido, motivo, liberar, falloTecnico = false }) {
  console.error(`❌ Roblox, pedido ${idPedido}: ${motivo}${liberar ? ' → se libera el pago' : ''}.`);
  if (liberar) {
    await cambiarPago(liberar, 'verificado', { soloSi: 'en_proceso' }).catch((e) =>
      console.error(`🚨 Roblox: no se pudo liberar el pago …${String(liberar).slice(-5)} del pedido ${idPedido}: ${e.message}`));
    return falloTecnico
      ? { status: 'error', sinCulpa: true, message: 'Fallo técnico momentáneo: tu pago no se usó. Intenta de nuevo en un minuto.' }
      : { status: 'error', agotado: true, sinCulpa: true, message: '⚠️ Este paquete se acaba de agotar. Tu pago no se usó: elige otro paquete o escríbenos por WhatsApp.' };
  }
  return { status: 'error', agotado: true, sinCulpa: true, message: '⚠️ Este paquete se agotó justo ahora. Tu pago anterior sigue guardado: escríbenos por WhatsApp y te lo entregamos.' };
}

/**
 * Sin códigos guardados: se compra el código en Central One con el pago ya apartado.
 *  - llegó el código  → pago(s) usado(s) y el código para el cliente.
 *  - no se compró     → noEntregado (una compra nueva libera el pago).
 *  - no se sabe o tarda → pago(s) usado(s) (nunca se liberan con la duda) y el pedido queda "en revisión"
 *    con la nota para el administrador; el código llega por el aviso (api/centralone-webhook.js), que lo
 *    guarda en el pedido y lo pasa a "completado". Respuesta 202 (pendiente).
 * La Idempotency-Key es el idPedido: repetir el pedido nunca compra dos códigos.
 */
async function comprarEnCentralOne({ idPedido, productId, usuario, referencias, liberar, telefono, inicio }) {
  const apiKey = llaveRoblox();
  const pendiente = async (nota) => {
    await usarPagos(referencias, idPedido);
    notaParaHistorial(`${nota}${telefono ? ` · WhatsApp ${telefono}` : ''}`);
    return { status: 'error', pendiente: true, sinCulpa: true, message: 'Fallo técnico momentáneo: tu compra quedó en proceso. Si en 5 minutos no recibes tu código, escríbenos por WhatsApp.' };
  };

  if (!PRODUCTO_VALIDO.test(String(productId || ''))) return noEntregado({ idPedido, motivo: `producto de Central One inválido ("${String(productId).slice(0, 60)}")`, liberar });

  // ¿Sigue en el catálogo y con stock? (antes de gastar saldo)
  const datos = await datosParaPedido({ apiKey, productId, idJugador: usuario });
  if (datos.error) return noEntregado({ idPedido, motivo: datos.error, liberar });

  const orden = await crearPedidoCentralOne({
    apiKey, productId, payload: datos.payload, idempotencia: idPedido, nota: `Level Up ${idPedido}`, tiempoMs: TIEMPO_PEDIDO_CENTRALONE_MS,
  });
  if (orden.tipo === 'rechazo') {
    if (orden.codigo === 'insufficient_balance') console.error('🚨 Central One: SIN SALDO para comprar códigos de Roblox. Recargar saldo en el portal.');
    return noEntregado({ idPedido, motivo: orden.motivo, liberar });
  }
  if (orden.tipo === 'incierto') {
    console.error(`⚠️ Roblox (Central One), pedido ${idPedido}: ${orden.motivo}`);
    return pendiente(`SIN CONFIRMAR en Central One: ${orden.motivo} Buscar la nota "Level Up ${idPedido}" en el portal: si existe, el código llega solo por el aviso.`);
  }

  const { id: idOrden, referencia } = orden.orden;
  console.info(`✅ Central One aceptó el pedido ${referencia} (${orden.orden.total}) de Roblox para ${usuario}`);
  const espera = await esperarCodigo({ apiKey, idOrden, limite: inicio + LIMITE_COMPRA_API_MS });
  if (espera.fallo) return noEntregado({ idPedido, motivo: `${espera.fallo}, pedido ${referencia}`, liberar });
  if (!espera.codigo) {
    console.error(`⚠️ Roblox: pedido ${referencia} pagado en Central One pero ${espera.pendiente}`);
    return pendiente(`PAGADO en Central One (pedido ${referencia}) pero ${espera.pendiente}: el código llega por el aviso y queda en este pedido. ENVIARLO POR WHATSAPP.`);
  }
  await usarPagos(referencias, idPedido);
  return { status: 'success', code: espera.codigo, message: '¡Código canjeado con éxito!' };
}
