// PRECIOS EN SUPABASE (supabase/precios.sql, desde 2026-11-14).
//
// 1. LA TIENDA COBRA CON SUPABASE (Free Fire, Blood Strike y Mobile Legends; Roblox en juegos/roblox.js):
//    conPreciosSupabase(juego, datosDeLaHoja) cambia el catálogo de la hoja por el de Supabase (precios_de):
//    solo los paquetes activos, con precio y con stock en Central One. De la hoja solo queda lo demás
//    (version del script, etc.). Si Supabase no responde, se usa el catálogo de la hoja tal cual.
//    Cada paquete lleva precioCobro: lo que se cobra (precio_cobro: si Central One cambió el costo hace
//    menos de 30 min, el menor de los dos precios). sinProducto de cada juego lo quita antes de ir al navegador.
// 2. COPIA DEL CATÁLOGO DE CENTRAL ONE (centralone_catalogo): costo y stock de cada producto.
//    - Botón "🔄 Traer productos de Central One" del panel (traerProductos, solo administrador):
//      POST /api/juego?juego=<freefire|bloodstrike|mobilelegends|roblox>&accion=traer_productos
//    - Sola: si al abrir una tienda la copia tiene más de 15 min, se renueva después de responder
//      (Central One pide no leer el catálogo en cada visita: 15 min por juego y por instancia).
import { waitUntil } from '@vercel/functions';
import { pedirJSON, conCache } from './externo.js';
import { supabaseActivo, guardar, actualizar, rpc, leerDonde, esAdminToken } from './supabase.js';
import { tokenDe } from './historial.js';
import { formatearVES } from './recarga-comun.js';

const URL_CATALOGO = 'https://portal.centraloneglobal.com/api/v1/catalog';
const UUID = /^[0-9a-f-]{36}$/;
const RENOVAR_CADA_MS = 15 * 60_000;

// Llave de Central One de cada juego (las mismas variables que usa cada tienda)
const LLAVES = {
  freefire: () => process.env.freefire_nuevo,
  bloodstrike: () => process.env.blood_nuevo,
  mobilelegends: () => process.env.mlbb_nuevo || process.env.blood_nuevo,
  roblox: () => process.env.roblox_nuevo,
};

// ¿El producto es de este juego? Por la familia de Central One (nunca por el SKU)
const sinAcentos = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[^a-z0-9]/g, '');
const DEL_JUEGO = {
  // Free Fire: solo LATAM (la región de Venezuela; los de BR, ID, EU… no sirven para cuentas de aquí)
  freefire: (p) => sinAcentos(p.product_family_name).includes('freefire') && String(p.region || p.market || '').trim().toUpperCase() === 'LATAM',
  bloodstrike: (p) => sinAcentos(p.product_family_name).includes('bloodstrike'),
  // Solo la familia normal (igual que esFamiliaNormalML de apps-script/mobilelegends.gs)
  mobilelegends: (p) => sinAcentos(p.product_family_name).replace(/bangbang$/, '') === 'mobilelegends',
  roblox: (p) => sinAcentos(p.product_family_name).includes('roblox'),
};

const corto = (t, max) => String(t ?? '').slice(0, max);

/** Lee el catálogo de Central One del juego y lo guarda en centralone_catalogo. { total, conStock } */
async function actualizarCatalogo(juego) {
  const llave = String(LLAVES[juego]?.() || '').trim();
  if (!llave) throw new Error('falta la llave de Central One de este juego en Vercel');
  const datos = await pedirJSON(URL_CATALOGO, {
    metodo: 'GET', cabeceras: { Authorization: `Bearer ${llave}` }, tiempoMs: 12000, reintentos: 1, reintentarTrasTimeout: true,
  });
  if (!Array.isArray(datos?.items)) throw new Error('catálogo sin items');

  const ahora = new Date().toISOString();
  const filas = datos.items.filter((p) => UUID.test(String(p?.product_id || '')) && DEL_JUEGO[juego](p)).map((p) => {
    const costo = Number(p.reseller_price);
    return {
      producto: p.product_id, juego,
      nombre: corto(p.name, 120), familia: corto(p.product_family_name, 80), region: corto(p.region || p.market, 20),
      // Central One manda 4 decimales como texto: se guardan tal cual (numeric(12,4))
      costo_usd: Number.isFinite(costo) && costo >= 0 ? String(p.reseller_price) : null,
      en_stock: p.in_stock === true && p.status !== 'inactive',
      stock: Number.isInteger(p.available_stock) ? p.available_stock : null,
      precio_desde: p.price_updated_at || null,
      visto: ahora,
    };
  });
  if (filas.length) await guardar('centralone_catalogo', filas, 'producto');
  // Lo que antes era de este juego y ya no entra (no está en Central One o es de otra región): sin stock y
  // sin juego, así sale de la lista "sin vender" del panel. No se borra: un paquete puede seguir unido a él.
  const ids = filas.map((f) => f.producto);
  await actualizar('centralone_catalogo', `juego=eq.${juego}${ids.length ? `&producto=not.in.(${ids.join(',')})` : ''}`,
    { en_stock: false, visto: ahora, juego: null });
  return { total: filas.length, conStock: filas.filter((f) => f.en_stock).length };
}

