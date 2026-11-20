// =========================================================================
// STOCK LIMITADO Y PEDIDOS EN ESPERA (desde 2026-11-20; supabase/secciones.sql)
//
// Productos de Central One con unidades contadas (centralone_catalogo.stock, p. ej. los tokens Evo de Free Fire):
//   1. La tienda muestra "Quedan X" y "Agotado" con MARGEN_STOCK o menos (otros revendedores compran del mismo stock).
//   2. apartar (POST /api/juego?juego=freefire&accion=apartar { paquete, clave }): al ir a pagar, el cliente aparta
//      una unidad 10 min (precios_apartar). Si no quedan, la página no le deja pagar.
//   3. Si aun así se agota con el pago ya verificado, la compra (juegos/freefire.js) llama a guardarEspera: el pedido
//      queda "esperando" y revisarEsperas (cada minuto, desde el tic del Worker del juego) lo entrega cuando Central
//      One repone. A las 24 h, "vencido": el administrador decide en el panel (devolver el dinero o cambiarlo por
//      diamantes con cambiarEspera).
// El catálogo de los productos limitados se relee cada minuto mientras haya alguno a la venta o algo esperando.
// =========================================================================
import { createHash } from 'node:crypto';
import { supabaseActivo, rpc, guardar, leerDonde, actualizar, esAdminToken } from './supabase.js';
import { obtenerIp, permitirUso } from './limitador.js';
import { entregarPaquete } from './entrega.js';
import { actualizarCatalogo } from './precios.js';
import { tokenDe } from './historial.js';

export const MARGEN_STOCK = 2;
export const MINUTOS_APARTADO = 10;
const ESPERA_HORAS = 24;
const CLAVE = /^[A-Za-z0-9_-]{16,64}$/;
const huellaIp = (ip) => createHash('sha256').update(`apartar:${ip}`).digest('hex').slice(0, 24);

/** Cuántos le quedan a la tienda de un paquete con stock contado (stock − margen − apartados); null = sin límite. */
export function quedanDe(fila) {
  if (fila.stock === null || fila.stock === undefined || !fila.producto) return null;
  return Math.max(0, (fila.en_stock ? Number(fila.stock) : 0) - MARGEN_STOCK - (Number(fila.apartados) || 0));
}

// ------------------------------------------------------------------ 2. apartar
export async function apartar(req, res, juego) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ status: 'error', message: 'Método no permitido' });
  const paquete = String(req.body?.paquete || '').trim().slice(0, 80);
  const clave = String(req.body?.clave || '');
  if (!paquete || !CLAVE.test(clave)) return res.status(400).json({ status: 'error', message: 'Recarga la página e intenta de nuevo.' });
  if (!supabaseActivo()) return res.status(200).json({ status: 'success', limitado: false });
  const ip = obtenerIp(req);
  const minutos = await permitirUso(`apartar:${ip}`);
  if (minutos > 0) return res.status(429).json({ status: 'error', message: `Demasiados intentos. Espera ${minutos} minutos.` });
  try {
    const r = await rpc('precios_apartar', { p_juego: juego, p_paquete: paquete, p_clave: clave, p_ip: huellaIp(ip), p_minutos: MINUTOS_APARTADO, p_margen: MARGEN_STOCK });
    if (r?.ok) return res.status(200).json({ status: 'success', limitado: !!r.limitado, hasta: r.hasta || null, quedan: r.quedan ?? null });
    const mensajes = {
      agotado: '😕 Se agotó justo ahora. Vuelve en un rato: Central One repone seguido.',
      muchos: 'Ya tienes 2 productos apartados. Paga uno o espera a que venzan (10 minutos).',
      no_existe: 'Ese paquete ya no está a la venta. Recarga la página.',
    };
    return res.status(409).json({ status: 'error', agotado: r?.motivo === 'agotado', message: mensajes[r?.motivo] || 'No se pudo apartar. Intenta de nuevo.' });
  } catch (error) {
    // Si Supabase no responde, se deja pagar: si se agota, el pedido queda en espera (no se pierde)
    console.error('⚠️ apartar:', error.message);
    return res.status(200).json({ status: 'success', limitado: false, sinApartar: true });
  }
}

/** La compra usa el apartado de la pestaña (no frena nada si falla). */
export function usarApartado(clave) {
  if (!CLAVE.test(String(clave || '')) || !supabaseActivo()) return;
  rpc('precios_usar_apartado', { p_clave: clave }).catch((error) => console.error('⚠️ apartado no marcado como usado:', error.message));
}

