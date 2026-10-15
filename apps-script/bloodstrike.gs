// =====================================================================
// LEVEL UP - Apps Script de BLOOD STRIKE (variable SCRIPT_BLOOD en Vercel)
// Usado por: api/_lib/juegos/bloodstrike.js (precios y recarga por la API de FazerCards) y
// api/fazer-webhook.js (estado de cada orden en tiempo real).
//
// Secciones:  1 Configuración · 2 Entrada (doGet / doPost) · 3 Pagos · 4 Recargas y FazerCards
//             5 Utilidades
//
// Cómo actualizarlo: pega este archivo en el editor de Apps Script y luego
// Implementar > Gestionar implementaciones > editar (lápiz) > Versión: "Nueva versión" > Implementar.
// Así la URL /exec NO cambia y no hay que tocar Vercel.
//
// Seguridad (opcional): propiedad del script TOKEN_VERCEL = el mismo valor que SCRIPT_RECARGAS_TOKEN
// en Vercel. Mientras no exista, no se comprueba. ORDEN: primero Vercel, después la propiedad.
//
// Reglas que no se deben romper:
//   - Los pagos viven en la hoja CENTRAL (ID_HOJA_PAGOS), la misma de Free Fire.
//   - Un pago encontrado NUNCA vuelve a "Verificado": ante cualquier error queda "Usado" y el
//     pedido se anota en "errores" (por eso ya no existe marcar_verificado).
//   - Cada recarga por la API queda en la pestaña "fazer_card"; el webhook de FazerCards
//     actualiza su estado (⏳ en proceso → ✅ completada / ❌ fallida / ↩️ reembolsada).
// =====================================================================


// =====================================================================
// 1. CONFIGURACIÓN
// =====================================================================

const PROJECT_ID = "levelupstore-87d4d";
const COLLECTION_NAME = "Pagos";
const FOLDER_ID = "12-YApHdXIFtbIk9qzNCiUY0SVsimCecO"; // Carpeta de comprobantes
const ID_HOJA_PAGOS = "1hYl8yGJzmlB2-O6VK9UghZFN5nI7S7Ld5uhA3Np-4X8"; // Hoja central de pagos

// Versión que la tienda lee en obtener_precios: con 2 o más, Vercel sabe que verificar_pago es
// idempotente (idPedido) y que puede reintentarlo tras un timeout sin bloquear otro pago.
const VERSION_SCRIPT = 2;

// Vercel espera hasta 15 s por intento: si el candado tarda más que esto, es mejor responder
// "ocupado" (Vercel reintenta) que trabajar para una petición que ya nadie espera.
const ESPERA_CANDADO_MS = 8000;
// Webhook de FazerCards: solo espera 10 s (si no, lo reintenta en 1 minuto)
const ESPERA_CANDADO_WEBHOOK_MS = 4000;
const MENSAJE_ERROR_INTERNO = "Error interno en el sistema de recargas. Intenta de nuevo en unos segundos.";

// Los comprobantes muestran nombre/cédula del cliente: por defecto solo los ve el dueño de la carpeta.
const COMPARTIR_COMPROBANTES_CON_ENLACE = false;

// Columnas de "errores" (A-D son las de siempre; E-H agregan el detalle que manda Vercel)
const COLUMNAS_ERRORES = ["fecha-hora", "id", "producto", "informe completo", "fase del fallo", "motivo técnico", "estado del pago", "id pedido"];
// "finalizados": A-E de siempre; F = orden de FazerCards
const TITULO_ORDEN_FINALIZADOS = "orden FazerCards";

// --- FazerCards ---
// Una fila por recarga enviada a la API. La columna J ("estado") la actualiza el webhook.
const HOJA_FAZER = "fazer_card";
const COLUMNAS_FAZER = ["fecha-hora", "id jugador", "paquete", "oferta FazerCards", "referencia", "cobrado (Bs)",
  "comprobante", "id pedido", "orden FazerCards", "estado", "actualizado", "detalle"];
