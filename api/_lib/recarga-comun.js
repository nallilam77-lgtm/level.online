// Código compartido por las recargas de Free Fire y Blood Strike (api/_lib/juegos/).
// (Los archivos con "_" dentro de /api no se publican como endpoints en Vercel.)
import { llamarScript } from './externo.js';
import { informeError } from './reporte.js';

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

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
 *  - registrarEnHoja: los registros agregan filas, así que no se reintentan tras un timeout
 *    (sí tras "ocupado": Apps Script no llegó a escribir nada). Devuelve true/false.
 *  - informe: informe de errores con los datos comunes del pedido ya incluidos.
 *  - bloquearPago: ante cualquier error con el pago ya encontrado, lo anota y lo deja "Usado".
 */
export function crearUtilidadesPedido({ urlScript, idPedido, tiempoIncidenteMs, datosInforme }) {
  // Apps Script responde HTTP 200 también cuando falla ({ status: "error" }), p. ej. "ocupado" si
  // otra operación tiene el candado: eso NO es éxito (el pago quedaba sin marcar y sin aviso).
  // "Ocupado" significa que no se ejecutó nada, así que se repite mientras quede tiempo.
  const llamarSinOcupado = async (cuerpo, opciones) => {
    const limite = Date.now() + tiempoIncidenteMs;
    let motivo = 'tiempo agotado';
    while (limite - Date.now() >= 2000) {
      try {
        const datos = await llamarScript(urlScript, cuerpo, { ...opciones, tiempoMs: limite - Date.now() });
        if (datos?.status !== 'error') return { ok: true };
        motivo = datos.message || 'Apps Script respondió status "error"';
        if (!datos.ocupado) break;
      } catch (e) {
        motivo = e.message;
        break;
      }
      await esperar(1000);
    }
    return { ok: false, motivo };
  };

  const marcarReferencia = async (accion, ref) => {
    const { ok, motivo } = await llamarSinOcupado({ accion, referencia: ref, idPedido }, { reintentos: 2, reintentarTrasTimeout: true });
    if (!ok) console.error(`❌ ${accion} falló para REF ${ref}:`, motivo);
    return ok;
  };

  const registrarEnHoja = async (cuerpo) => {
    const { ok, motivo } = await llamarSinOcupado(cuerpo, { reintentos: 1 });
    if (!ok) console.error(`❌ ${cuerpo.accion} falló para el pedido ${idPedido}:`, motivo, '| Informe:', cuerpo.urlImagen);
    return ok;
  };

  const informe = (datos) => informeError({ ...datosInforme, ...datos });

  // REGLA: un pago encontrado NUNCA vuelve a "Verificado" (podrían usarlo dos veces). Ante cualquier
  // error se anota en "errores" y después se marca "Usado" (EN ORDEN: marcar_usado siempre al final).
  // Si no se pudo marcar, una segunda fila en "errores" pide hacerlo a mano.
  const bloquearPago = async (ref, datos) => {
    await registrarEnHoja(informe({
      ...datos, referenciaCompleta: ref,
      estadoPago: `BLOQUEADO (se marca "Usado" justo después de este registro): ${datos.queHacer}`,
    }));
    const bloqueado = await marcarReferencia("marcar_usado", ref);
    if (!bloqueado) {
      await registrarEnHoja(informe({
        fase: datos.fase, referenciaCompleta: ref, sinPines: true,
        motivo: `No se pudo marcar "Usado" el pago tras el error anterior de este pedido`,
        estadoPago: `SIN BLOQUEAR: marca a mano como "Usado" la referencia ${ref} (podrían reutilizarla)`,
      }));
    }
    return bloqueado;
  };

  return { marcarReferencia, registrarEnHoja, informe, bloquearPago };
}
