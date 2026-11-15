// =========================================================================
// REVISIÓN: dos botones del panel (admin.html → Revisión) para las recargas de Central One que quedaron
// "en revisión" o "con problema" (Free Fire, Blood Strike y Mobile Legends). Desde 2026-11-15.
//   POST /api/juego?accion=revision_verificar { idPedido }  → qué pedidos tiene Central One de esa recarga
//   POST /api/juego?accion=revision_rehacer   { idPedido }  → la vuelve a pedir a Central One
// Solo el administrador (esAdminToken). El pago de esa recarga ya está "usado": aquí no se toca.
//
// CÓMO SE EVITA ENTREGAR DOS VECES
// - Cada pedido a Central One lleva una Idempotency-Key: repetir la MISMA llave devuelve el mismo pedido y
//   no cobra otra vez (_lib/centralone.js). Las de la tienda: Free Fire "ff-<id>" (220 = "ff-<id>-1" y "-2"),
//   Mobile Legends "ml-<id>", Blood Strike "<id>".
// - Rehacer busca primero en Central One (GET /orders) los pedidos de esa recarga. Si alguno de una parte
//   está entregado o en camino, esa parte NO se vuelve a pedir.
// - Una parte sin pedido en Central One se pide con su llave ORIGINAL: si el pedido sí existía (y la lista
//   no lo mostró), Central One devuelve ese mismo pedido en vez de crear otro.
// - Solo si todos los pedidos de esa parte fallaron se usa una llave nueva "-r<N>" (otro pedido de verdad).
//   api/centralone-webhook.js reconoce esas llaves y actualiza la recarga igual.
// =========================================================================
import { leer, actualizar, rpc, esAdminToken, supabaseActivo } from './supabase.js';
import { tokenDe } from './historial.js';
import { datosParaPedido, crearPedidoCentralOne } from './centralone.js';

const URL_ORDENES = 'https://portal.centraloneglobal.com/api/v1/orders';
const ID_PEDIDO = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRODUCTO = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGINAS = 5;
// Estados de Central One con los que esa parte ya NO se puede volver a pedir (entregada o todavía en camino)
const FALLIDOS = new Set(['failed', 'cancelled', 'canceled', 'rejected', 'refunded']);
const ENTREGADOS = new Set(['completed', 'delivered']);

const JUEGOS = {
  freefire: { llave: () => process.env.freefire_nuevo, base: (id) => `ff-${id}` },
  bloodstrike: { llave: () => process.env.blood_nuevo, base: (id) => id },
  mobilelegends: { llave: () => process.env.mlbb_nuevo || process.env.blood_nuevo, base: (id) => `ml-${id}`, zona: true },
};

// Llave de la parte i (de n) en el intento r (0 = la original de la tienda)
const llaveDe = (juego, id, i, n, r = 0) => `${JUEGOS[juego].base(id)}${r ? `-r${r}` : ''}${n > 1 ? `-${i + 1}` : ''}`;

async function comun(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ status: 'error', message: 'Método no permitido' }); return null; }
  if (!supabaseActivo()) { res.status(503).json({ status: 'error', message: 'Supabase no está configurado.' }); return null; }
  if (!(await esAdminToken(tokenDe(req)))) { res.status(403).json({ status: 'error', message: 'Solo el administrador.' }); return null; }
  const idPedido = String(req.body?.idPedido || '').trim();
  if (!ID_PEDIDO.test(idPedido)) { res.status(400).json({ status: 'error', message: 'Pedido inválido.' }); return null; }
  const filas = await leer('recargas', { id_pedido: idPedido }, 'id_pedido,juego,paquete,id_jugador,zona,estado,nota_admin');
  const recarga = Array.isArray(filas) ? filas[0] : null;
  if (!recarga) { res.status(404).json({ status: 'error', message: 'No existe ese pedido.' }); return null; }
  if (!Object.hasOwn(JUEGOS, recarga.juego)) {
    res.status(400).json({ status: 'error', message: 'Esta tienda no recarga por Central One: hazla a mano.' });
    return null;
  }
  const apiKey = String(JUEGOS[recarga.juego].llave() || '').trim();
  if (!apiKey) { res.status(503).json({ status: 'error', message: 'Falta la llave de Central One de esta tienda en Vercel.' }); return null; }
  return { idPedido, recarga, apiKey };
}

