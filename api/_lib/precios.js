// PRECIOS EN SUPABASE (supabase/precios.sql, desde 2026-11-14).
// "🔄 Traer productos de Central One" del panel admin (pestaña Precios):
//   POST /api/juego?juego=<freefire|bloodstrike|mobilelegends|roblox>&accion=traer_productos
//   con el token de la sesión del administrador (Authorization: Bearer …).
// Lee el catálogo de Central One con la llave de ese juego (solo vive en Vercel), se queda con los
// productos del juego y guarda en centralone_catalogo su costo (4 decimales, como texto) y su stock.
// Los que ya no aparecen quedan "sin stock". El panel después elige cuáles se venden (admin_precio_guardar).
import { waitUntil } from '@vercel/functions';
import { pedirJSON } from './externo.js';
import { supabaseActivo, guardar, actualizar, borrar, rpc, esAdminToken } from './supabase.js';
import { tokenDe } from './historial.js';
import { limpiarMontoVES } from './recarga-comun.js';

const URL_CATALOGO = 'https://portal.centraloneglobal.com/api/v1/catalog';
const UUID = /^[0-9a-f-]{36}$/;

// Llave de Central One de cada juego (las mismas variables que usa cada tienda)
const LLAVES = {
  freefire: () => process.env.freefire_nuevo,
  bloodstrike: () => process.env.blood_nuevo,
  mobilelegends: () => process.env.mlbb_nuevo || process.env.blood_nuevo,
  roblox: () => process.env.roblox_nuevo,
};

// ¿El producto es de este juego? Por la familia de Central One (nunca por el SKU)
const sinAcentos = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[^a-z0-9]/g, '');
const DEL_JUEGO = {
  freefire: (p) => sinAcentos(p.product_family_name).includes('freefire'),
  bloodstrike: (p) => sinAcentos(p.product_family_name).includes('bloodstrike'),
  // Solo la familia normal (igual que esFamiliaNormalML de apps-script/mobilelegends.gs)
  mobilelegends: (p) => sinAcentos(p.product_family_name).replace(/bangbang$/, '') === 'mobilelegends',
  roblox: (p) => sinAcentos(p.product_family_name).includes('roblox'),
};

const corto = (t, max) => String(t ?? '').slice(0, max);

export async function traerProductos(req, res, juego) {
  if (req.method !== 'POST') return res.status(405).json({ status: 'error', message: 'Método no permitido' });
  if (!Object.hasOwn(LLAVES, juego)) return res.status(400).json({ status: 'error', message: 'Este juego no usa Central One.' });
  if (!supabaseActivo()) return res.status(503).json({ status: 'error', message: 'Supabase no está configurado.' });
  if (!(await esAdminToken(tokenDe(req)))) return res.status(403).json({ status: 'error', message: 'Solo el administrador.' });
  const llave = String(LLAVES[juego]() || '').trim();
  if (!llave) return res.status(503).json({ status: 'error', message: 'Falta la llave de Central One de este juego en Vercel.' });

  let items;
  try {
    const datos = await pedirJSON(URL_CATALOGO, {
      metodo: 'GET', cabeceras: { Authorization: `Bearer ${llave}` }, tiempoMs: 12000, reintentos: 1, reintentarTrasTimeout: true,
    });
    if (!Array.isArray(datos?.items)) throw new Error('catálogo sin items');
    items = datos.items;
  } catch (error) {
    console.error(`⚠️ precios: Central One no respondió el catálogo (${juego}):`, error.message);
    return res.status(503).json({ status: 'error', message: 'Central One no respondió. Intenta de nuevo en un minuto.' });
  }

  const ahora = new Date().toISOString();
  const filas = items.filter((p) => UUID.test(String(p?.product_id || '')) && DEL_JUEGO[juego](p)).map((p) => {
    const costo = Number(p.reseller_price);
    return {
      producto: p.product_id, juego,
      nombre: corto(p.name, 120), familia: corto(p.product_family_name, 80), region: corto(p.region || p.market, 20),
      // Central One manda 4 decimales como texto: se guardan tal cual (numeric(12,4))
      costo_usd: Number.isFinite(costo) && costo >= 0 ? String(p.reseller_price) : null,
      en_stock: p.in_stock === true && p.status !== 'inactive',
      stock: Number.isInteger(p.available_stock) ? p.available_stock : null,
      precio_desde: p.price_updated_at || null,
      visto: ahora,
    };
  });

  try {
    if (filas.length) await guardar('centralone_catalogo', filas, 'producto');
    // Lo que antes era de este juego y ya no está en el catálogo: sin stock (no se borra: puede volver)
    const ids = filas.map((f) => f.producto);
    await actualizar('centralone_catalogo', `juego=eq.${juego}${ids.length ? `&producto=not.in.(${ids.join(',')})` : ''}`,
      { en_stock: false, visto: ahora });
  } catch (error) {
    console.error(`⚠️ precios: no se pudo guardar el catálogo (${juego}):`, error.message);
    return res.status(503).json({ status: 'error', message: 'No se pudo guardar el catálogo. Intenta de nuevo.' });
  }

  return res.status(200).json({ status: 'success', total: filas.length, conStock: filas.filter((f) => f.en_stock).length });
}

// =========================================================================
// PRUEBA EN PARALELO (paso 5): la tienda sigue cobrando con la hoja. Cuando alguien abre una tienda, después
// de responderle, se compara cada precio de la hoja con el de Supabase (precios_de) y se guarda en
// precios_diferencias lo que no coincide (el panel lo muestra en Precios). Como mucho una vez cada 5 min
// por juego en cada instancia: no frena a nadie ni gasta Supabase.
// catalogo: la lista de la hoja [{ diamantes: "110 Diamantes", precio: "780,00" }, ...]
// =========================================================================
const ultimaComparacion = new Map();
const CADA_MS = 5 * 60_000;

export function compararConHoja(juego, catalogo) {
  if (!supabaseActivo() || !Array.isArray(catalogo)) return;
  const ahora = Date.now();
  if (ahora - (ultimaComparacion.get(juego) || 0) < CADA_MS) return;
  ultimaComparacion.set(juego, ahora);
  waitUntil((async () => {
    const filas = await rpc('precios_de', { p_juego: juego });
    const enSupabase = new Map((filas || []).filter((f) => f.activo).map((f) => [String(f.paquete).trim(), f.precio === null ? null : Number(f.precio)]));
    const enHoja = new Map(catalogo.map((p) => [String(p.diamantes ?? p.paquete ?? p.producto ?? '').trim(), limpiarMontoVES(p.precio)]).filter(([n]) => n));
    const visto = new Date().toISOString();
    const diferencias = [];
    for (const paquete of new Set([...enHoja.keys(), ...enSupabase.keys()])) {
      const hoja = enHoja.has(paquete) ? enHoja.get(paquete) : null;
      const supa = enSupabase.has(paquete) ? enSupabase.get(paquete) : null;
      if (hoja !== null && supa !== null && Math.abs(hoja - supa) < 0.01) continue;
      diferencias.push({ juego, paquete: paquete.slice(0, 80), precio_hoja: hoja, precio_supabase: supa, visto });
    }
    await borrar('precios_diferencias', `juego=eq.${juego}`);
    if (diferencias.length) await guardar('precios_diferencias', diferencias, 'juego,paquete');
    if (diferencias.length) console.info(`💲 prueba de precios (${juego}): ${diferencias.length} diferencia(s) entre la hoja y Supabase`);
  })().catch((error) => console.error(`⚠️ prueba de precios (${juego}):`, error.message)));
}
