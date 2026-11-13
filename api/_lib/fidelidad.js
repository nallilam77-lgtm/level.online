// PREMIO DE CLIENTE FIEL y PAQUETES DESTACADOS (tiendas automáticas: Free Fire, Blood Strike,
// Mobile Legends y Roblox). Todo vive en Supabase (desde 2026-11-13; antes Firestore): tablas y funciones
// en supabase/levelup.sql, acceso en _lib/supabase.js. Sin SUPABASE_URL y SUPABASE_SECRET_KEY no hay
// premio ni "Más vendido" y todo sigue como antes.
//
// Premio: la recarga número RECARGAS_POR_PREMIO (6.ª, 12.ª, 18.ª...) de la misma CUENTA DE LEVEL UP
// (cliente con sesión de Google, desde 2026-11-13; antes era por ID del juego) lleva PREMIO % de
// descuento (fijo). Suman las recargas de las 4 tiendas automáticas, con cualquier ID. Sin sesión no se
// cuenta ni hay premio. El usuario sale del token de la recarga (usuarioActual de _lib/historial.js).
// Tabla "fidelidad", una fila por cuenta: juego = ALCANCE ('cuenta') y cuenta = SHA-256 del UUID:
// { juego, cuenta, recargas, premio, actualizado } (las filas viejas por juego + ID quedan sin uso).
// El +1 lo hace la función SQL fidelidad_anotar en un solo paso (dos compras a la vez no se pisan).
//   - El premio se gana al pagar la recarga anterior (5.ª, 11.ª...) y queda guardado hasta usarlo.
//   - No se suma a un código de descuento: con código, el premio se guarda para la próxima recarga.
//   - Cuenta como recarga cada pago ENCONTRADO (aunque no alcance: el pedido queda guardado con su precio).
//   - La página recibe el premio firmado (HMAC con SCRIPT_RECARGAS_TOKEN). Si al recargar Supabase no
//     responde, se respeta el premio firmado que la página mostró (así el cliente nunca paga "de menos").
//   - Cada venta con premio queda en la tabla "fidelidad_usos" (juego, cuenta, pedido, %, precios).
//   - anotarRecarga también deja los datos del pedido para el perfil del cliente (_lib/historial.js).
//
// Destacados: tabla "ventas_paquetes", una fila por juego + paquete con sus ventas (ventas_sumar). El
// paquete con más ventas lleva "⭐ Más vendido" (desde VENTAS_MINIMAS ventas) y el de menor precio por
// unidad "💰 Mejor precio" (campo "etiqueta" del catálogo, que las páginas ya dibujan).
// (Los archivos con "_" dentro de /api no se publican como endpoints en Vercel.)
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import { obtenerIp, permitirUso } from './limitador.js';
import { supabaseActivo, rpc, leer, guardar, usuarioDelToken } from './supabase.js';
import { anotarEnHistorial, usuarioActual, tokenDe } from './historial.js';
import { precioConDescuento } from './descuentos.js';
import { formatearVES, limpiarMontoVES } from './recarga-comun.js';

export const RECARGAS_POR_PREMIO = 6;
// Descuento del premio, en %
const PREMIO = 1.5;
const PREMIO_MAX = PREMIO;
// La firma que recibe la página vale este tiempo (lo que tarda un cliente en pagar)
const VIGENCIA_FIRMA_MS = 3 * 60 * 60 * 1000;
const VENTAS_MINIMAS = 10;
const DESTACADOS_MS = 10 * 60 * 1000;

export const ETIQUETA_MAS_VENDIDO = '⭐ Más vendido';
export const ETIQUETA_MEJOR_PRECIO = '💰 Mejor precio';

// El premio es de la cuenta de Level Up: una sola fila por usuario en la tabla "fidelidad"
const ALCANCE = 'cuenta';
const huella = (texto) => createHash('sha256').update(texto).digest('hex');
const idDocumento = (usuario) => huella(`${ALCANCE}:${String(usuario).toLowerCase()}`);

