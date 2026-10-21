// API de Central One (recargas directas por ID de jugador). Por ahora solo Blood Strike.
// (Los archivos con "_" dentro de /api no se publican como endpoints en Vercel.)
// Docs: portal de Central One → Integración. La llave (variable blood_nuevo) solo vive en Vercel:
// la API no acepta llamadas desde el navegador (sin CORS) y autoriza a gastar todo el saldo.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { pedirJSON, conCache } from './externo.js';

const URL_API = 'https://portal.centraloneglobal.com/api/v1';
// Avisos del webhook con un timestamp más viejo que esto se rechazan (la firma lo incluye)
const MAX_ANTIGUEDAD_AVISO_S = 300;

const cabeceras = (apiKey) => ({ Authorization: `Bearer ${apiKey}` });
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// Catálogo con el precio de revendedor. Central One pide no consultarlo en cada compra (60 lecturas
// por minuto por llave): copia de 15 min por instancia, y la copia anterior si la API no responde.
async function catalogo(apiKey) {
  const { datos } = await conCache('catalogo:centralone',
    () => pedirJSON(`${URL_API}/catalog`, { metodo: 'GET', cabeceras: cabeceras(apiKey), tiempoMs: 8000, reintentos: 1, reintentarTrasTimeout: true }),
    { frescoMs: 15 * 60_000, esValido: (d) => Array.isArray(d?.items) });
  return datos.items;
}

/**
 * target_payload del pedido, armado con el target_schema del producto (no se escribe fijo: Central One
 * avisa que los campos cambian de un producto a otro y con el tiempo).
 *  - { payload }: listo para POST /orders (null si el producto no pide datos del jugador).
 *  - { error }:   el producto no se puede comprar así (fuera del catálogo, sin stock o pide un dato que
 *                 la tienda no pregunta). No se llamó a POST /orders: no se movió dinero.
 * Si el catálogo no responde se manda solo { player_id }: si faltara un campo, Central One rechaza el
 * pedido antes de cobrar.
 */
export async function datosParaPedido({ apiKey, productId, idJugador }) {
  let items;
  try {
    items = await catalogo(apiKey);
  } catch (error) {
    console.error(`⚠️ Central One: no se pudo leer el catálogo (${error.message}). Se envía solo player_id.`);
    return { payload: { player_id: idJugador } };
  }
  const producto = items.find((p) => p?.product_id === productId);
  if (!producto) return { error: `El producto ${productId} no está en el catálogo de Central One (no habilitado, en pausa o inexistente).` };
  if (producto.in_stock === false) return { error: `Central One no tiene stock de "${producto.name}" (${productId}).` };
  if (!producto.requires_target) return { payload: null };

  const campos = Array.isArray(producto.target_schema) && producto.target_schema.length
    ? producto.target_schema
    : (producto.target_fields || []).map((key) => ({ key, type: 'text' }));
  const textos = campos.filter((c) => c.type !== 'select');
  // La tienda solo pregunta el ID del jugador: va en el único campo de texto
  if (textos.length !== 1) {
    return { error: `"${producto.name}" pide ${textos.length} datos de texto (${textos.map((c) => c.key).join(', ') || 'ninguno'}) y la tienda solo tiene el ID del jugador.` };
  }
  const payload = {};
  for (const campo of campos) {
    if (campo.type !== 'select') {
      payload[campo.key] = idJugador;
      continue;
    }
    // Un "select" solo acepta el value de una de sus opciones; con varias, habría que preguntarla
    const opciones = Array.isArray(campo.options) ? campo.options : [];
    if (opciones.length !== 1) {
      return { error: `"${producto.name}" pide elegir "${campo.label || campo.key}" (${opciones.map((o) => o.value).join(', ')}) y la tienda no lo pregunta.` };
    }
    payload[campo.key] = opciones[0].value;
  }
  return { payload };
}

// Lo que ve el cliente cuando Central One rechaza el pedido (el código técnico va a "errores")
function mensajeRechazo(codigo) {
  if (codigo === 'invalid_request') return 'ID de jugador incorrecto o datos inválidos';
  if (codigo === 'insufficient_stock') return 'el paquete está agotado en este momento';
  return 'el proveedor no está disponible en este momento';
}