export async function traerProductos(req, res, juego) {
  if (req.method !== 'POST') return res.status(405).json({ status: 'error', message: 'Método no permitido' });
  if (!Object.hasOwn(LLAVES, juego)) return res.status(400).json({ status: 'error', message: 'Este juego no usa Central One.' });
  if (!supabaseActivo()) return res.status(503).json({ status: 'error', message: 'Supabase no está configurado.' });
  if (!(await esAdminToken(tokenDe(req)))) return res.status(403).json({ status: 'error', message: 'Solo el administrador.' });
  try {
    const r = await actualizarCatalogo(juego);
    ultimaRenovacion.set(juego, Date.now());
    return res.status(200).json({ status: 'success', ...r });
  } catch (error) {
    console.error(`⚠️ precios: no se pudo traer el catálogo de Central One (${juego}):`, error.message);
    return res.status(503).json({ status: 'error', message: 'Central One no respondió o no se pudo guardar. Intenta de nuevo en un minuto.' });
  }
}

// Renovación sola de la copia del catálogo (después de responder; nunca frena a nadie)
const ultimaRenovacion = new Map();
function renovarSiHaceFalta(juego, filas) {
  const ahora = Date.now();
  if (ahora - (ultimaRenovacion.get(juego) || 0) < RENOVAR_CADA_MS) return;
  const vistos = filas.filter((f) => f.producto && f.visto).map((f) => Date.parse(f.visto));
  if (vistos.length && ahora - Math.max(...vistos) < RENOVAR_CADA_MS) return;
  ultimaRenovacion.set(juego, ahora);
  waitUntil(actualizarCatalogo(juego)
    .then((r) => console.info(`🔄 catálogo de Central One (${juego}) renovado solo: ${r.total} productos, ${r.conStock} con stock`))
    .catch((error) => console.error(`⚠️ catálogo de Central One (${juego}) no se pudo renovar:`, error.message)));
}

// Paquetes de un juego en Supabase (30 s en memoria)
async function paquetesDe(juego) {
  const { datos } = await conCache(`precios:supabase:${juego}`, () => rpc('precios_de', { p_juego: juego }),
    { frescoMs: 30_000, respaldoMs: 10 * 60_000, esValido: Array.isArray });
  return datos;
}

/**
 * datos de la hoja ({ status, catalogo: [{ diamantes, precio, producto }], version, … }) con el catálogo
 * de Supabase en vez del de la hoja. Sin Supabase (o si falla), los datos de la hoja tal cual.
 */
export async function conPreciosSupabase(juego, datos) {
  if (!supabaseActivo() || !Object.hasOwn(LLAVES, juego)) return datos;
  let filas;
  try {
    filas = await paquetesDe(juego);
  } catch (error) {
    console.error(`⚠️ precios: Supabase no respondió (${juego}), se usan los precios de la hoja:`, error.message);
    return datos;
  }
  renovarSiHaceFalta(juego, filas);
  // Lo que la hoja trae de cada paquete (otros campos que la tienda pueda usar), por nombre
  const deLaHoja = new Map((Array.isArray(datos?.catalogo) ? datos.catalogo : []).map((p) => [String(p.diamantes ?? '').trim(), p]));
  const catalogo = filas
    .filter((f) => f.activo && Number(f.precio) > 0 && f.en_stock)
    .map((f) => ({
      ...(deLaHoja.get(String(f.paquete).trim()) || {}),
      diamantes: f.paquete,
      precio: formatearVES(Number(f.precio)),
      // Lo que se cobra (nunca va al navegador: sinProducto lo quita)
      precioCobro: Number(f.precio_cobro) > 0 ? Number(f.precio_cobro) : Number(f.precio),
      // "2x<id>" = dos pedidos de ese producto (como la fila 3 de la hoja de Free Fire)
      producto: f.producto ? (f.cantidad > 1 ? `${f.cantidad}x${f.producto}` : f.producto) : '',
    }));
  // Supabase sin paquetes de este juego: mejor la hoja que una tienda vacía
  if (!catalogo.length) {
    console.error(`⚠️ precios: Supabase no tiene paquetes a la venta de ${juego}; se usan los de la hoja`);
    return datos;
  }
  return { ...datos, catalogo, origenPrecios: 'supabase' };
}