// Firma del premio para la página: "<décimas>.<vence>.<hmac>" (1,2 % -> 12), atada al usuario.
// Sin SCRIPT_RECARGAS_TOKEN no se firma.
function llaveFirma() {
  const token = (process.env.SCRIPT_RECARGAS_TOKEN || '').trim();
  return token ? createHash('sha256').update(`levelup-fidelidad:${token}`).digest() : null;
}
function firmar(usuario, porcentaje, vence) {
  const llave = llaveFirma();
  if (!llave) return '';
  const decimas = Math.round(porcentaje * 10);
  const mac = createHmac('sha256', llave).update(`${idDocumento(usuario)}|${decimas}|${vence}`).digest('base64url');
  return `${decimas}.${vence}.${mac}`;
}
// Devuelve el porcentaje firmado para ESE usuario, o 0 si la firma no es válida o venció
function leerFirma(usuario, firma) {
  const partes = String(firma || '').split('.');
  if (partes.length !== 3 || !/^\d{1,2}$/.test(partes[0]) || !/^\d{13}$/.test(partes[1])) return 0;
  const porcentaje = Number(partes[0]) / 10;
  const vence = Number(partes[1]);
  if (!(porcentaje > 0 && porcentaje <= PREMIO_MAX) || !(vence > Date.now())) return 0;
  const esperada = firmar(usuario, porcentaje, vence).split('.').pop();
  const recibida = partes[2];
  if (!esperada || esperada.length !== recibida.length) return 0;
  return timingSafeEqual(Buffer.from(esperada), Buffer.from(recibida)) ? porcentaje : 0;
}

async function leerCuenta(usuario) {
  if (!supabaseActivo()) return null;
  const filas = await leer('fidelidad', { juego: ALCANCE, cuenta: idDocumento(usuario) }, 'recargas,premio');
  const datos = (Array.isArray(filas) && filas[0]) || {};
  return { recargas: Number(datos.recargas) || 0, premio: Number(datos.premio) > 0 ? PREMIO : 0 };
}

/**
 * Premio (en %) del cliente con sesión de ESTA recarga, o 0 (sin sesión, 0). Supabase manda; si no
 * responde, vale el premio firmado que mostró la página. Nunca lanza.
 */
export async function porcentajePremio({ juego, firma }) {
  const usuario = await usuarioActual();
  if (!usuario) return 0;
  let porcentaje = 0;
  try {
    const datos = await leerCuenta(usuario);
    porcentaje = datos ? datos.premio : leerFirma(usuario, firma);
  } catch (error) {
    console.error(`⚠️ fidelidad: no se pudo leer el premio (${juego}):`, error.message);
    porcentaje = leerFirma(usuario, firma);
  }
  return porcentaje > 0 && porcentaje <= PREMIO_MAX ? porcentaje : 0;
}

// Recargas que faltan para ganar el premio (0 si ya lo tiene)
const faltanPara = ({ recargas, premio }) => (premio > 0 ? 0 : Math.max(1, (RECARGAS_POR_PREMIO - 1) - (recargas % RECARGAS_POR_PREMIO)));

/**
 * Para la recarga: el precio a cobrar con el premio (si la cuenta lo tiene y no trae código).
 * precio = el que ya salió de aplicarDescuentoARecarga. firma = la que la página recibió (respaldo).
 * Devuelve { porcentaje, precio }. Nunca lanza: si algo falla, sin premio (o el firmado).
 */
export async function premioParaRecarga({ juego, firma, desc, precio }) {
  if (desc) return { porcentaje: 0, precio };
  const porcentaje = await porcentajePremio({ juego, firma });
  if (!porcentaje) return { porcentaje: 0, precio };
  const conPremio = precioConDescuento(precio, { tipo: 'porcentaje', valor: porcentaje });
  return conPremio < precio ? { porcentaje, precio: conPremio } : { porcentaje: 0, precio };
}

