import { waitUntil } from '@vercel/functions';
import { llamarScript, leerCuerpoCrudo } from './_lib/externo.js';
import { firmaCentralOneValida, primerCodigo, leerCodigos } from './_lib/centralone.js';
import { registrarUsoDescuento } from './_lib/descuentos.js';
import { limpiarMontoVES } from './_lib/recarga-comun.js';
import { actualizarEstado } from './_lib/historial.js';
import { supabaseActivo, guardar, leerDonde, actualizar } from './_lib/supabase.js';

// ---------------------------------------------------------------------------------------------------
// STOCK Y PRECIOS AL INSTANTE (product.stock_changed / product.price_changed, desde 2026-11-14)
// Solo se actualizan los productos que ya están en la copia del catálogo (centralone_catalogo); la tienda
// los oculta o los vuelve a mostrar sola (_lib/precios.js) en 1-2 min (copias de 30-60 s). Cada cambio de
// un producto de una tienda queda en centralone_cambios (panel → Precios).
// ---------------------------------------------------------------------------------------------------
const EVENTOS_CATALOGO = new Set(['product.price_changed', 'product.stock_changed']);
const UUID = /^[0-9a-f-]{36}$/;
async function avisoDeCatalogo(aviso) {
  const productos = (Array.isArray(aviso?.products) ? aviso.products : []).filter((p) => UUID.test(String(p?.product_id || '')));
  if (!productos.length) return 0;
  const ids = [...new Set(productos.map((p) => p.product_id))];
  const actuales = await leerDonde('centralone_catalogo', `producto=in.(${ids.join(',')})`, 'producto,juego,nombre,costo_usd,en_stock') || [];
  const porId = new Map(actuales.map((a) => [a.producto, a]));
  const ahora = new Date().toISOString();
  const evento = String(aviso?.event_id || ahora).slice(0, 60);
  const filas = [];
  const cambios = [];
  for (const p of productos) {
    const a = porId.get(p.product_id);
    if (!a) continue;   // no es de ninguna tienda (otra región o juego): no interesa
    const enCatalogo = p.in_catalog !== false;
    const enStock = enCatalogo && p.in_stock === true;
    const precio = Number(p.reseller_price);
    const costo = enCatalogo && p.reseller_price !== null && Number.isFinite(precio) && precio >= 0 ? String(p.reseller_price) : a.costo_usd;
    filas.push({ producto: p.product_id, costo_usd: costo, en_stock: enStock,
      stock: Number.isInteger(p.available_stock) ? p.available_stock : null, precio_desde: p.price_updated_at || null, visto: ahora });
    if (!a.juego) continue;
    const base = { producto: p.product_id, juego: a.juego, nombre: String(a.nombre || '').slice(0, 120), evento };
    if (a.en_stock && !enStock) cambios.push({ ...base, tipo: enCatalogo ? 'agotado' : 'fuera' });
    if (!a.en_stock && enStock) cambios.push({ ...base, tipo: p.previous_in_catalog === false ? 'dentro' : 'repuesto' });
    if (costo !== null && a.costo_usd !== null && Math.abs(Number(costo) - Number(a.costo_usd)) >= 0.0001) {
      cambios.push({ ...base, tipo: 'precio', antes: Number(a.costo_usd), despues: Number(costo) });
    }
  }
  if (filas.length) await guardar('centralone_catalogo', filas, 'producto');
  if (cambios.length) {
    await guardar('centralone_cambios', cambios.map((c) => ({ antes: null, despues: null, ...c })), 'evento,producto,tipo');
    console.info(`📦 Central One: ${cambios.map((c) => `${c.nombre} ${c.tipo}`).join(' · ')}`);
  }
  return filas.length;
}

