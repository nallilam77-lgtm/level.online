// PAGOS EN SUPABASE (supabase/pagos.sql, desde 2026-11-14). Etapa 1: EN PARALELO con la hoja "pagos".
// Cada macro de MacroDroid (Pago móvil, BDV a BDV, Transferencia de otros bancos) manda el pago a la hoja
// como siempre y, en otra acción, aquí:
//   POST /api/juego?accion=pago_recibido
//   { "clave": "<MACRODROID_CLAVE_VERCEL>", "origen": "pago_movil"|"bdv"|"transferencia",
//     "telefono": "...", "referencia": "...", "monto": "1.560,00" }
// Sin la variable MACRODROID_CLAVE_VERCEL en Vercel no se acepta nada. Una referencia repetida (la misma
// notificación dos veces, o un reintento) no crea un segundo pago: responde "duplicado".
// Responde siempre rápido y con "success" en el texto cuando quedó guardado (MacroDroid puede reintentar si no).
import { timingSafeEqual } from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import { supabaseActivo, guardar, leer, rpc, esAdminToken } from './supabase.js';
import { limpiarMontoVES, formatearVES } from './recarga-comun.js';
import { llamarScript } from './externo.js';
import { tokenDe } from './historial.js';
import { cambiarPago } from './motor-pagos.js';

// Limpieza diaria (pagos_limpiar de supabase/pagos.sql): la primera vez que llega un pago cada día
// (hora de Venezuela) en esta instancia, después de responder.
let ultimaLimpieza = '';
function limpiarSiToca() {
  const hoy = new Date(Date.now() - 4 * 3600 * 1000).toISOString().slice(0, 10);
  if (ultimaLimpieza === hoy) return;
  ultimaLimpieza = hoy;
  waitUntil(rpc('pagos_limpiar', {})
    .then((r) => console.info('🧹 pagos: limpieza del día', JSON.stringify(r)))
    .catch((error) => { ultimaLimpieza = ''; console.error('⚠️ pagos: no se pudo limpiar:', error.message); }));
}

const ORIGENES = new Set(['pago_movil', 'bdv', 'transferencia']);

function mismaClave(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
}

export async function pagoRecibido(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ status: 'error', message: 'Método no permitido' });
  const claveEsperada = String(process.env.MACRODROID_CLAVE_VERCEL || '').trim();
  if (!claveEsperada || !supabaseActivo()) {
    console.error('🚨 pago_recibido: falta MACRODROID_CLAVE_VERCEL o Supabase en Vercel');
    return res.status(503).json({ status: 'error', message: 'No configurado' });
  }
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  if (!mismaClave(String(b.clave || '').trim(), claveEsperada)) {
    console.error('⚠️ pago_recibido: clave incorrecta');
    return res.status(401).json({ status: 'error', message: 'No autorizado' });
  }

  const referencia = String(b.referencia ?? '').replace(/\D/g, '');
  const montoTexto = String(b.monto ?? '').trim().slice(0, 40);
  const monto = limpiarMontoVES(montoTexto);
  if (!/^\d{4,30}$/.test(referencia)) {
    console.error(`⚠️ pago_recibido: referencia inválida ("${String(b.referencia ?? '').slice(0, 40)}")`);
    return res.status(400).json({ status: 'error', message: 'Referencia vacía o inválida' });
  }
  if (!(monto >= 0) || !Number.isFinite(monto)) {
    return res.status(400).json({ status: 'error', message: 'Monto inválido' });
  }
  const origen = ORIGENES.has(String(b.origen)) ? String(b.origen) : 'otro';

  try {
    const ya = await leer('pagos', { referencia }, 'id');
    if (Array.isArray(ya) && ya.length) return res.status(200).json({ status: 'success', duplicado: true, message: 'Pago ya registrado' });
    // Sin "on_conflict": si dos avisos iguales llegan a la vez, el segundo choca con la regla de la base
    // (referencia única) y se toma como duplicado. Nunca se pisa un pago que ya existe.
    await guardar('pagos', {
      referencia, monto: Math.round(monto * 100) / 100, monto_texto: montoTexto || null,
      remitente: String(b.telefono ?? '').trim().slice(0, 80) || null, origen,
    });
    console.info(`💵 Pago recibido en Supabase: …${referencia.slice(-5)} · ${monto} Bs · ${origen}`);
    limpiarSiToca();
    return res.status(200).json({ status: 'success', message: 'Pago guardado en Supabase' });
  } catch (error) {
    if (/Supabase 409/.test(error.message)) return res.status(200).json({ status: 'success', duplicado: true, message: 'Pago ya registrado' });
    console.error('⚠️ pago_recibido: no se pudo guardar:', error.message);
    return res.status(503).json({ status: 'error', message: 'No se pudo guardar, reintenta' });
  }
}

