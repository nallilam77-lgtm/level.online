// MOTOR DE PAGOS: hoja o Supabase (supabase/pagos.sql, desde 2026-11-14).
// Interruptor: configuracion "pagos_motor" = 'hoja' | 'supabase' (admin.html → Pagos).
// Con 'supabase', las operaciones de cobro que Free Fire, Blood Strike y Mobile Legends le piden a su Apps
// Script (verificar_pago, marcar_usado, bloquear_pedido, pago_por_completar, usar_complemento) se resuelven
// AQUÍ, en Supabase, con las mismas reglas y la MISMA respuesta que daba la hoja: el resto de cada tienda no
// cambia. llamarScript (_lib/externo.js) pregunta primero aquí (pagoEnSupabase). Roblox y las tiendas
// manuales usan tomarPago / cambiarPago directamente (sus scripts cobran por dentro).
// Espejo: cada pago que queda "usado" en Supabase se marca también "Usado" en la hoja "pagos" (después de
// responder): si un día se vuelve a la hoja, esa referencia no se puede usar otra vez.
import { waitUntil } from '@vercel/functions';
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

// ¿Con qué se cobra? 20 s en memoria. Si Supabase no responde, se queda con lo último que supo.
// Una instancia recién arrancada que todavía no lo sabe NO adivina "hoja": falla (la recarga queda como
// fallo técnico y el cliente reintenta). Si adivinara, con Supabase activo podría cobrar con la hoja un
// pago que en Supabase ya está usado.
let motor = { valor: null, hasta: 0 };
export async function motorPagos() {
  if (!supabaseActivo()) return 'hoja';
  if (motor.valor && Date.now() < motor.hasta) return motor.valor;
  try {
    const v = await rpc('pagos_motor', {});
    motor = { valor: v === 'supabase' ? 'supabase' : 'hoja', hasta: Date.now() + 20_000 };
  } catch (error) {
    if (!motor.valor) throw new Error(`Supabase (pagos_motor) no respondió: ${error.message}`);
    motor.hasta = Date.now() + 5_000;
    console.error('⚠️ motor de pagos: Supabase no respondió, se sigue con', motor.valor, error.message);
  }
  return motor.valor;
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

// Marca "Usado" en la hoja "pagos" (el Apps Script de Free Fire tiene la hoja central). Nunca frena nada.
function espejoEnHoja(referencia) {
  const url = String(process.env.SCRIPT_RECARGAS_URL || '').trim();
  const token = String(process.env.SCRIPT_RECARGAS_TOKEN || '').trim();
  const ref = String(referencia || '').replace(/\D/g, '');
  if (!url || !ref) return;
  // La hoja guarda la referencia como número y se come el cero inicial ("0302…" → "302…"): se marcan las dos
  const variantes = [...new Set([ref, ref.replace(/^0+/, '')])].filter(Boolean);
  waitUntil(Promise.all(variantes.map((r) => fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'follow',
    body: JSON.stringify({ accion: 'marcar_usado', referencia: r, token }), signal: AbortSignal.timeout(20000),
  }))).catch((error) => console.error(`⚠️ motor de pagos: no se pudo marcar "Usado" en la hoja la referencia …${ref.slice(-5)}:`, error.message)));
}

/** Aparta un pago (últimos 5) para un pedido. { encontrado, referencia, monto, repetido } o { encontrado: false, message } */
export async function tomarPago(ultimos5, idPedido, juego) {
  const r = await llamar('pagos_tomar', { p_ultimos5: String(ultimos5), p_id_pedido: String(idPedido), p_juego: juego });
  if (r?.encontrado) return { encontrado: true, referencia: String(r.referencia), monto: Number(r.monto) || 0, repetido: r.repetido === true };
  return { encontrado: false, motivo: r?.motivo, message: MENSAJES_PAGO[r?.motivo] || MENSAJES_PAGO.no_existe };
}

/** Cambia el estado de un pago. 'usado' también lo marca en la hoja. */
export async function cambiarPago(referencia, nuevo, { soloSi = null, idPedido = null } = {}) {
  const ok = await llamar('pagos_cambiar', { p_referencia: String(referencia), p_nuevo: nuevo, p_solo_si: soloSi, p_id_pedido: idPedido });
  if (nuevo === 'usado') espejoEnHoja(referencia);
  return ok === true;
}

export const guardarPorCompletar = (p) => llamar('pagos_guardar_por_completar', { p });
export async function completarPago(claveHash, ultimos5, idPedido, juego) {
  const r = await llamar('pagos_completar', { p_clave_hash: claveHash, p_ultimos5: String(ultimos5), p_id_pedido: String(idPedido), p_juego: juego });
  if (r?.valido && r.encontrado === false) return { ...r, message: MENSAJES_PAGO[r.motivo] || MENSAJES_PAGO.no_existe };
  return r;
}

/**
 * Lo llama llamarScript antes de ir al Apps Script. null = no es una operación de cobro, no es de FF/BS/ML o
 * se cobra con la hoja (sigue a la hoja como siempre). Si no, la respuesta igual a la del Apps Script.
 */
export async function pagoEnSupabase(url, cuerpo) {
  if (!cuerpo || !ACCIONES.has(cuerpo.accion)) return null;
  const juego = juegoDelScript(url);
  if (!juego || (await motorPagos()) !== 'supabase') return null;
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
      const referencia = await llamar('pagos_usar_del_pedido', { p_id_pedido: idPedido });
      // Puede traer varias ("ref1 + ref2": un pago completado): cada una se marca en la hoja
      String(referencia || '').split('+').map((r) => r.trim()).filter(Boolean).forEach(espejoEnHoja);
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
