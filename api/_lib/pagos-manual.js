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
 * Si ya hay OTRO pedido pendiente con esos 5 dígitos (otro ID, otro teléfono o el mismo cliente otra vez),
 * devuelve { repetida: true } y la tienda responde "referencia repetida" sin anotar nada.
 */
export async function crearSolicitud(ultimos5, juego, monto, idPedido) {
  try {
    if (!/^\d{5}$/.test(String(ultimos5)) || !(await pagosManualActivo())) return null;
    const desde = new Date(Date.now() - DIAS_RECHAZO * 864e5).toISOString();
    const [rechazada] = (await leerDonde('pagos_solicitudes',
      `ultimos5=eq.${ultimos5}&estado=eq.rechazado&resuelto=gt.${desde}&order=resuelto.desc&limit=1`, 'nota')) || [];
    if (rechazada) return { rechazada: true, motivo: String(rechazada.nota || '').slice(0, 200) };
    // UNA sola pendiente por referencia (cualquier juego, ID o teléfono). Solo la reutiliza el MISMO pedido
    // (la tienda repitió la petición por la red); otro pedido con esos 5 dígitos → "referencia repetida".
    const d = datosDeLaRecarga();
    const idJugador = corto(String(d.idJugador ?? '').toLowerCase(), 60);
    const pendiente = async () => {
      const [fila] = (await leerDonde('pagos_solicitudes',
        `ultimos5=eq.${ultimos5}&estado=eq.pendiente&order=creado.asc&limit=1`, 'id,id_pedido')) || [];
      if (!fila) return null;
      return idPedido && fila.id_pedido === String(idPedido) ? fila.id : { repetida: true };
    };
    let id = await pendiente();
    if (id?.repetida) {
      console.info(`🖐️ Referencia repetida en Revisar pagos: …${ultimos5} · ${juego} (ya hay una pendiente)`);
      return id;
    }
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
        // Otra petición con esa referencia la creó a la vez (índice único de pagos-manual.sql): si no es este
        // mismo pedido, es "referencia repetida" (nunca se une a la ajena)
        if (!/Supabase 409/.test(error.message)) throw error;
        id = (await pendiente()) || { repetida: true };
        if (id.repetida) return id;
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

/**
 * Al soltar CON referencia completa: ¿ya llegó por la macro (3 días) un pago con los mismos 5 dígitos pero escrito
 * distinto? El banco y MacroDroid no siempre usan el mismo formato (p. ej. "0050938468018" en la app del banco y
 * "932038468018" en la notificación): sin esto se guardaba un pago nuevo y el de la macro quedaba LIBRE para otra
 * recarga (pasó el 2026-11-16 con …68018). Devuelve la respuesta 409 { llego } o null. distinto = el administrador
 * confirmó que es OTRO pago.
 */
async function otroFormato(ultimos5, escrita, distinto) {
  if (distinto) return null;
  const desde = new Date(Date.now() - 3 * 864e5).toISOString();
  const iguales = (await leerDonde('pagos', `referencia=like.*${ultimos5}&recibido=gt.${desde}&order=recibido.desc`, 'referencia,monto,estado')
    .catch(() => [])) || [];
  if (iguales.some((p) => p.referencia === escrita)) return null;   // es exactamente ese: se usa ese
  // Los usados que la limpieza diaria ya pasó a pagos_usados también cuentan (no tienen monto guardado)
  if (!iguales.length) {
    const usados = (await leerDonde('pagos_usados', `referencia=like.*${ultimos5}&usado=gt.${desde}`, 'referencia').catch(() => [])) || [];
    const u = usados.find((x) => x.referencia !== escrita);
    if (u) iguales.push({ referencia: u.referencia, monto: 0, estado: 'usado' });
  }
  const p = iguales[0];
  if (!p) return null;
  return { status: 'error', llego: { referencia: p.referencia, monto: Number(p.monto) || 0, estado: p.estado },
    message: `Ya llegó por la macro el pago ${p.referencia} (${formatearVES(Number(p.monto) || 0)} Bs, "${p.estado}"), que termina igual. Si es el mismo pago, usa esa referencia; si de verdad es otro pago, confírmalo.` };
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
  // Sin límite de intentos: el administrador ya aprobó el pago (limitador.js → sinLimites)
  const { sinLimites } = await import('./limitador.js');
  await sinLimites.run(true, () => conHistorial(req, res, s.juego, () => juego.recargar(req, res)));
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
  if (!UUID.test(id) || !['aprobar', 'rechazar', 'deshacer'].includes(accion)) return res.status(400).json({ status: 'error', message: 'Datos inválidos.' });

  let fila;
  try {
    [fila] = (await leer('pagos_solicitudes', { id }, 'id,ultimos5,juego,monto,estado,id_pedido,datos')) || [];
  } catch (error) {
    console.error('⚠️ pagos a mano: no se pudo leer la solicitud:', error.message);
    return res.status(503).json({ status: 'error', message: 'No se pudo leer. Intenta de nuevo.' });
  }
  if (!fila) return res.status(404).json({ status: 'error', message: 'Esa solicitud ya no existe.' });
  if (accion === 'deshacer') return deshacerRechazo(req, res, fila, b);
  if (fila.estado !== 'pendiente') return res.status(409).json({ status: 'error', message: `Esa solicitud ya está ${fila.estado}.` });
  const ahora = new Date().toISOString();
  const soloPendiente = `id=eq.${id}&estado=eq.pendiente`;
  const pedido = fila.id_pedido ? `id_pedido=eq.${encodeURIComponent(fila.id_pedido)}&estado=eq.pendiente` : '';

  if (accion === 'rechazar') {
    // El motivo lo ve el cliente (ventana de la tienda, "Consulta tus últimas recargas" y su perfil)
    const motivo = String(b.nota ?? '').replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (motivo.length < 5) return res.status(400).json({ status: 'error', message: 'Escribe el motivo del rechazo (lo verá el cliente).' });
    try {
      // La petición cifrada se queda (se borra con las resueltas, a los 7 días): "↩️ Me equivoqué" la devuelve a pendiente
      const cambiadas = await actualizar('pagos_solicitudes', soloPendiente, { estado: 'rechazado', resuelto: ahora, nota: motivo }, 'id');
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
      // La limpieza diaria pasa los pagos usados a "pagos_usados": también cuentan (2026-11-20: un pago de 780 Bs
      // dio dos recargas porque el cliente recargó con el pago real y después se soltó su solicitud sin referencia)
      const [usado] = (await leerDonde('pagos_usados', `referencia=like.*${fila.ultimos5}&usado=gt.${desde}`, 'referencia')) || [];
      if (usado) return res.status(409).json({ status: 'error', message: `Ya se usó un pago que termina en ${fila.ultimos5} (${usado.referencia}) en los últimos 3 días: casi seguro el cliente ya recargó con él. Revisa sus recargas; si de verdad es otro pago, escribe su referencia completa.` });
      const [hecha] = (await leerDonde('recargas', `referencia=eq.${fila.ultimos5}&estado=in.(completado,en_proceso)&id_pedido=neq.${encodeURIComponent(fila.id_pedido || '-')}&creado=gt.${desde}`, 'cuenta,paquete')) || [];
      if (hecha) return res.status(409).json({ status: 'error', message: `Ya hay una recarga hecha con la referencia …${fila.ultimos5} (${hecha.paquete}, ${hecha.cuenta}) en los últimos 3 días. Si es el mismo pago, ya se entregó: rechaza esta. Si es otro pago, escribe su referencia completa.` });
    } catch (error) {
      console.error('⚠️ pagos a mano: no se pudo revisar si el pago ya se usó:', error.message);
      return res.status(503).json({ status: 'error', message: 'No se pudo comprobar el pago. Intenta de nuevo o escribe la referencia completa.' });
    }
  } else {
    const otro = await otroFormato(fila.ultimos5, escrita, b.distinto === true);
    if (otro) return res.status(409).json(otro);
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

/**
 * Panel → Revisar pagos → Rechazados → "↩️ Me equivoqué" ({ id, accion: "deshacer", referencia?, monto? }).
 *   - Con la petición guardada (rechazos desde 2026-11-16 noche): la solicitud y el pedido vuelven a "pendiente"
 *     y aparece otra vez en Revisar pagos, para soltarla como siempre.
 *   - Sin ella (los rechazos de antes la borraban): solo Free Fire, Blood Strike y Mobile Legends. Se guarda el
 *     pago como USADO de ese pedido (la notificación real que llegue después no da otra recarga) y la recarga se
 *     pide a Central One con el ID y el paquete del pedido (revision.js → rehacerRevision, como "Hacer de nuevo").
 */
async function deshacerRechazo(req, res, fila, b) {
  if (fila.estado !== 'rechazado') return res.status(409).json({ status: 'error', message: `Esa solicitud está ${fila.estado}: solo se deshace un rechazo.` });
  const ahora = new Date().toISOString();
  const idPedido = fila.id_pedido ? encodeURIComponent(fila.id_pedido) : '';

  if (fila.datos) {
    let vuelta;
    try {
      vuelta = await actualizar('pagos_solicitudes', `id=eq.${fila.id}&estado=eq.rechazado`, { estado: 'pendiente', resuelto: null, nota: null }, 'id');
    } catch (error) {
      // Ya hay otra pendiente con esa referencia (una sola por referencia)
      if (/Supabase 409/.test(error.message)) return res.status(409).json({ status: 'error', message: 'Ya hay otra solicitud pendiente con esa referencia en Revisar pagos: resuelve esa primero.' });
      console.error('⚠️ pagos a mano: no se pudo deshacer:', error.message);
      return res.status(503).json({ status: 'error', message: 'No se pudo guardar. Intenta de nuevo.' });
    }
    if (!vuelta?.length) return res.status(409).json({ status: 'error', message: 'Esa solicitud ya no está rechazada.' });
    if (idPedido) {
      await actualizar('recargas', `id_pedido=eq.${idPedido}&estado=eq.problema`, { estado: 'pendiente', motivo_fallo: null, revisado: null, actualizado: ahora,
        nota_admin: `🖐️ Pago por verificar a mano (…${fila.ultimos5})` }).catch((error) => console.error('⚠️ pagos a mano: no se pudo reabrir el pedido:', error.message));
    }
    console.info(`🖐️ Rechazo de …${fila.ultimos5} deshecho: vuelve a Revisar pagos`);
    return res.status(200).json({ status: 'success', recarga: 'Volvió a "Revisar pagos": suéltala desde ahí.' });
  }

  // Sin la petición: recarga directa en Central One con el pedido guardado
  if (!['freefire', 'bloodstrike', 'mobilelegends'].includes(fila.juego) || !idPedido) {
    return res.status(409).json({ status: 'error', message: 'Este rechazo no guardó los datos del pedido: hazle la recarga a mano y márcala entregada en Pedidos.' });
  }
  const escrita = String(b.referencia ?? '').replace(/\D/g, '');
  const monto = limpiarMontoVES(String(b.monto ?? ''));
  if (escrita && (!/^\d{6,30}$/.test(escrita) || !escrita.endsWith(fila.ultimos5))) return res.status(400).json({ status: 'error', message: `La referencia completa debe terminar en ${fila.ultimos5} (o déjala vacía).` });
  // pide: "monto" → el panel pregunta el monto (y la referencia) y vuelve a llamar
  if (!(monto > 0)) return res.status(400).json({ status: 'error', pide: 'monto', monto: Number(fila.monto) || 0, message: 'Escribe el monto que llegó, en Bs.' });
  const desde = new Date(Date.now() - 3 * 864e5).toISOString();
  if (!escrita) {
    const [soltada] = (await leerDonde('pagos_solicitudes', `ultimos5=eq.${fila.ultimos5}&estado=eq.aprobado&id=neq.${fila.id}&resuelto=gt.${desde}`, 'id').catch(() => [])) || [];
    if (soltada) return res.status(409).json({ status: 'error', message: `Ya soltaste otro pago que termina en ${fila.ultimos5}. Para este, escribe su referencia completa del banco.` });
    const [llego] = (await leerDonde('pagos', `referencia=like.*${fila.ultimos5}&recibido=gt.${desde}`, 'estado').catch(() => [])) || [];
    if (llego) return res.status(409).json({ status: 'error', message: `Ya llegó un pago que termina en ${fila.ultimos5} (está "${llego.estado}"). Si es el mismo, escribe su referencia completa; si es otro, la de este.` });
  } else {
    const otro = await otroFormato(fila.ultimos5, escrita, b.distinto === true);
    if (otro) return res.status(409).json(otro);
  }
  const referencia = escrita || `000${Date.now()}${fila.ultimos5}`;

  // 1. La solicitud pasa a soltada (solo si sigue rechazada: dos clics no lo hacen dos veces)
  const tomada = await actualizar('pagos_solicitudes', `id=eq.${fila.id}&estado=eq.rechazado`,
    { estado: 'aprobado', resuelto: ahora, referencia, nota: escrita ? null : 'sin_ref', recargada: ahora }, 'id').catch(() => null);
  if (!tomada?.length) return res.status(409).json({ status: 'error', message: 'Esa solicitud ya no está rechazada.' });
  // 2. El pago queda USADO por este pedido (si ya llegó libre con esa referencia, se usa ese)
  const [existente] = escrita ? ((await leer('pagos', { referencia }, 'estado').catch(() => [])) || []) : [];
  try {
    if (existente?.estado === 'verificado') {
      await actualizar('pagos', `referencia=eq.${referencia}&estado=eq.verificado`, { estado: 'usado', usado: ahora, id_pedido: fila.id_pedido, juego: fila.juego });
    } else if (!existente) {
      await guardar('pagos', { referencia, monto: Math.round(monto * 100) / 100, monto_texto: formatearVES(monto), origen: 'manual',
        nota: `Soltado a mano tras deshacer un rechazo (${fila.juego})`, estado: 'usado', usado: ahora, id_pedido: fila.id_pedido, juego: fila.juego });
    } else {
      throw new Error(`esa referencia ya está registrada (${existente.estado})`);
    }
  } catch (error) {
    await actualizar('pagos_solicitudes', `id=eq.${fila.id}&estado=eq.aprobado`, { estado: 'rechazado', referencia: null, recargada: null }).catch(() => {});
    console.error('⚠️ pagos a mano: no se pudo guardar el pago al deshacer:', error.message);
    return res.status(409).json({ status: 'error', message: `No se pudo guardar el pago: ${/registrada/.test(error.message) ? error.message : 'intenta de nuevo'}.` });
  }
  // 3. El pedido a Revisión (para que "Hacer de nuevo" lo acepte) y se pide a Central One
  await actualizar('recargas', `id_pedido=eq.${idPedido}`, { estado: 'en_revision', motivo_fallo: null, revisado: null, actualizado: ahora,
    nota_admin: `🖐️ Pago …${fila.ultimos5} soltado (se había rechazado por error)` }).catch(() => {});
  const { rehacerRevision } = await import('./revision.js');
  const r = respuestaFalsa();
  try {
    await rehacerRevision({ method: 'POST', headers: req.headers, body: { idPedido: fila.id_pedido } }, r);
  } catch (error) {
    console.error('🚨 pagos a mano: falló la recarga al deshacer:', error.message);
    r.cuerpo = { status: 'error', message: 'La recarga dio un error inesperado.' };
  }
  console.info(`🖐️ Rechazo de …${fila.ultimos5} deshecho: recarga directa (${r.cuerpo?.status})`);
  const ok = r.cuerpo?.status === 'success';
  return res.status(200).json({ status: 'success', recarga: ok ? '✅ Recarga pedida a Central One: pasa sola a "Entregada".'
    : `⚠️ El pago quedó guardado, pero la recarga no salió: ${String(r.cuerpo?.message || 'sin detalle').slice(0, 200)} Está en Revisión: usa "Hacer de nuevo".` });
}