/**
 * Panel admin → Pagos → "Agregar pago" (un pago que MacroDroid no anotó). POST /api/juego?accion=pago_manual
 * { referencia, monto, remitente?, nota? } con el token del administrador. Se guarda en Supabase y también en la
 * hoja "pagos" (igual que MacroDroid), así sirve cobre la tienda con una o con otra.
 */
export async function pagoManual(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ status: 'error', message: 'Método no permitido' });
  if (!(await esAdminToken(tokenDe(req)))) return res.status(403).json({ status: 'error', message: 'Solo el administrador.' });
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const referencia = String(b.referencia ?? '').replace(/\D/g, '');
  const monto = limpiarMontoVES(String(b.monto ?? ''));
  if (!/^\d{6,30}$/.test(referencia)) return res.status(400).json({ status: 'error', message: 'Escribe la referencia completa (solo números).' });
  if (!(monto > 0)) return res.status(400).json({ status: 'error', message: 'Escribe el monto en Bs.' });
  const remitente = String(b.remitente ?? '').trim().slice(0, 80) || null;
  const nota = String(b.nota ?? '').trim().slice(0, 200) || null;

  // 1. Supabase (la regla de la base no deja repetir la referencia)
  try {
    const ya = await leer('pagos', { referencia }, 'id,estado');
    if (Array.isArray(ya) && ya.length) return res.status(409).json({ status: 'error', message: `Esa referencia ya está registrada (${ya[0].estado}).` });
    await guardar('pagos', { referencia, monto: Math.round(monto * 100) / 100, monto_texto: formatearVES(monto), remitente, origen: 'manual', nota });
  } catch (error) {
    if (/Supabase 409/.test(error.message)) return res.status(409).json({ status: 'error', message: 'Esa referencia ya está registrada.' });
    console.error('⚠️ pago_manual: no se pudo guardar en Supabase:', error.message);
    return res.status(503).json({ status: 'error', message: 'No se pudo guardar. Intenta de nuevo.' });
  }

  // 2. La hoja "pagos" (el Apps Script de Free Fire, como MacroDroid: sin "accion")
  let enHoja = false;
  const url = process.env.SCRIPT_RECARGAS_URL;
  if (url) {
    try {
      const r = await llamarScript(url, {
        referencia, monto: formatearVES(monto), telefono: remitente || 'Agregado a mano',
        ...(process.env.MACRODROID_CLAVE && { clave: process.env.MACRODROID_CLAVE }),
      }, { tiempoMs: 25000 });
      enHoja = r?.status === 'success';
    } catch (error) {
      console.error('⚠️ pago_manual: no se pudo anotar en la hoja:', error.message);
    }
  }
  console.info(`💵 Pago agregado a mano: …${referencia.slice(-5)} · ${monto} Bs · hoja: ${enHoja ? 'sí' : 'NO'}`);
  return res.status(200).json({ status: 'success', enHoja });
}

/** Panel admin → Pagos → "Limpiar ahora": la misma limpieza diaria. */
export async function limpiarPagos(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!(await esAdminToken(tokenDe(req)))) return res.status(403).json({ status: 'error', message: 'Solo el administrador.' });
  try {
    return res.status(200).json({ status: 'success', ...(await rpc('pagos_limpiar', {})) });
  } catch (error) {
    return res.status(503).json({ status: 'error', message: 'No se pudo limpiar.' });
  }
}

/**
 * Panel admin → Pagos: "Marcar usado" (un pago que ya se usó a mano, p. ej. una recarga por WhatsApp) o
 * "Liberar" (un pago apartado o por completar que debe volver a estar libre). POST /api/juego?accion=pago_estado
 * { referencia, estado: "usado" | "verificado" } con el token del administrador. "usado" también se marca en la hoja.
 */
export async function pagoEstado(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ status: 'error', message: 'Método no permitido' });
  if (!(await esAdminToken(tokenDe(req)))) return res.status(403).json({ status: 'error', message: 'Solo el administrador.' });
  const referencia = String(req.body?.referencia ?? '').replace(/\D/g, '');
  const estado = String(req.body?.estado ?? '');
  if (!/^\d{4,30}$/.test(referencia) || !['usado', 'verificado'].includes(estado)) {
    return res.status(400).json({ status: 'error', message: 'Datos inválidos.' });
  }
  try {
    const ok = estado === 'usado'
      ? await cambiarPago(referencia, 'usado')
      : (await cambiarPago(referencia, 'verificado', { soloSi: 'en_proceso' })) || (await cambiarPago(referencia, 'verificado', { soloSi: 'por_completar' }));
    if (!ok) return res.status(409).json({ status: 'error', message: estado === 'usado' ? 'No se pudo marcar (¿ya estaba usado?).' : 'Solo se libera un pago apartado o por completar.' });
    console.info(`💵 Pago …${referencia.slice(-5)} marcado ${estado} a mano desde el panel`);
    return res.status(200).json({ status: 'success' });
  } catch (error) {
    console.error('⚠️ pago_estado:', error.message);
    return res.status(503).json({ status: 'error', message: 'No se pudo cambiar. Intenta de nuevo.' });
  }
}
