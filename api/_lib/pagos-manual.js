// PAGOS VERIFICADOS A MANO (supabase/pagos-manual.sql, desde 2026-11-16).
// Para cuando la notificación de un banco no llega a MacroDroid (p. ej. Venezuela). Con el interruptor del
// panel encendido (admin.html → Ajustes, configuracion "pagos_manual" = true):
//   1. La tienda busca el pago como siempre (motor-pagos.js → tomarPago). Si llegó, todo sigue automático.
//   2. Si la referencia NO existe, tomarPago llama a crearSolicitud: queda una fila "pendiente" en
//      pagos_solicitudes con la petición de la tienda CIFRADA (cifrado.js: las tiendas manuales mandan la
//      contraseña), el pedido se guarda en "recargas" como "pendiente" (Recibido: el cliente lo ve en
//      "Consulta tus últimas recargas" y en su perfil) y la respuesta lleva { solicitudPago } (historial.js).
//      La página (public/js/pago-manual.js) le dice "Estamos verificando tu pago" y dónde ver el estado.
//   3. El administrador la aprueba en admin.html → Pagos con la referencia COMPLETA del banco
//      (POST /api/recargar?accion=solicitud_resolver: corre en recargar.js por sus 180 s): se guarda en "pagos"
//      como un pago más y la MISMA recarga se repite aquí mismo (repetirRecarga), con el mismo idPedido, la
//      cuenta y la IP del cliente: descuento, fichas, Central One y el pedido van por el camino normal y la
//      fila "pendiente" se pone al día sola. La referencia completa es obligatoria: si después llega la
//      notificación real, es la misma referencia y la base no deja registrarla dos veces.
//      O la rechaza: el pedido queda "problema" ("Escríbenos").
// Nunca se aprueba nada solo: sin el administrador, la solicitud se queda pendiente.
import { randomUUID } from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import { supabaseActivo, guardar, leer, leerDonde, actualizar, borrar, esAdminToken } from './supabase.js';
import { conCache } from './externo.js';
import { limpiarMontoVES, formatearVES } from './recarga-comun.js';
import { tokenDe, datosDeLaRecarga, marcarSolicitudPago, guardarPorVerificar, conHistorial } from './historial.js';
import { cifrar, descifrar } from './cifrado.js';

// Si la página del cliente es vieja (sin js/pago-manual.js), esto es lo que ve en la ventana de error
// (el cliente no sabe que el pago se revisa a mano: solo que su recarga está pendiente)
export const MENSAJE_SOLICITUD = '⏳ Tu recarga está pendiente. Puedes ver cómo va en levelupstore.online → "Consulta tus últimas recargas" con tu ID (o en tu perfil). No hace falta pagar de nuevo.';
// Pedido rechazado en "Revisar pagos": nota_admin = PREFIJO_RECHAZO + motivo (lo ve el cliente). Igual en
// api/consultar-ordenes.js y public/js/perfil.js.
export const PREFIJO_RECHAZO = '❌ Pago rechazado: ';
// Una referencia rechazada no se puede volver a mandar a "Revisar pagos" durante estos días (las resueltas
// se borran a los 7: no subir de 7)
const DIAS_RECHAZO = 7;
export const mensajeRechazada = (motivo) => `❌ Este pago fue rechazado${motivo ? `: ${motivo}` : '.'} Si crees que es un error, escríbenos por WhatsApp con tu comprobante.`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const corto = (v, max) => String(v ?? '').trim().slice(0, max) || null;

/** ¿Está encendido el interruptor? Copia de 15 s; si Supabase no responde, apagado (como siempre). */
export async function pagosManualActivo() {
  if (!supabaseActivo()) return false;
  try {
    const { datos } = await conCache('pagos:manual', async () => {
      const filas = await leer('configuracion', { clave: 'pagos_manual' }, 'valor');
      // Encendido siempre, salvo que el administrador lo apague en Ajustes (valor false)
      return !(Array.isArray(filas) && filas[0]?.valor === false);
    }, { frescoMs: 15_000, respaldoMs: 10 * 60_000 });
    return datos === true;
  } catch (error) {
    console.error('⚠️ pagos a mano: no se pudo leer el interruptor:', error.message);
    return false;
  }
}

/**
 * La referencia no existe y el interruptor está encendido: deja (o reutiliza) la solicitud pendiente de esa
 * referencia y ese juego, guarda el pedido como "pendiente" y marca la respuesta. Devuelve el id o null si no
 * se pudo (la tienda responde entonces "referencia no encontrada", como siempre).
 * Una referencia RECHAZADA en los últimos DIAS_RECHAZO días (cualquier juego o ID) no se vuelve a anotar:
 * devuelve { rechazada: true, motivo } y la tienda le dice al cliente que ese pago fue rechazado.
 */