const ORDEN_FAZER_VALIDA = /^[A-Za-z0-9_.:-]{1,80}$/;
const TEXTO_ESTADO_FAZER = { processing: "⏳ EN PROCESO", completed: "✅ COMPLETADA", failed: "❌ FALLIDA", refund: "↩️ REEMBOLSADA", refunded: "↩️ REEMBOLSADA" };
// Aviso del webhook que llegó antes de que la orden se anotara: se guarda este tiempo (máximo de CacheService)
const ESPERA_AVISO_FAZER_S = 21600;


// =====================================================================
// 2. ENTRADA
// =====================================================================

// GET: solo los precios (la tienda los pide así para evitar redirecciones de POST)
function doGet(e) {
  var accion = (e && e.parameter && e.parameter.accion) ? e.parameter.accion : "";
  if (accion === "obtener_precios") return obtenerPrecios();
  return responder({ status: "error", message: "Acción no válida por GET" });
}

function doPost(e) {
  var datos;
  try {
    datos = JSON.parse((e && e.postData && e.postData.contents) || "{}");
  } catch (err) {
    return responder({ status: "error", message: "JSON inválido" });
  }
  var accion = String(datos.accion || "");

  // Solo Vercel (si la propiedad TOKEN_VERCEL existe)
  var tokenVercel = PropertiesService.getScriptProperties().getProperty("TOKEN_VERCEL");
  if (tokenVercel && String(datos.token || "") !== tokenVercel) {
    return responder({ status: "error", message: "No autorizado" });
  }

  // Lecturas y subidas: no tocan pagos, así que NO esperan el candado
  var sinCandado = {
    obtener_precios: obtenerPrecios,
    subir_imagen: subirImagen
  };
  // Cambian pagos o registros: una a la vez
  var conCandadoAcciones = {
    verificar_pago: verificarPago,
    marcar_usado: marcarUsado,
    registrar_finalizado: registrarFinalizado,
    registrar_error: registrarError
  };

  try {
    // Webhook de FazerCards (api/fazer-webhook.js): espera menos el candado porque FazerCards corta a los 10 s
    if (accion === "estado_fazer") return conCandado(function () { return estadoFazer(datos); }, ESPERA_CANDADO_WEBHOOK_MS);
    if (sinCandado.hasOwnProperty(accion)) return sinCandado[accion](datos);
    if (conCandadoAcciones.hasOwnProperty(accion)) {
      return conCandado(function () { return conCandadoAcciones[accion](datos); });
    }
    return responder({ status: "error", message: "Acción no válida" });
  } catch (error) {
    console.error("Error en acción " + accion + ": " + (error && error.stack || error));
    return responder({ status: "error", message: MENSAJE_ERROR_INTERNO });
  }
}

// 🛡️ Candado: una sola operación sobre pagos a la vez
function conCandado(operacion, esperaMs) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(esperaMs || ESPERA_CANDADO_MS)) {
    return responder({ status: "error", ocupado: true, message: "⚠️ Sistema ocupado procesando otra transacción. Por favor, intenta de nuevo en unos segundos." });
  }
  try {
    return operacion();
  } catch (error) {
    console.error("Error dentro del candado: " + (error && error.stack || error));
    return responder({ status: "error", message: MENSAJE_ERROR_INTERNO });
  } finally {
    lock.releaseLock();
  }
}


// =====================================================================
// 3. PAGOS (hoja central, pestaña "pagos": A fecha · B teléfono · C referencia · D monto · E estado)
//    Estados: Verificado -> En proceso (lo tomó un pedido) -> Usado. Nunca vuelve atrás.
// =====================================================================