/**
 * Pago encontrado: +1 recarga de la cuenta de Level Up, solo con sesión (y gasta el premio si se usó), +1 venta del paquete y, con
 * premio, una fila en "fidelidad_usos". Corre después de responder (waitUntil): nunca frena la recarga.
 * paquete = nombre del paquete tal como sale en el catálogo.
 */
export function anotarRecarga({ juego, cuenta, paquete, idPedido, premio = 0, precioLista, precio }) {
  // Perfil del cliente (solo con sesión): se guarda al terminar la recarga, con su estado
  anotarEnHistorial({ cuenta, paquete, idPedido, precio });
  if (!supabaseActivo()) return;
  // Se toma aquí, dentro de la recarga (contexto de la sesión). Las manuales (cuenta null) no suman.
  const promesaUsuario = cuenta ? usuarioActual() : Promise.resolve(null);
  waitUntil((async () => {
    try {
      // La próxima es la del premio: fidelidad_anotar lo deja guardado (la página lo muestra en la próxima visita)
      const usuario = await promesaUsuario;
      if (usuario) {
        await rpc('fidelidad_anotar', {
          p_juego: ALCANCE, p_cuenta: idDocumento(usuario), p_premio_usado: premio > 0,
          p_cada: RECARGAS_POR_PREMIO, p_premio: PREMIO,
        });
      }
      if (premio > 0) {
        await guardar('fidelidad_usos', {
          juego, cuenta: String(cuenta).slice(0, 60), id_pedido: String(idPedido || '').slice(0, 80), porcentaje: premio,
          precio_lista: Number(precioLista) || 0, precio_cobrado: Number(precio) || 0,
        });
      }
      const clave = claveVenta(paquete);
      if (clave) await rpc('ventas_sumar', { p_juego: juego, p_clave: clave });
    } catch (error) {
      console.error(`⚠️ fidelidad: no se pudo anotar la recarga (${juego}, pedido ${idPedido}):`, error.message);
    }
  })());
}

/**
 * Acción "fidelidad" de api/juego.js: POST con la cabecera Authorization del cliente (public/js/sesion.js)
 * -> { activo, sesion, recargas, cada, faltan, premio, firma, catalogo? } (con premio, el catálogo ya trae
 * los precios con el premio, igual que un código). Sin sesión: { activo: true, sesion: false } (la página
 * invita a iniciar sesión). El ID del juego ya no importa: el premio es de la cuenta.
 */
export function crearAccionFidelidad(juego, obtenerCatalogo) {
  return async function fidelidad(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ status: 'error', message: 'Método no permitido' });
    if (!supabaseActivo()) return res.status(200).json({ status: 'success', activo: false });

    const minutos = await permitirUso(`fidelidad:${obtenerIp(req)}`);
    if (minutos > 0) return res.status(429).json({ status: 'error', message: `Espera ${minutos} minutos.` });

    const usuario = await usuarioDelToken(tokenDe(req));
    if (!usuario) return res.status(200).json({ status: 'success', activo: true, sesion: false, cada: RECARGAS_POR_PREMIO });

    try {
      const datos = await leerCuenta(usuario);
      if (!datos) return res.status(200).json({ status: 'success', activo: false });
      const respuesta = { status: 'success', activo: true, sesion: true, recargas: datos.recargas, cada: RECARGAS_POR_PREMIO, faltan: faltanPara(datos), premio: datos.premio };
      if (datos.premio > 0) {
        respuesta.firma = firmar(usuario, datos.premio, Date.now() + VIGENCIA_FIRMA_MS);
        const desc = { tipo: 'porcentaje', valor: datos.premio };
        respuesta.catalogo = (await obtenerCatalogo()).map((p) => {
          const original = limpiarMontoVES(p.precio);
          const final = precioConDescuento(original, desc);
          return final < original ? { ...p, precio: formatearVES(final), precioOriginal: p.precio } : { ...p };
        });
      }
      return res.status(200).json(respuesta);
    } catch (error) {
      console.error(`⚠️ fidelidad: consulta fallida (${juego}):`, error.message);
      return res.status(200).json({ status: 'success', activo: false });
    }
  };
}