export async function crearSolicitud(ultimos5, juego, monto, idPedido) {
  try {
    if (!/^\d{5}$/.test(String(ultimos5)) || !(await pagosManualActivo())) return null;
    const desde = new Date(Date.now() - DIAS_RECHAZO * 864e5).toISOString();
    const [rechazada] = (await leerDonde('pagos_solicitudes',
      `ultimos5=eq.${ultimos5}&estado=eq.rechazado&resuelto=gt.${desde}&order=resuelto.desc&limit=1`, 'nota')) || [];
    if (rechazada) return { rechazada: true, motivo: String(rechazada.nota || '').slice(0, 200) };
    // Una pendiente por referencia + juego + CLIENTE (ID en minúsculas): el mismo cliente que reintenta espera
    // la misma; otro cliente con una referencia que termina igual tiene la suya (índice único de pagos-manual.sql)
    const d = datosDeLaRecarga();
    const idJugador = corto(String(d.idJugador ?? '').toLowerCase(), 60);
    const pendiente = async () => (await leerDonde('pagos_solicitudes',
      `ultimos5=eq.${ultimos5}&juego=eq.${encodeURIComponent(juego)}&estado=eq.pendiente&id_jugador=${idJugador ? `eq.${encodeURIComponent(idJugador)}` : 'is.null'}`,
      'id'))?.[0]?.id || null;
    let id = await pendiente();
    if (!id) {
      // Sin llave para cifrar no se guarda la petición: sin ella no se podría repetir la recarga
      const datos = cifrar(JSON.stringify(d.body || {}));
      id = randomUUID();
      try {
        await guardar('pagos_solicitudes', {
          id, ultimos5, juego: corto(juego, 30),
          monto: Number(monto) > 0 ? Math.round(Number(monto) * 100) / 100 : null,
          id_jugador: idJugador, paquete: corto(d.paquete, 80), telefono: corto(d.telefono, 30),
          id_pedido: corto(idPedido, 80), usuario: (await d.usuario) || null, ip: corto(d.ip, 60), datos,
        });
        console.info(`🖐️ Pago por aprobar a mano: …${ultimos5} · ${juego} · ${monto || '?'} Bs`);
        // El pedido "Recibido" que ve el cliente (si falla, la solicitud vale igual: al aprobar se crea)
        await guardarPorVerificar({ idPedido, juego, precio: monto, ultimos5 })
          .catch((error) => console.error('⚠️ pagos a mano: no se pudo guardar el pedido pendiente:', error.message));
      } catch (error) {
        // Otra petición del mismo cliente la creó a la vez (una sola pendiente por referencia, juego y cliente).
        // Mientras no se corra el índice nuevo, el viejo (referencia + juego) también choca con OTRO cliente:
        // entonces no hay solicitud suya y la tienda responde "referencia no encontrada" (nunca se une a la ajena).
        if (!/Supabase 409/.test(error.message)) throw error;
        id = await pendiente();
      }
    }
    if (id) marcarSolicitudPago({ id, message: MENSAJE_SOLICITUD });
    return id;
  } catch (error) {
    console.error('⚠️ pagos a mano: no se pudo crear la solicitud:', error.message);
    return null;
  }
}

/** La página del cliente pregunta cómo va: GET /api/juego?accion=solicitud_estado&id=<uuid> → { estado }. */
export async function solicitudEstado(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const id = String(req.query.id || '');
  if (!UUID.test(id)) return res.status(400).json({ status: 'error', message: 'Solicitud inválida.' });
  try {
    const [fila] = (await leer('pagos_solicitudes', { id }, 'estado,nota')) || [];
    if (!fila) return res.status(404).json({ status: 'error', estado: 'no_existe' });
    // Rechazada: el motivo que escribió el administrador (es para el cliente)
    return res.status(200).json({ status: 'success', estado: fila.estado, ...(fila.estado === 'rechazado' && fila.nota && { motivo: fila.nota }) });
  } catch (error) {
    console.error('⚠️ pagos a mano: no se pudo leer el estado:', error.message);
    return res.status(503).json({ status: 'error', message: 'Intenta de nuevo.' });
  }
}

/**
 * Guarda un pago a mano en "pagos" (lo usan "Agregar pago a mano" y "Aprobar"). La base no deja repetir una
 * referencia ni registrar una que ya se usó. { ok: true } o { ok: false, codigo, message }.
 */
