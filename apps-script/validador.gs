// =====================================================================
// LEVEL UP - Apps Script VALIDADOR DE IDs (variable SCRIPT_VALIDADOR_URL en Vercel)
// Usado por: api/_lib/juegos/freefire.js y api/_lib/juegos/bloodstrike.js (acción verificar).
//
// POST { id, juego } ("freefire", o sin juego, y "bloodstrike"): Central One /player/validate (no compra
// ni toca el saldo). Responde { valid, verificado, player_name }:
//   valid true  + verificado true  -> la cuenta existe (player_name = apodo, si el juego lo da)
//   valid false + verificado true  -> la cuenta NO existe
//   valid true  + verificado false -> no se pudo comprobar (no es un "no existe"): la tienda deja seguir
//
// Llave: Configuración del proyecto (⚙️) > Propiedades del script. NUNCA en el código:
//   CENTRALONE_API_KEY  llave de Central One con el permiso catalog:read (basta con ese)
// (FAZER_API_KEY ya no se usa: se puede borrar)
//
// Cómo actualizarlo: pega este archivo y luego Implementar > Gestionar implementaciones > editar (lápiz) >
// Versión: "Nueva versión" > Implementar. Así la URL /exec NO cambia.
// =====================================================================

const URL_CENTRALONE = "https://portal.centraloneglobal.com/api/v1";
// Producto del juego con el que se valida (la validación pide uno): se busca en el catálogo y se
// recuerda este tiempo (Central One pide no leer el catálogo en cada consulta)
const CACHE_PRODUCTO_S = 21600;
// Un mismo ID ya consultado se responde de la copia (límite: 30 validaciones por minuto por cuenta)
const CACHE_ID_S = 600;
// Cada juego: cómo se reconoce en el catálogo, su región y qué paquete se prefiere (el más común,
// que seguro existe para toda cuenta). "prefijo" separa sus copias en la caché.
const JUEGOS = {
  freefire: { nombre: "Free Fire", familia: "freefire", region: /latam|latin/i, preferido: /diamond|diamante/i, prefijo: "ff" },
  bloodstrike: { nombre: "Blood Strike", familia: "bloodstrike", region: /^global$/i, preferido: /gold|oro/i, prefijo: "bs" }
};

function doPost(e) {
  try {
    var datos = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    var idJugador = String(datos.id || "").trim();
    if (!/^\d{5,15}$/.test(idJugador)) return responder({ valid: false, message: "ID con formato inválido" });

    var juego = String(datos.juego || "freefire");
    if (!JUEGOS.hasOwnProperty(juego)) return responder({ valid: false, message: "Juego no válido" });
    return responder(validarEnCentralOne(JUEGOS[juego], idJugador));
  } catch (error) {
    console.error("Error en el validador: " + (error && error.stack || error));
    // El detalle va al registro de Apps Script, nunca a la respuesta
    return responder({ valid: false, message: "Error interno del validador" });
  }
}

// ---------------------------------------------------------------------
// CENTRAL ONE: POST /player/validate (no compra ni toca el saldo)
// ---------------------------------------------------------------------

function validarEnCentralOne(juego, idJugador) {
  var noComprobado = function (motivo) {
    console.warn(juego.nombre + ": no se pudo comprobar el ID " + idJugador + " (" + motivo + ")");
    return { valid: true, verificado: false };
  };
  var llave = PropertiesService.getScriptProperties().getProperty("CENTRALONE_API_KEY");
  if (!llave) return noComprobado("falta la propiedad del script CENTRALONE_API_KEY");

  var cache = CacheService.getScriptCache();
  var guardado = cache.get(juego.prefijo + "_id_" + idJugador);
  if (guardado) return JSON.parse(guardado);

  var producto = productoParaValidar(juego, llave);
  if (!producto) return noComprobado("no hay un producto de " + juego.nombre + " que pida solo el ID en el catálogo");

  var payload = {};
  payload[producto.campo] = idJugador;
  var respuesta = UrlFetchApp.fetch(URL_CENTRALONE + "/player/validate", {
    method: "post",
    headers: { Authorization: "Bearer " + llave, "Content-Type": "application/json" },
    payload: JSON.stringify({ product_id: producto.id, target_payload: payload }),
    muteHttpExceptions: true
  });
  var codigo = respuesta.getResponseCode();
  if (codigo === 404) cache.remove(juego.prefijo + "_producto"); // el producto salió del catálogo: se busca otro la próxima vez
  if (codigo !== 200) return noComprobado("Central One respondió HTTP " + codigo);

  var datos = JSON.parse(respuesta.getContentText());
  var resultado;
  if (datos.status === "valid") {
    var nombre = datos.player && datos.player.name ? String(datos.player.name).slice(0, 60) : "";
    resultado = { valid: true, verificado: true, player_name: nombre };
  } else if (datos.status === "invalid") {
    resultado = { valid: false, verificado: true, message: "Ese ID no existe en " + juego.nombre };
  } else {
    // unverified: not_supported (el juego no tiene comprobación) o temporarily_unavailable
    return noComprobado("unverified: " + String(datos.reason || "sin motivo"));
  }
  cache.put(juego.prefijo + "_id_" + idJugador, JSON.stringify(resultado), CACHE_ID_S);
  return resultado;
}

// Producto del juego (de su región, con stock) que pida un solo dato de texto: el ID del jugador.
// Devuelve { id, campo } o null.
function productoParaValidar(juego, llave) {
  var cache = CacheService.getScriptCache();
  var guardado = cache.get(juego.prefijo + "_producto");
  if (guardado) return JSON.parse(guardado);

  var respuesta = UrlFetchApp.fetch(URL_CENTRALONE + "/catalog", {
    headers: { Authorization: "Bearer " + llave }, muteHttpExceptions: true
  });
  if (respuesta.getResponseCode() !== 200) return null;
  var candidatos = (JSON.parse(respuesta.getContentText()).items || []).filter(function (p) {
    var familia = String(p.product_family_name + " " + p.name).toLowerCase().replace(/[^a-z0-9]/g, "");
    var region = juego.familia === "freefire" ? String(p.region || "") + " " + p.name + " " + p.product_family_name : String(p.region || "");
    var campos = p.target_schema && p.target_schema.length ? p.target_schema : (p.target_fields || []).map(function (k) { return { key: k, type: "text" }; });
    return familia.indexOf(juego.familia) !== -1 && p.requires_target && juego.region.test(region.trim()) && p.in_stock !== false &&
      campos.length === 1 && campos[0].type !== "select";
  });
  if (!candidatos.length) return null;
  var preferidos = candidatos.filter(function (p) { return juego.preferido.test(p.name); });
  var elegido = (preferidos.length ? preferidos : candidatos)[0];
  var campos = elegido.target_schema && elegido.target_schema.length ? elegido.target_schema : [{ key: elegido.target_fields[0] }];
  var producto = { id: elegido.product_id, campo: campos[0].key };
  cache.put(juego.prefijo + "_producto", JSON.stringify(producto), CACHE_PRODUCTO_S);
  return producto;
}

// ---------------------------------------------------------------------

function responder(objeto) {
  return ContentService.createTextOutput(JSON.stringify(objeto)).setMimeType(ContentService.MimeType.JSON);
}