// ---------------------------------------------------------------------------------------------------
// MOTIVO DE UN PEDIDO QUE FALLÓ (failure.code / failure.action, desde 2026-11-14)
// Viene en el aviso cuando Central One activó los eventos nuevos de la cuenta; si no, se busca en
// GET /orders (la lista trae el failure de cada pedido) con la llave de esa tienda.
// ---------------------------------------------------------------------------------------------------
const CODIGO_FALLO = /^[a-z_]{1,40}$/;
function llaveDelPedido(idPedido) {
  if (/^ff-/.test(idPedido)) return process.env.freefire_nuevo;
  if (/^ml-/.test(idPedido)) return process.env.mlbb_nuevo || process.env.blood_nuevo;
  if (/^rbx-/.test(idPedido)) return process.env.roblox_nuevo;
  return process.env.blood_nuevo;
}
async function falloDelPedido(aviso, idPedido) {
  const o = aviso?.order || {};
  let f = o.failure || (Array.isArray(o.lines) ? (o.lines.find((l) => l?.failure) || {}).failure : null);
  if (!f?.code) {
    const llave = String(llaveDelPedido(idPedido) || '').trim();
    if (!llave) return null;
    try {
      const r = await fetch('https://portal.centraloneglobal.com/api/v1/orders?limit=50&status=failed,partially_completed',
        { headers: { Authorization: `Bearer ${llave}` }, signal: AbortSignal.timeout(6000) });
      const d = await r.json();
      f = (Array.isArray(d?.orders) ? d.orders : []).find((x) => x?.reference_code === o.reference_code)?.failure || null;
    } catch {
      return null;
    }
  }
  return f && CODIGO_FALLO.test(String(f.code)) ? { codigo: String(f.code), accion: CODIGO_FALLO.test(String(f.action || '')) ? String(f.action) : null } : null;
}
// Lo anota en el pedido (perfil del cliente y panel). Si la fila todavía no existe, se reintenta una vez.
function anotarMotivo(aviso, idPedidoCO, idDelPerfil) {
  if (!supabaseActivo()) return;
  waitUntil((async () => {
    const f = await falloDelPedido(aviso, idPedidoCO);
    if (!f) return;
    for (let intento = 0; intento < 2; intento++) {
      if (intento) await new Promise((r) => setTimeout(r, 6000));
      const filas = await actualizar('recargas', `id_pedido=eq.${encodeURIComponent(idDelPerfil)}`,
        { motivo_fallo: f.codigo, motivo_accion: f.accion }, 'id_pedido');
      if (Array.isArray(filas) && filas.length) { console.info(`🧾 Central One: el pedido ${idDelPerfil} falló por ${f.codigo} (${f.accion || 'sin acción'})`); return; }
    }
  })().catch((error) => console.error('⚠️ centralone-webhook: no se pudo anotar el motivo del fallo:', error.message)));
}

// Avisos de saldo (desde 2026-11-14): el último se guarda en Supabase (configuracion "centralone_saldo") y el
// panel admin lo muestra en Resumen: balance.low = alerta roja; deposit.approved / balance.credited = saldo
// acreditado (la alerta se quita). Hay que marcarlos en el portal: Integración → Webhooks.
const EVENTOS_SALDO = new Set(['balance.low', 'deposit.approved', 'balance.credited', 'deposit.rejected']);
async function avisoDeSaldo(aviso, evento) {
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const valor = {
    evento,
    disponible: num(aviso?.balance?.available),
    umbral: num(aviso?.balance?.threshold),
    monto: num(aviso?.deposit?.credited_amount ?? aviso?.credit?.amount ?? aviso?.deposit?.amount),
    motivo: evento === 'deposit.rejected' ? String(aviso?.deposit?.reason || '').slice(0, 200) : null,
    fecha: String(aviso?.occurred_at || new Date().toISOString()).slice(0, 40),
    id: String(aviso?.event_id || '').slice(0, 60),
  };
  await guardar('configuracion', { clave: 'centralone_saldo', valor, publico: false, actualizado: new Date().toISOString() }, 'clave');
}