// ------------------------------------------------------------------ 3. espera
/** Deja el pedido esperando stock. true si se guardó (si no, la compra lo manda a revisión como siempre). */
export async function guardarEspera({ idPedido, juego, paquete, idJugador, referencias, monto }) {
  if (!supabaseActivo()) return false;
  try {
    await guardar('pedidos_espera', {
      id_pedido: idPedido, juego, paquete, id_jugador: String(idJugador), referencias: String(referencias || '').slice(0, 120),
      monto: Number.isFinite(Number(monto)) ? Number(monto) : null, vence: new Date(Date.now() + ESPERA_HORAS * 3600_000).toISOString(),
      estado: 'esperando', nota: 'Sin stock en Central One al momento de la compra',
    }, 'id_pedido');
    return true;
  } catch (error) {
    console.error(`❌ espera: no se pudo guardar el pedido ${idPedido}:`, error.message);
    return false;
  }
}

// Cada minuto (tic): relee el stock de lo limitado y entrega lo que espera. Nunca lanza.
const ultimaLectura = new Map();
export async function revisarEsperas(limite) {
  if (!supabaseActivo()) return { entregadas: 0 };
  let entregadas = 0;
  try {
    const vencidas = await rpc('esperas_vencer', {});
    if (vencidas > 0) console.warn(`⏰ espera: ${vencidas} pedido(s) pasaron 24 h sin stock (decidir en el panel → Precios)`);
    const esperando = (await leerDonde('pedidos_espera', 'estado=in.(esperando,entregando)&order=creado.asc&limit=20',
      'id_pedido,juego,paquete,id_jugador,estado,intento,actualizado')) || [];
    // Juegos con algo limitado a la venta o esperando: su catálogo se relee (máximo una vez por minuto)
    const juegos = new Set(esperando.map((e) => e.juego));
    const limitados = (await rpc('precios_juegos_limitados', {}).catch(() => null)) || [];
    for (const j of limitados) juegos.add(typeof j === 'string' ? j : j.precios_juegos_limitados);
    for (const juego of juegos) {
      if (Date.now() - (ultimaLectura.get(juego) || 0) < 55_000) continue;
      ultimaLectura.set(juego, Date.now());
      await actualizarCatalogo(juego).catch((error) => console.warn(`⚠️ espera: no se pudo releer el catálogo de ${juego}:`, error.message));
    }
    if (!esperando.length) return { entregadas };
    // ¿Qué productos tienen stock ahora?
    for (const e of esperando) {
      if (Date.now() > limite - 15_000) break;
      if (e.estado === 'entregando' && Date.now() - Date.parse(e.actualizado) < 10 * 60_000) continue;
      const fila = (await leerDonde('precios', `juego=eq.${e.juego}&paquete=eq.${encodeURIComponent(e.paquete)}`, 'producto')) || [];
      const producto = fila[0] && fila[0].producto;
      if (!producto) continue;
      const cat = (await leerDonde('centralone_catalogo', `producto=eq.${producto}`, 'en_stock,stock')) || [];
      if (!cat[0] || !cat[0].en_stock || (cat[0].stock !== null && cat[0].stock <= 0)) continue;
      const tomado = await rpc('espera_tomar', { p_id: e.id_pedido });
      if (!Array.isArray(tomado) || !tomado.length) continue;
      const intento = (Number(e.intento) || 0) + 1;
      const r = await entregarPaquete({
        juego: e.juego, paquete: e.paquete, idJugador: e.id_jugador, idPedido: `${e.id_pedido}-r${intento}`, idFila: e.id_pedido,
        soloEstado: true, catalogoFresco: true, tiempoMs: 12_000, nota: 'Pedido en espera: volvió el stock',
      });
      if (r.estado === 'entregado' || r.estado === 'en_proceso') {
        entregadas++;
        await rpc('espera_fin', { p_id: e.id_pedido, p_estado: 'entregado', p_nota: `Entregado al volver el stock (${(r.ordenes || []).map((o) => o.referencia).join(', ')})`, p_intento: intento }).catch(() => {});
        console.info(`📦 espera: ${e.id_pedido} (${e.paquete} → ${e.id_jugador}) entregado al volver el stock`);
      } else {
        // Sin stock otra vez, rechazo o duda: sigue esperando (la próxima vez con otra Idempotency-Key)
        await rpc('espera_fin', { p_id: e.id_pedido, p_estado: 'esperando', p_nota: `Intento ${intento}: ${r.motivo || r.estado}`, p_intento: r.estado === 'no_disponible' ? intento - 1 : intento }).catch(() => {});
        if (r.estado === 'incierto') console.error(`❌ espera: ${e.id_pedido} quedó INCIERTO en Central One (revisar antes de repetir): ${r.motivo}`);
      }
    }
  } catch (error) {
    console.error('⚠️ espera: no se pudieron revisar los pedidos en espera:', error.message);
  }
  return { entregadas };
}

