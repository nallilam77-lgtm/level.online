// =========================================================================
// CÓDIGOS DE REGALO (desde 2026-11-15; supabase/canjes.sql, página public/canjear.html)
//   POST /api/juego?accion=canjear { codigo, id }  → el PRIMERO que canjea el código se lleva el premio
//   GET  /api/juego?accion=canjes                   → últimos canjes (nombre, ID tapado, cuándo) y cuántos quedan
// El administrador crea los códigos en admin.html → Canjes (admin_canjes_crear).
//
// Orden (nada se gasta a ciegas):
//   1. Formato y límite de intentos por IP (adivinar códigos bloquea la IP como con las referencias).
//   2. Se valida el ID en Free Fire (el mismo validador de la tienda) y se toma el nombre del jugador.
//   3. canje_tomar: el código se marca en UN paso; si dos personas lo canjean a la vez, solo una lo toma.
//   4. Se pide la recarga a Central One con Idempotency-Key "ff-<idPedido>" (el webhook la reconoce como
//      Free Fire y actualiza la recarga) y se guarda en "recargas" (Panel → Pedidos/Revisión, precio vacío).
//   5. Rechazo de Central One (no cobró) → canje_liberar: el código vuelve a quedar libre.
//      Incierto (pudo crearse) → el código queda "revisar" y la recarga en Revisión.
// =========================================================================
import { randomUUID } from 'node:crypto';
import { supabaseActivo, rpc, guardar } from './supabase.js';
import { llamarScript, LECTURA_APPS_SCRIPT, conCache } from './externo.js';
import { datosParaPedido, crearPedidoCentralOne } from './centralone.js';
import { obtenerIp, minutosBloqueado, registrarFallo } from './limitador.js';
import { anotarIncidencia } from './incidencias.js';

const PRODUCTO = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_DISPONIBLE = 'Los canjes no están disponibles en este momento. Tu código sigue libre: intenta más tarde.';

