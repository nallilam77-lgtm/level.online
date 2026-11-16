// VALIDADOR DE IDs desde Vercel (desde 2026-11-16; antes apps-script/validador.gs, SCRIPT_VALIDADOR_URL).
// Pregunta a Central One (POST /player/validate: no compra ni toca el saldo) si la cuenta existe. Mismas
// reglas que validador.gs, sin el salto a Google (5-15 s cuando Apps Script arranca en frío).
//
// validarJugador(juego, id, zona) → { valid, verificado, player_name?, message? }
//   valid true  + verificado true  → la cuenta existe (player_name = apodo, si el juego lo da)
//   valid false + verificado true  → la cuenta NO existe
//   valid true  + verificado false → no se pudo comprobar (no es un "no existe"): la tienda deja seguir
// Lanza ErrorExterno solo si Central One no responde (red o tiempo agotado): cada tienda decide qué hacer.
//
// Llave: la misma de las compras de cada juego (freefire_nuevo, blood_nuevo, mlbb_nuevo o blood_nuevo);
// basta con el permiso catalog:read. Sin llave se usa el Apps Script viejo si SCRIPT_VALIDADOR_URL existe.
import { catalogo } from './centralone.js';
import { llamarScript, LECTURA_APPS_SCRIPT, ErrorExterno } from './externo.js';

const URL_API = 'https://portal.centraloneglobal.com/api/v1';
const TIEMPO_MS = 8000;
// Un mismo ID ya consultado se responde de la copia (Central One: 30 validaciones por minuto por cuenta)
const COPIA_ID_MS = 10 * 60_000;
const MAX_COPIAS = 5000;
const copias = new Map();
// Productos que salieron del catálogo (404 al validar): no se vuelven a elegir durante un rato
const descartados = new Map();
const DESCARTE_MS = 30 * 60_000;

// Cada juego: cómo se reconoce en el catálogo, su región y qué paquete se prefiere (el más común, que
// seguro existe para toda cuenta). Igual que JUEGOS de validador.gs.
const JUEGOS = {
  freefire: { nombre: 'Free Fire', familia: 'freefire', region: /latam|latin/i, preferido: /diamond|diamante/i, llave: () => process.env.freefire_nuevo },
  bloodstrike: { nombre: 'Blood Strike', familia: 'bloodstrike', region: /^global$/i, preferido: /gold|oro/i, llave: () => process.env.blood_nuevo },
  // conZona: el producto pide dos datos de texto (ID y Zona ID). Cualquier región sirve para comprobar.
  mobilelegends: { nombre: 'Mobile Legends', familia: 'mobilelegends', region: /.*/, preferido: /diamond|diamante/i, conZona: true, soloFamiliaExacta: true, llave: () => process.env.mlbb_nuevo || process.env.blood_nuevo },
};

// Campo donde va la Zona ID (igual que CAMPO_ZONA de centralone.js)
const CAMPO_ZONA = /zone|zona|server|servidor/i;
const esCampoZona = (c) => CAMPO_ZONA.test(`${c?.key || ''} ${c?.label || ''}`);
const camposDe = (p) => (Array.isArray(p.target_schema) && p.target_schema.length
  ? p.target_schema
  : (p.target_fields || []).map((key) => ({ key, type: 'text' })));
const soloLetras = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[^a-z0-9]/g, '');
// "Mobile Legends: Bang Bang" cuenta como "mobilelegends"; "Mobile Legends Especial" no
const esFamiliaExacta = (p, familia) => soloLetras(p.product_family_name).replace(/bangbang$/, '') === familia;

