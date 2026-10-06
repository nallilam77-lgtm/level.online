// =====================================================================
// LEVEL UP - Apps Script de RECARGAS FREE FIRE (variable SCRIPT_RECARGAS_URL en Vercel)
// Usado por: api/recargar.js, api/precios.js, api/subir-imagen.js y MacroDroid.
//
// Cómo actualizarlo: pega este archivo en el editor de Apps Script y luego
// Implementar > Gestionar implementaciones > editar (lápiz) > Versión: "Nueva versión" > Implementar.
// Así la URL /exec NO cambia y no hay que tocar Vercel.
//
// Seguridad (Configuración del proyecto > Propiedades del script), ambas opcionales:
//   TOKEN_VERCEL     = el mismo valor que SCRIPT_RECARGAS_TOKEN en Vercel.
//   MACRODROID_CLAVE = clave que MacroDroid envía en el campo "clave" del JSON.
// Mientras una propiedad no exista, esa comprobación se omite (compatible con lo anterior).
// ORDEN: primero configura Vercel/MacroDroid, después crea la propiedad.
// =====================================================================

const PROJECT_ID = "levelupstore-87d4d";
const COLLECTION_NAME = "Pagos";
const FOLDER_ID = "12-YApHdXIFtbIk9qzNCiUY0SVsimCecO";

// Vercel corta sus llamadas a los 6-9 s: si el candado tarda más que esto en liberarse,
// es mejor responder "ocupado" que trabajar para una petición que ya nadie espera
// (eso dejaba pagos "En proceso" o pines borrados sin usar).
const ESPERA_CANDADO_MS = 5000;

// Los comprobantes muestran nombre/cédula del cliente: por defecto solo los ve el dueño de la carpeta.
const COMPARTIR_COMPROBANTES_CON_ENLACE = false;

function doPost(e) {
  var datos;
  try {
    datos = JSON.parse((e && e.postData && e.postData.contents) || "{}");
  } catch (err) {
    return responder({ status: "error", message: "JSON inválido" });
  }
  var accion = datos.accion || "";
  var props = PropertiesService.getScriptProperties();

  // ==========================================
  // 0: MACRODROID (GUARDAR PAGO AUTOMÁTICO) - no envía "accion"
  // ==========================================
  if (!accion && (datos.referencia || datos.monto || datos.telefono)) {
    var claveMacro = props.getProperty("MACRODROID_CLAVE");
    if (claveMacro && String(datos.clave || "") !== claveMacro) {
      return responder({ status: "error", message: "No autorizado" });
    }
    return conCandado(function () { return guardarPagoMacroDroid(datos); });
  }

  // Todas las demás acciones solo las puede pedir Vercel
  var tokenVercel = props.getProperty("TOKEN_VERCEL");
  if (tokenVercel && String(datos.token || "") !== tokenVercel) {
    return responder({ status: "error", message: "No autorizado" });
  }

  try {
    // Lecturas y subidas: no tocan pagos ni pines, así que NO esperan el candado
    if (accion === "obtener_precios") return obtenerPrecios();
    if (accion === "subir_imagen") return subirImagen(datos);

    switch (accion) {
      case "verificar_pago":       return conCandado(function () { return verificarPago(datos); });
      case "obtener_codigo":       return conCandado(function () { return obtenerCodigo(datos); });
      case "marcar_usado":         return conCandado(function () { return marcarUsado(datos); });
      case "marcar_verificado":    return conCandado(function () { return marcarVerificado(datos); });
      case "registrar_finalizado": return conCandado(function () { return registrarFinalizado(datos); });
      case "registrar_error":      return conCandado(function () { return registrarError(datos); });
    }
    return responder({ status: "error", message: "Acción no válida" });
  } catch (error) {
    console.error("Error en acción " + accion + ": " + (error && error.stack || error));
    return responder({ status: "error", message: "Error interno en el sistema de recargas. Intenta de nuevo en unos segundos." });
  }
}

// 🛡️ Candado: una sola operación sobre pagos/pines a la vez
function conCandado(operacion) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(ESPERA_CANDADO_MS)) {
    return responder({ status: "error", ocupado: true, message: "⚠️ Sistema ocupado procesando otra transacción. Por favor, intenta de nuevo en unos segundos." });
  }
  try {
    return operacion();
  } catch (error) {
    console.error("Error dentro del candado: " + (error && error.stack || error));
    return responder({ status: "error", message: "Error interno en el sistema de recargas. Intenta de nuevo en unos segundos." });
  } finally {
    lock.releaseLock();
  }
}