// Webhook de Central One: POST https://levelupstore.online/api/centralone-webhook
// (registrar en el portal de Central One: Integración → Webhooks, con los eventos de cierre de pedido;
// el secreto que genera va en CENTRALONE_WEBHOOK_SECRET).
// Cuando un pedido se cierra (entregado / fallido / entregado en parte / reembolsado):
//  - Blood Strike: su estado pasa a la pestaña "fazer_card" de la hoja de Blood Strike (acción estado_fazer
//    de bloodstrike.gs, la misma que usa FazerCards); si falló, bloodstrike.gs anota UNA fila en "errores".
//  - Free Fire (idempotency_key "ff-…"): igual, en la pestaña "fazer_card" de la hoja de Free Fire
//    (estado_fazer de recargas.gs, SCRIPT_RECARGAS_URL).
//  - Mobile Legends (idempotency_key "ml-…"): igual, en la pestaña "pedidos" de la hoja de Mobile Legends
//    (estado_fazer de mobilelegends.gs, SCRIPT_MLBB). Solo va a esa hoja.
//  - Roblox (idempotency_key "rbx-…"): roblox.gs (GAS_URL) anota el código que la compra no alcanzó a
//    esperar (entregar_api: "pedidos_api" dice que hay que enviarlo por WhatsApp) o libera el pago si
//    falló (liberar_api). Las dos miran el estado de la fila: un aviso repetido no cambia nada.
//
// Central One espera un 2xx en menos de 10 s; si no, reintenta (5 y 25 min, 2 h, 10 h…) y abandona a
// los 6 intentos. Por eso: firma mala -> 401; la hoja no respondió -> 503 (se puede repetir sin
// efectos); todo lo demás -> 200. La entrega es "al menos una vez" y sin orden garantizado:
// bloodstrike.gs ignora un aviso con "sequence" menor que el último anotado para ese pedido.

// Firma sobre el cuerpo crudo: Vercel no debe convertirlo a JSON antes
export const config = { api: { bodyParser: false } };