// Busca el pago por los últimos 5 dígitos y lo bloquea ("En proceso") para que nadie más lo use
function verificarPago(datos) {
  var ultimos5 = String(datos.referencia || "").replace(/\s+/g, "");
  if (!/^\d{5}$/.test(ultimos5)) {
    return responder({ status: "success", encontrado: false, message: "🔍 La referencia debe tener exactamente 5 dígitos." });
  }
  var precioRequerido = limpiarMontoVES(datos.monto);
  var hojaPagos = hojaCentralPagos();
  var rows = hojaPagos.getDataRange().getValues();

  var idPedido = String(datos.idPedido || "");
  var props = PropertiesService.getScriptProperties();
  var respuestaEncontrado = function (i, repetido) {
    var montoPago = limpiarMontoVES(rows[i][3]);
    return responder({
      status: "success", encontrado: true, fila: i + 1, telefono: String(rows[i][1]).trim(),
      referencia: String(rows[i][2]).replace(/\s+/g, ""), montoPagado: montoPago,
      insuficiente: montoPago < (precioRequerido - 0.50), repetido: repetido
    });
  };

  // De abajo hacia arriba: el pago disponible más reciente; los ya usados se saltan
  var hayUsado = false, hayEnProceso = false;
  for (var i = rows.length - 1; i >= 1; i--) {
    var referenciaCompleta = String(rows[i][2]).replace(/\s+/g, "");
    if (!referenciaCompleta || referenciaCompleta.slice(-5) !== ultimos5) continue;

    var estadoActual = String(rows[i][4]).trim().toLowerCase();
    if (estadoActual === "usado" || estadoActual === "usada") { hayUsado = true; continue; }
    if (estadoActual === "en proceso") {
      // Reintento de la MISMA petición (Vercel no recibió la primera respuesta): mismo resultado
      if (idPedido && props.getProperty("proc_" + referenciaCompleta) === idPedido) return respuestaEncontrado(i, true);
      hayEnProceso = true; continue;
    }
    if (estadoActual !== "verificado" && estadoActual !== "") continue;

    hojaPagos.getRange(i + 1, 5).setValue("En proceso");
    SpreadsheetApp.flush();
    if (idPedido) props.setProperty("proc_" + referenciaCompleta, idPedido);
    actualizarEstadoFirebase(referenciaCompleta, "En proceso");
    return respuestaEncontrado(i, false);
  }

  if (hayEnProceso) {
    return responder({ status: "success", encontrado: false, message: "⚠️ Otro cliente está procesando esta referencia en este momento." });
  }
  if (hayUsado) {
    return responder({ status: "success", encontrado: false, message: "❌ Este pago ya fue validado y gastado." });
  }
  return responder({ status: "success", encontrado: false, message: "🔍 Referencia no encontrada en el sistema." });
}

// Éxito definitivo o pago bloqueado para revisión
function marcarUsado(datos) {
  var cambiado = cambiarEstadoPago(datos.referencia, "Usado", null);
  return responder({ status: "success", cambiado: cambiado });
}

// Cambia el estado del pago con esa referencia completa (la fila más reciente).
// Si soloSiEstado se indica, solo cambia cuando el estado actual coincide.
function cambiarEstadoPago(referencia, nuevoEstado, soloSiEstado) {
  var refBuscada = String(referencia || "").replace(/\s+/g, "");
  if (!refBuscada) return false;
  var hoja = hojaCentralPagos();
  var rows = hoja.getDataRange().getValues();
  for (var r = rows.length - 1; r >= 1; r--) {
    if (String(rows[r][2]).replace(/\s+/g, "") !== refBuscada) continue;
    if (soloSiEstado && String(rows[r][4]).trim().toLowerCase() !== soloSiEstado) return false;
    hoja.getRange(r + 1, 5).setValue(nuevoEstado);
    SpreadsheetApp.flush();
    PropertiesService.getScriptProperties().deleteProperty("proc_" + refBuscada);
    actualizarEstadoFirebase(refBuscada, nuevoEstado);
    return true;
  }
  return false;
}

// Un fallo de Firebase nunca debe tumbar la operación: la hoja es la fuente de verdad
function actualizarEstadoFirebase(referencia, nuevoEstado) {
  try {
    var docId = "ref_" + referencia;
    var url = "https://firestore.googleapis.com/v1/projects/" + PROJECT_ID + "/databases/(default)/documents/" +
      COLLECTION_NAME + "/" + encodeURIComponent(docId) + "?updateMask.fieldPaths=estado";
    var respuesta = UrlFetchApp.fetch(url, {
      method: "patch", contentType: "application/json",
      headers: { "Authorization": "Bearer " + ScriptApp.getOAuthToken() },
      payload: JSON.stringify({ fields: { estado: { stringValue: String(nuevoEstado) } } }),
      muteHttpExceptions: true
    });
    if (respuesta.getResponseCode() >= 300) {
      console.error("Firebase respondió " + respuesta.getResponseCode() + " para " + docId);
    }
  } catch (err) {
    console.error("No se pudo actualizar Firebase para " + referencia + ": " + err);
  }
}