async function intentoPedido({ apiKey, productId, payload, idempotencia, nota, tiempoMs }) {
  const controlador = new AbortController();
  const temporizador = setTimeout(() => controlador.abort(), tiempoMs);
  try {
    const respuesta = await fetch(`${URL_API}/orders`, {
      method: 'POST',
      headers: { ...cabeceras(apiKey), 'Content-Type': 'application/json', 'Idempotency-Key': idempotencia, 'X-Request-Id': idempotencia },
      body: JSON.stringify({
        items: [{ catalog_item_id: productId, quantity: 1, ...(payload && { target_payload: payload }) }],
        note: nota,
      }),
      signal: controlador.signal,
    });
    const texto = await respuesta.text();
    // Soporte de Central One encuentra la petición exacta con este id
    const requestId = respuesta.headers.get('x-request-id');
    const sufijo = requestId ? ` (X-Request-Id ${requestId})` : '';
    if (respuesta.status >= 500) {
      return { tipo: 'incierto', motivo: `Central One respondió HTTP ${respuesta.status}${sufijo}. El pedido pudo haberse creado.` };
    }
    let datos;
    try { datos = JSON.parse(texto); } catch (e) {
      return { tipo: 'incierto', motivo: `Central One devolvió una respuesta ilegible (HTTP ${respuesta.status})${sufijo}: ${texto.slice(0, 200) || 'vacía'}. El pedido pudo haberse creado.` };
    }
    if (respuesta.ok && datos?.order?.id) {
      const { id, reference_code: referencia, status, total_sale_amount: total, currency } = datos.order;
      return { tipo: 'ok', orden: { id: String(id), referencia: String(referencia || id), status: String(status || 'confirmed'), total: `${total ?? '?'} ${currency || ''}`.trim() } };
    }
    if (respuesta.ok) {
      return { tipo: 'incierto', motivo: `Central One respondió HTTP ${respuesta.status} sin pedido${sufijo}. El pedido pudo haberse creado.` };
    }
    // 4xx: Central One no creó el pedido (ni retuvo saldo)
    const codigo = String(datos?.error?.code || `http_${respuesta.status}`);
    return { tipo: 'rechazo', codigo, motivo: `Central One rechazó el pedido (HTTP ${respuesta.status}, ${codigo})${sufijo}.`, errorCliente: mensajeRechazo(codigo) };
  } catch (error) {
    const motivo = error.name === 'AbortError'
      ? `Central One no respondió en ${Math.round(tiempoMs / 1000)} s (tiempo agotado). El pedido pudo haberse creado.`
      : `Error de red con Central One (${error.cause?.code || error.message}). El pedido pudo haberse creado.`;
    return { tipo: 'incierto', motivo };
  } finally {
    clearTimeout(temporizador);
  }
}

/**
 * Crea el pedido (una línea, cantidad 1) y clasifica el resultado:
 *  - ok:       Central One lo aceptó (orden = { id, referencia, status, total }; status suele ser "confirmed").
 *              La entrega sigue después: el resultado final llega por api/centralone-webhook.js.
 *  - rechazo:  respondió 4xx: NO creó el pedido ni retuvo saldo.
 *  - incierto: red caída, tiempo agotado o 5xx tras los reintentos: el pedido PUDO crearse.
 * Con la MISMA Idempotency-Key (el idPedido) repetir es seguro: Central One devuelve el mismo pedido y
 * no cobra dos veces. Por eso, y solo por eso, esta compra sí se reintenta una vez tras un incierto.
 */
export async function crearPedidoCentralOne({ apiKey, productId, payload, idempotencia, nota, tiempoMs }) {
  const limite = Date.now() + tiempoMs;
  const intentoMs = Math.floor(tiempoMs / 2);
  let resultado;
  for (let intento = 1; intento <= 2; intento++) {
    const restante = limite - Date.now();
    if (resultado && restante < 5000) break;
    resultado = await intentoPedido({ apiKey, productId, payload, idempotencia, nota, tiempoMs: Math.min(restante, intentoMs) });
    if (resultado.tipo !== 'incierto') return resultado;
    if (intento === 1) await esperar(1000);
  }
  return { ...resultado, motivo: `${resultado.motivo} (tras reintentar con la misma Idempotency-Key)` };
}

// Webhook: X-CentralOne-Signature = "sha256=" + HMAC-SHA256(secreto, timestamp + "." + cuerpo crudo) en hex.
// Durante las 24 h siguientes a rotar el secreto, X-CentralOne-Signature-Previous trae la firma con el
// anterior: se acepta cualquiera de las dos que coincida con el secreto que tiene Vercel.
export function firmaCentralOneValida(cuerpoCrudo, { timestamp, firma, firmaAnterior }, secreto) {
  const segundos = Number(timestamp);
  if (!Number.isInteger(segundos) || Math.abs(Date.now() / 1000 - segundos) > MAX_ANTIGUEDAD_AVISO_S) return false;
  const esperada = Buffer.from('sha256=' + createHmac('sha256', secreto).update(`${timestamp}.`).update(cuerpoCrudo).digest('hex'));
  return [firma, firmaAnterior].some((f) => {
    const recibida = Buffer.from(String(f || ''));
    return recibida.length === esperada.length && timingSafeEqual(recibida, esperada);
  });
}
