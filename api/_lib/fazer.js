// FazerCards: ya no se le hacen pedidos (Free Fire y Blood Strike compran en Central One). Solo queda la
// firma de su webhook, para que api/fazer-webhook.js siga anotando el estado de las órdenes anteriores.
// (Los archivos con "_" dentro de /api no se publican como endpoints en Vercel.)
import { createHmac, timingSafeEqual } from 'node:crypto';

// Webhook: cabecera X-Webhook-Signature = "sha256=" + HMAC-SHA256(cuerpo crudo, secreto) en hex
export function firmaFazerValida(cuerpoCrudo, firma, secreto) {
  const esperada = 'sha256=' + createHmac('sha256', secreto).update(cuerpoCrudo).digest('hex');
  const recibida = String(firma || '');
  return recibida.length === esperada.length && timingSafeEqual(Buffer.from(recibida), Buffer.from(esperada));
}
