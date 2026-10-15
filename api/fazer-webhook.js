import { llamarScript } from './_lib/externo.js';
import { firmaFazerValida } from './_lib/fazer.js';

// Webhook de FazerCards: POST https://levelupstore.online/api/fazer-webhook
// (configurar en el panel de FazerCards: Settings → Webhook; el secreto que genera va en FAZER_WEBHOOK_SECRET).
// Cada cambio de estado de una orden (processing → completed / failed / refund) se pasa a la
// pestaña "fazer_card" de la hoja de Free Fire (acción estado_fazer de recargas.gs).
//
// FazerCards espera un 200 en menos de 10 s; con otra respuesta reintenta (1, 5 y 30 min) y tras
// 50 fallos seguidos DESACTIVA el webhook. Por eso: firma mala -> 401; la hoja no respondió -> 503
// (FazerCards lo reintenta y estado_fazer se puede repetir sin efectos); todo lo demás -> 200.
// Las órdenes de Blood Strike (misma cuenta) también llegan aquí: recargas.gs las ignora.

// Firma sobre el cuerpo crudo: Vercel no debe convertirlo a JSON antes
export const config = { api: { bodyParser: false } };

const EVENTOS_DE_ORDEN = new Set(['order.created', 'order.status_changed']);
const ORDEN_VALIDA = /^[A-Za-z0-9_.:-]{1,80}$/;
const ESTADO_VALIDO = /^[a-z_]{1,30}$/;
const MAX_CUERPO = 64 * 1024;

// Primero el flujo crudo (sin tocar req.body: leerlo haría que Vercel lo convierta a JSON)
async function leerCuerpoCrudo(req) {
  const partes = [];
  let total = 0;
  for await (const parte of req) {
    total += parte.length;
    if (total > MAX_CUERPO) throw new Error('cuerpo demasiado grande');
    partes.push(Buffer.from(parte));
  }
  if (total > 0) return Buffer.concat(partes);
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return Buffer.from(req.body);
  return Buffer.alloc(0);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false });

  const secreto = (process.env.FAZER_WEBHOOK_SECRET || '').trim();
  const URL_GOOGLE_SCRIPT = process.env.SCRIPT_RECARGAS_URL;
  if (!secreto || !URL_GOOGLE_SCRIPT) {
    console.error(`🚨 fazer-webhook: falta ${['FAZER_WEBHOOK_SECRET', 'SCRIPT_RECARGAS_URL'].filter((v) => !(process.env[v] || '').trim()).join(' y ')} en Vercel`);
    return res.status(503).json({ ok: false });
  }

  let crudo;
  try {
    crudo = await leerCuerpoCrudo(req);
  } catch (error) {
    return res.status(413).json({ ok: false });
  }
  if (!firmaFazerValida(crudo, req.headers['x-webhook-signature'], secreto)) {
    console.error('⚠️ fazer-webhook: firma inválida (¿FAZER_WEBHOOK_SECRET distinto al del panel de FazerCards?)');
    return res.status(401).json({ ok: false });
  }

  let aviso;
  try {
    aviso = JSON.parse(crudo.toString('utf8'));
  } catch (e) {
    return res.status(200).json({ ok: true, ignorado: 'JSON inválido' });
  }
  const datos = aviso?.data || {};
  const ordenFazer = String(datos.order_id ?? '');
  const estado = String(datos.status ?? '').toLowerCase();
  // Eventos de chat, pruebas u otros tipos de orden: nada que anotar
  if (!EVENTOS_DE_ORDEN.has(aviso?.event) || !ORDEN_VALIDA.test(ordenFazer) || !ESTADO_VALIDO.test(estado)) {
    return res.status(200).json({ ok: true, ignorado: true });
  }

  try {
    // Se puede repetir: estado_fazer solo deja el último estado en la fila de la orden
    const r = await llamarScript(URL_GOOGLE_SCRIPT, {
      accion: 'estado_fazer', ordenFazer, estado,
      estadoAnterior: String(datos.previous_status ?? '').slice(0, 30),
      evento: aviso.event, idEvento: String(aviso.event_id ?? '').slice(0, 80),
    }, { tiempoMs: 8500, intentoMs: 8500 });
    if (r?.status !== 'success') throw new Error(r?.message || 'respuesta inválida de Apps Script');
    if (!r.encontrado) console.info(`ℹ️ fazer-webhook: orden ${ordenFazer} (${estado}) aún no está en "fazer_card" o no es de Free Fire: guardada para cuando aparezca`);
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error(`❌ fazer-webhook: no se pudo anotar la orden ${ordenFazer} (${estado}): ${error.message}. FazerCards lo reintentará.`);
    return res.status(503).json({ ok: false });
  }
}
