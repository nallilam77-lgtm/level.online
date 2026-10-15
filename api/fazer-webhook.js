import { llamarScript } from './_lib/externo.js';
import { firmaFazerValida } from './_lib/fazer.js';

// Webhook de FazerCards: POST https://levelupstore.online/api/fazer-webhook
// (configurar en el panel de FazerCards: Settings → Webhook; el secreto que genera va en FAZER_WEBHOOK_SECRET).
// Cada cambio de estado de una orden (processing → completed / failed / refund) se pasa a la
// pestaña "fazer_card" de la hoja de Free Fire (recargas.gs) y a la de Blood Strike (bloodstrike.gs):
// las dos reciben el aviso (acción estado_fazer) y solo la que tiene esa orden la anota.
//
// FazerCards espera un 200 en menos de 10 s; con otra respuesta reintenta (1, 5 y 30 min) y tras
// 50 fallos seguidos DESACTIVA el webhook. Por eso: firma mala -> 401; la hoja no respondió -> 503
// (FazerCards lo reintenta y estado_fazer se puede repetir sin efectos); todo lo demás -> 200.

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
  // Vercel ya lo convirtió a objeto: se vuelve a JSON compacto, que es como lo envía FazerCards
  if (req.body && typeof req.body === 'object') return Buffer.from(JSON.stringify(req.body));
  return Buffer.alloc(0);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false });

  const secreto = (process.env.FAZER_WEBHOOK_SECRET || '').trim();
  const URL_GOOGLE_SCRIPT = process.env.SCRIPT_RECARGAS_URL;
  const URL_BLOOD = process.env.SCRIPT_BLOOD;
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

  // Se puede repetir: estado_fazer solo deja el último estado en la fila de la orden.
  // Free Fire y Blood Strike a la vez (FazerCards corta a los 10 s).
  const cuerpo = {
    accion: 'estado_fazer', ordenFazer, estado,
    estadoAnterior: String(datos.previous_status ?? '').slice(0, 30),
    evento: aviso.event, idEvento: String(aviso.event_id ?? '').slice(0, 80),
  };
  const hojas = [['Free Fire', URL_GOOGLE_SCRIPT], ['Blood Strike', URL_BLOOD]].filter(([, url]) => url);
  const resultados = await Promise.all(hojas.map(async ([juego, url]) => {
    try {
      const r = await llamarScript(url, cuerpo, { tiempoMs: 8500, intentoMs: 8500 });
      if (r?.status === 'success') return { juego, encontrado: Boolean(r.encontrado) };
      // "ocupado": no se anotó nada, hay que repetirlo. Otro error (p. ej. un Apps Script sin
      // estado_fazer): repetir no lo arreglaría y FazerCards acabaría desactivando el webhook.
      if (r?.ocupado) return { juego, fallo: 'ocupado' };
      console.error(`⚠️ fazer-webhook: ${juego} respondió "${r?.message || 'respuesta inválida'}" a estado_fazer`);
      return { juego, encontrado: false };
    } catch (error) {
      return { juego, fallo: error.message };
    }
  }));

  const anotada = resultados.find((r) => r.encontrado);
  const fallos = resultados.filter((r) => r.fallo);
  if (anotada) return res.status(200).json({ ok: true });
  if (fallos.length) {
    console.error(`❌ fazer-webhook: no se pudo anotar la orden ${ordenFazer} (${estado}): ${fallos.map((f) => `${f.juego}: ${f.fallo}`).join('; ')}. FazerCards lo reintentará.`);
    return res.status(503).json({ ok: false });
  }
  console.info(`ℹ️ fazer-webhook: la orden ${ordenFazer} (${estado}) aún no está en ninguna pestaña "fazer_card": guardada para cuando aparezca`);
  return res.status(200).json({ ok: true });
}