// ==========================================
// 0: MACRODROID
// ==========================================
function guardarPagoMacroDroid(datos) {
  var hoja = obtenerHoja("pagos");
  var ref = String(datos.referencia || "").replace(/\s+/g, "");
  if (!ref) {
    return responder({ status: "error", message: "Referencia vacía" });
  }

  // Si MacroDroid manda la misma notificación dos veces, no se crea un segundo pago
  // (con dos filas iguales el cliente podría gastar el mismo pago dos veces).
  var rows = hoja.getDataRange().getValues();
  for (var i = rows.length - 1; i >= 1; i--) {
    if (String(rows[i][2]).replace(/\s+/g, "") === ref) {
      return responder({ status: "success", duplicado: true, message: "Pago ya registrado" });
    }
  }

  var fechaHora = Utilities.formatDate(new Date(), "America/Caracas", "dd/MM/yyyy HH:mm:ss");
  hoja.appendRow([fechaHora, textoSeguro(datos.telefono), ref, textoSeguro(datos.monto || "0"), "Verificado"]);
  SpreadsheetApp.flush();
  return responder({ status: "success", message: "Pago guardado automáticamente" });
}

// ==========================================
// 1: VERIFICAR Y BLOQUEAR PAGO (Para que nadie más lo use)
// ==========================================
function verificarPago(datos) {
  var hoja = obtenerHoja("pagos");
  var ultimos5 = String(datos.referencia || "").replace(/\s+/g, "");
  if (!/^\d{5}$/.test(ultimos5)) {
    return responder({ status: "success", encontrado: false, message: "🔍 La referencia debe tener exactamente 5 dígitos." });
  }
  var precioRequerido = limpiarMontoVES(datos.monto);
  var rows = hoja.getDataRange().getValues();

  // Solo coincidencia EXACTA de los últimos 5 dígitos (se eliminó la búsqueda "contiene":
  // multiplicaba las posibilidades de acertar el pago de otro cliente probando números).
  // De abajo hacia arriba, se elige el pago disponible más reciente y se saltan los ya usados,
  // así un pago viejo "Usado" con los mismos 5 dígitos no bloquea uno nuevo.
  var hayUsado = false, hayEnProceso = false;
  for (var i = rows.length - 1; i >= 1; i--) {
    var referenciaCompleta = String(rows[i][2]).replace(/\s+/g, "");
    if (!referenciaCompleta || referenciaCompleta.slice(-5) !== ultimos5) continue;

    var estadoActual = String(rows[i][4]).trim().toLowerCase();
    if (estadoActual === "usado") { hayUsado = true; continue; }
    if (estadoActual === "en proceso") { hayEnProceso = true; continue; }
    if (estadoActual !== "verificado" && estadoActual !== "") continue;

    var filaNum = i + 1;
    var montoPago = limpiarMontoVES(rows[i][3]);

    // Bloquear al instante
    hoja.getRange(filaNum, 5).setValue("En proceso");
    SpreadsheetApp.flush();
    actualizarEstadoFirebase(referenciaCompleta, "En proceso");

    return responder({
      status: "success", encontrado: true, fila: filaNum, telefono: String(rows[i][1]).trim(),
      referencia: referenciaCompleta, montoPagado: montoPago,
      insuficiente: montoPago < (precioRequerido - 0.50)
    });
  }

  if (hayEnProceso) {
    return responder({ status: "success", encontrado: false, message: "⚠️ Otro cliente está procesando esta referencia en este momento." });
  }
  if (hayUsado) {
    return responder({ status: "success", encontrado: false, message: "❌ Este pago ya fue validado y gastado en otra recarga." });
  }
  return responder({ status: "success", encontrado: false, message: "🔍 Referencia no encontrada en el sistema." });
}