// =========================================================================
// SALDO DE CENTRAL ONE (panel admin → Resumen). GET /api/juego?accion=saldo_centralone con el token del
// administrador. Cada llave de Vercel puede ser de la misma cuenta o de otra: se pregunta una vez por llave
// distinta y se dice qué tiendas la usan. Necesita el permiso balance:read en la llave (si no, lo avisa).
// =========================================================================
const NOMBRES = { freefire: 'Free Fire', bloodstrike: 'Blood Strike', mobilelegends: 'Mobile Legends', roblox: 'Roblox' };

export async function saldoCentralOne(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ status: 'error', message: 'Método no permitido' });
  if (!(await esAdminToken(tokenDe(req)))) return res.status(403).json({ status: 'error', message: 'Solo el administrador.' });
  res.setHeader('Cache-Control', 'no-store');
  const porLlave = new Map();
  for (const juego of Object.keys(LLAVES)) {
    const llave = String(LLAVES[juego]() || '').trim();
    if (!llave) continue;
    if (!porLlave.has(llave)) porLlave.set(llave, []);
    porLlave.get(llave).push(NOMBRES[juego]);
  }
  const cuentas = await Promise.all([...porLlave.entries()].map(async ([llave, juegos]) => {
    try {
      const r = await fetch('https://portal.centraloneglobal.com/api/v1/balance', {
        headers: { Authorization: `Bearer ${llave}` }, signal: AbortSignal.timeout(8000),
      });
      const d = await r.json().catch(() => ({}));
      if (r.status === 403) return { juegos, error: 'Esta llave no tiene el permiso balance:read (márcalo en el portal de Central One o crea una llave con él).' };
      if (!r.ok) return { juegos, error: `Central One respondió ${r.status}.` };
      const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
      return { juegos, disponible: num(d.available_balance), retenido: num(d.held_balance), total: num(d.total_balance), moneda: String(d.currency || 'USD') };
    } catch (error) {
      return { juegos, error: 'Central One no respondió.' };
    }
  }));
  return res.status(200).json({ status: 'success', cuentas });
}

// =========================================================================
// CUADRE CON CENTRAL ONE (panel admin → Cuadre). GET /api/juego?accion=cuadre_centralone&dias=1|3|7 con el
// token del administrador. Compara las compras en Central One (GET /orders, con cada llave distinta) con
// los pedidos de la tienda (tabla recargas). Cada compra lleva la nota "Level Up <id del pedido>" (con
// "ml-" en Mobile Legends y "rbx-" en Roblox; "(1 de 2)" en un paquete partido de Free Fire).
// Marca lo raro:
//   entregado_alla   Central One lo entregó, pero la tienda no lo dice entregado.
//   fallo_alla       La tienda lo dice entregado, pero en Central One falló o se reembolsó.
//   sin_pedido       Compra en Central One sin pedido en la tienda (hecha en el portal, o de antes del 13/11).
//   sin_compra       Pedido de Blood Strike o Mobile Legends entregado sin compra en Central One.
//   doble            Más compras que las esperadas para un mismo pedido (posible compra repetida).
//   demorado         Lleva más de 2 horas en proceso en Central One.
// =========================================================================
const NOTA_PEDIDO = /Level Up (?:ml-)?((?:rbx-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?: \((\d) de (\d)\))?/i;
const NOMBRE_JUEGO = { freefire: 'Free Fire', bloodstrike: 'Blood Strike', mobilelegends: 'Mobile Legends', roblox: 'Roblox' };

async function pedidosCentralOne(llave, desde) {
  const ordenes = [];
  let cursor = null;
  for (let pagina = 0; pagina < 12; pagina++) {
    const url = `https://portal.centraloneglobal.com/api/v1/orders?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${llave}` }, signal: AbortSignal.timeout(8000) });
    if (r.status === 403) throw Object.assign(new Error('Una llave no tiene el permiso orders:read.'), { permiso: true });
    if (!r.ok) throw new Error(`Central One respondió ${r.status}`);
    const d = await r.json();
    const lista = Array.isArray(d?.orders) ? d.orders : [];
    ordenes.push(...lista);
    cursor = d?.pagination?.next_cursor || null;
    const ultima = lista.length ? Date.parse(lista[lista.length - 1].created_at) : 0;
    if (!cursor || !lista.length || ultima < desde) break;
  }
  return ordenes.filter((o) => Date.parse(o.created_at) >= desde);
}

const datosPedido = (p) => ({ id: p.id_pedido, juego: NOMBRE_JUEGO[p.juego] || p.juego, paquete: p.paquete, cuenta: p.cuenta,
  precio: p.precio, estado: p.estado, fecha: p.creado });
const datosCompra = (o) => ({ referencia: o.reference_code, estado: o.status, total: Number(o.total_sale_amount) || 0, fecha: o.created_at,
  reembolsado: o.refund?.refunded === true, motivo: o.failure?.code || null });