export async function guardarPagoManual({ referencia, monto, remitente = null, nota = null }) {
  try {
    const ya = await leer('pagos', { referencia }, 'id,estado');
    if (Array.isArray(ya) && ya.length) return { ok: false, codigo: 409, message: `Esa referencia ya está registrada (${ya[0].estado}).` };
    await guardar('pagos', { referencia, monto: Math.round(monto * 100) / 100, monto_texto: formatearVES(monto), remitente, origen: 'manual', nota });
    return { ok: true };
  } catch (error) {
    if (/Supabase 409/.test(error.message)) return { ok: false, codigo: 409, message: 'Esa referencia ya está registrada o ya se usó.' };
    console.error('⚠️ pago a mano: no se pudo guardar en Supabase:', error.message);
    return { ok: false, codigo: 503, message: 'No se pudo guardar. Intenta de nuevo.' };
  }
}

// Respuesta falsa para correr la recarga aquí mismo: guarda lo que la tienda respondería al cliente
function respuestaFalsa() {
  const r = { statusCode: 200, cuerpo: null, headersSent: false };
  r.status = (codigo) => { r.statusCode = codigo; return r; };
  r.json = (cuerpo) => { r.cuerpo = cuerpo; r.headersSent = true; return r; };
  r.send = r.json;
  r.setHeader = () => r;
  r.end = () => { r.headersSent = true; return r; };
  return r;
}

/**
 * Repite la recarga del cliente con su misma petición (descifrada), el mismo idPedido, su cuenta y su IP.
 * Solo una vez por solicitud: "recargada" se marca ANTES (si dos aprobaciones llegaran a la vez, solo una corre).
 * Devuelve { codigo, cuerpo } (lo que la tienda le habría respondido al cliente) o { error }.
 */
async function repetirRecarga(id) {
  const [s] = (await leer('pagos_solicitudes', { id }, 'juego,id_pedido,usuario,ip,datos,recargada')) || [];
  if (!s || s.recargada || !s.datos || !s.id_pedido) return { error: 'La recarga de esta solicitud ya se hizo o no tiene datos.' };
  const tomada = await actualizar('pagos_solicitudes', `id=eq.${id}&recargada=is.null`, { recargada: new Date().toISOString(), datos: null }, 'id');
  if (!tomada?.length) return { error: 'La recarga de esta solicitud ya se está haciendo.' };
  const body = JSON.parse(descifrar(s.datos));
  const { cargarJuego } = await import('./juegos/index.js');
  const juego = await cargarJuego(s.juego);
  if (!juego) return { error: 'Juego no válido.' };
  const req = {
    method: 'POST', query: { juego: s.juego }, headers: {}, body, socket: {},
    idPedidoForzado: s.id_pedido, usuarioForzado: s.usuario || null, ipForzada: s.ip || 'panel',
  };
  const res = respuestaFalsa();
  await conHistorial(req, res, s.juego, () => juego.recargar(req, res));
  return { codigo: res.statusCode, cuerpo: res.cuerpo || {} };
}

/**
 * Panel admin → Pagos → "Pagos por aprobar". POST /api/recargar?accion=solicitud_resolver con el token del
 * administrador: { id, accion: "aprobar", referencia (completa, termina en los 5 del cliente), monto }
 * o { id, accion: "rechazar", nota? }.
 */