// ==========================================
// 2: OBTENER Y QUEMAR CÓDIGOS DE INVENTARIO
// ==========================================
function obtenerCodigo(datos) {
  var hojaCodigos = obtenerHoja("codigos");
  var diamantesBuscados = String(datos.diamantes || "").replace(/[^0-9]/g, "");
  var cantidadNecesaria = (diamantesBuscados === "220") ? 2 : 1;
  var columnaBuscar = (diamantesBuscados === "220") ? "110" : diamantesBuscados;

  var headers = hojaCodigos.getRange(1, 1, 1, hojaCodigos.getLastColumn()).getValues()[0];
  var colIndex = -1;
  for (var h = 0; h < headers.length; h++) {
    if (String(headers[h]).replace(/[^0-9]/g, "") === columnaBuscar) { colIndex = h + 1; break; }
  }
  if (!columnaBuscar || colIndex === -1) {
    return responder({ status: "error", message: "Columna de códigos no configurada para " + columnaBuscar });
  }

  var codigosAsignados = [];
  var filasConDatos = hojaCodigos.getLastRow() - 1; // sin la fila de títulos
  if (filasConDatos > 0) {
    var values = hojaCodigos.getRange(2, colIndex, filasConDatos, 1).getValues();
    for (var i = 0; i < values.length && codigosAsignados.length < cantidadNecesaria; i++) {
      var codigo = String(values[i][0] || "").trim();
      if (codigo) codigosAsignados.push({ fila: i + 2, codigo: codigo });
    }
  }

  if (codigosAsignados.length < cantidadNecesaria) {
    return responder({ status: "error", message: "⚠️ ¡Nos quedamos sin stock! Faltan pines de " + columnaBuscar + " diamantes." });
  }

  // Borrar los códigos usados de inmediato
  for (var k = 0; k < codigosAsignados.length; k++) {
    hojaCodigos.getRange(codigosAsignados[k].fila, colIndex).clearContent();
  }
  SpreadsheetApp.flush();

  return responder({ status: "success", pines: codigosAsignados.map(function (c) { return c.codigo; }) });
}

// ==========================================
// 3: MARCAR COMO USADO (Éxito definitivo o pago bloqueado para revisión)
// ==========================================
function marcarUsado(datos) {
  cambiarEstadoPago(datos.referencia, "Usado", null);
  return responder({ status: "success" });
}

// ==========================================
// 4: DEVOLVER A VERIFICADO (error sin códigos, pago insuficiente...)
// ==========================================
function marcarVerificado(datos) {
  // Solo libera pagos que estaban "En proceso": nunca revive un pago "Usado"
  cambiarEstadoPago(datos.referencia, "Verificado", "en proceso");
  return responder({ status: "success" });
}