// "lu abcd efgh", "LUABCDEFGH" o "LU-ABCD-EFGH" → "LU-ABCD-EFGH" (o '' si no tiene la forma)
function normalizarCodigo(texto) {
  const t = String(texto || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const m = t.match(/^LU([A-Z0-9]{4})([A-Z0-9]{4})$/);
  return m ? `LU-${m[1]}-${m[2]}` : '';
}

// Producto(s) de Central One del paquete (220 = dos de 110), como lo vende hoy la tienda
async function productosDe(paquete) {
  const filas = await rpc('precios_de', { p_juego: 'freefire' });
  const f = (Array.isArray(filas) ? filas : []).find((x) => String(x.paquete).trim() === String(paquete).trim());
  if (!f || !PRODUCTO.test(String(f.producto || ''))) return [];
  return Array(Math.max(1, Math.min(9, Number(f.cantidad) || 1))).fill(String(f.producto).toLowerCase());
}

export async function canjear(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ status: 'error', message: 'Método no permitido' });
  const codigo = normalizarCodigo(req.body?.codigo);
  const id = String(req.body?.id ?? '').trim();
  if (!codigo) return res.status(400).json({ status: 'error', message: 'Escribe el código completo, por ejemplo LU-ABCD-EFGH.' });
  if (!/^\d{5,15}$/.test(id)) return res.status(400).json({ status: 'error', message: 'Escribe tu ID de Free Fire (solo números).' });

  const apiKey = String(process.env.freefire_nuevo || '').trim();
  const urlValidador = String(process.env.SCRIPT_VALIDADOR_URL || '').trim();
  if (!supabaseActivo() || !apiKey || !urlValidador) {
    console.error('🚨 canjes: falta Supabase, freefire_nuevo o SCRIPT_VALIDADOR_URL en Vercel');
    return res.status(503).json({ status: 'error', message: NO_DISPONIBLE });
  }

  // 1. Quien prueba códigos al azar queda bloqueado (los mismos límites que la tienda)
  const ip = obtenerIp(req);
  const claves = [`ip:${ip}`, `canje:${ip}`];
  const minutos = await minutosBloqueado(claves);
  if (minutos > 0) return res.status(429).json({ status: 'error', message: `Demasiados intentos. Espera ${minutos} minutos.` });

  // 2. El ID existe en Free Fire (y su nombre, que se muestra en la lista de canjes)
  let nombre = '';
  try {
    const v = await llamarScript(urlValidador, { id, juego: 'freefire' }, LECTURA_APPS_SCRIPT);
    if (v?.valid !== true) {
      return res.status(400).json({ status: 'error', message: '❌ Ese ID no existe en Free Fire (servidor LATAM). Revísalo y vuelve a intentar.' });
    }
    nombre = String(v.player_name || '').replace(/[<>]/g, '').trim().slice(0, 40);
  } catch (error) {
    console.error('⚠️ canjes: el validador no respondió:', error.message);
    return res.status(503).json({ status: 'error', message: 'No pudimos comprobar tu ID ahora. Tu código sigue libre: intenta en un minuto.' });
  }

  // 3. Tomar el código (solo uno gana)
  const idPedido = randomUUID();
  let toma;
  try {
    toma = await rpc('canje_tomar', { p_codigo: codigo, p_id_jugador: id, p_nombre: nombre, p_id_pedido: idPedido });
  } catch (error) {
    console.error('⚠️ canjes: Supabase no respondió al tomar el código:', error.message);
    return res.status(503).json({ status: 'error', message: NO_DISPONIBLE });
  }
  if (!toma?.ok) {
    if (toma?.motivo === 'no_existe') {
      await registrarFallo(claves).catch(() => {});
      return res.status(404).json({ status: 'error', message: '❌ Ese código no existe. Revisa que esté bien escrito.' });
    }
    return res.status(409).json({ status: 'error', message: '😕 Llegaste tarde: ese código ya lo canjeó otra persona.' });
  }
  const paquete = String(toma.paquete || '110 Diamantes');
  const liberar = () => rpc('canje_liberar', { p_codigo: codigo, p_id_pedido: idPedido })
    .catch((error) => console.error(`🚨 canjes: no se pudo liberar ${codigo} (queda tomado, liberarlo a mano):`, error.message));

  // 4. Pedido a Central One
  let productos;
  let datos;
  try {
    productos = await productosDe(paquete);
    datos = productos.length ? await datosParaPedido({ apiKey, productId: productos[0], idJugador: id }) : { error: `"${paquete}" no tiene producto de Central One en Precios` };
  } catch (error) {
    datos = { error: error.message };
  }
  if (datos.error) {
    console.error(`⚠️ canjes: no se puede pedir ${paquete} (${datos.error}); ${codigo} vuelve a quedar libre`);
    await liberar();
    return res.status(503).json({ status: 'error', message: NO_DISPONIBLE });
  }

  const ordenes = [];
  let falla = null;
  for (let i = 0; i < productos.length && !falla; i++) {
    const r = await crearPedidoCentralOne({
      apiKey, productId: productos[i], payload: datos.payload,
      idempotencia: `ff-${idPedido}${productos.length > 1 ? `-${i + 1}` : ''}`,
      nota: `Level Up ${idPedido} (canje ${codigo})${productos.length > 1 ? ` (${i + 1} de ${productos.length})` : ''}`,
      tiempoMs: Math.floor(16000 / productos.length),
    });
    if (r.tipo === 'ok') ordenes.push(r.orden); else falla = r;
  }

  const fila = (estado, nota) => guardar('recargas', {
    id_pedido: idPedido, usuario: null, juego: 'freefire', cuenta: `ID ${id}`, id_jugador: id, paquete,
    precio: null, referencia: null, estado, nota_admin: nota.slice(0, 500), actualizado: new Date().toISOString(),
  }, 'id_pedido').catch((error) => console.error(`⚠️ canjes: no se pudo guardar la recarga del canje ${codigo}:`, error.message));

  // 5. Resultado
  if (falla && !ordenes.length && falla.tipo === 'rechazo') {
    console.error(`⚠️ canjes: Central One rechazó ${codigo} para ${id}: ${falla.motivo}; el código vuelve a quedar libre`);
    await liberar();
    return res.status(400).json({ status: 'error', message: `❌ No se pudo recargar: ${falla.errorCliente || 'intenta más tarde'}. Tu código sigue libre.` });
  }
  if (falla) {
    // Incierto o un 220 a medias: lo revisa el administrador (Panel → Revisión: Verificar / Hacer de nuevo)
    console.error(`❌ canjes: ${codigo} para ${id} quedó por revisar: ${falla.motivo}`);
    await fila('en_revision', `🎁 Canje ${codigo} (${nombre || 'sin nombre'}): ${falla.motivo}`);
    anotarIncidencia(process.env.SCRIPT_RECARGAS_URL, {
      accion: 'registrar_error', idPedido, idJugador: id, paquete, referencia: codigo,
      fase: 'CANJE DE CÓDIGO DE REGALO (Central One)', motivo: falla.motivo, estadoPago: 'Sin pago: es un código de regalo',
    });
    await rpc('canje_estado', { p_codigo: codigo, p_id_pedido: idPedido, p_estado: 'revisar' }).catch(() => {});
    return res.status(202).json({ status: 'error', message: '⏳ Tu código es válido y tu recarga quedó en revisión. Te la entregamos pronto.' });
  }
  const entregada = ordenes.every((o) => /^(completed|delivered)$/i.test(o.status));
  await fila(entregada ? 'completado' : 'en_proceso', `🎁 Canje ${codigo} (${nombre || 'sin nombre'}): ${ordenes.map((o) => o.referencia).join(', ')}`);
  if (entregada) await rpc('canje_estado', { p_codigo: codigo, p_id_pedido: idPedido, p_estado: 'entregado' }).catch(() => {});
  console.info(`🎁 canjes: ${codigo} → ${paquete} para ${id} (${nombre}) · ${ordenes.map((o) => o.referencia).join(', ')}`);
  return res.status(200).json({ status: 'success', premio: paquete, nombre, message: `🎉 ¡Listo${nombre ? `, ${nombre}` : ''}! Tus ${paquete} van en camino a tu cuenta.` });
}

// Lista pública (canjear.html). 15 s en la CDN y en memoria: muchos miran a la vez cuando sale un código.
export async function canjesPublicos(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ status: 'error', message: 'Método no permitido' });
  if (!supabaseActivo()) return res.status(200).json({ status: 'success', libres: 0, canjes: [] });
  try {
    const { datos } = await conCache('canjes:publicos', async () => {
      const [canjes, libres] = await Promise.all([rpc('canjes_publicos', {}), rpc('canjes_libres', {})]);
      return { canjes: Array.isArray(canjes) ? canjes : [], libres: Number(libres) || 0 };
    }, { frescoMs: 10_000, respaldoMs: 5 * 60_000 });
    res.setHeader('Cache-Control', 'public, s-maxage=15');
    return res.status(200).json({ status: 'success', ...datos });
  } catch (error) {
    console.error('⚠️ canjes: no se pudo leer la lista:', error.message);
    return res.status(503).json({ status: 'error', message: 'No se pudo cargar la lista.' });
  }
}
