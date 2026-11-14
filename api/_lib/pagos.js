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
import { supabaseActivo, guardar, leer } from './supabase.js';
import { limpiarMontoVES } from './recarga-comun.js';

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
    return res.status(200).json({ status: 'success', message: 'Pago guardado en Supabase' });
  } catch (error) {
    if (/Supabase 409/.test(error.message)) return res.status(200).json({ status: 'success', duplicado: true, message: 'Pago ya registrado' });
    console.error('⚠️ pago_recibido: no se pudo guardar:', error.message);
    return res.status(503).json({ status: 'error', message: 'No se pudo guardar, reintenta' });
  }
}