// ------------------------------------------------------------------ panel: cambiar por diamantes
// POST /api/juego?accion=espera_cambiar { idPedido, paquete } (solo administrador): entrega ese paquete en lugar del
// que no llegó (el pedido queda "cambiado"). El precio no se revisa: lo decide el administrador.
export async function cambiarEspera(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ status: 'error', message: 'Método no permitido' });
  if (!(await esAdminToken(tokenDe(req)))) return res.status(403).json({ status: 'error', message: 'Solo el administrador.' });
  const idPedido = String(req.body?.idPedido || '');
  const paquete = String(req.body?.paquete || '').trim().slice(0, 80);
  if (!/^[A-Za-z0-9-]{8,80}$/.test(idPedido) || !paquete) return res.status(400).json({ status: 'error', message: 'Datos incompletos.' });
  const filas = (await leerDonde('pedidos_espera', `id_pedido=eq.${encodeURIComponent(idPedido)}`, '*')) || [];
  const e = filas[0];
  if (!e || !['esperando', 'vencido'].includes(e.estado)) return res.status(409).json({ status: 'error', message: 'Ese pedido ya no está esperando.' });
  const tomado = await rpc('espera_tomar', { p_id: idPedido }).catch(() => null);
  if (e.estado === 'esperando' && (!Array.isArray(tomado) || !tomado.length)) return res.status(409).json({ status: 'error', message: 'Ese pedido se está entregando ahora mismo.' });
  if (e.estado === 'vencido') await actualizar('pedidos_espera', `id_pedido=eq.${encodeURIComponent(idPedido)}&estado=eq.vencido`, { estado: 'entregando', actualizado: new Date().toISOString() });
  const r = await entregarPaquete({
    juego: e.juego, paquete, idJugador: e.id_jugador, idPedido: `${idPedido}-c`, idFila: idPedido, soloEstado: true,
    tiempoMs: 20_000, nota: `Cambio: ${paquete} en lugar de ${e.paquete} (sin stock)`,
  });
  if (r.estado === 'entregado' || r.estado === 'en_proceso') {
    await rpc('espera_fin', { p_id: idPedido, p_estado: 'cambiado', p_nota: `Cambiado por ${paquete}`, p_intento: e.intento }).catch(() => {});
    await actualizar('recargas', `id_pedido=eq.${encodeURIComponent(idPedido)}`, { paquete: `${paquete} (en vez de ${e.paquete})`.slice(0, 80) }).catch(() => {});
    return res.status(200).json({ status: 'success', message: `✅ Se entregó ${paquete} al ID ${e.id_jugador}.` });
  }
  await rpc('espera_fin', { p_id: idPedido, p_estado: e.estado === 'vencido' ? 'vencido' : 'esperando', p_nota: `Cambio fallido: ${r.motivo || r.estado}`, p_intento: e.intento }).catch(() => {});
  return res.status(502).json({ status: 'error', message: `No se pudo entregar ${paquete}: ${r.errorCliente || r.motivo || r.estado}` });
}

/**
 * Central One aceptó el pedido y después avisó que falló por falta de stock (webhook): si es un producto de stock
 * contado de Free Fire, el pedido pasa a esperar stock (el pago ya quedó usado con la compra). Nunca lanza.
 */
export async function esperarSiLimitado(idPedido) {
  try {
    const filas = (await leerDonde('recargas', `id_pedido=eq.${encodeURIComponent(idPedido)}`, 'juego,paquete,id_jugador,referencia,precio')) || [];
    const r = filas[0];
    if (!r || r.juego !== 'freefire' || !r.id_jugador) return false;
    const paq = (await leerDonde('precios', `juego=eq.freefire&paquete=eq.${encodeURIComponent(r.paquete)}`, 'producto')) || [];
    if (!paq[0] || !paq[0].producto) return false;
    const cat = (await leerDonde('centralone_catalogo', `producto=eq.${paq[0].producto}`, 'stock')) || [];
    if (!cat[0] || cat[0].stock === null) return false;
    const ok = await guardarEspera({ idPedido, juego: 'freefire', paquete: r.paquete, idJugador: r.id_jugador, referencias: r.referencia, monto: r.precio });
    if (ok) console.warn(`⏳ espera: ${idPedido} (${r.paquete}) falló por falta de stock en Central One: queda esperando stock`);
    return ok;
  } catch (error) {
    console.error(`⚠️ espera: no se pudo dejar en espera ${idPedido}:`, error.message);
    return false;
  }
}