// Evento -> estado que se anota. order.refunded no cambia order.status (sigue "completed"): se anota aparte.
const ESTADO_POR_EVENTO = {
  'order.delivered': null,
  'order.failed': null,
  'order.partially_delivered': null,
  'order.cancelled': null,
  'order.refunded': 'refunded',
};
const ORDEN_VALIDA = /^[A-Za-z0-9_.:-]{1,80}$/;
const ESTADO_VALIDO = /^[a-z_]{1,30}$/;
// idPedido de una compra de Roblox (api/_lib/juegos/roblox.js), que es su Idempotency-Key
const PEDIDO_ROBLOX = /^rbx-[0-9a-f-]{36}$/;
// Idempotency-Key de una recarga de Free Fire (api/_lib/juegos/freefire.js): "ff-<idPedido>" o, si el
// paquete son varios pedidos (220 = dos de 110), "ff-<idPedido>-1", "-2"…
const PEDIDO_FREEFIRE = /^ff-[0-9a-f-]{36}(-[1-9])?$/;
// Idempotency-Key de una recarga de Mobile Legends (api/_lib/juegos/mobilelegends.js): "ml-<idPedido>"
const PEDIDO_MLBB = /^ml-[0-9a-f-]{36}$/;
// Idempotency-Key de una recarga de Blood Strike (api/_lib/juegos/bloodstrike.js): el idPedido tal cual
const PEDIDO_BLOOD = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Estados con los que un pedido ya terminó (para eventos de pedido con otro nombre, p. ej. order.completed)
const ESTADOS_FINALES = new Set(['completed', 'delivered', 'failed', 'cancelled', 'partially_completed', 'partially_delivered', 'refunded']);
const AL_SCRIPT = { tiempoMs: 8500, intentoMs: 8500 };
// Estado de Central One -> estado del perfil del cliente (_lib/historial.js)
const ESTADO_EN_PERFIL = {
  completed: 'completado', delivered: 'completado',
  failed: 'en_revision', cancelled: 'en_revision', partially_completed: 'en_revision', partially_delivered: 'en_revision',
  refunded: 'reembolsado',
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false });

  const secreto = (process.env.CENTRALONE_WEBHOOK_SECRET || '').trim();
  if (!secreto) {
    console.error('🚨 centralone-webhook: falta CENTRALONE_WEBHOOK_SECRET en Vercel');
    return res.status(503).json({ ok: false });
  }

  let crudo;
  try {
    crudo = await leerCuerpoCrudo(req);
  } catch (error) {
    return res.status(413).json({ ok: false });
  }
  const firmas = {
    timestamp: req.headers['x-centralone-timestamp'],
    firma: req.headers['x-centralone-signature'],
    firmaAnterior: req.headers['x-centralone-signature-previous'],
  };
  if (!firmaCentralOneValida(crudo, firmas, secreto)) {
    console.error('⚠️ centralone-webhook: firma inválida o aviso de hace más de 5 min (¿CENTRALONE_WEBHOOK_SECRET distinto al del portal?)');
    return res.status(401).json({ ok: false });
  }

  let aviso;
  try {
    aviso = JSON.parse(crudo.toString('utf8'));
  } catch (e) {
    return res.status(200).json({ ok: true, ignorado: 'JSON inválido' });
  }
  const evento = String(aviso?.event ?? '');
  const ordenCentralOne = String(aviso?.order?.reference_code ?? '');
  const estadoPedido = String(aviso?.order?.status ?? '').toLowerCase();
  const estado = ESTADO_POR_EVENTO[evento] || estadoPedido;
  const idPedido = String(aviso?.order?.idempotency_key ?? '');
  // Qué llegó (sin datos del jugador ni códigos): para revisar en los logs de Vercel si los avisos llegan
  console.info(`📨 centralone-webhook: ${evento || 'sin evento'} · pedido ${ordenCentralOne || '?'} · estado ${estadoPedido || '?'} · idempotency_key ${idPedido ? idPedido.slice(0, 7) + '…' : 'NO VIENE'}`);
  if (EVENTOS_CATALOGO.has(evento)) {
    if (supabaseActivo()) {
      try {
        await avisoDeCatalogo(aviso);
      } catch (error) {
        console.error('⚠️ centralone-webhook: no se pudo aplicar el aviso de catálogo:', error.message);
        return res.status(503).json({ ok: false });   // Central One lo repite
      }
    }
    return res.status(200).json({ ok: true });
  }
  if (EVENTOS_SALDO.has(evento)) {
    if (supabaseActivo()) {
      try {
        await avisoDeSaldo(aviso, evento);
        if (evento === 'balance.low') console.error(`🚨 Central One: SALDO BAJO ($${aviso?.balance?.available} de $${aviso?.balance?.threshold}). Recargar saldo.`);
      } catch (error) {
        console.error('⚠️ centralone-webhook: no se pudo guardar el aviso de saldo:', error.message);
        return res.status(503).json({ ok: false });   // Central One lo repite
      }
    }
    return res.status(200).json({ ok: true });
  }
  // webhook.test, avisos de catálogo, order.created…: nada que anotar. Un evento de pedido con
  // otro nombre (p. ej. order.completed) se anota si el pedido ya terminó.
  const eventoDeCierre = Object.hasOwn(ESTADO_POR_EVENTO, evento) || (evento.startsWith('order.') && ESTADOS_FINALES.has(estadoPedido));
  if (!eventoDeCierre || !ORDEN_VALIDA.test(ordenCentralOne) || !ESTADO_VALIDO.test(estado)) {
    return res.status(200).json({ ok: true, ignorado: true });
  }

  // Perfil del cliente con sesión (Supabase): el estado le llega en vivo. La fila usa el idPedido sin el
  // prefijo de la Idempotency-Key (ff-/ml-, y sin el -1/-2 de un paquete partido en dos pedidos)
  const idDelPerfil = PEDIDO_ROBLOX.test(idPedido) ? idPedido : idPedido.replace(/^(ff|ml)-/, '').replace(/-[1-9]$/, '');
  // Paquete partido en dos pedidos (Free Fire "ff-<id>-1" / "-2"): cada aviso es de UNA mitad. "Entregado"
  // no pisa una falla de la otra mitad, y el reembolso de una sola mitad queda "en revisión" (no
  // "reembolsado": la otra mitad sí llegó y el pedido entero no se devolvió).
  const partido = /^ff-.+-[1-9]$/.test(idPedido);
  const estadoPerfil = ESTADO_EN_PERFIL[estado] || '';
  // Falló (entero o en parte): por qué, según Central One
  if (estadoPerfil === 'en_revision') anotarMotivo(aviso, idPedido, idDelPerfil);
  if (!partido) actualizarEstado(idDelPerfil, estadoPerfil);
  else if (estadoPerfil === 'completado') actualizarEstado(idDelPerfil, 'completado', { noPisar: ['en_revision', 'problema', 'reembolsado'] });
  else if (estadoPerfil) actualizarEstado(idDelPerfil, 'en_revision', { noPisar: ['problema', 'reembolsado'] });

  if (PEDIDO_ROBLOX.test(idPedido)) return avisoRoblox(res, { aviso, evento, ordenCentralOne, idPedido });

  // Free Fire, Blood Strike o Mobile Legends: las hojas anotan el estado igual (acción estado_fazer) y
  // solo la que tiene el pedido lo aplica. Con idempotency_key se sabe a cuál va; sin ella (o con una que
  // no se reconoce) se manda a Free Fire y Blood Strike, como el webhook de FazerCards (Mobile Legends
  // siempre manda la suya: nunca le llega un aviso ajeno).
  const FREE_FIRE = { juego: 'Free Fire', variable: 'SCRIPT_RECARGAS_URL' };
  const BLOOD = { juego: 'Blood Strike', variable: 'SCRIPT_BLOOD' };
  const hojas = PEDIDO_MLBB.test(idPedido) ? [{ juego: 'Mobile Legends', variable: 'SCRIPT_MLBB' }]
    : PEDIDO_FREEFIRE.test(idPedido) ? [FREE_FIRE]
      : PEDIDO_BLOOD.test(idPedido) ? [BLOOD]
        : [FREE_FIRE, BLOOD];
  const faltan = hojas.filter((h) => !(process.env[h.variable] || '').trim());
  if (faltan.length) {
    console.error(`🚨 centralone-webhook: falta ${faltan.map((h) => h.variable).join(' y ')} en Vercel (aviso del pedido ${ordenCentralOne})`);
    return res.status(503).json({ ok: false });
  }
  const cuerpo = {
    accion: 'estado_fazer', ordenFazer: ordenCentralOne, estado, evento,
    idEvento: String(aviso.event_id ?? '').slice(0, 80),
    // Los avisos de la forma original no traen sequence: 0 = sin orden que comprobar
    secuencia: Number.isInteger(aviso.sequence) ? aviso.sequence : 0,
  };
  // En paralelo: Central One corta a los 10 s
  const resultados = await Promise.all(hojas.map((h) => llamarScript(process.env[h.variable].trim(), cuerpo, AL_SCRIPT)
    .then((r) => ({ ...h, r }), (error) => ({ ...h, fallo: error.message }))));
  const encontrado = resultados.find((x) => x.r?.status === 'success' && x.r.encontrado);
  if (encontrado) {
    console.info(`✅ centralone-webhook: pedido ${ordenCentralOne} (${estado}) anotado en la hoja de ${encontrado.juego}`);
    return res.status(200).json({ ok: true });
  }
  // "ocupado" o sin respuesta: no se anotó nada, que Central One lo repita. Otro error (p. ej. un Apps
  // Script sin estado_fazer): repetir no lo arreglaría.
  const reintentar = resultados.filter((x) => x.fallo || x.r?.ocupado);
  if (reintentar.length) {
    console.error(`❌ centralone-webhook: no se pudo anotar el pedido ${ordenCentralOne} (${estado}) en ${reintentar.map((x) => `${x.juego} (${x.fallo || 'ocupado'})`).join(', ')}. Central One lo reintentará.`);
    return res.status(503).json({ ok: false });
  }
  resultados.filter((x) => x.r?.status !== 'success').forEach((x) => console.error(`⚠️ centralone-webhook: ${x.juego} respondió "${x.r?.message || 'respuesta inválida'}" a estado_fazer (pedido ${ordenCentralOne}, ${estado})`));
  console.info(`ℹ️ centralone-webhook: el pedido ${ordenCentralOne} (${estado}) aún no está en ninguna "fazer_card" (${hojas.map((h) => h.juego).join(' / ')}): guardado para cuando aparezca`);
  return res.status(200).json({ ok: true });
}

