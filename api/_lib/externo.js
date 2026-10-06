// Llamadas a Apps Script y APIs externas con tiempo límite, reintentos y caché en memoria.
// (Los archivos con "_" dentro de /api no se publican como endpoints en Vercel.)
//
// REGLA DE REINTENTOS: solo se reintenta lo que se puede repetir sin efectos secundarios
// (leer precios, validar un ID, marcar una referencia como usada). Nunca se reintenta lo que
// crea algo (verificar_pago, obtener_codigo, compras, registros, ruleta), porque un reintento
// tras un timeout podría duplicar la operación aunque la primera sí se haya completado.

export const TIEMPO_LIMITE_MS = 8000;
const ESPERA_ENTRE_REINTENTOS_MS = 300;

export class ErrorExterno extends Error {
  constructor(mensaje, { tiempoAgotado = false, estadoHttp = null } = {}) {
    super(mensaje);
    this.name = 'ErrorExterno';
    this.tiempoAgotado = tiempoAgotado;
    this.estadoHttp = estadoHttp;
  }
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function intentoUnico(url, opciones, tiempoMs) {
  const controlador = new AbortController();
  const temporizador = setTimeout(() => controlador.abort(), tiempoMs);
  try {
    const respuesta = await fetch(url, { ...opciones, signal: controlador.signal });
    const texto = await respuesta.text();
    let datos;
    try {
      datos = JSON.parse(texto);
    } catch (e) {
      // Apps Script devuelve una página HTML cuando el script falla
      console.error(`🚨 Respuesta no JSON (HTTP ${respuesta.status}):`, texto.slice(0, 500));
      throw new ErrorExterno(`Respuesta ilegible (HTTP ${respuesta.status})`, { estadoHttp: respuesta.status });
    }
    if (respuesta.status >= 500) {
      throw new ErrorExterno(`HTTP ${respuesta.status}`, { estadoHttp: respuesta.status });
    }
    return datos;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new ErrorExterno(`Tiempo agotado (${Math.round(tiempoMs / 1000)} s)`, { tiempoAgotado: true });
    }
    if (error instanceof ErrorExterno) throw error;
    throw new ErrorExterno(`Red: ${error.message}`);
  } finally {
    clearTimeout(temporizador);
  }
}

// Hace la petición y devuelve el JSON. Todo el proceso (incluidos reintentos) respeta
// un presupuesto total de `tiempoMs`: la función nunca tarda más que eso.
// Tras un timeout no se reintenta (no queda tiempo y el servidor ya está lento).
export async function pedirJSON(url, { metodo = 'POST', cuerpo, reintentos = 0, tiempoMs = TIEMPO_LIMITE_MS, cabeceras = {} } = {}) {
  const opciones = { method: metodo, headers: { 'Content-Type': 'application/json', ...cabeceras } };
  if (cuerpo !== undefined) opciones.body = JSON.stringify(cuerpo);

  const limite = Date.now() + tiempoMs;
  let ultimoError;
  for (let intento = 0; intento <= reintentos; intento++) {
    const restante = limite - Date.now();
    if (restante < 500) break;
    try {
      return await intentoUnico(url, opciones, restante);
    } catch (error) {
      ultimoError = error;
      if (error.tiempoAgotado || intento === reintentos) break;
      await esperar(ESPERA_ENTRE_REINTENTOS_MS);
    }
  }
  throw ultimoError || new ErrorExterno('Tiempo agotado');
}

// Atajo para Apps Script: POST con { accion, ... }
// Al Apps Script de recargas se le añade SCRIPT_RECARGAS_TOKEN en el cuerpo (Apps Script no puede
// leer cabeceras): así solo Vercel puede pedir pines o cambiar pagos aunque la URL se filtre.
export function llamarScript(url, cuerpo, opciones = {}) {
  const token = (process.env.SCRIPT_RECARGAS_TOKEN || '').trim();
  const esScriptRecargas = Boolean(url) && String(url).trim() === (process.env.SCRIPT_RECARGAS_URL || '').trim();
  return pedirJSON(url, { ...opciones, cuerpo: token && esScriptRecargas ? { ...cuerpo, token } : cuerpo });
}

// =========================================================================
// CACHÉ EN MEMORIA (por instancia de Vercel; sobrevive entre peticiones "tibias")
// - Dentro de `frescoMs`: responde al instante sin llamar a Apps Script.
// - Pasado ese tiempo consulta de nuevo; si Apps Script falla o tarda, devuelve la
//   última copia buena (hasta `respaldoMs`) para que la página nunca se quede sin precios.
// - Peticiones simultáneas comparten una sola llamada a Apps Script.
// =========================================================================
const cache = new Map();
const enCurso = new Map();

export async function conCache(clave, obtener, { frescoMs = 60_000, respaldoMs = 6 * 60 * 60_000, esperaConRespaldoMs = 1500, esValido = () => true } = {}) {
  const guardado = cache.get(clave);
  const edad = guardado ? Date.now() - guardado.momento : Infinity;
  if (edad < frescoMs) return { datos: guardado.datos, origen: 'cache' };
  const hayRespaldo = guardado && edad < respaldoMs;

  if (!enCurso.has(clave)) {
    const promesa = (async () => {
      try {
        const datos = await obtener();
        if (!esValido(datos)) throw new ErrorExterno('Datos inválidos de Apps Script');
        cache.set(clave, { datos, momento: Date.now() });
        return datos;
      } finally {
        enCurso.delete(clave);
      }
    })();
    promesa.catch(() => {}); // puede terminar después de responder con el respaldo
    enCurso.set(clave, promesa);
  }

  try {
    const consulta = enCurso.get(clave);
    // Con copia guardada no se hace esperar al cliente: si Apps Script tarda más de 1,5 s
    // se responde con la copia y la consulta sigue renovando la caché en segundo plano.
    const datos = hayRespaldo
      ? await Promise.race([consulta, esperar(esperaConRespaldoMs).then(() => { throw new ErrorExterno('Apps Script lento', { tiempoAgotado: true }); })])
      : await consulta;
    return { datos, origen: 'fresco' };
  } catch (error) {
    if (hayRespaldo) {
      console.error(`⚠️ ${clave}: Apps Script falló (${error.message}). Usando copia de hace ${Math.round(edad / 1000)} s.`);
      return { datos: guardado.datos, origen: 'respaldo' };
    }
    throw error;
  }
}

export const catalogoValido = (datos) => datos?.status === 'success' && Array.isArray(datos.catalogo) && datos.catalogo.length > 0;

// Precios: el navegador y la CDN de Vercel reutilizan la respuesta 60 s y,
// mientras se renueva, siguen sirviendo la copia anterior hasta 10 minutos.
export function cabecerasCachePrecios(res) {
  res.setHeader('Cache-Control', 'public, max-age=30, s-maxage=60, stale-while-revalidate=600');
}
