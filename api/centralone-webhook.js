import { waitUntil } from '@vercel/functions';
import { llamarScript, leerCuerpoCrudo } from './_lib/externo.js';
import { firmaCentralOneValida, primerCodigo, leerCodigos } from './_lib/centralone.js';
import { registrarUsoDescuento } from './_lib/descuentos.js';
import { limpiarMontoVES } from './_lib/recarga-comun.js';

// Webhook de Central One: POST https://levelupstore.online/api/centralone-webhook
// (registrar en el portal de Central One: Integración → Webhooks, con los eventos de cierre de pedido;
// el secreto que genera va en CENTRALONE_WEBHOOK_SECRET).
// Cuando un pedido se cierra (entregado / fallido / entregado en parte / reembolsado):
//  - Blood Strike: su estado pasa a la pestaña "fazer_card" de la hoja de Blood Strike (acción estado_fazer
//    de bloodstrike.gs, la misma que usa FazerCards); si falló, bloodstrike.gs anota UNA fila en "errores".
//  - Free Fire (idempotency_key "ff-…"): igual, en la pestaña "fazer_card" de la hoja de Free Fire
//    (estado_fazer de recargas.gs, SCRIPT_RECARGAS_URL).
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
// Idempotency-Key de una recarga de Blood Strike (api/_lib/juegos/bloodstrike.js): el idPedido tal cual
const PEDIDO_BLOOD = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Estados con los que un pedido ya terminó (para eventos de pedido con otro nombre, p. ej. order.completed)
const ESTADOS_FINALES = new Set(['completed', 'delivered', 'failed', 'cancelled', 'partially_completed', 'partially_delivered', 'refunded']);
const AL_SCRIPT = { tiempoMs: 8500, intentoMs: 8500 };

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
  // webhook.test, avisos de saldo o de catálogo, order.created…: nada que anotar. Un evento de pedido con
  // otro nombre (p. ej. order.completed) se anota si el pedido ya terminó.
  const eventoDeCierre = Object.hasOwn(ESTADO_POR_EVENTO, evento) || (evento.startsWith('order.') && ESTADOS_FINALES.has(estadoPedido));
  if (!eventoDeCierre || !ORDEN_VALIDA.test(ordenCentralOne) || !ESTADO_VALIDO.test(estado)) {
    return res.status(200).json({ ok: true, ignorado: true });
  }

  if (PEDIDO_ROBLOX.test(idPedido)) return avisoRoblox(res, { aviso, evento, ordenCentralOne, idPedido });

  // Free Fire o Blood Strike: las dos hojas anotan el estado igual (acción estado_fazer) y solo la que
  // tiene el pedido en "fazer_card" lo aplica. Con idempotency_key se sabe a cuál va; sin ella (o con
  // una que no se reconoce) se manda a las dos, como el webhook de FazerCards.
  const hojas = [
    { juego: 'Free Fire', variable: 'SCRIPT_RECARGAS_URL' },
    { juego: 'Blood Strike', variable: 'SCRIPT_BLOOD' },
  ].filter((h) => !idPedido || !(PEDIDO_FREEFIRE.test(idPedido) || PEDIDO_BLOOD.test(idPedido))
    || (h.juego === 'Free Fire') === PEDIDO_FREEFIRE.test(idPedido));
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
    console.info(`✅ centralone-webhook: pedido ${ordenCentralOne} (${estado}) anotado en "fazer_card" de ${encontrado.juego}`);
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
  // roblox.gs exige el token si tiene la propiedad TOKEN_VERCEL (igual que conToken de juegos/roblox.js)
  const token = (process.env.SCRIPT_RECARGAS_TOKEN || '').trim();
  const enviar = (cuerpo) => llamarScript(URL_ROBLOX, { ...cuerpo, idPedido, aviso: true, ...(token && { token }) }, AL_SCRIPT);

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