// Pedido de un código de Roblox. El código nunca se escribe en los logs.
async function avisoRoblox(res, { aviso, evento, ordenCentralOne, idPedido }) {
  const URL_ROBLOX = (process.env.GAS_URL || '').trim();
  if (!URL_ROBLOX) {
    console.error('🚨 centralone-webhook: falta GAS_URL en Vercel (aviso de un pedido de Roblox)');
    return res.status(503).json({ ok: false });
  }
  // llamarScript añade el token (SCRIPT_RECARGAS_TOKEN), que roblox.gs exige
  const enviar = (cuerpo) => llamarScript(URL_ROBLOX, { ...cuerpo, idPedido, aviso: true }, AL_SCRIPT);

  try {
    let r;
    let codigo = '';
    if (evento === 'order.delivered' || evento === 'order.partially_delivered') {
      // El aviso trae los códigos (si no se apagó esa opción en el portal); si no, se piden a la API
      codigo = primerCodigo(aviso.order?.codes);
      const apiKey = (process.env.roblox_nuevo || '').trim();
      if (!codigo && apiKey) codigo = (await leerCodigos(apiKey, ordenCentralOne).catch(() => ({}))).codigo || '';
      r = codigo
        ? await enviar({ tipo: 'entregar_api', codigo, ordenCentralOne, enPagina: false })
        : await enviar({ tipo: 'nota_api', siempre: true, texto: `⚠️ Central One avisó ${evento} (pedido ${ordenCentralOne}) sin código: buscarlo en el portal y enviarlo por WhatsApp` });
    } else if (evento === 'order.refunded') {
      r = await enviar({ tipo: 'nota_api', siempre: true, texto: `⚠️ Central One REEMBOLSÓ el pedido ${ordenCentralOne}: revisar si el código funcionó` });
    } else {
      // failed / cancelled: no se cobró. roblox.gs no toca un pedido ya entregado (un aviso viejo que llega tarde)
      r = await enviar({ tipo: 'liberar_api', motivo: `Central One avisó ${evento} (pedido ${ordenCentralOne})` });
    }
    if (r?.ocupado) throw new Error('ocupado');
    if (r?.status !== 'success') console.error(`⚠️ centralone-webhook: Roblox respondió "${r?.message || 'respuesta inválida'}" (pedido ${ordenCentralOne}, ${evento})`);

    // Primera entrega de un pedido con código de descuento: +1 uso y la comisión del creador (después de responder)
    if (r?.status === 'success' && codigo && !r.yaEntregado && r.codigoDescuento) {
      waitUntil(registrarUsoDescuento({
        codigo: String(r.codigoDescuento), montoCobrado: limpiarMontoVES(r.precio), idPedido, idJugador: String(r.usuario || ''), juego: 'Roblox',
      }));
    }
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error(`❌ centralone-webhook: no se pudo anotar el pedido de Roblox ${ordenCentralOne} (${evento}): ${error.message}. Central One lo reintentará.`);
    return res.status(503).json({ ok: false });
  }
}