// ==========================================
// 5: SUBIR IMAGEN A DRIVE
// ==========================================
function subirImagen(datos) {
  var contenido = String(datos.base64 || "");
  var archivoBase64 = contenido.indexOf(",") !== -1 ? contenido.split(",")[1] : contenido; // con o sin "data:...;base64,"
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

// ==========================================
// 6: REGISTRAR EN FINALIZADOS CON CÓDIGOS USADOS
// ==========================================
function registrarFinalizado(datos) {
  var hojaFinalizados = obtenerHoja("finalizados");
  var fechaHora = Utilities.formatDate(new Date(), "America/Caracas", "dd/MM/yyyy HH:mm:ss");
  hojaFinalizados.appendRow([
    fechaHora,                                           // A
    textoSeguro(datos.idJugador),                        // B
    textoSeguro(datos.paquete),                          // C
    textoSeguro(datos.referencias || datos.referencia),  // D
    textoSeguro(datos.codigosUsados || "No especificado"), // E
    textoSeguro(datos.urlImagen || "Sin comprobante")    // F
  ]);
  SpreadsheetApp.flush();
  // (Se quitó la llamada a /api/sincronizar-pedidos: ese endpoint no existe en la tienda
  //  y la petición alargaba el candado en cada recarga.)
  return responder({ status: "success", message: "Guardado en finalizados correctamente" });
}

// ==========================================
// 7: OBTENER PRECIOS (sin candado: solo lectura)
// ==========================================
function obtenerPrecios() {
  var hojaPrecios = obtenerHoja("precios", true);
  if (!hojaPrecios) return responder({ status: "error", message: "Falta pestaña precios" });

  var rows = hojaPrecios.getDataRange().getValues();
  var paquetes = [];
  if (rows.length >= 2) {
    for (var i = 0; i < rows[0].length; i++) {
      var titulo = String(rows[0][i] || "").trim();
      if (titulo) paquetes.push({ diamantes: titulo, precio: rows[1][i] });
    }
  }
  return responder({ status: "success", catalogo: paquetes });
}

// ==========================================
// 🛡️ 8: REGISTRAR ERROR DEL BOT Y SALVAR CÓDIGOS
// ==========================================
function registrarError(datos) {
  var hojaErrores = obtenerHoja("errores", true);
  if (!hojaErrores) {
    // Antes, sin esta pestaña los pines del error se perdían en silencio
    hojaErrores = SpreadsheetApp.getActiveSpreadsheet().insertSheet("errores");
    hojaErrores.appendRow(["fecha-hora", "id", "codigos", "producto", "url / motivo"]);
  }
  var fechaHora = Utilities.formatDate(new Date(), "America/Caracas", "dd/MM/yyyy HH:mm:ss");
  hojaErrores.appendRow([
    fechaHora,                                                       // A: fecha-hora
    textoSeguro(datos.idJugador || "Desconocido"),                   // B: id
    textoSeguro(datos.codigosUsados || "Ninguno"),                   // C: codigos (¡AQUÍ SE SALVAN!)
    textoSeguro(datos.paquete || "Desconocido"),                     // D: producto
    textoSeguro(datos.urlImagen || datos.error || "Fallo en el Bot") // E: url o motivo
  ]);
  SpreadsheetApp.flush();

  // YA NO cambia el estado del pago. Antes lo devolvía a "Verificado", y si Vercel marcaba
  // "Usado" al mismo tiempo, el pago podía quedar libre para usarse otra vez tras un fallo
  // del bot (con pines quizá ya canjeados). Vercel decide el estado final después de
  // registrar el error: marcar_usado (bloquear para revisión) o marcar_verificado (liberar).
  return responder({ status: "success", message: "Error guardado correctamente y códigos respaldados" });
}

// ==========================================
// FUNCIONES AUXILIARES
// ==========================================

function responder(objeto) {
  return ContentService.createTextOutput(JSON.stringify(objeto)).setMimeType(ContentService.MimeType.JSON);
}

// Acepta "pagos" o "Pagos". Con opcional=true devuelve null si no existe.
function obtenerHoja(nombre, opcional) {
  var libro = SpreadsheetApp.getActiveSpreadsheet();
  var hoja = libro.getSheetByName(nombre) || libro.getSheetByName(nombre.charAt(0).toUpperCase() + nombre.slice(1));
  if (!hoja && !opcional) throw new Error("Falta la pestaña '" + nombre + "'");
  return hoja;
}

// Texto que se escribe en la hoja: si empieza como fórmula (= + - @) se guarda como texto
function textoSeguro(valor) {
  var texto = String(valor === undefined || valor === null ? "" : valor).slice(0, 1000);
  return /^[=+\-@]/.test(texto) ? "'" + texto : texto;
}

// Cambia el estado del pago con esa referencia completa (la fila más reciente).
// Si soloSiEstado se indica, solo cambia cuando el estado actual coincide.
function cambiarEstadoPago(referencia, nuevoEstado, soloSiEstado) {
  var refBuscada = String(referencia || "").replace(/\s+/g, "");
  if (!refBuscada) return;
  var hoja = obtenerHoja("pagos");
  var rows = hoja.getDataRange().getValues();
  for (var r = rows.length - 1; r >= 1; r--) {
    if (String(rows[r][2]).replace(/\s+/g, "") !== refBuscada) continue;
    if (soloSiEstado && String(rows[r][4]).trim().toLowerCase() !== soloSiEstado) return;
    hoja.getRange(r + 1, 5).setValue(nuevoEstado);
    SpreadsheetApp.flush();
    actualizarEstadoFirebase(refBuscada, nuevoEstado);
    return;
  }
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

// Ejecutar a mano desde el editor si quedaron pagos trabados en "En proceso".
// Toma el candado para no liberar un pago que se está procesando justo ahora.
function liberarPagosAtascados() {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var hoja = obtenerHoja("pagos");
    var rows = hoja.getDataRange().getValues();
    for (var i = 1; i < rows.length; i++) {
      if (String(rows[i][4]).trim().toLowerCase() === "en proceso") {
        hoja.getRange(i + 1, 5).setValue("Verificado");
        actualizarEstadoFirebase(String(rows[i][2]).replace(/\s+/g, ""), "Verificado");
      }
    }
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
}

function forzarPermisos() {
  UrlFetchApp.fetch("https://www.google.com");
  Logger.log("Permisos concedidos con éxito");
}
