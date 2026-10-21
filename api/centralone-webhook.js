import { llamarScript, leerCuerpoCrudo } from './_lib/externo.js';
import { firmaCentralOneValida } from './_lib/centralone.js';

// Webhook de Central One: POST https://levelupstore.online/api/centralone-webhook
// (registrar en el portal de Central One: Integración → Webhooks, con los eventos de cierre de pedido;
// el secreto que genera va en CENTRALONE_WEBHOOK_SECRET).
// Cuando un pedido se cierra (entregado / fallido / entregado en parte / reembolsado), su estado pasa a
// la pestaña "fazer_card" de la hoja de Blood Strike (acción estado_fazer de bloodstrike.gs, la misma
// que usa FazerCards); si falló, bloodstrike.gs anota UNA fila en "errores" para hacerla a mano.
//
// Central One espera un 2xx en menos de 10 s; si no, reintenta (5 y 25 min, 2 h, 10 h…) y abandona a
// los 6 intentos. Por eso: firma mala -> 401; la hoja no respondió -> 503 (estado_fazer se puede
// repetir sin efectos); todo lo demás -> 200. La entrega es "al menos una vez" y sin orden garantizado:
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

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false });

  const secreto = (process.env.CENTRALONE_WEBHOOK_SECRET || '').trim();
  const URL_BLOOD = (process.env.SCRIPT_BLOOD || '').trim();
  if (!secreto || !URL_BLOOD) {
    console.error(`🚨 centralone-webhook: falta ${['CENTRALONE_WEBHOOK_SECRET', 'SCRIPT_BLOOD'].filter((v) => !(process.env[v] || '').trim()).join(' y ')} en Vercel`);
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
  const estado = ESTADO_POR_EVENTO[evento] || String(aviso?.order?.status ?? '').toLowerCase();
  // webhook.test, avisos de saldo o de catálogo, order.created…: nada que anotar
  if (!Object.hasOwn(ESTADO_POR_EVENTO, evento) || !ORDEN_VALIDA.test(ordenCentralOne) || !ESTADO_VALIDO.test(estado)) {
    return res.status(200).json({ ok: true, ignorado: true });
  }

  try {
    const r = await llamarScript(URL_BLOOD, {
      accion: 'estado_fazer', ordenFazer: ordenCentralOne, estado, evento,
      idEvento: String(aviso.event_id ?? '').slice(0, 80),
      // Los avisos de la forma original no traen sequence: 0 = sin orden que comprobar
      secuencia: Number.isInteger(aviso.sequence) ? aviso.sequence : 0,
    }, { tiempoMs: 8500, intentoMs: 8500 });
    if (r?.status === 'success') {
      if (!r.encontrado) console.info(`ℹ️ centralone-webhook: el pedido ${ordenCentralOne} (${estado}) aún no está en "fazer_card": guardado para cuando aparezca`);
      return res.status(200).json({ ok: true });
    }
    // "ocupado": no se anotó nada, que Central One lo repita. Otro error (p. ej. un Apps Script sin
    // estado_fazer): repetir no lo arreglaría.
    if (r?.ocupado) throw new Error('ocupado');
    console.error(`⚠️ centralone-webhook: Blood Strike respondió "${r?.message || 'respuesta inválida'}" a estado_fazer (pedido ${ordenCentralOne}, ${estado})`);
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error(`❌ centralone-webhook: no se pudo anotar el pedido ${ordenCentralOne} (${estado}): ${error.message}. Central One lo reintentará.`);
    return res.status(503).json({ ok: false });
  }
}
