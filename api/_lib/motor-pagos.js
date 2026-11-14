// MOTOR DE PAGOS: SOLO Supabase (supabase/pagos.sql). Desde 2026-11-14 la hoja "pagos" ya no tiene nada
// que ver con el cobro: las hojas solo anotan las ventas (libro diario).
// Las operaciones de cobro que Free Fire, Blood Strike y Mobile Legends le pedían a su Apps Script
// (verificar_pago, marcar_usado, bloquear_pedido, pago_por_completar, usar_complemento) se resuelven AQUÍ,
// con las mismas reglas y la MISMA respuesta que daba la hoja: el resto de cada tienda no cambia.
// llamarScript (_lib/externo.js) pregunta primero aquí (pagoEnSupabase). Roblox y las tiendas manuales usan
// tomarPago / cambiarPago directamente.
import { supabaseActivo, rpc } from './supabase.js';

const ACCIONES = new Set(['verificar_pago', 'marcar_usado', 'bloquear_pedido', 'pago_por_completar', 'usar_complemento']);
const MARGEN_BS = 0.50;

// Los mismos mensajes que las hojas
export const MENSAJES_PAGO = {
  en_proceso: '⚠️ Otro cliente está procesando esta referencia en este momento.',
  vencido: '⌛ Este pago tiene más de 3 días: escríbenos por WhatsApp con tu referencia y lo revisamos.',
  por_completar: '⏳ Este pago no alcanzó y está esperando que completes la diferencia: usa el botón "Completar pago" de la tienda o escríbenos por WhatsApp.',
  usado: '❌ Este pago ya fue validado y gastado en otra recarga.',
  no_existe: '🔍 Referencia no encontrada en el sistema. Si acabas de pagar, espera un minuto e intenta de nuevo.',
  formato: '🔍 La referencia debe tener exactamente 5 dígitos.',
};

// Siempre Supabase. Sin sus variables en Vercel no se cobra nada (nunca se vuelve a la hoja).
export async function motorPagos() {
  if (!supabaseActivo()) throw new Error('Supabase no está configurado: no se puede cobrar (los pagos solo están en Supabase)');
  return 'supabase';
}

// Juego según el Apps Script al que iba la operación (solo los tres que cobran desde Vercel)
function juegoDelScript(url) {
  const u = String(url || '').trim();
  if (!u) return null;
  if (u === String(process.env.SCRIPT_RECARGAS_URL || '').trim()) return 'freefire';
  if (u === String(process.env.SCRIPT_BLOOD || '').trim()) return 'bloodstrike';
  if (u === String(process.env.SCRIPT_MLBB || '').trim()) return 'mobilelegends';
  return null;
}

async function llamar(funcion, args) {
  try {
    return await rpc(funcion, args);
  } catch (error) {
    throw new Error(`Supabase (pagos, ${funcion}): ${error.message}`);
  }
}

/** Aparta un pago (últimos 5) para un pedido. { encontrado, referencia, monto, repetido } o { encontrado: false, message } */
export async function tomarPago(ultimos5, idPedido, juego) {
  const r = await llamar('pagos_tomar', { p_ultimos5: String(ultimos5), p_id_pedido: String(idPedido), p_juego: juego });
  if (r?.encontrado) return { encontrado: true, referencia: String(r.referencia), monto: Number(r.monto) || 0, repetido: r.repetido === true };
  return { encontrado: false, motivo: r?.motivo, message: MENSAJES_PAGO[r?.motivo] || MENSAJES_PAGO.no_existe };
}

/** Cambia el estado de un pago (un pago usado ya no cambia nunca). */
export async function cambiarPago(referencia, nuevo, { soloSi = null, idPedido = null } = {}) {
  const ok = await llamar('pagos_cambiar', { p_referencia: String(referencia), p_nuevo: nuevo, p_solo_si: soloSi, p_id_pedido: idPedido });
  return ok === true;
}

export const guardarPorCompletar = (p) => llamar('pagos_guardar_por_completar', { p });
export async function completarPago(claveHash, ultimos5, idPedido, juego) {
  const r = await llamar('pagos_completar', { p_clave_hash: claveHash, p_ultimos5: String(ultimos5), p_id_pedido: String(idPedido), p_juego: juego });
  if (r?.valido && r.encontrado === false) return { ...r, message: MENSAJES_PAGO[r.motivo] || MENSAJES_PAGO.no_existe };
  return r;
}

/**
 * Lo llama llamarScript antes de ir al Apps Script. null = no es una operación de cobro o no es de FF/BS/ML
 * (sigue al Apps Script). Si no, la respuesta igual a la que daba el Apps Script.
 */
export async function pagoEnSupabase(url, cuerpo) {
  if (!cuerpo || !ACCIONES.has(cuerpo.accion)) return null;
  const juego = juegoDelScript(url);
  if (!juego) return null;
  await motorPagos();
  const idPedido = String(cuerpo.idPedido || '');

  switch (cuerpo.accion) {
    case 'verificar_pago': {
      const ultimos5 = String(cuerpo.referencia || '').replace(/\s+/g, '');
      if (!/^\d{5}$/.test(ultimos5)) return { status: 'success', encontrado: false, message: MENSAJES_PAGO.formato };
      const p = await tomarPago(ultimos5, idPedido, juego);
      if (!p.encontrado) return { status: 'success', encontrado: false, message: p.message };
      const precio = Number(cuerpo.monto) || 0;
      return { status: 'success', encontrado: true, referencia: p.referencia, montoPagado: p.monto, telefono: '',
        insuficiente: p.monto < precio - MARGEN_BS, repetido: p.repetido };
    }
    case 'marcar_usado':
      return { status: 'success', cambiado: await cambiarPago(cuerpo.referencia, 'usado', { idPedido: idPedido || null }) };
    case 'bloquear_pedido': {
      // Puede traer varias ("ref1 + ref2": un pago completado): todas quedan usadas
      const referencia = await llamar('pagos_usar_del_pedido', { p_id_pedido: idPedido });
      return { status: 'success', referencia: String(referencia || '') };
    }
    case 'pago_por_completar':
      return guardarPorCompletar({
        idPedido, referencia: cuerpo.referencia, claveHash: cuerpo.claveHash, precio: Number(cuerpo.precio) || 0,
        pagado: Number(cuerpo.pagado) || 0, juego,
        datos: { idJugador: String(cuerpo.idJugador || ''), ...(cuerpo.zona !== undefined && { zona: String(cuerpo.zona) }),
          paquete: String(cuerpo.paquete || ''), codigoDescuento: String(cuerpo.codigoDescuento || ''),
          comprobante: String(cuerpo.comprobante || ''), telefono: String(cuerpo.telefono || '') },
      });
    case 'usar_complemento':
      return completarPago(String(cuerpo.claveHash || ''), String(cuerpo.referencia || ''), idPedido, juego);
    default:
      return null;
  }
}
