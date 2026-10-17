// Código compartido por las recargas de Free Fire y Blood Strike (api/_lib/juegos/).
// (Los archivos con "_" dentro de /api no se publican como endpoints en Vercel.)
import { waitUntil } from '@vercel/functions';
import { llamarScript } from './externo.js';
import { informeError, FASES } from './reporte.js';

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// Cierre en segundo plano (cerrarEnSegundoPlano): esperas antes de cada ronda de reintentos y
// tiempo máximo desde que empezó la petición (maxDuration de api/recargar.js = 180 s, con margen).
const ESPERAS_CIERRE_MS = [10000, 20000, 40000];
const PLAZO_PEDIDO_MS = 165000;

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
 *  - cerrarEnSegundoPlano: repite después de responder lo que el cierre de una recarga entregada no confirmó.
 * inicio: momento en que empezó la petición (limita el trabajo en segundo plano a maxDuration).
 */
export function crearUtilidadesPedido({ urlScript, idPedido, tiempoIncidenteMs, datosInforme, inicio = Date.now() }) {
  // Apps Script responde HTTP 200 también cuando falla ({ status: "error" }), p. ej. "ocupado" si
  // otra operación tiene el candado: eso NO es éxito (el pago quedaba sin marcar y sin aviso).
  // "Ocupado" significa que no se ejecutó nada, así que se repite mientras quede tiempo.
  // Motivo del último fallo (el aviso del cierre en segundo plano lo copia a "errores")
  let ultimoMotivo = '';
  const llamarSinOcupado = async (cuerpo, opciones) => {
    const limite = Date.now() + tiempoIncidenteMs;
    let motivo = 'tiempo agotado';
    while (limite - Date.now() >= 2000) {
      try {
        const datos = await llamarScript(urlScript, cuerpo, { ...opciones, tiempoMs: limite - Date.now() });
        if (datos?.status !== 'error') return { ok: true, datos };
        motivo = (datos.message || 'Apps Script respondió status "error"') + (datos.detalle ? ` (${datos.detalle})` : '');
        if (!datos.ocupado) break;
      } catch (e) {
        motivo = e.message;
        break;
      }
      await esperar(1000);
    }
    ultimoMotivo = `${cuerpo.accion}: ${motivo}`;
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

  // bloquear_pedido: deja "Usado" SOLO el pago que tomó ESTE idPedido (si no tomó ninguno, no toca nada).
  // { ok, referencia } — referencia "" = el pedido no llegó a tomar ningún pago.
  const bloquearPedido = async () => {
    const { ok, datos, motivo } = await llamarSinOcupado({ accion: "bloquear_pedido", idPedido }, { reintentos: 2, reintentarTrasTimeout: true });
    if (!ok) console.error(`❌ bloquear_pedido falló para el pedido ${idPedido}:`, motivo);
    return { ok, referencia: String(datos?.referencia || ''), motivo };
  };

  // Último recurso ante un error NO previsto (una excepción, una respuesta rara): nada se da por bueno.
  // Con las referencias del pedido, todas quedan "Usado"; sin ellas (el error pasó antes de conocerlas),
  // bloquear_pedido. Siempre deja una fila en "errores" para revisar a mano. Nunca lanza.
  // Devuelve pagoTomado: false solo si se confirmó que el pedido no tocó ningún pago (el cliente puede reintentar).
  const bloquearPorError = async ({ referencias = [], ...datos }) => {
    try {
      if (referencias.length) {
        const [primera, ...resto] = referencias;
        await bloquearPago(primera, {
          ...datos,
          motivo: resto.length ? `${datos.motivo} (pago completado con ${referencias.join(' + ')})` : datos.motivo,
          queHacer: 'revisar a mano: no se sabe si la recarga llegó al jugador',
        });
        for (const ref of resto) await marcarReferencia("marcar_usado", ref);
        return { pagoTomado: true };
      }
      const bloqueo = await bloquearPedido();
      const sinPago = bloqueo.ok && !bloqueo.referencia;
      await registrarEnHoja(informe({
        ...datos,
        ...(bloqueo.referencia && { referenciaCompleta: bloqueo.referencia }),
        estadoPago: !bloqueo.ok
          ? `SIN CONFIRMAR (bloquear_pedido falló: ${bloqueo.motivo}): si quedó un pago "En proceso" de este pedido, márcalo "Usado" y haz la recarga a mano`
          : sinPago ? 'SIN CAMBIOS: este pedido no llegó a tomar ningún pago; el cliente puede reintentar'
            : `BLOQUEADO ("Usado", referencia ${bloqueo.referencia}): revisar a mano, la recarga NO se entregó`,
      }));
      return { pagoTomado: !sinPago };
    } catch (e) {
      console.error(`❌ No se pudo bloquear el pedido ${idPedido} tras un error:`, e.message);
      return { pagoTomado: true };
    }
  };

  // Cierre de una recarga YA entregada (marcar "Usado", "finalizados"...). Al cliente se le responde éxito
  // sin esperar a Apps Script: los pasos corren en segundo plano (waitUntil; sin él Vercel congela la
  // función al responder), EN ORDEN y uno tras otro (comparten el candado del script). Lo que no se
  // confirme se repite tras 10, 20 y 40 s, y solo si al final sigue sin confirmarse se anota el aviso en
  // "errores" con alFallar(nombres, rondas, motivo del último fallo).
  // pasos = [{ nombre, repetible, ejecutar: async () => bool }]. Todos se ejecutan una vez; se repiten
  // solo los repetibles (repetir no duplica nada): marcar_usado y registrar_uso_descuento siempre;
  // registrar_finalizado con el script v3 (ignora un idPedido ya anotado). Una ronda de reintentos solo
  // empieza si cabe entera antes de PLAZO_PEDIDO_MS.
  const cerrarEnSegundoPlano = (pasos, alFallar) => waitUntil((async () => {
    let pendientes = [];
    let rondas = 0;
    try {
      for (const paso of pasos) {
        if (!(await paso.ejecutar())) pendientes.push(paso);
      }
      for (const espera of ESPERAS_CIERRE_MS) {
        if (!pendientes.length) break;
        const repetibles = pendientes.filter((p) => p.repetible).length;
        if (!repetibles) break;
        // Cada paso y el aviso final de "errores" pueden tardar hasta tiempoIncidenteMs
        if (Date.now() + espera + (repetibles + 1) * tiempoIncidenteMs > inicio + PLAZO_PEDIDO_MS) break;
        await esperar(espera);
        rondas++;
        const siguen = [];
        for (const paso of pendientes) {
          if (!paso.repetible || !(await paso.ejecutar())) siguen.push(paso);
        }
        pendientes = siguen;
      }
      if (!pendientes.length) {
        if (rondas) console.info(`✅ Cierre del pedido ${idPedido} completado en segundo plano (tras ${rondas} reintento(s))`);
        return;
      }
      await alFallar(pendientes.map((p) => p.nombre), rondas, ultimoMotivo);
    } catch (e) {
      console.error(`❌ Cierre en segundo plano del pedido ${idPedido} falló:`, e.message);
    }
  })());

  return { marcarReferencia, registrarEnHoja, informe, bloquearPago, bloquearPedido, bloquearPorError, cerrarEnSegundoPlano };
}

/**
 * catch general de una recarga. pedido = { utilidades, referencias } desde que se pide verificar_pago
 * (o usar_complemento): a partir de ahí cualquier excepción bloquea el pago y lo anota en "errores",
 * así ningún pago se queda "En proceso" sin aviso. Devuelve null si todavía no había pedido en curso.
 */
export async function responderErrorInesperado(res, pedido, error, datosInforme = {}) {
  if (!pedido) return null;
  const lugar = String(error?.stack || '').split('\n')[1]?.trim();
  const { pagoTomado } = await pedido.utilidades.bloquearPorError({
    ...datosInforme, fase: FASES.inesperado, referencias: pedido.referencias,
    motivo: `${error?.name || 'Error'}: ${error?.message || error}${lugar ? ` (${lugar})` : ''}`,
  });
  if (res.headersSent) return res;
  return pagoTomado
    ? res.status(202).json({ status: "error", message: "Fallo técnico momentáneo. Tu pago quedó registrado y la recarga está en revisión: escríbenos por WhatsApp con tu referencia." })
    : res.status(503).json({ status: "error", message: "No pudimos confirmar tu pago a tiempo. Espera un minuto e intenta de nuevo." });
}