export async function solicitudResolver(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ status: 'error', message: 'Método no permitido' });
  if (!(await esAdminToken(tokenDe(req)))) return res.status(403).json({ status: 'error', message: 'Solo el administrador.' });
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const id = String(b.id || '');
  const accion = String(b.accion || '');
  if (!UUID.test(id) || !['aprobar', 'rechazar'].includes(accion)) return res.status(400).json({ status: 'error', message: 'Datos inválidos.' });

  let fila;
  try {
    [fila] = (await leer('pagos_solicitudes', { id }, 'id,ultimos5,juego,monto,estado,id_pedido')) || [];
  } catch (error) {
    console.error('⚠️ pagos a mano: no se pudo leer la solicitud:', error.message);
    return res.status(503).json({ status: 'error', message: 'No se pudo leer. Intenta de nuevo.' });
  }
  if (!fila) return res.status(404).json({ status: 'error', message: 'Esa solicitud ya no existe.' });
  if (fila.estado !== 'pendiente') return res.status(409).json({ status: 'error', message: `Esa solicitud ya está ${fila.estado}.` });
  const ahora = new Date().toISOString();
  const soloPendiente = `id=eq.${id}&estado=eq.pendiente`;
  const pedido = fila.id_pedido ? `id_pedido=eq.${encodeURIComponent(fila.id_pedido)}&estado=eq.pendiente` : '';

  if (accion === 'rechazar') {
    // El motivo lo ve el cliente (ventana de la tienda, "Consulta tus últimas recargas" y su perfil)
    const motivo = String(b.nota ?? '').replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (motivo.length < 5) return res.status(400).json({ status: 'error', message: 'Escribe el motivo del rechazo (lo verá el cliente).' });
    try {
      const cambiadas = await actualizar('pagos_solicitudes', soloPendiente, { estado: 'rechazado', resuelto: ahora, nota: motivo, datos: null }, 'id');
      if (!cambiadas?.length) return res.status(409).json({ status: 'error', message: 'Esa solicitud ya no está pendiente.' });
      // El pedido que veía el cliente como "Recibido" pasa a "Con problema" (le dice que escriba)
      if (pedido) {
        // motivo_fallo solo acepta códigos (^[a-z_]{1,40}$, regla de la base): el texto va en nota_admin con el
        // prefijo PREFIJO_RECHAZO; perfil.js y consultar-ordenes.js se lo muestran al cliente
        await actualizar('recargas', pedido, { estado: 'problema', motivo_fallo: 'pago_rechazado', revisado: ahora, actualizado: ahora,
          nota_admin: `${PREFIJO_RECHAZO}${motivo}` }).catch((error) => console.error('⚠️ pagos a mano: no se pudo marcar el pedido:', error.message));
      }
      console.info(`🖐️ Pago …${fila.ultimos5} (${fila.juego}) rechazado a mano`);
      return res.status(200).json({ status: 'success' });
    } catch (error) {
      console.error('⚠️ pagos a mano: no se pudo rechazar:', error.message);
      return res.status(503).json({ status: 'error', message: 'No se pudo guardar. Intenta de nuevo.' });
    }
  }

  // Soltar: la referencia completa del banco es OPCIONAL. Si viene, debe terminar en los 5 dígitos del cliente.
  // Sin ella se guarda una referencia interna ("000" + hora + los 5 dígitos) y la solicitud queda marcada
  // "sin_ref": si la notificación real llega después, pagos.js la anota ya usada (no da otra recarga).
  const escrita = String(b.referencia ?? '').replace(/\D/g, '');
  const monto = limpiarMontoVES(String(b.monto ?? ''));
  if (escrita && !/^\d{6,30}$/.test(escrita)) return res.status(400).json({ status: 'error', message: 'La referencia completa debe tener al menos 6 números (o déjala vacía).' });
  if (escrita && !escrita.endsWith(fila.ultimos5)) return res.status(400).json({ status: 'error', message: `La referencia debe terminar en ${fila.ultimos5} (lo que escribió el cliente).` });
  const sinReferencia = !escrita;
  const referencia = escrita || `000${Date.now()}${fila.ultimos5}`;
  if (!(monto > 0)) return res.status(400).json({ status: 'error', message: 'Escribe el monto que llegó, en Bs.' });
  // Sin referencia completa, un mismo pago podría soltarse dos veces (dos clientes con los mismos 5 dígitos, o
  // un pago que sí llegó). Entonces se exige la referencia completa: la base no deja usar la misma dos veces.
  if (sinReferencia) {
    const desde = new Date(Date.now() - 3 * 864e5).toISOString();
    try {
      const [soltada] = (await leerDonde('pagos_solicitudes', `ultimos5=eq.${fila.ultimos5}&estado=eq.aprobado&id=neq.${id}&resuelto=gt.${desde}`, 'id')) || [];
      if (soltada) return res.status(409).json({ status: 'error', message: `En los últimos 3 días ya soltaste otro pago que termina en ${fila.ultimos5}. Para soltar este, escribe su referencia completa del banco (tiene que ser distinta).` });
      const [llego] = (await leerDonde('pagos', `referencia=like.*${fila.ultimos5}&recibido=gt.${desde}&order=recibido.desc`, 'estado')) || [];
      if (llego) return res.status(409).json({ status: 'error', message: `Ya llegó un pago que termina en ${fila.ultimos5} (está "${llego.estado}"). Si es el mismo pago, escribe su referencia completa y se usa ese; si es otro, escribe la referencia completa de este.` });
    } catch (error) {
      console.error('⚠️ pagos a mano: no se pudo revisar si el pago ya se usó:', error.message);
      return res.status(503).json({ status: 'error', message: 'No se pudo comprobar el pago. Intenta de nuevo o escribe la referencia completa.' });
    }
  }

  // Primero se "toma" la solicitud (solo si sigue pendiente: dos clics no aprueban dos veces); después el pago
  let tomada;
  try {
    tomada = await actualizar('pagos_solicitudes', soloPendiente, { estado: 'aprobado', resuelto: ahora, referencia, nota: sinReferencia ? 'sin_ref' : null }, 'id');
  } catch (error) {
    console.error('⚠️ pagos a mano: no se pudo aprobar:', error.message);
    return res.status(503).json({ status: 'error', message: 'No se pudo guardar. Intenta de nuevo.' });
  }
  if (!tomada?.length) return res.status(409).json({ status: 'error', message: 'Esa solicitud ya no está pendiente.' });
  // Si la notificación de ESE pago ya llegó y está libre, se usa ese mismo (no se guarda otra vez)
  const [existente] = escrita ? ((await leer('pagos', { referencia }, 'estado').catch(() => [])) || []) : [];
  const r = existente?.estado === 'verificado' ? { ok: true }
    : await guardarPagoManual({ referencia, monto, nota: sinReferencia ? `Soltado a mano sin referencia completa (${fila.juego})` : `Soltado a mano (${fila.juego})` });
  if (!r.ok) {
    // El pago no quedó: la solicitud vuelve a pendiente para corregir la referencia
    await actualizar('pagos_solicitudes', `id=eq.${id}&estado=eq.aprobado`, { estado: 'pendiente', resuelto: null, referencia: null, nota: null })
      .catch((error) => console.error('⚠️ pagos a mano: no se pudo devolver a pendiente:', error.message));
    return res.status(r.codigo).json({ status: 'error', message: r.message });
  }
  console.info(`🖐️ Pago …${referencia.slice(-5)} · ${monto} Bs (${fila.juego}) aprobado a mano`);
  // De paso, las solicitudes resueltas de más de 7 días se borran (no hacen falta para nada)
  waitUntil(borrar('pagos_solicitudes', `estado=neq.pendiente&creado=lt.${new Date(Date.now() - 7 * 864e5).toISOString()}`)
    .catch((error) => console.error('⚠️ pagos a mano: no se pudieron borrar las viejas:', error.message)));

  // La recarga del cliente, aquí mismo y por el camino normal (el pago ya está libre con su referencia)
  let resultado;
  try {
    resultado = await repetirRecarga(id);
  } catch (error) {
    console.error('🚨 pagos a mano: falló la recarga al aprobar:', error.message);
    resultado = { error: 'La recarga dio un error inesperado.' };
  }
  const cuerpo = resultado.cuerpo || {};
  const exito = !resultado.error && cuerpo.status === 'success';
  // Si la tienda no llegó a tomar el pago (p. ej. el paquete ya no existe: el pago sigue libre), el pedido
  // "Recibido" va a Revisión. Si lo tomó, la tienda ya anotó el pedido como siempre (bloquear, incompleto…).
  const pagoLibre = !exito && (await leer('pagos', { referencia }, 'estado').catch(() => []))?.[0]?.estado === 'verificado';
  if (pagoLibre && pedido) {
    await actualizar('recargas', pedido, { estado: 'en_revision', motivo_fallo: 'pago_no_tomado', actualizado: new Date().toISOString(),
      nota_admin: corto(`🖐️ Pago …${fila.ultimos5} soltado, pero la recarga no se hizo (el pago quedó libre): ${resultado.error || cuerpo.message || 'sin detalle'}`, 500) })
      .catch((error) => console.error('⚠️ pagos a mano: no se pudo pasar el pedido a revisión:', error.message));
  }
  const recarga = resultado.error ? `⚠️ ${resultado.error} El pago quedó guardado${pagoLibre ? ' y libre' : ''}: revisa el pedido en Revisión.`
    : exito ? (cuerpo.entrega === 'en_camino' ? '✅ Recarga pedida: va en camino (Central One la confirma en unos minutos).' : '✅ Recarga hecha.')
    : cuerpo.insuficiente ? '⚠️ El pago no alcanzó: el pedido quedó "Pago incompleto" y el cliente puede completar la diferencia.'
    : `⚠️ La recarga no se hizo: ${String(cuerpo.message || 'sin detalle').slice(0, 200)}`;
  return res.status(200).json({ status: 'success', recarga, aviso: Number(fila.monto) > 0 && monto < Number(fila.monto) - 1
    ? `Llegó menos de lo que cuesta el paquete (${formatearVES(Number(fila.monto))} Bs).` : '' });
}