export async function cuadreCentralOne(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ status: 'error', message: 'Método no permitido' });
  if (!(await esAdminToken(tokenDe(req)))) return res.status(403).json({ status: 'error', message: 'Solo el administrador.' });
  res.setHeader('Cache-Control', 'no-store');
  const dias = [1, 3, 7].includes(Number(req.query?.dias)) ? Number(req.query.dias) : 1;
  const desde = Date.now() - dias * 24 * 3600 * 1000;

  // 1. Compras en Central One (una vez por llave distinta)
  const llaves = [...new Set(Object.keys(LLAVES).map((j) => String(LLAVES[j]() || '').trim()).filter(Boolean))];
  const avisos = [];
  const ordenes = [];
  for (const llave of llaves) {
    try {
      ordenes.push(...await pedidosCentralOne(llave, desde));
    } catch (error) {
      avisos.push(error.permiso ? error.message : `No se pudieron leer las compras de una llave (${error.message}).`);
    }
  }
  const vistas = new Set();
  const unicas = ordenes.filter((o) => (vistas.has(o.id) ? false : vistas.add(o.id)));

  // 2. Pedidos de la tienda en el mismo periodo (1 h antes: la compra puede ser un poco después del pedido)
  let pedidos = [];
  try {
    pedidos = await leerDonde('recargas', `creado=gte.${new Date(desde - 3600 * 1000).toISOString()}&order=creado.desc&limit=3000`,
      'id_pedido,juego,paquete,cuenta,precio,estado,creado') || [];
  } catch (error) {
    return res.status(503).json({ status: 'error', message: 'No se pudieron leer los pedidos de Supabase.' });
  }
  const porId = new Map(pedidos.map((p) => [String(p.id_pedido).toLowerCase(), p]));

  // 3. Comparar
  const problemas = [];
  const comprasPorPedido = new Map();
  let gastado = 0;
  let coinciden = 0;
  for (const o of unicas) {
    if (['completed', 'partially_completed'].includes(o.status) && o.refund?.refunded !== true) gastado += Number(o.total_sale_amount) || 0;
    const m = NOTA_PEDIDO.exec(String(o.reseller_note || ''));
    const id = m ? m[1].toLowerCase() : '';
    const p = id ? porId.get(id) : null;
    if (!p) { problemas.push({ tipo: 'sin_pedido', compra: datosCompra(o), nota: String(o.reseller_note || '').slice(0, 120) }); continue; }
    if (!comprasPorPedido.has(id)) comprasPorPedido.set(id, { esperadas: m[3] ? Number(m[3]) : 1, compras: [] });
    comprasPorPedido.get(id).compras.push(o);
    const fallo = o.status === 'failed' || o.status === 'cancelled' || o.refund?.refunded === true;
    if (o.status === 'completed' && o.refund?.refunded !== true && p.estado !== 'completado') problemas.push({ tipo: 'entregado_alla', compra: datosCompra(o), pedido: datosPedido(p) });
    else if (fallo && p.estado === 'completado') problemas.push({ tipo: 'fallo_alla', compra: datosCompra(o), pedido: datosPedido(p) });
    else if (['confirmed', 'processing', 'created'].includes(o.status) && Date.now() - Date.parse(o.created_at) > 2 * 3600 * 1000) problemas.push({ tipo: 'demorado', compra: datosCompra(o), pedido: datosPedido(p) });
    else coinciden++;
  }
  for (const [id, g] of comprasPorPedido) {
    const validas = g.compras.filter((o) => !['failed', 'cancelled'].includes(o.status));
    if (validas.length > g.esperadas) {
      problemas.push({ tipo: 'doble', compra: datosCompra(validas[0]), compras: validas.length, esperadas: g.esperadas, pedido: datosPedido(porId.get(id)) });
    }
  }
  // Blood Strike y Mobile Legends siempre compran en Central One: entregado aquí sin compra allá es raro
  for (const p of pedidos) {
    if (Date.parse(p.creado) < desde || !['bloodstrike', 'mobilelegends'].includes(p.juego) || p.estado !== 'completado') continue;
    if (!comprasPorPedido.has(String(p.id_pedido).toLowerCase())) problemas.push({ tipo: 'sin_compra', pedido: datosPedido(p) });
  }
  problemas.sort((a, b) => Date.parse((b.compra || b.pedido).fecha) - Date.parse((a.compra || a.pedido).fecha));
  return res.status(200).json({
    status: 'success', dias, avisos,
    compras: unicas.length, gastadoUsd: Math.round(gastado * 100) / 100,
    pedidos: pedidos.filter((p) => Date.parse(p.creado) >= desde).length,
    coinciden, problemas: problemas.slice(0, 200),
  });
}