// =====================================================================
// 4. RECARGAS Y FAZERCARDS
//    obtener_precios -> verificar_pago -> orden en FazerCards (Vercel) -> marcar_usado
//    -> registrar_finalizado (éxito, con la orden) o registrar_error (fallo)
// =====================================================================

// Sin candado: pestaña "PreciosBlood" (o "precios"): fila 1 = paquetes, fila 2 = precios
function obtenerPrecios() {
  var libroLocal = SpreadsheetApp.getActiveSpreadsheet();
  var hojaPrecios = libroLocal.getSheetByName("PreciosBlood") || libroLocal.getSheetByName("precios") || libroLocal.getSheetByName("Precios");
  if (!hojaPrecios) return responder({ status: "error", message: "Falta pestaña de precios" });

  var rows = hojaPrecios.getDataRange().getValues();
  var paquetes = [];
  if (rows.length >= 2) {
    for (var i = 0; i < rows[0].length; i++) {
      var titulo = String(rows[0][i] || "").trim();
      if (titulo) paquetes.push({ diamantes: titulo, precio: rows[1][i] });
    }
  }
  return responder({ status: "success", catalogo: paquetes, version: VERSION_SCRIPT });
}

// Recarga exitosa: fila en "finalizados" y, si vino por la API, fila en "fazer_card"
function registrarFinalizado(datos) {
  var hojaFinalizados = obtenerHojaLocal("finalizados");
  if (!hojaFinalizados) return responder({ status: "error", message: "Falta la pestaña finalizados" });
  var fechaHora = ahora();
  var orden = String(datos.ordenFazer || "");
  if (orden && !String(hojaFinalizados.getRange(1, 6).getValue() || "").trim()) {
    hojaFinalizados.getRange(1, 6).setValue(TITULO_ORDEN_FINALIZADOS);
  }
  hojaFinalizados.appendRow([
    fechaHora,
    textoSeguro(datos.idJugador),
    textoSeguro(datos.paquete),
    textoSeguro(datos.referencia || datos.referencias),
    textoSeguro(datos.urlImagen || "Sin comprobante"),
    textoSeguro(orden)
  ]);
  if (orden) anotarOrdenFazer(datos, fechaHora);
  SpreadsheetApp.flush();
  return responder({ status: "success", message: "Guardado correctamente" });
}

// Fallo (proveedor, pago insuficiente...): fila en "errores". NO cambia el estado del pago.
function registrarError(datos) {
  var hojaErrores = obtenerHojaLocal("errores");
  if (!hojaErrores) {
    hojaErrores = SpreadsheetApp.getActiveSpreadsheet().insertSheet("errores");
    hojaErrores.appendRow(COLUMNAS_ERRORES);
  } else if (!String(hojaErrores.getRange(1, 5).getValue() || "").trim()) {
    hojaErrores.getRange(1, 5, 1, COLUMNAS_ERRORES.length - 4).setValues([COLUMNAS_ERRORES.slice(4)]);
  }

  hojaErrores.appendRow([
    ahora(),
    textoSeguro(datos.idJugador || "Desconocido"),
    textoSeguro(datos.paquete || "Desconocido"),
    textoSeguro(datos.urlImagen || datos.error || "Fallo en Proveedor FazerCards"),
    textoSeguro(datos.fase || ""),
    textoSeguro(datos.motivo || ""),
    textoSeguro(datos.estadoPago || ""),
    textoSeguro(datos.idPedido || "")
  ]);
  SpreadsheetApp.flush();
  return responder({ status: "success", message: "Error guardado correctamente" });
}

