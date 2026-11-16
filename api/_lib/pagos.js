// PAGOS EN SUPABASE (supabase/pagos.sql, desde 2026-11-14). La hoja "pagos" ya no se usa para cobrar.
// Cada macro de MacroDroid (Pago móvil, BDV a BDV, Transferencia de otros bancos) manda el pago aquí:
//   POST /api/juego?accion=pago_recibido
//   { "clave": "<MACRODROID_CLAVE_VERCEL>", "origen": "pago_movil"|"bdv"|"transferencia",
//     "telefono": "...", "referencia": "...", "monto": "1.560,00" }
// Sin la variable MACRODROID_CLAVE_VERCEL en Vercel no se acepta nada. Una referencia repetida (la misma
// notificación dos veces, o un reintento) no crea un segundo pago: responde "duplicado".
// Responde siempre rápido y con "success" en el texto cuando quedó guardado (MacroDroid puede reintentar si no).
import { timingSafeEqual } from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import { supabaseActivo, guardar, leer, leerDonde, actualizar, rpc, esAdminToken } from './supabase.js';
import { limpiarMontoVES } from './recarga-comun.js';
import { tokenDe } from './historial.js';
import { cambiarPago } from './motor-pagos.js';
import { guardarPagoManual } from './pagos-manual.js';

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
  // De paso: las contraseñas de las tiendas manuales de más de 7 días se borran (supabase/manuales.sql)
  waitUntil(rpc('manuales_borrar_claves_viejas', {})
    .then((n) => { if (n) console.info(`🧹 manuales: ${n} contraseña(s) de más de 7 días borradas`); })
    .catch((error) => console.error('⚠️ manuales: no se pudieron borrar las contraseñas viejas:', error.message)));
}

const ORIGENES = new Set(['pago_movil', 'bdv', 'transferencia']);

/**
 * Solicitud de "Revisar pagos" soltada SIN referencia completa (nota "sin_ref") en los últimos 3 días, con
 * los mismos últimos 5 dígitos y un monto parecido (±1 Bs del que se soltó o del precio del paquete).
 * Es la que este pago cubre. null si no hay.
 */
async function pagoYaSoltado(referencia, monto) {
  const desde = new Date(Date.now() - 3 * 864e5).toISOString();
  const filas = await leerDonde('pagos_solicitudes',
    `ultimos5=eq.${referencia.slice(-5)}&estado=eq.aprobado&nota=eq.sin_ref&resuelto=gt.${desde}&order=resuelto.asc`,
    'id,id_pedido,juego,monto,referencia');
  for (const s of Array.isArray(filas) ? filas : []) {
    const [soltado] = (await leer('pagos', { referencia: s.referencia }, 'monto')) || [];
    const montos = [Number(soltado?.monto), Number(s.monto)].filter((m) => m > 0);
    if (montos.some((m) => Math.abs(m - monto) <= 1)) return s;
  }
  return null;
}

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
  // Ya pasó la clave: toda respuesta dice lo que llegó, para verlo en las variables de MacroDroid
  const recibido = {
    referencia: String(b.referencia ?? '').slice(0, 60), monto: montoTexto,
    origen: String(b.origen ?? '').slice(0, 30), telefono: String(b.telefono ?? '').slice(0, 80),
  };
  const responder = (codigo, cuerpo) => res.status(codigo).json({ ...cuerpo, recibido });
  if (!/^\d{4,30}$/.test(referencia)) {
    console.error(`⚠️ pago_recibido: referencia inválida ("${recibido.referencia.slice(0, 40)}")`);
    return responder(400, { status: 'error', message: 'Referencia vacía o inválida' });
  }
  if (!(monto >= 0) || !Number.isFinite(monto)) {
    return responder(400, { status: 'error', message: 'Monto inválido' });
  }
  const origen = ORIGENES.has(String(b.origen)) ? String(b.origen) : 'otro';

  try {
    const ya = await leer('pagos', { referencia }, 'id');
    if (Array.isArray(ya) && ya.length) return responder(200, { status: 'success', duplicado: true, message: 'Pago ya registrado' });
    // Ya se usó y la limpieza diaria lo borró: un aviso repetido no lo hace renacer libre
    // (si esa consulta falla, igual protege la regla de la base al guardar: pagos_no_repetir_usado)
    const usada = await leer('pagos_usados', { referencia }, 'referencia').catch(() => null);
    if (Array.isArray(usada) && usada.length) return responder(200, { status: 'success', duplicado: true, message: 'Pago ya usado' });
    // ¿Este pago ya se soltó a mano SIN la referencia completa (Revisar pagos, _lib/pagos-manual.js)? Entonces
    // llega ya usado: si quedara libre, el cliente podría recargar dos veces con el mismo pago.
    const cubierta = await pagoYaSoltado(referencia, monto).catch((error) => {
      console.error('⚠️ pago_recibido: no se pudo revisar los pagos soltados a mano:', error.message);
      return null;
    });
    // Sin "on_conflict": si dos avisos iguales llegan a la vez, el segundo choca con la regla de la base
    // (referencia única) y se toma como duplicado. Nunca se pisa un pago que ya existe.
    await guardar('pagos', {
      referencia, monto: Math.round(monto * 100) / 100, monto_texto: montoTexto || null,
      remitente: String(b.telefono ?? '').trim().slice(0, 80) || null, origen,
      ...(cubierta && { estado: 'usado', usado: new Date().toISOString(), id_pedido: cubierta.id_pedido, juego: cubierta.juego }),
    });
    if (cubierta) {
      await actualizar('pagos_solicitudes', `id=eq.${cubierta.id}&nota=eq.sin_ref`, { nota: 'sin_ref_llego' })
        .catch((error) => console.error('⚠️ pago_recibido: no se pudo marcar la solicitud:', error.message));
      console.info(`💵 Pago …${referencia.slice(-5)} llegó después de soltarlo a mano: queda usado`);
      return responder(200, { status: 'success', message: 'Pago guardado (ya se había soltado a mano: queda usado)' });
    }
    console.info(`💵 Pago recibido en Supabase: …${referencia.slice(-5)} · ${monto} Bs · ${origen}`);
    limpiarSiToca();
    return responder(200, { status: 'success', message: 'Pago guardado en Supabase' });
  } catch (error) {
    if (/Supabase 409/.test(error.message)) return responder(200, { status: 'success', duplicado: true, message: 'Pago ya registrado' });
    console.error('⚠️ pago_recibido: no se pudo guardar:', error.message);
    return responder(503, { status: 'error', message: 'No se pudo guardar, reintenta' });
  }
}

/**
 * Panel admin → Pagos → "Agregar pago" (un pago que MacroDroid no anotó). POST /api/juego?accion=pago_manual
 * { referencia, monto, remitente?, nota? } con el token del administrador. Solo Supabase.
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

  // La regla de la base no deja repetir la referencia (ni una que ya se usó: pagos_usados)
  const r = await guardarPagoManual({ referencia, monto, remitente, nota });
  if (!r.ok) return res.status(r.codigo).json({ status: 'error', message: r.message });
  console.info(`💵 Pago agregado a mano: …${referencia.slice(-5)} · ${monto} Bs`);
  return res.status(200).json({ status: 'success' });
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
 * { referencia, estado: "usado" | "verificado" } con el token del administrador.
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