// Pedidos de Central One de esta recarga (por su Idempotency-Key o por la nota "Level Up <id>"), de los
// más recientes de la cuenta. Lanza si Central One no responde (entonces no se rehace nada).
async function pedidosDe(apiKey, idPedido) {
  const encontrados = [];
  let cursor = '';
  for (let pagina = 0; pagina < PAGINAS; pagina++) {
    const url = `${URL_ORDENES}?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`Central One respondió ${r.status} al listar pedidos`);
    const d = await r.json();
    const lista = Array.isArray(d?.orders) ? d.orders : Array.isArray(d?.data) ? d.data : [];
    for (const o of lista) {
      if (!JSON.stringify(o).includes(idPedido)) continue;
      const falla = o.failure || (Array.isArray(o.items) ? (o.items.find((l) => l?.failure) || {}).failure : null);
      encontrados.push({
        referencia: String(o.reference_code || o.id || ''),
        estado: String(o.status || '').toLowerCase(),
        llave: String(o.idempotency_key || ''),
        nota: String(o.note || ''),
        fallo: falla?.code ? String(falla.code).slice(0, 40) : '',
        creado: String(o.created_at || ''),
      });
    }
    cursor = d?.next_cursor || d?.pagination?.next_cursor || d?.meta?.next_cursor || '';
    if (!cursor || !lista.length) break;
  }
  return encontrados;
}

// Producto(s) de Central One del paquete, como los vende hoy la tienda (precios_de)
async function productosDelPaquete(juego, paquete) {
  const filas = await rpc('precios_de', { p_juego: juego });
  const f = (Array.isArray(filas) ? filas : []).find((x) => String(x.paquete).trim() === String(paquete).trim());
  if (!f || !PRODUCTO.test(String(f.producto || ''))) return [];
  return Array(Math.max(1, Math.min(9, Number(f.cantidad) || 1))).fill(String(f.producto).toLowerCase());
}

// De qué parte (0..n-1) y de qué intento (0 = original, N = "-rN") es un pedido. null = no se sabe.
function parteDe(juego, idPedido, n, pedido) {
  for (let r = 0; r <= 9; r++) {
    for (let i = 0; i < n; i++) if (pedido.llave === llaveDe(juego, idPedido, i, n, r)) return { i, r };
  }
  // Sin llave en la lista: por la nota ("Level Up <id> (2 de 2)" · "(reintento 1)")
  const parte = pedido.nota.match(/\((\d) de (\d)\)/);
  const intento = pedido.nota.match(/reintento (\d)/);
  if (n === 1 || parte) return { i: parte ? Number(parte[1]) - 1 : 0, r: intento ? Number(intento[1]) : 0 };
  return null;
}

export async function verificarRevision(req, res) {
  const c = await comun(req, res);
  if (!c) return;
  let pedidos;
  try {
    pedidos = await pedidosDe(c.apiKey, c.idPedido);
  } catch (error) {
    console.error('⚠️ revisión: no se pudo leer Central One:', error.message);
    return res.status(503).json({ status: 'error', message: 'Central One no respondió. Intenta de nuevo en un minuto.' });
  }
  const partes = Math.max(1, (await productosDelPaquete(c.recarga.juego, c.recarga.paquete).catch(() => [])).length);
  const entregados = pedidos.filter((p) => ENTREGADOS.has(p.estado)).length;
  const enCamino = pedidos.filter((p) => !ENTREGADOS.has(p.estado) && !FALLIDOS.has(p.estado)).length;
  const resultado = !pedidos.length ? 'sin_pedido'
    : entregados >= partes ? 'entregada'
      : enCamino ? 'en_camino'
        : entregados ? 'en_parte' : 'fallida';
  return res.status(200).json({ status: 'success', resultado, partes, pedidos: pedidos.map(({ nota, ...p }) => p) });
}

export async function rehacerRevision(req, res) {
  const c = await comun(req, res);
  if (!c) return;
  const { idPedido, recarga, apiKey } = c;
  if (!['en_revision', 'problema'].includes(recarga.estado)) {
    return res.status(409).json({ status: 'error', message: `La recarga está "${recarga.estado}": solo se rehace una en revisión o con problema.` });
  }
  if (!recarga.id_jugador) return res.status(400).json({ status: 'error', message: 'La recarga no tiene ID de jugador guardado: hazla a mano.' });

  let productos;
  let pedidos;
  try {
    [productos, pedidos] = await Promise.all([productosDelPaquete(recarga.juego, recarga.paquete), pedidosDe(apiKey, idPedido)]);
  } catch (error) {
    console.error('⚠️ revisión: no se pudo preparar el rehacer:', error.message);
    return res.status(503).json({ status: 'error', message: 'Central One o Supabase no respondieron. No se pidió nada; intenta de nuevo.' });
  }
  if (!productos.length) return res.status(409).json({ status: 'error', message: `"${recarga.paquete}" ya no tiene producto de Central One en Precios: hazla a mano.` });
  const n = productos.length;

  // Qué partes faltan y con qué llave
  const porParte = Array.from({ length: n }, () => []);
  for (const p of pedidos) {
    const donde = parteDe(recarga.juego, idPedido, n, p);
    if (!donde) {
      // No se sabe de qué parte es: si no falló, no se arriesga nada
      if (!FALLIDOS.has(p.estado)) return res.status(409).json({ status: 'error', message: `Central One ya tiene el pedido ${p.referencia} (${p.estado}) de esta recarga. Usa "Verificar estado".` });
      continue;
    }
    porParte[donde.i].push({ ...p, intento: donde.r });
  }
  const pendientes = [];
  for (let i = 0; i < n; i++) {
    const vivos = porParte[i].filter((p) => !FALLIDOS.has(p.estado));
    if (vivos.length) continue;   // entregada o en camino: no se repite
    const intento = porParte[i].length ? Math.max(...porParte[i].map((p) => p.intento)) + 1 : 0;
    if (intento > 9) return res.status(409).json({ status: 'error', message: 'Ya se intentó demasiadas veces: hazla a mano.' });
    pendientes.push({ i, llave: llaveDe(recarga.juego, idPedido, i, n, intento), intento });
  }
  if (!pendientes.length) {
    return res.status(409).json({ status: 'error', message: 'Central One ya tiene esta recarga entregada o en camino: no se pidió otra vez. Usa "Verificar estado".' });
  }

  const datos = await datosParaPedido({ apiKey, productId: productos[0], idJugador: String(recarga.id_jugador), zona: JUEGOS[recarga.juego].zona ? String(recarga.zona || '') : '' });
  if (datos.error) return res.status(409).json({ status: 'error', message: `No se pidió nada: ${datos.error}` });

  const hechos = [];
  for (const p of pendientes) {
    const r = await crearPedidoCentralOne({
      apiKey, productId: productos[p.i], payload: datos.payload, idempotencia: p.llave, tiempoMs: 25000,
      nota: `Level Up ${idPedido}${n > 1 ? ` (${p.i + 1} de ${n})` : ''}${p.intento ? ` (reintento ${p.intento})` : ''}`,
    });
    hechos.push({ parte: p.i + 1, tipo: r.tipo, referencia: r.orden?.referencia || '', estado: r.orden?.status || '', motivo: r.tipo === 'ok' ? '' : r.motivo });
    if (r.tipo !== 'ok') break;   // si una parte falla, la otra no se pide a ciegas
  }
  const ok = hechos.filter((h) => h.tipo === 'ok');
  console.info(`🔁 revisión: ${recarga.juego} ${idPedido} rehecha desde el panel: ${hechos.map((h) => `${h.tipo} ${h.referencia}`).join(', ')}`);
  if (ok.length) {
    const nota = `🔁 Rehecha desde el panel (${new Date().toLocaleString('es-VE', { timeZone: 'America/Caracas' })}): ${ok.map((h) => h.referencia).join(', ')}`;
    // En proceso hasta que el aviso de Central One la marque entregada (o fallida otra vez)
    await actualizar('recargas', `id_pedido=eq.${encodeURIComponent(idPedido)}`, {
      estado: 'en_proceso', actualizado: new Date().toISOString(),
      nota_admin: `${recarga.nota_admin ? `${recarga.nota_admin} · ` : ''}${nota}`.slice(0, 500),
    }).catch((error) => console.error('⚠️ revisión: no se pudo anotar la recarga rehecha:', error.message));
  }
  const todo = ok.length === hechos.length && hechos.length === pendientes.length;
  return res.status(200).json({ status: todo ? 'success' : 'error', hechos,
    message: todo ? 'Pedido enviado a Central One. Cuando la entregue, la recarga pasa sola a "Entregada".'
      : `Central One no aceptó todo: ${hechos.filter((h) => h.tipo !== 'ok').map((h) => h.motivo).join(' · ')}` });
}
