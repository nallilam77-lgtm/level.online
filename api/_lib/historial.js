// PEDIDOS EN SUPABASE (tabla "recargas" de supabase/levelup.sql; supabase/tienda.sql la abre a todos).
// Desde 2026-11-13 se guardan TODOS los pedidos: con sesión iniciada (Google) la fila lleva el usuario y
// sale en su perfil; sin sesión, usuario vacío (sirve para "Consulta tus últimas recargas", el contador
// del inicio y el panel admin). La página manda el token en la cabecera Authorization de /api/recargar
// (public/js/sesion.js).
//
// Cómo se arma la fila sin tocar cada tienda:
//   1. api/recargar.js corre la recarga dentro de conHistorial() y mira la respuesta (res.json).
//   2. Cuando la tienda ENCUENTRA el pago llama a anotarRecarga (_lib/fidelidad.js), que deja aquí los
//      datos del pedido (anotarEnHistorial).
//   3. Con la respuesta ya enviada, se guarda la fila con su estado (waitUntil: nunca frena la recarga).
//   Completar un pago insuficiente (tokenComplemento) actualiza la fila de ese pedido por la huella de la clave.
// Después el estado cambia solo: el webhook de Central One (actualizarEstado) y, en las tiendas manuales,
// la acción "estado" que consulta la hoja. El perfil lo recibe en vivo (Realtime).
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import { supabaseActivo, guardar, actualizar, leer, usuarioDelToken } from './supabase.js';
import { limpiarMontoVES } from './recarga-comun.js';

const MANUALES = new Set(['fcmobile', 'codmobile', 'clashroyale']);
export const ESTADOS = ['pendiente', 'en_proceso', 'completado', 'incompleto', 'en_revision', 'problema', 'reembolsado'];

const contexto = new AsyncLocalStorage();
const huella = (texto) => createHash('sha256').update(String(texto)).digest('hex');
const corto = (texto, max = 120) => String(texto ?? '').slice(0, max);

export function tokenDe(req) {
  const m = String(req.headers?.authorization || '').match(/^Bearer\s+(\S+)$/i);
  return m ? m[1] : '';
}

/**
 * Promesa con el UUID del cliente con sesión de ESTA recarga (o null sin sesión). La usa el premio de
 * cliente fiel (_lib/fidelidad.js), que se cuenta por cuenta de Level Up, no por ID del juego.
 */
export function usuarioActual() {
  return contexto.getStore()?.usuario || Promise.resolve(null);
}

/** La tienda encontró el pago: datos del pedido para el historial (lo llama anotarRecarga). */
export function anotarEnHistorial(datos) {
  const ctx = contexto.getStore();
  if (ctx) ctx.pedido = datos;
}

// Estado según lo que se le respondió al cliente
function estadoDeRespuesta(juego, cuerpo) {
  if (cuerpo?.insuficiente) return 'incompleto';
  // Central One aceptó el pedido pero no confirmó la entrega: "en proceso" hasta el webhook (que lo pasa a
  // "completado"; recién ahí el disparador de Supabase da las fichas del minijuego)
  if (cuerpo?.status === 'success' && cuerpo.entrega === 'en_camino') return 'en_proceso';
  if (cuerpo?.status === 'success') return MANUALES.has(juego) ? 'pendiente' : 'completado';
  return 'en_revision';
}

function cuentaVisible(juego, cuenta, body) {
  if (MANUALES.has(juego)) {
    const tel = String(body?.telefono || '').replace(/\D/g, '').replace(/^58/, '').replace(/^0/, '');
    return { cuenta: tel.length === 10 ? `WhatsApp +58 ${tel.slice(0, 3)}-${tel.slice(3)}` : 'Recarga manual' };
  }
  if (juego === 'roblox') return { cuenta: `Usuario ${corto(cuenta, 40)}`, id_jugador: corto(cuenta, 40) };
  if (juego === 'mobilelegends') {
    const [id, zona] = String(cuenta).split(':');
    return { cuenta: `ID ${corto(id, 20)} (${corto(zona, 10)})`, id_jugador: corto(id, 20), zona: corto(zona, 10) };
  }
  return { cuenta: `ID ${corto(cuenta, 30)}`, id_jugador: corto(cuenta, 30) };
}

