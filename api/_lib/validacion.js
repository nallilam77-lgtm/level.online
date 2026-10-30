// Validaciones compartidas por los endpoints de recarga.
// (Los archivos con "_" dentro de /api no se publican como endpoints en Vercel.)

// Nombre de paquete/producto (los nombres salen de la hoja y pueden traer emojis o símbolos):
// 1-60 caracteres, sin los que sirven para inyectar HTML (< > " ' `) ni caracteres de control,
// y sin empezar como fórmula de Google Sheets (= + - @).
export const PAQUETE_VALIDO = /^(?![=+\-@\s])[^<>"'`\\\u0000-\u001f\u007f]{1,60}$/u;

// Texto libre que termina en Google Sheets (URL del comprobante, nombres de archivo...):
// sin caracteres de control y, si empieza como fórmula (= + - @), se antepone ' para que
// Sheets lo guarde como texto y no ejecute IMPORTXML/HYPERLINK inyectados.
export function textoParaHoja(valor, max = 500) {
  let texto = String(valor ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
  if (/^[=+\-@]/.test(texto)) texto = "'" + texto;
  return texto;
}

// WhatsApp del cliente (opcional): celular venezolano de 10 dígitos que empieza por 4 (412, 414, 416,
// 422, 424, 426). Acepta "4141916377", "04141916377" o "+58 414-191.6377" y devuelve "+584141916377".
// Inválido o vacío → "" (nunca bloquea la compra: el número es opcional).
export function telefonoCliente(valor) {
  let digitos = String(valor ?? '').replace(/\D/g, '').slice(0, 15);
  if (digitos.length === 12 && digitos.startsWith('58')) digitos = digitos.slice(2);
  if (digitos.length === 11 && digitos.startsWith('0')) digitos = digitos.slice(1);
  return /^4(12|14|16|22|24|26)\d{7}$/.test(digitos) ? `+58${digitos}` : '';
}

// Respuesta cuando falta una variable de entorno: 503 (servicio no disponible), nunca 500.
// El detalle queda solo en los logs de Vercel.
export function faltaConfiguracion(res, variables, cuerpo) {
  console.error(`❌ Faltan variables de entorno en Vercel: ${variables.join(', ')}`);
  return res.status(503).json(cuerpo || { status: "error", message: "Servicio no disponible en este momento. Intenta de nuevo en unos minutos." });
}
