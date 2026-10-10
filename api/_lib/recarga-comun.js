// Código compartido por las recargas de Free Fire y Blood Strike (api/_lib/juegos/).
// (Los archivos con "_" dentro de /api no se publican como endpoints en Vercel.)
import { llamarScript } from './externo.js';
import { informeError } from './reporte.js';

export const formatearVES = (monto) => Number(monto).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Convierte un monto de la hoja ("1.234,56", "1234.56", "1.234") a número
export function limpiarMontoVES(valor) {
  if (!valor) return 0;
  if (typeof valor === 'number') return valor;
  let m = String(valor).trim().replace(/[^0-9.,-]/g, '');
  if (!m) return 0;

  let lastComma = m.lastIndexOf(',');
  let lastDot = m.lastIndexOf('.');

  if (lastComma > lastDot) {
    m = m.replace(/\./g, '').replace(',', '.');
  } else if (lastComma !== -1 && lastDot === -1) {
    m = m.replace(',', '.');
  } else if (lastDot !== -1 && lastComma === -1) {
    let parts = m.split('.');
    if (parts.length > 2 || (parts.length === 2 && parts[1].length === 3)) {
      m = m.replace(/\./g, '');
    }
  }
  return parseFloat(m) || 0;
}

/**
 * Funciones ligadas a un pedido concreto, contra el Apps Script de su juego:
 *  - marcarReferencia: cambiar el estado de un pago se puede repetir sin efectos secundarios
 *    (reintentos rápidos). Devuelve true/false para poder informar el estado real del pago.
 *  - registrarEnHoja: los registros agregan filas, así que no se reintentan tras un timeout.
 *  - informe: informe de errores con los datos comunes del pedido ya incluidos.
 */
export function crearUtilidadesPedido({ urlScript, idPedido, tiempoIncidenteMs, datosInforme }) {
  const marcarReferencia = (accion, ref) =>
    llamarScript(urlScript, { accion, referencia: ref, idPedido }, { reintentos: 2, tiempoMs: tiempoIncidenteMs, reintentarTrasTimeout: true })
      .then(() => true)
      .catch((e) => { console.error(`❌ ${accion} falló para REF ${ref}:`, e.message); return false; });

  const registrarEnHoja = (cuerpo) =>
    llamarScript(urlScript, cuerpo, { tiempoMs: tiempoIncidenteMs, reintentos: 1 })
      .then(() => true)
      .catch((e) => { console.error(`❌ ${cuerpo.accion} falló para el pedido ${idPedido}:`, e.message, '| Informe:', cuerpo.urlImagen); return false; });

  const informe = (datos) => informeError({ ...datosInforme, ...datos });

  return { marcarReferencia, registrarEnHoja, informe };
}