// Producto del juego (de su región, con stock) que pida solo el ID (con zona: el ID y la Zona ID).
// { id, campo, campoZona } o null. El catálogo ya tiene su copia de 15 min (centralone.js).
async function productoParaValidar(juego, apiKey) {
  const items = await catalogo(apiKey);
  const ahora = Date.now();
  const candidatos = items.filter((p) => {
    if (!p?.requires_target || p.in_stock === false) return false;
    if ((descartados.get(p.product_id) || 0) > ahora) return false;
    if (!soloLetras(`${p.product_family_name} ${p.name}`).includes(juego.familia)) return false;
    if (juego.soloFamiliaExacta && !esFamiliaExacta(p, juego.familia)) return false;
    const region = juego.familia === 'freefire' ? `${p.region || ''} ${p.name} ${p.product_family_name}` : String(p.region || '');
    if (!juego.region.test(region.trim())) return false;
    const campos = camposDe(p);
    return juego.conZona
      ? campos.length === 2 && campos.every((c) => c.type !== 'select') && campos.filter(esCampoZona).length === 1
      : campos.length === 1 && campos[0].type !== 'select';
  });
  if (!candidatos.length) return null;
  const preferidos = candidatos.filter((p) => juego.preferido.test(p.name));
  const elegido = (preferidos.length ? preferidos : candidatos)[0];
  const campos = camposDe(elegido);
  return juego.conZona
    ? { id: elegido.product_id, campo: campos.find((c) => !esCampoZona(c)).key, campoZona: campos.find(esCampoZona).key }
    : { id: elegido.product_id, campo: campos[0].key };
}

// Sin llave en Vercel: el Apps Script de antes (mientras siga publicado)
async function validarConScript(juego, id, zona) {
  const url = String(process.env.SCRIPT_VALIDADOR_URL || '').trim();
  if (!url) {
    console.error(`🚨 validador: falta la llave de Central One de ${JUEGOS[juego].nombre} en Vercel`);
    return { valid: true, verificado: false };
  }
  const v = await llamarScript(url, { id, juego, ...(zona && { zona }) }, LECTURA_APPS_SCRIPT);
  return { valid: v?.valid === true, verificado: v?.verificado === true, player_name: v?.player_name, message: v?.message };
}

export async function validarJugador(juego, id, zona = '') {
  const datos = JUEGOS[juego];
  if (!datos) throw new Error(`validador: juego desconocido "${juego}"`);
  const apiKey = String(datos.llave() || '').trim();
  if (!apiKey) return validarConScript(juego, id, zona);

  const clave = `${juego}:${id}:${zona}`;
  const guardado = copias.get(clave);
  if (guardado && Date.now() - guardado.momento < COPIA_ID_MS) return guardado.resultado;

  const noComprobado = (motivo) => {
    console.warn(`⚠️ validador: ${datos.nombre}: no se pudo comprobar el ID ${id} (${motivo})`);
    return { valid: true, verificado: false };
  };

  let producto;
  try {
    producto = await productoParaValidar(datos, apiKey);
  } catch (error) {
    return noComprobado(`catálogo: ${error.message}`);
  }
  if (!producto) return noComprobado(`no hay un producto que pida solo ${datos.conZona ? 'el ID y la Zona ID' : 'el ID'}`);

  const payload = { [producto.campo]: id, ...(producto.campoZona && { [producto.campoZona]: zona }) };
  const controlador = new AbortController();
  const temporizador = setTimeout(() => controlador.abort(), TIEMPO_MS);
  let respuesta;
  let cuerpo;
  try {
    respuesta = await fetch(`${URL_API}/player/validate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ product_id: producto.id, target_payload: payload }),
      signal: controlador.signal,
    });
    cuerpo = await respuesta.json().catch(() => null);
  } catch (error) {
    throw new ErrorExterno(error.name === 'AbortError' ? `Central One no respondió en ${TIEMPO_MS / 1000} s` : `Red: ${error.cause?.code || error.message}`,
      { tiempoAgotado: error.name === 'AbortError' });
  } finally {
    clearTimeout(temporizador);
  }

  // El producto salió del catálogo: la próxima vez se elige otro
  if (respuesta.status === 404) descartados.set(producto.id, Date.now() + DESCARTE_MS);
  if (respuesta.status !== 200 || !cuerpo) return noComprobado(`HTTP ${respuesta.status}`);

  let resultado;
  if (cuerpo.status === 'valid') {
    resultado = { valid: true, verificado: true, player_name: cuerpo.player?.name ? String(cuerpo.player.name).slice(0, 60) : '' };
  } else if (cuerpo.status === 'invalid') {
    resultado = { valid: false, verificado: true, message: `Ese ID ${zona ? 'con esa Zona ID ' : ''}no existe en ${datos.nombre}` };
  } else {
    // unverified: not_supported o temporarily_unavailable
    return noComprobado(`unverified: ${String(cuerpo.reason || 'sin motivo')}`);
  }
  copias.delete(clave);
  copias.set(clave, { resultado, momento: Date.now() });
  if (copias.size > MAX_COPIAS) copias.delete(copias.keys().next().value);
  return resultado;
}