async function guardarFila({ usuario: promesaUsuario, juego, body, pedido, respuesta }) {
  const usuario = await promesaUsuario;   // null sin sesión: el pedido se guarda igual, sin dueño
  const cuerpo = respuesta.cuerpo || {};
  const referencia = String(body?.referencia ?? '').replace(/\D/g, '');
  const precio = typeof pedido.precio === 'number' ? pedido.precio : limpiarMontoVES(cuerpo.precio || pedido.precio || '');
  await guardar('recargas', {
    id_pedido: corto(pedido.idPedido, 80), usuario, juego,
    ...cuentaVisible(juego, pedido.cuenta, body),
    paquete: corto(pedido.paquete, 80),
    precio: Number.isFinite(precio) && precio > 0 ? Math.round(precio * 100) / 100 : null,
    referencia: referencia ? referencia.slice(-6) : null,
    estado: estadoDeRespuesta(juego, cuerpo),
    codigo: juego === 'roblox' && cuerpo.code ? corto(cuerpo.code, 80) : null,
    clave_hash: cuerpo.tokenComplemento ? huella(cuerpo.tokenComplemento) : null,
    actualizado: new Date().toISOString(),
  }, 'id_pedido');
}

// Pago completado con la clave del pago insuficiente: misma fila, estado nuevo
async function completarFila({ clave, respuesta }) {
  const cuerpo = respuesta.cuerpo || {};
  const estado = cuerpo.status === 'success' ? 'completado' : respuesta.codigo === 202 ? 'en_revision' : null;
  if (!estado) return; // clave o referencia rechazada: el pedido sigue "incompleto"
  await actualizar('recargas', `clave_hash=eq.${huella(clave)}`, {
    estado, actualizado: new Date().toISOString(), ...(cuerpo.code && { codigo: corto(cuerpo.code, 80) }),
  });
}

/**
 * api/recargar.js: corre la recarga (fn) mirando qué se le responde al cliente y guarda el pedido después
 * de responder (con su usuario si hay sesión).
 */
export async function conHistorial(req, res, juego, fn) {
  if (!supabaseActivo()) return fn();
  const token = tokenDe(req);
  // El usuario se averigua en paralelo con la recarga (no la frena); fidelidad.js lo espera solo si hace falta
  const ctx = { pedido: null, usuario: token ? usuarioDelToken(token) : Promise.resolve(null) };
  const respuesta = { codigo: 0, cuerpo: null };
  const jsonOriginal = res.json.bind(res);
  res.json = (cuerpo) => { respuesta.codigo = res.statusCode; respuesta.cuerpo = cuerpo; return jsonOriginal(cuerpo); };
  try {
    return await contexto.run(ctx, fn);
  } finally {
    const body = req.body || {};
    const clave = typeof body.tokenComplemento === 'string' ? body.tokenComplemento : '';
    const tarea = ctx.pedido ? guardarFila({ usuario: ctx.usuario, juego, body, pedido: ctx.pedido, respuesta })
      : clave && respuesta.cuerpo ? completarFila({ clave, respuesta }) : null;
    if (tarea) waitUntil(tarea.catch((error) => console.error(`⚠️ historial: no se pudo guardar la recarga (${juego}):`, error.message)));
  }
}

/**
 * Estado nuevo de un pedido (webhook de Central One, hoja de las manuales). Sin fila, no hace nada.
 * noPisar: estados que este aviso NO puede cambiar (un paquete partido en dos pedidos: que una mitad se
 * entregue no tapa que la otra falló).
 */
// Esperas antes de volver a buscar la fila de un aviso que llegó antes que el pedido (ver actualizarEstado).
// Suman 18 s: caben en los 30 s de maxDuration del webhook.
const ESPERAS_FILA_MS = [3000, 6000, 9000];
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

export function actualizarEstado(idPedido, estado, { noPisar = [] } = {}) {
  if (!supabaseActivo() || !ESTADOS.includes(estado) || !/^[A-Za-z0-9-]{8,80}$/.test(String(idPedido || ''))) return;
  const intactos = [estado, ...noPisar.filter((e) => ESTADOS.includes(e))];
  const id = encodeURIComponent(idPedido);
  // Central One puede confirmar la entrega ANTES de que se guarde la fila del pedido (se guarda después de
  // responder al cliente). Si no cambió ninguna fila y el pedido todavía no existe, se espera y se repite:
  // si no, la fila nacía "en_proceso" y se quedaba así para siempre (y sin fichas del minijuego).
  waitUntil((async () => {
    for (let intento = 0; intento <= ESPERAS_FILA_MS.length; intento++) {
      if (intento) await esperar(ESPERAS_FILA_MS[intento - 1]);
      const cambiadas = await actualizar('recargas', `id_pedido=eq.${id}&estado=not.in.(${intactos.join(',')})`,
        { estado, actualizado: new Date().toISOString() }, 'id_pedido');
      if (Array.isArray(cambiadas) && cambiadas.length) return;
      // No cambió nada: o ya tenía ese estado (listo) o la fila todavía no existe (se espera)
      const existe = await leer('recargas', { id_pedido: idPedido }, 'id_pedido');
      if (Array.isArray(existe) && existe.length) return;
    }
    console.error(`⚠️ historial: el pedido ${idPedido} no apareció en Supabase para anotarle "${estado}"`);
  })().catch((error) => console.error('⚠️ historial: no se pudo actualizar el estado:', error.message)));
}