// Sin candado: comprobante de pago a la carpeta de Drive
function subirImagen(datos) {
  var contenido = String(datos.base64 || "");
  var archivoBase64 = contenido.indexOf(",") !== -1 ? contenido.split(",")[1] : contenido;
  if (!archivoBase64) return responder({ status: "error", message: "Imagen vacía" });

  var mimeType = /^image\/(png|jpe?g|webp|gif|heic|heif)$/.test(String(datos.mimeType)) ? datos.mimeType : "image/jpeg";
  var nombre = String(datos.nombre || "comprobante").replace(/[\\/:*?"<>|]/g, "_").slice(0, 100);

  var blob = Utilities.newBlob(Utilities.base64Decode(archivoBase64), mimeType, nombre);
  var archivo = DriveApp.getFolderById(FOLDER_ID).createFile(blob);
  if (COMPARTIR_COMPROBANTES_CON_ENLACE) {
    archivo.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  }
  return responder({ status: "success", url: archivo.getUrl() });
}

// --- Pestaña "fazer_card" ---

// Nueva fila con la orden que aceptó FazerCards. Si el webhook avisó antes, se aplica ese estado.
function anotarOrdenFazer(datos, fechaHora) {
  var orden = String(datos.ordenFazer);
  if (buscarFilaFazer(9, orden)) return; // reintento de registrar_finalizado: ya está
  var hoja = hojaFazer();
  hoja.appendRow([
    fechaHora,
    textoSeguro(datos.idJugador),
    textoSeguro(datos.paquete),
    textoSeguro(datos.ofertaFazer || ""),
    textoSeguro(datos.referencia || datos.referencias),
    limpiarMontoVES(datos.montoCobrado),
    textoSeguro(datos.urlImagen || "Sin comprobante"),
    textoSeguro(datos.idPedido || ""),
    textoSeguro(orden),
    textoEstadoFazer(datos.estadoFazer || "processing"),
    fechaHora,
    "orden aceptada por FazerCards"
  ]);
  var cache = CacheService.getScriptCache();
  var guardado = cache.get("fazer_" + orden);
  if (guardado) {
    var aviso = JSON.parse(guardado);
    aplicarEstadoFazer(hoja.getLastRow(), aviso.estado, aviso.evento);
    cache.remove("fazer_" + orden);
  }
}

// Webhook de FazerCards (acción estado_fazer, con candado): nuevo estado de una orden.
// Se puede repetir: el mismo estado dos veces no cambia nada.
function estadoFazer(datos) {
  var orden = String(datos.ordenFazer || "");
  var estado = String(datos.estado || "").toLowerCase();
  if (!ORDEN_FAZER_VALIDA.test(orden) || !/^[a-z_]{1,30}$/.test(estado)) {
    return responder({ status: "error", message: "Datos de FazerCards inválidos" });
  }
  var fila = buscarFilaFazer(9, orden);
  if (!fila) {
    // La orden aún no se anotó (el aviso llegó antes que registrar_finalizado) o es de Free Fire
    // (misma cuenta): se guarda unas horas por si aparece
    CacheService.getScriptCache().put("fazer_" + orden, JSON.stringify({ estado: estado, evento: String(datos.evento || "") }), ESPERA_AVISO_FAZER_S);
    return responder({ status: "success", encontrado: false });
  }
  aplicarEstadoFazer(fila, estado, datos.evento);
  SpreadsheetApp.flush();
  return responder({ status: "success", encontrado: true });
}

// Si la orden falló o se reembolsó, la recarga NO llegó al jugador: se anota UNA vez en "errores"
// para hacerla a mano (el pago ya está "Usado").
function aplicarEstadoFazer(fila, estado, evento) {
  var hoja = hojaFazer();
  var valores = hoja.getRange(fila, 1, 1, COLUMNAS_FAZER.length).getValues()[0];
  var anterior = String(valores[9]);
  var texto = textoEstadoFazer(estado);
  if (anterior === texto) return;
  var fallo = estado === "failed" || estado.indexOf("refund") === 0;
  if (fallo && !/FALLIDA|REEMBOLSADA/.test(anterior)) {
    var motivo = "FazerCards marcó la orden " + valores[8] + " como " + estado + ": la recarga NO llegó al jugador";
    registrarError({
      idJugador: valores[1], paquete: valores[2], idPedido: valores[7],
      fase: "4. RECARGA EN LA API DEL PROVEEDOR (FazerCards) - aviso posterior del webhook",
      motivo: motivo,
      estadoPago: "USADO: hacer la recarga a mano o devolver el pago",
      urlImagen: motivo + " | JUGADOR: " + valores[1] + " | PAQUETE: " + valores[2] + " | REFERENCIA: " + valores[4] + " | PEDIDO: " + valores[7]
    });
  }
  hoja.getRange(fila, 10).setValue(texto);
  hoja.getRange(fila, 11).setValue(ahora());
  hoja.getRange(fila, 12).setValue(textoSeguro("aviso " + String(evento || "de FazerCards") + (fallo ? " - anotado en errores" : "")));
}

function hojaFazer() {
  var hoja = obtenerHojaLocal(HOJA_FAZER);
  if (!hoja) {
    hoja = SpreadsheetApp.getActiveSpreadsheet().insertSheet(HOJA_FAZER, 0);
    hoja.appendRow(COLUMNAS_FAZER);
    hoja.getRange(1, 1, 1, COLUMNAS_FAZER.length).setFontWeight("bold");
    hoja.setFrozenRows(1);
  }
  return hoja;
}

// Fila (la más reciente) de "fazer_card" con ese valor exacto en esa columna (9 = orden)
function buscarFilaFazer(columna, valor) {
  var hoja = obtenerHojaLocal(HOJA_FAZER);
  if (!valor || !hoja || hoja.getLastRow() < 2) return 0;
  var celdas = hoja.getRange(2, columna, hoja.getLastRow() - 1, 1)
    .createTextFinder(String(valor)).matchEntireCell(true).matchCase(true).findAll();
  return celdas.length ? celdas[celdas.length - 1].getRow() : 0;
}

function textoEstadoFazer(estado) {
  var e = String(estado || "").toLowerCase();
  return (TEXTO_ESTADO_FAZER[e] || "❔ " + e.toUpperCase()) + " (" + e + ")";
}


// =====================================================================
// 5. UTILIDADES
// =====================================================================

function responder(objeto) {
  return ContentService.createTextOutput(JSON.stringify(objeto)).setMimeType(ContentService.MimeType.JSON);
}

// Fecha y hora de Venezuela con el formato de todas las pestañas
function ahora() {
  return Utilities.formatDate(new Date(), "America/Caracas", "dd/MM/yyyy HH:mm:ss");
}

// Acepta "errores" o "Errores". null si no existe.
function obtenerHojaLocal(nombre) {
  var libro = SpreadsheetApp.getActiveSpreadsheet();
  return libro.getSheetByName(nombre) || libro.getSheetByName(nombre.charAt(0).toUpperCase() + nombre.slice(1));
}

function hojaCentralPagos() {
  var libroPagos = SpreadsheetApp.openById(ID_HOJA_PAGOS);
  var hoja = libroPagos.getSheetByName("pagos") || libroPagos.getSheetByName("Pagos");
  if (!hoja) throw new Error("Falta la pestaña 'pagos' en la hoja central");
  return hoja;
}

// Texto que se escribe en la hoja: si empieza como fórmula (= + - @) se guarda como texto
function textoSeguro(valor) {
  var texto = String(valor === undefined || valor === null ? "" : valor).slice(0, 3000);
  return /^[=+\-@\t\r]/.test(texto) ? "'" + texto : texto;
}

function limpiarMontoVES(valor) {
  if (typeof valor === "number") return valor;
  if (!valor) return 0;

  var m = String(valor).trim().replace(/[^0-9.,]/g, "");
  if (!m) return 0;

  if (m.indexOf(",") !== -1 && m.indexOf(".") !== -1) {
    if (m.lastIndexOf(",") > m.lastIndexOf(".")) { m = m.replace(/\./g, "").replace(",", "."); }
    else { m = m.replace(/,/g, ""); }
  } else if (m.indexOf(".") !== -1) {
    var partes = m.split(".");
    if (partes.length > 2 || (partes.length === 2 && partes[1].length === 3)) { m = m.replace(/\./g, ""); }
  } else if (m.indexOf(",") !== -1) {
    m = m.replace(",", ".");
  }
  return parseFloat(m) || 0;
}
