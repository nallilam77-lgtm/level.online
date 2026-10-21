// =====================================================================
// LEVEL UP - Apps Script VALIDADOR DE IDs (variable SCRIPT_VALIDADOR_URL en Vercel)
// Usado por: api/_lib/juegos/freefire.js y api/_lib/juegos/bloodstrike.js (acción verificar).
//
// POST { id, juego }:
//   - juego "freefire" (o sin juego): FazerCards /topups/validate-id. Responde lo que dice FazerCards
//     ({ valid, player_name, ... }), igual que siempre.
//   - juego "bloodstrike": Central One /player/validate. Responde { valid, verificado, player_name }:
//       valid true  + verificado true  -> la cuenta existe (player_name = apodo, si el juego lo da)
//       valid false + verificado true  -> la cuenta NO existe
//       valid true  + verificado false -> no se pudo comprobar (no es un "no existe"): la tienda deja seguir
//
// Llaves: Configuración del proyecto (⚙️) > Propiedades del script. NUNCA en el código:
//   FAZER_API_KEY       llave de FazerCards (Free Fire)
//   CENTRALONE_API_KEY  llave de Central One con el permiso catalog:read (basta con ese)
//
// Cómo actualizarlo: pega este archivo y luego Implementar > Gestionar implementaciones > editar (lápiz) >
// Versión: "Nueva versión" > Implementar. Así la URL /exec NO cambia.
// =====================================================================

const URL_FAZER_VALIDAR = "https://api.fzr.cards/api/v2/topups/validate-id";
const URL_CENTRALONE = "https://portal.centraloneglobal.com/api/v1";
// Producto de Blood Strike con el que se valida (la validación pide uno): se busca en el catálogo y se
// recuerda este tiempo (Central One pide no leer el catálogo en cada consulta)
const CACHE_PRODUCTO_S = 21600;
// Un mismo ID ya consultado se responde de la copia (límite: 30 validaciones por minuto por cuenta)
const CACHE_ID_S = 600;

function doPost(e) {
  try {
    var datos = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    var idJugador = String(datos.id || "").trim();
    if (!/^\d{5,15}$/.test(idJugador)) return responder({ valid: false, message: "ID con formato inválido" });

    var juego = String(datos.juego || "freefire");
    if (juego === "bloodstrike") return responder(validarBloodStrike(idJugador));
    if (juego === "freefire") return responder(validarFreeFire(idJugador));
    return responder({ valid: false, message: "Juego no válido" });
  } catch (error) {
    console.error("Error en el validador: " + (error && error.stack || error));
    // El detalle va al registro de Apps Script, nunca a la respuesta
    return responder({ valid: false, message: "Error interno del validador" });
  }
}

// ---------------------------------------------------------------------
// FREE FIRE (FazerCards)
// ---------------------------------------------------------------------

function validarFreeFire(idJugador) {
  var llave = PropertiesService.getScriptProperties().getProperty("FAZER_API_KEY");
  if (!llave) {
    console.error("Falta la propiedad del script FAZER_API_KEY");
    return { valid: false, message: "Validador sin configurar" };
  }
  var opciones = {
    method: "post",
    headers: { "X-API-Key": llave, "Content-Type": "application/json" },
    payload: JSON.stringify({ category_id: "free_fire", fields: { player_id: idJugador } }),
    muteHttpExceptions: true
  };

  // Reintentos ante fallas temporales (502...). Vercel espera como mucho 20 s: esperas cortas.
  var esperas = [1000, 2000];
  var respuesta;
  for (var intento = 0; intento <= esperas.length; intento++) {
    respuesta = UrlFetchApp.fetch(URL_FAZER_VALIDAR, opciones);
    var codigo = respuesta.getResponseCode();
    // 200 = válido, 422 = ID inválido: respuestas definitivas
    if (codigo === 200 || codigo === 422) break;
    if (intento < esperas.length) Utilities.sleep(esperas[intento]);
  }
  try {
    return JSON.parse(respuesta.getContentText());
  } catch (err) {
    return { valid: false, message: "FazerCards devolvió una respuesta ilegible" };
  }
}