// ---------------------------------------------------------------------
// Destacados del catálogo
// ---------------------------------------------------------------------

// Nombre del paquete en cualquier catálogo (diamantes/oro: "diamantes"; Roblox: "producto"; manuales: "paquete")
export const nombreDePaquete = (p) => String(p?.diamantes ?? p?.producto ?? p?.paquete ?? '');
function claveVenta(nombre) {
  return String(nombre || '').toLowerCase().normalize('NFD').replace(/[^a-z0-9]/g, '').slice(0, 60);
}
// Cantidad al inicio del nombre ("1.060 Diamantes" -> 1060); los pases y tarjetas no tienen
function cantidadDe(nombre) {
  const m = String(nombre).trim().match(/^(\d{1,3}(?:[.,]\d{3})+|\d+)(?:\s|$)/);
  return m ? Number(m[1].replace(/[.,]/g, '')) : 0;
}

const memoriaVentas = new Map();
async function ventasDe(juego) {
  const guardado = memoriaVentas.get(juego);
  if (guardado && Date.now() - guardado.fecha < DESTACADOS_MS) return guardado.conteo;
  let conteo = guardado?.conteo || {};
  try {
    if (supabaseActivo()) {
      const filas = await leer('ventas_paquetes', { juego }, 'clave,ventas');
      conteo = Object.fromEntries((Array.isArray(filas) ? filas : []).map((f) => [f.clave, Number(f.ventas) || 0]));
    }
  } catch (error) {
    console.error(`⚠️ destacados: no se pudieron leer las ventas (${juego}):`, error.message);
  }
  memoriaVentas.set(juego, { fecha: Date.now(), conteo });
  return conteo;
}

/**
 * Agrega "etiqueta" al paquete más vendido y al de mejor precio por unidad. No pisa una etiqueta que ya
 * venga de la hoja. Nunca lanza: si algo falla, devuelve el catálogo tal cual.
 */
export async function conDestacados(juego, catalogo) {
  if (!Array.isArray(catalogo) || catalogo.length < 3) return catalogo;
  try {
    const conteo = await ventasDe(juego);
    const ventas = catalogo.map((p) => Number(conteo[claveVenta(nombreDePaquete(p))]) || 0);
    const maximo = Math.max(...ventas);
    const masVendido = maximo >= VENTAS_MINIMAS && ventas.filter((v) => v === maximo).length === 1 ? ventas.indexOf(maximo) : -1;

    // Mejor precio por unidad entre los paquetes con cantidad (al menos 3 para comparar)
    let mejor = -1, mejorRazon = Infinity, conCantidad = 0;
    catalogo.forEach((p, i) => {
      const cantidad = cantidadDe(nombreDePaquete(p));
      const precio = limpiarMontoVES(p.precio);
      if (!(cantidad > 0 && precio > 0) || p.stock === 'agotado') return;
      conCantidad++;
      const razon = precio / cantidad;
      if (razon < mejorRazon - 1e-9) { mejorRazon = razon; mejor = i; }
    });
    if (conCantidad < 3) mejor = -1;

    return catalogo.map((p, i) => {
      if (p.etiqueta) return p;
      if (i === masVendido) return { ...p, etiqueta: ETIQUETA_MAS_VENDIDO };
      if (i === mejor) return { ...p, etiqueta: ETIQUETA_MEJOR_PRECIO };
      return p;
    });
  } catch (error) {
    console.error(`⚠️ destacados (${juego}):`, error.message);
    return catalogo;
  }
}
