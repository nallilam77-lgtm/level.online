// API de FazerCards (recargas directas por ID de jugador), común a Blood Strike y Free Fire.
// (Los archivos con "_" dentro de /api no se publican como endpoints en Vercel.)
// Docs: https://reseller.fazercards.com/en/docs (POST /topups/order) y la guía de webhooks.
import { createHmac, timingSafeEqual } from 'node:crypto';

const URL_ORDEN = "https://api.fzr.cards/api/v2/topups/order";

/**
 * Crea la orden en FazerCards y clasifica el resultado. NUNCA se reintenta (podría recargar dos veces).
 *  - ok:       FazerCards aceptó la orden (orden = { id, status }; status suele ser "processing").
 *  - rechazo:  FazerCards respondió claramente que NO hizo la recarga.
 *  - incierto: red caída, tiempo agotado, error 5xx o respuesta ilegible: la orden PUDO crearse.
 * idempotencia: con el id del pedido, si la petición llegara dos veces FazerCards crea una sola orden.
 */
export async function crearOrdenFazer({ apiKey, categoria, offerId, campos, idempotencia, tiempoMs }) {
  const controlador = new AbortController();
  const temporizador = setTimeout(() => controlador.abort(), tiempoMs);
  try {
    const respuesta = await fetch(URL_ORDEN, {
      method: "POST",
      headers: { "X-API-Key": apiKey, "Content-Type": "application/json", ...(idempotencia && { "Idempotency-Key": idempotencia }) },
      body: JSON.stringify({ "category_id": categoria, "offer_id": offerId, "fields": campos }),
      signal: controlador.signal
    });
    const texto = await respuesta.text();
    if (respuesta.status >= 500) {
      return { tipo: 'incierto', motivo: `FazerCards respondió HTTP ${respuesta.status}: ${texto.slice(0, 200) || 'sin cuerpo'}. La orden pudo haberse creado.` };
    }
    let datos;
    try { datos = JSON.parse(texto); } catch (e) {
      return { tipo: 'incierto', motivo: `FazerCards devolvió una respuesta ilegible (HTTP ${respuesta.status}): ${texto.slice(0, 200) || 'vacía'}. La orden pudo haberse creado.` };
    }
    if (datos && datos.ok === true) {
      return { tipo: 'ok', datos, orden: { id: String(datos.order?.id || ''), status: String(datos.order?.status || 'processing') } };
    }
    return { tipo: 'rechazo', motivo: `FazerCards rechazó la recarga (HTTP ${respuesta.status}): ${String(datos?.error || 'ID de jugador incorrecto o mantenimiento.')}`, errorCliente: String(datos?.error || "ID de jugador incorrecto o mantenimiento.") };
  } catch (error) {
    const motivo = error.name === 'AbortError'
      ? `FazerCards no respondió en ${Math.round(tiempoMs / 1000)} s (tiempo agotado). La orden pudo haberse creado.`
      : `Error de red con FazerCards (${error.cause?.code || error.message}). La orden pudo haberse creado.`;
    return { tipo: 'incierto', motivo };
  } finally {
    clearTimeout(temporizador);
  }
}

// Webhook: cabecera X-Webhook-Signature = "sha256=" + HMAC-SHA256(cuerpo crudo, secreto) en hex
export function firmaFazerValida(cuerpoCrudo, firma, secreto) {
  const esperada = 'sha256=' + createHmac('sha256', secreto).update(cuerpoCrudo).digest('hex');
  const recibida = String(firma || '');
  return recibida.length === esperada.length && timingSafeEqual(Buffer.from(recibida), Buffer.from(esperada));
}