// ---------------------------------------------------------------------
// BLOOD STRIKE (Central One: POST /player/validate, no compra ni toca el saldo)
// ---------------------------------------------------------------------

function validarBloodStrike(idJugador) {
  var noComprobado = function (motivo) {
    console.warn("Blood Strike: no se pudo comprobar el ID " + idJugador + " (" + motivo + ")");
    return { valid: true, verificado: false };
  };
  var llave = PropertiesService.getScriptProperties().getProperty("CENTRALONE_API_KEY");
  if (!llave) return noComprobado("falta la propiedad del script CENTRALONE_API_KEY");

  var cache = CacheService.getScriptCache();
  var guardado = cache.get("bs_id_" + idJugador);
  if (guardado) return JSON.parse(guardado);

  var producto = productoParaValidar(llave);
  if (!producto) return noComprobado("no hay un producto de Blood Strike que pida solo el ID en el catálogo");

  var payload = {};
  payload[producto.campo] = idJugador;
  var respuesta = UrlFetchApp.fetch(URL_CENTRALONE + "/player/validate", {
    method: "post",
    headers: { Authorization: "Bearer " + llave, "Content-Type": "application/json" },
    payload: JSON.stringify({ product_id: producto.id, target_payload: payload }),
    muteHttpExceptions: true
  });
  var codigo = respuesta.getResponseCode();
  if (codigo === 404) cache.remove("bs_producto"); // el producto salió del catálogo: se busca otro la próxima vez
  if (codigo !== 200) return noComprobado("Central One respondió HTTP " + codigo);

  var datos = JSON.parse(respuesta.getContentText());
  var resultado;
  if (datos.status === "valid") {
    var nombre = datos.player && datos.player.name ? String(datos.player.name).slice(0, 60) : "";
    resultado = { valid: true, verificado: true, player_name: nombre };
  } else if (datos.status === "invalid") {
    resultado = { valid: false, verificado: true, message: "Ese ID no existe en Blood Strike" };
  } else {
    // unverified: not_supported (el juego no tiene comprobación) o temporarily_unavailable
    return noComprobado("unverified: " + String(datos.reason || "sin motivo"));
  }
  cache.put("bs_id_" + idJugador, JSON.stringify(resultado), CACHE_ID_S);
  return resultado;
}

// Producto de Blood Strike (región GLOBAL, con stock) que pida un solo dato de texto: el ID del jugador.
// Devuelve { id, campo } o null.
function productoParaValidar(llave) {
  var cache = CacheService.getScriptCache();
  var guardado = cache.get("bs_producto");
  if (guardado) return JSON.parse(guardado);

  var respuesta = UrlFetchApp.fetch(URL_CENTRALONE + "/catalog", {
    headers: { Authorization: "Bearer " + llave }, muteHttpExceptions: true
  });
  if (respuesta.getResponseCode() !== 200) return null;
  var candidatos = (JSON.parse(respuesta.getContentText()).items || []).filter(function (p) {
    var esBlood = String(p.product_family_name + " " + p.name).toLowerCase().replace(/[^a-z0-9]/g, "").indexOf("bloodstrike") !== -1;
    var campos = p.target_schema && p.target_schema.length ? p.target_schema : (p.target_fields || []).map(function (k) { return { key: k, type: "text" }; });
    return esBlood && p.requires_target && String(p.region || "").toUpperCase() === "GLOBAL" && p.in_stock !== false &&
      campos.length === 1 && campos[0].type !== "select";
  });
  if (!candidatos.length) return null;
  // Mejor un paquete de oro (el más común): es el que seguro existe para toda cuenta
  var oro = candidatos.filter(function (p) { return /gold|oro/i.test(p.name); });
  var elegido = (oro.length ? oro : candidatos)[0];
  var campos = elegido.target_schema && elegido.target_schema.length ? elegido.target_schema : [{ key: elegido.target_fields[0] }];
  var producto = { id: elegido.product_id, campo: campos[0].key };
  cache.put("bs_producto", JSON.stringify(producto), CACHE_PRODUCTO_S);
  return producto;
}

// ---------------------------------------------------------------------

function responder(objeto) {
  return ContentService.createTextOutput(JSON.stringify(objeto)).setMimeType(ContentService.MimeType.JSON);
}
