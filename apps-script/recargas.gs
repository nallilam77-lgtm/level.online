// =====================================================================
// LEVEL UP - Apps Script de RECARGAS FREE FIRE (variable SCRIPT_RECARGAS_URL en Vercel)
// Usado por: api/_lib/juegos/freefire.js (precios, recarga, descuentos), api/subir-imagen.js y MacroDroid.
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
//
// Versión 2: cada pedido de la tienda trae un idPedido. Con él, repetir verificar_pago u
// obtener_codigo devuelve el mismo resultado (la tienda puede reintentar sin sacar pines de más),
// cada asignación queda en la pestaña "asignaciones_pines" y los pines que el bot nunca recibió
// se devuelven al inventario (devolver_codigos). La pestaña "errores" gana las columnas F-L.
//
// Códigos de descuento: pestaña "Descuentos" (A: código, B: descuento, C: usos, D: dinero total
// movido, E: creador, F: PIN, G: % de comisión, H: comisión total USD, I: liquidado Bs, J: pendiente USD,
// K: sin uso (eran los niveles bajados), L: comisión por convertir Bs), común a Free Fire y Blood Strike.
// Vercel consulta el código (validar_descuento), calcula el precio con descuento y, al terminar la
// recarga, suma +1 uso y el monto cobrado a ese código (y la comisión de esa venta a H y J del creador):
// Free Fire dentro de registrar_finalizado; Blood Strike con registrar_uso_descuento.
// =====================================================================

const PROJECT_ID = "levelupstore-87d4d";
const COLLECTION_NAME = "Pagos";
const FOLDER_ID = "12-YApHdXIFtbIk9qzNCiUY0SVsimCecO";

// Versión que la tienda lee en obtener_precios: con 2 o más, Vercel sabe que verificar_pago y
// obtener_codigo son idempotentes (idPedido) y que puede reintentarlos tras un timeout.
const VERSION_SCRIPT = 2;

// Vercel espera hasta 15 s por intento: si el candado tarda más que esto en liberarse,
// es mejor responder "ocupado" (Vercel reintenta) que trabajar para una petición que ya nadie espera.
const ESPERA_CANDADO_MS = 8000;

// Pestaña de auditoría: qué pines se entregaron a cada pedido y qué pasó con ellos
const HOJA_ASIGNACIONES = "asignaciones_pines";
const COLUMNAS_ASIGNACIONES = ["fecha", "id pedido", "referencia", "columna", "n.º columna", "pines", "estado"];

// Ruleta: pestaña donde se anotan los ganadores (para entregar el premio) y máximo de pagos
// con los mismos últimos 5 dígitos que se devuelven a Vercel
const HOJA_RULETA = "ruleta";
const COLUMNAS_RULETA = ["fecha-hora", "id jugador", "referencia", "paquete", "premio", "estado de entrega"];
const MAX_CANDIDATOS_RULETA = 5;

// Códigos de descuento (acepta "Descuentos" o "descuentos"). Columna B:
//   siempre porcentaje sobre el precio: "10%" o "10" = 10 % de descuento.
const HOJA_DESCUENTOS = "descuentos";

// Panel de creadores (códigos con la columna E "creador" llena):
//   - Todos los códigos de creador dan PORCENTAJE_CREADOR de descuento al cliente y el creador
//     gana ese MISMO % de cada venta. Sin niveles, sin metas semanales y sin límite de creadores.
//   - Cada venta guarda SU comisión: el % de ese momento y la tasa de ese día (pestaña "config",
//     B1 = Bs por 1 USD). Se anota en "movimientos_descuentos" y se SUMA a H (total ganado) y
//     J (pendiente de pago). Cambiar el % o la tasa no toca lo ya ganado.
//     G muestra el % actual. Registrar pago deja J en 0. Mínimo para retirar: RETIRO_MINIMO_USD (sobre J).
const PORCENTAJE_CREADOR = 1.5;
const RETIRO_MINIMO_USD = 3;
// Columna L: comisión en Bs de ventas hechas sin ninguna tasa conocida (se pasa a H y J al haber tasa)
const COLUMNA_POR_CONVERTIR = 12;
const HOJA_CONFIG = "config";
// Historial de ventas con código (para los últimos movimientos y la comisión de cada creador).
// D = id del jugador que recargó (para ver quién compra con cada código); I = id del pedido
// (evita anotar dos veces la misma venta). Las filas viejas tienen el id del pedido en D.
const HOJA_MOVIMIENTOS_DESCUENTOS = "movimientos_descuentos";
const COLUMNAS_MOVIMIENTOS_DESCUENTOS = ["fecha-hora", "código", "juego", "id jugador", "venta (Bs)", "comisión (Bs)", "tasa Bs/USD", "comisión (USD)", "id pedido"];
// Registro de cada pago a un creador (lo crea el menú ⭐ Creadores > Registrar pago)
// Ventas que muestra el panel de cada creador en "Últimos movimientos"
const MOVIMIENTOS_PANEL = 10;
const HOJA_PAGOS_CREADORES = "pagos_creadores";
const COLUMNAS_PAGOS_CREADORES = ["fecha-hora", "código", "creador", "ventas liquidadas (Bs)", "comisión (%)", "tasa Bs/USD", "pagado (USD)"];

// Columnas de la pestaña "errores" (A-E son las de siempre; F-L agregan el detalle)
const COLUMNAS_ERRORES = ["fecha-hora", "id", "estado de los pines", "producto", "informe completo",
  "fase del fallo", "referencia", "estado del pago", "motivo técnico", "comprobante", "id pedido", "pines asignados al pedido"];

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
    // Ruleta: consultar solo lee la hoja; el premio lo decide y lo guarda Vercel (Firestore GirosRuleta)
    if (accion === "consultar_ruleta") return consultarRuleta(datos);
    if (accion === "registrar_premio_ruleta") return registrarPremioRuleta(datos);
    // Descuentos: consultar un código solo lee la pestaña "Descuentos"
    if (accion === "validar_descuento") return validarDescuento(datos);
    // Panel de creadores: solo lee "Descuentos" y "movimientos_descuentos"
    if (accion === "consultar_creador") return consultarCreador(datos);

    switch (accion) {
      case "verificar_pago":       return conCandado(function () { return verificarPago(datos); });
      case "obtener_codigo":       return conCandado(function () { return obtenerCodigo(datos); });
      case "devolver_codigos":     return conCandado(function () { return devolverCodigos(datos); });
      case "liberar_pedido":       return conCandado(function () { return liberarPedido(datos); });
      case "marcar_usado":         return conCandado(function () { return marcarUsado(datos); });
      case "marcar_verificado":    return conCandado(function () { return marcarVerificado(datos); });
      case "registrar_finalizado": return conCandado(function () { return registrarFinalizado(datos); });
      case "registrar_error":      return conCandado(function () { return registrarError(datos); });
      case "registrar_uso_descuento": return conCandado(function () { return registrarUsoDescuento(datos); });
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
  var ultima = hoja.getLastRow();
  var referencias = ultima > 1 ? hoja.getRange(2, 3, ultima - 1, 1).getValues() : [];
  for (var i = referencias.length - 1; i >= 0; i--) {
    if (String(referencias[i][0]).replace(/\s+/g, "") === ref) {
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

  var hayUsado = false, hayEnProceso = false;
  for (var i = rows.length - 1; i >= 1; i--) {
    var referenciaCompleta = String(rows[i][2]).replace(/\s+/g, "");
    if (!referenciaCompleta || referenciaCompleta.slice(-5) !== ultimos5) continue;

    var estadoActual = String(rows[i][4]).trim().toLowerCase();
    if (estadoActual === "usado") { hayUsado = true; continue; }
    if (estadoActual === "en proceso") {
      // Reintento de la MISMA petición (Vercel no recibió la primera respuesta): mismo resultado
      if (idPedido && props.getProperty("proc_" + referenciaCompleta) === idPedido) return respuestaEncontrado(i, true);
      hayEnProceso = true; continue;
    }
    if (estadoActual !== "verificado" && estadoActual !== "") continue;

    // Bloquear al instante y recordar qué pedido lo bloqueó
    hoja.getRange(i + 1, 5).setValue("En proceso");
    SpreadsheetApp.flush();
    if (idPedido) {
      props.setProperty("proc_" + referenciaCompleta, idPedido);
      props.setProperty("pedido_" + idPedido, referenciaCompleta);
    }
    actualizarEstadoFirebase(referenciaCompleta, "En proceso");
    return respuestaEncontrado(i, false);
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
  var idPedido = String(datos.idPedido || "");
  // Reintento de la MISMA petición: se devuelven los mismos pines, sin sacar otros del inventario
  if (idPedido) {
    var previa = buscarAsignacion(idPedido);
    if (previa) {
      if (previa.estado.indexOf("ASIGNADOS") !== 0) {
        return responder({ status: "error", message: "Los pines de este pedido ya no están asignados (" + previa.estado + ")." });
      }
      return responder({ status: "success", pines: previa.pines, repetido: true });
    }
  }

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
  var pines = codigosAsignados.map(function (c) { return c.codigo; });

  // Auditoría: qué pines salieron del inventario, para qué pedido y de qué columna
  if (idPedido) {
    var fechaHora = Utilities.formatDate(new Date(), "America/Caracas", "dd/MM/yyyy HH:mm:ss");
    hojaAsignaciones().appendRow([fechaHora, idPedido, textoSeguro(datos.referencia || ""),
      textoSeguro(String(headers[colIndex - 1])), colIndex, pines.join(" | "), "ASIGNADOS"]);
  }
  SpreadsheetApp.flush();

  return responder({ status: "success", pines: pines });
}

// ==========================================
// 2b: DEVOLVER AL INVENTARIO LOS PINES DE UN PEDIDO (el bot nunca los recibió o no los procesó)
// ==========================================
function devolverCodigos(datos) {
  var idPedido = String(datos.idPedido || "");
  if (!idPedido) return responder({ status: "error", message: "Falta idPedido" });

  var asignacion = buscarAsignacion(idPedido);
  if (!asignacion) {
    // obtener_codigo nunca llegó a sacar pines para este pedido
    return responder({ status: "success", pines: [], sinAsignacion: true });
  }
  if (asignacion.estado.indexOf("DEVUELTOS") === 0) {
    return responder({ status: "success", pines: asignacion.pines, yaDevueltos: true }); // idempotente
  }
  if (asignacion.estado.indexOf("ASIGNADOS") !== 0) {
    return responder({ status: "error", message: "No se devuelven: el pedido está en estado " + asignacion.estado });
  }

  // Cada pin vuelve a la primera celda vacía de su columna
  var hojaCodigos = obtenerHoja("codigos");
  var col = asignacion.columna;
  var ultima = Math.max(hojaCodigos.getLastRow(), 1);
  var valores = ultima > 1 ? hojaCodigos.getRange(2, col, ultima - 1, 1).getValues() : [];
  var libres = [];
  for (var i = 0; i < valores.length; i++) if (!String(valores[i][0] || "").trim()) libres.push(i + 2);
  for (var k = 0; k < asignacion.pines.length; k++) {
    var fila = k < libres.length ? libres[k] : ultima + 1 + (k - libres.length);
    hojaCodigos.getRange(fila, col).setValue(asignacion.pines[k]);
  }

  var fechaHora = Utilities.formatDate(new Date(), "America/Caracas", "dd/MM/yyyy HH:mm:ss");
  hojaAsignaciones().getRange(asignacion.fila, 7).setValue(
    textoSeguro("DEVUELTOS AL INVENTARIO " + fechaHora + " - " + String(datos.motivo || "sin motivo")));
  SpreadsheetApp.flush();
  return responder({ status: "success", pines: asignacion.pines });
}

// ==========================================
// 2c: LIBERAR EL PAGO DE UN PEDIDO QUE NO PUDO CONTINUAR (solo si este pedido lo bloqueó)
// ==========================================
function liberarPedido(datos) {
  var idPedido = String(datos.idPedido || "");
  if (!idPedido) return responder({ status: "error", message: "Falta idPedido" });
  var props = PropertiesService.getScriptProperties();
  var referencia = props.getProperty("pedido_" + idPedido);
  if (!referencia) return responder({ status: "success", liberado: false }); // nunca llegó a bloquear un pago
  var liberado = false;
  if (props.getProperty("proc_" + referencia) === idPedido) {
    liberado = cambiarEstadoPago(referencia, "Verificado", "en proceso");
  }
  return responder({ status: "success", liberado: liberado, referencia: referencia });
}

// ==========================================
// 3: MARCAR COMO USADO (Éxito definitivo o pago bloqueado para revisión)
// ==========================================
function marcarUsado(datos) {
  var cambiado = cambiarEstadoPago(datos.referencia, "Usado", null);
  return responder({ status: "success", cambiado: cambiado });
}

// ==========================================
// 4: DEVOLVER A VERIFICADO (error sin códigos, pago insuficiente...)
// ==========================================
function marcarVerificado(datos) {
  // Solo libera pagos que estaban "En proceso": nunca revive un pago "Usado".
  // Si otro pedido es quien lo tiene bloqueado, tampoco lo libera.
  var referencia = String(datos.referencia || "").replace(/\s+/g, "");
  var duenio = PropertiesService.getScriptProperties().getProperty("proc_" + referencia);
  if (datos.idPedido && duenio && duenio !== String(datos.idPedido)) {
    return responder({ status: "success", cambiado: false, message: "El pago lo procesa otro pedido" });
  }
  var cambiado = cambiarEstadoPago(referencia, "Verificado", "en proceso");
  return responder({ status: "success", cambiado: cambiado });
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
  // Auditoría: los pines de este pedido quedan como usados
  var asignacion = buscarAsignacion(String(datos.idPedido || ""));
  if (asignacion && asignacion.estado.indexOf("ASIGNADOS") === 0) {
    hojaAsignaciones().getRange(asignacion.fila, 7).setValue("USADOS (recarga finalizada " + fechaHora + ")");
  }
  // Código de descuento usado en esta recarga: +1 uso y el monto cobrado en la pestaña "Descuentos"
  if (datos.codigoDescuento) sumarUsoDescuento(datos.codigoDescuento, datos.montoCobrado, "Free Fire", datos.idPedido, datos.idJugador);
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
  return responder({ status: "success", catalogo: paquetes, version: VERSION_SCRIPT });
}

// ==========================================
// 🛡️ 8: REGISTRAR ERROR DEL BOT Y SALVAR CÓDIGOS
// ==========================================
function registrarError(datos) {
  var hojaErrores = obtenerHoja("errores", true);
  if (!hojaErrores) {
    // Antes, sin esta pestaña los pines del error se perdían en silencio
    hojaErrores = SpreadsheetApp.getActiveSpreadsheet().insertSheet("errores");
    hojaErrores.appendRow(COLUMNAS_ERRORES);
  } else if (!String(hojaErrores.getRange(1, 6).getValue() || "").trim()) {
    // Pestaña antigua de 5 columnas: se agregan los títulos de las columnas nuevas (F-L)
    hojaErrores.getRange(1, 6, 1, COLUMNAS_ERRORES.length - 5).setValues([COLUMNAS_ERRORES.slice(5)]);
  }

  // Pines que el sistema asignó a este pedido, según la pestaña de auditoría
  var asignacion = buscarAsignacion(String(datos.idPedido || ""));
  var pinesAsignados = asignacion
    ? asignacion.pines.join(" | ") + " (estado: " + asignacion.estado + ")"
    : (datos.idPedido ? "ninguno: no salieron pines del inventario para este pedido" : "");

  var fechaHora = Utilities.formatDate(new Date(), "America/Caracas", "dd/MM/yyyy HH:mm:ss");
  hojaErrores.appendRow([
    fechaHora,                                                          // A: fecha-hora
    textoSeguro(datos.idJugador || "Desconocido"),                      // B: id
    textoSeguro(datos.estadoPines || datos.codigosUsados || "Ninguno"), // C: estado exacto de cada pin
    textoSeguro(datos.paquete || "Desconocido"),                        // D: producto
    textoSeguro(datos.urlImagen || datos.error || "Fallo en el Bot"),   // E: informe completo
    textoSeguro(datos.fase || ""),                                      // F: fase del fallo
    textoSeguro(datos.referenciaDetalle || datos.referencia || ""),     // G: referencia
    textoSeguro(datos.estadoPago || ""),                                // H: estado del pago
    textoSeguro(datos.motivo || ""),                                    // I: motivo técnico
    textoSeguro(datos.comprobante || ""),                               // J: comprobante
    textoSeguro(datos.idPedido || ""),                                  // K: id pedido
    textoSeguro(pinesAsignados)                                         // L: pines asignados
  ]);
  SpreadsheetApp.flush();

  // YA NO cambia el estado del pago. Antes lo devolvía a "Verificado", y si Vercel marcaba
  // "Usado" al mismo tiempo, el pago podía quedar libre para usarse otra vez tras un fallo
  // del bot (con pines quizá ya canjeados). Vercel decide el estado final después de
  // registrar el error: marcar_usado (bloquear para revisión) o marcar_verificado (liberar).
  return responder({ status: "success", message: "Error guardado correctamente y códigos respaldados" });
}

// ==========================================
// 🎰 9: RULETA - CONSULTAR QUÉ PAGOS PUEDEN GIRAR (sin candado: solo lectura)
// Devuelve los pagos "Usado" (recarga completada) cuya referencia coincide, del más reciente
// al más antiguo, con el jugador y paquete de la pestaña "finalizados" si aparecen.
// La columna F de "pagos" es la marca de la ruleta anterior ("listo"/"usado"): esos pagos
// ya giraron con el sistema viejo y se informan como ruletaAnterior.
// ==========================================
function consultarRuleta(datos) {
  var buscada = String(datos.referencia || "").replace(/\s+/g, "");
  if (!/^\d{5,20}$/.test(buscada)) return responder({ status: "success", candidatos: [] });

  var rows = obtenerHoja("pagos").getDataRange().getValues();
  var candidatos = [];
  for (var i = rows.length - 1; i >= 1 && candidatos.length < MAX_CANDIDATOS_RULETA; i--) {
    var referencia = String(rows[i][2]).replace(/\s+/g, "");
    // 5 dígitos: coinciden los últimos 5. Referencia completa: coincidencia exacta.
    var coincide = buscada.length === 5 ? referencia.slice(-5) === buscada : referencia === buscada;
    if (!referencia || !coincide) continue;
    if (String(rows[i][4]).trim().toLowerCase() !== "usado") continue;
    var marcaAnterior = String(rows[i][5] || "").trim().toLowerCase();
    candidatos.push({
      referencia: referencia,
      ruletaAnterior: marcaAnterior === "listo" || marcaAnterior === "usado",
      idJugador: "",
      paquete: ""
    });
  }

  var hojaFinalizados = obtenerHoja("finalizados", true);
  if (hojaFinalizados && candidatos.length) {
    var filas = hojaFinalizados.getDataRange().getValues();
    candidatos.forEach(function (c) {
      for (var j = filas.length - 1; j >= 1; j--) {
        if (String(filas[j][3]).replace(/\s+/g, "") !== c.referencia) continue;
        c.idJugador = String(filas[j][1] || "");
        c.paquete = String(filas[j][2] || "");
        break;
      }
    });
  }
  return responder({ status: "success", candidatos: candidatos });
}

// ==========================================
// 🎰 10: RULETA - ANOTAR UN GANADOR EN LA PESTAÑA "ruleta"
// Firestore (GirosRuleta) ya registró el giro: esta fila es solo para entregar el premio.
// ==========================================
function registrarPremioRuleta(datos) {
  var hoja = obtenerHoja(HOJA_RULETA, true);
  if (!hoja) {
    hoja = SpreadsheetApp.getActiveSpreadsheet().insertSheet(HOJA_RULETA);
    hoja.appendRow(COLUMNAS_RULETA);
  }
  var fechaHora = Utilities.formatDate(new Date(), "America/Caracas", "dd/MM/yyyy HH:mm:ss");
  hoja.appendRow([
    fechaHora,
    textoSeguro(datos.idJugador || "Sin registrar: pedirlo por WhatsApp"),
    textoSeguro(datos.referencia),
    textoSeguro(datos.paquete || ""),
    textoSeguro(datos.premio),
    "PENDIENTE"
  ]);
  SpreadsheetApp.flush();
  return responder({ status: "success" });
}

// ==========================================
// 🎟️ 11: CÓDIGOS DE DESCUENTO (pestaña "Descuentos")
// A: Codigos | B: descuento en % ("10%" o "10"; solo códigos promocionales: los de creador dan siempre
//    PORCENTAJE_CREADOR) | C: Usos
// D: Dinero Total Movido (Bs) | E: Creador (vacío = código promocional normal) | F: PIN
// G: Comision (%) = el % actual del creador (PORCENTAJE_CREADOR)                    -> la escribe el script
// H: usd = comisión total ganada: suma de la comisión de cada venta (% y tasa de ese día)
// I: Liquidado (Bs) = ventas ya pagadas (referencia; la anota Registrar pago)
// J: Pendiente (USD) = suma de comisiones aún no pagadas: lo que le debes hoy
//    H y J son SALDOS: cada venta les suma y Registrar pago deja J en 0. No se recalculan;
//    si corriges uno a mano, ese valor queda como nuevo saldo.
// K: sin uso (eran los niveles bajados por metas semanales; se puede dejar o borrar)
// L: Por convertir (Bs) = comisión de ventas sin tasa conocida; pasa a H y J cuando haya tasa
// El precio con descuento lo calcula Vercel; aquí solo se lee el código y se anotan los usos.
// ==========================================

// Sin candado: solo lectura. Vercel pregunta si el código existe y cuánto descuenta.
function validarDescuento(datos) {
  var fila = buscarFilaDescuento(datos.codigo);
  if (!fila) return responder({ status: "success", valido: false });
  var descuento = descuentoDeFila(fila);
  if (!descuento) {
    console.error("Descuentos: el código " + fila.codigo + " tiene un descuento no válido en la columna B: '" + fila.descuento + "'");
    return responder({ status: "success", valido: false });
  }
  return responder({ status: "success", valido: true, codigo: fila.codigo, tipo: descuento.tipo, valor: descuento.valor });
}

// Juegos que registran su recarga en OTRA hoja (Blood Strike): Vercel avisa aquí el uso de un
// código al terminar la recarga. Con candado, igual que registrarFinalizado.
function registrarUsoDescuento(datos) {
  sumarUsoDescuento(datos.codigo, datos.montoCobrado, datos.juego, datos.idPedido, datos.idJugador);
  SpreadsheetApp.flush();
  return responder({ status: "success" });
}

// Se llama desde registrarFinalizado y registrarUsoDescuento, que ya tienen el candado
// (dos recargas no pisan el contador). Suma +1 uso y el monto en "Descuentos", suma la comisión de
// ESTA venta a H y J del creador y la anota en "movimientos_descuentos".
// Un fallo aquí nunca impide que la recarga quede anotada en "finalizados".
function sumarUsoDescuento(codigo, montoCobrado, juego, idPedido, idJugador) {
  try {
    var fila = buscarFilaDescuento(codigo);
    if (!fila) {
      console.error("Descuentos: no se encontró el código " + codigo + " al registrar su uso");
      return;
    }
    // Mismo pedido ya anotado (un reintento de Vercel): no se cuenta dos veces el uso ni la comisión
    if (idPedido && pedidoYaAnotado(String(idPedido), fila.codigo)) {
      console.log("Descuentos: el pedido " + idPedido + " ya estaba anotado para " + fila.codigo);
      return;
    }
    var hoja = obtenerHoja(HOJA_DESCUENTOS);
    var monto = limpiarMontoVES(montoCobrado);
    var tasa = leerTasaUsd() || ultimaTasaConocida();
    if (fila.creador) iniciarSaldosPorVenta(hoja, tasa);

    // % que recibió el cliente en ESTA venta = comisión del creador
    var descuentoVenta = fila.creador ? descuentoDeFila(fila) : null;

    var celdas = hoja.getRange(fila.numero, 3, 1, 2); // C: usos, D: dinero movido
    var actuales = celdas.getValues()[0];
    fila.usos = limpiarMontoVES(actuales[0]) + 1;
    fila.ventasBs = redondear2(limpiarMontoVES(actuales[1]) + monto);
    celdas.setValues([[fila.usos, fila.ventasBs]]);

    // Comisión de esta venta, fija para siempre: 4 decimales para que los centavos no se pierdan
    var comisionBs = descuentoVenta ? redondear4(monto * descuentoVenta.valor / 100) : "";
    var comisionUsdVenta = descuentoVenta && tasa ? redondear4(comisionBs / tasa) : "";
    if (fila.creador) {
      sumarComisionCreador(hoja, fila.numero, comisionUsdVenta, comisionUsdVenta === "" ? comisionBs || 0 : 0);
      escribirPorcentajeCreador(hoja, fila); // G = % actual del creador
    }

    // Historial de la venta (también para los códigos promocionales, sin comisión)
    var fechaHora = Utilities.formatDate(new Date(), "America/Caracas", "dd/MM/yyyy HH:mm:ss");
    hojaMovimientosDescuentos().appendRow([
      fechaHora, textoSeguro(fila.codigo), textoSeguro(juego || "Free Fire"), textoSeguro(idJugador || "Sin ID"),
      monto, comisionBs, comisionUsdVenta !== "" ? tasa : "", comisionUsdVenta, textoSeguro(idPedido || "")
    ]);
  } catch (err) {
    console.error("Descuentos: no se pudo sumar el uso del código " + codigo + ": " + err);
  }
}

// ¿Ya hay una venta de este pedido con este código en "movimientos_descuentos"?
// El id del pedido está en I (o en D en las filas anteriores al cambio). Se busca con TextFinder:
// esto corre dentro del candado en cada venta con código y la pestaña no para de crecer.
function pedidoYaAnotado(idPedido, codigo) {
  var hoja = obtenerHoja(HOJA_MOVIMIENTOS_DESCUENTOS, true);
  if (!idPedido || !hoja || hoja.getLastRow() < 2) return false;
  var celdas = hoja.getRange(2, 1, hoja.getLastRow() - 1, COLUMNAS_MOVIMIENTOS_DESCUENTOS.length)
    .createTextFinder(idPedido).matchEntireCell(true).matchCase(true).findAll();
  for (var i = 0; i < celdas.length; i++) {
    var columna = celdas[i].getColumn();
    if (columna !== 4 && columna !== 9) continue;
    var codigoFila = String(hoja.getRange(celdas[i].getRow(), 2).getValue()).trim().toUpperCase();
    if (codigoFila === codigo.toUpperCase()) return true;
  }
  return false;
}

// G = % actual del creador (lo que ganará en sus PRÓXIMAS ventas; no cambia lo ya ganado)
function escribirPorcentajeCreador(hoja, fila) {
  hoja.getRange(fila.numero, 7).setValue(porcentajeCreador(fila) / 100).setNumberFormat("0.00%");
}

// Suma una comisión a los saldos del creador: usd a H (total) y J (pendiente); bsSinTasa a L,
// que se convierte cuando haya tasa (convertirPorConvertir). Lee las celdas al momento: así nunca
// pisa un saldo que cambió desde que se leyó la fila.
function sumarComisionCreador(hoja, numeroFila, usd, bsSinTasa) {
  asegurarColumnas(hoja, COLUMNA_POR_CONVERTIR);
  var celdas = hoja.getRange(numeroFila, 8, 1, COLUMNA_POR_CONVERTIR - 7); // H..L
  var v = celdas.getValues()[0];
  if (usd) {
    hoja.getRange(numeroFila, 8).setValue(redondear4(limpiarMontoVES(v[0]) + usd)).setNumberFormat("0.00");
    hoja.getRange(numeroFila, 10).setValue(redondear4(limpiarMontoVES(v[2]) + usd)).setNumberFormat("0.00");
  }
  if (bsSinTasa) {
    var titulo = hoja.getRange(1, COLUMNA_POR_CONVERTIR);
    if (!String(titulo.getValue() || "").trim()) titulo.setValue("Por convertir (Bs)");
    hoja.getRange(numeroFila, COLUMNA_POR_CONVERTIR).setValue(redondear4(limpiarMontoVES(v[4]) + bsSinTasa)).setNumberFormat("0.00");
    console.error("Descuentos: venta sin tasa conocida; la comisión queda en Bs en la columna L de la fila " + numeroFila);
  }
}

// Pasa a dólares (H y J) la comisión en Bs que quedó en L por ventas sin tasa
function convertirPorConvertir(hoja, fila, tasa) {
  if (!tasa || !(fila.porConvertirBs > 0)) return;
  sumarComisionCreador(hoja, fila.numero, redondear4(fila.porConvertirBs / tasa), 0);
  hoja.getRange(fila.numero, COLUMNA_POR_CONVERTIR).setValue("");
  fila.porConvertirBs = 0;
}

// Una sola vez, al estrenar la comisión por venta: H y J arrancan con lo que el creador veía con el
// cálculo anterior (D x % / tasa y (D - I) x % / tasa). Desde ahí, cada venta solo suma.
// Necesita una tasa: sin ella no hace nada y lo intenta en la próxima ocasión.
function iniciarSaldosPorVenta(hoja, tasa) {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty("saldos_por_venta") || !tasa) return;
  leerFilasDescuentos(hoja).forEach(function (fila) {
    if (!fila.codigo || !fila.creador) return;
    var porcentaje = porcentajeCreador(fila);
    hoja.getRange(fila.numero, 8).setValue(comisionUsd(fila.ventasBs, porcentaje, tasa)).setNumberFormat("0.00");
    hoja.getRange(fila.numero, 10).setValue(comisionUsd(ventasPendientesBs(fila), porcentaje, tasa)).setNumberFormat("0.00");
    escribirPorcentajeCreador(hoja, fila);
  });
  props.setProperty("saldos_por_venta", Utilities.formatDate(new Date(), "America/Caracas", "dd/MM/yyyy HH:mm:ss"));
  SpreadsheetApp.flush();
  console.log("Comisión por venta activada: saldos iniciales de H y J guardados con la tasa " + tasa);
}

// Si la hoja no tiene tantas columnas, las agrega al final
function asegurarColumnas(hoja, cantidad) {
  if (hoja.getMaxColumns() < cantidad) hoja.insertColumnsAfter(hoja.getMaxColumns(), cantidad - hoja.getMaxColumns());
}

// % de comisión del creador = el % de descuento de su código
function porcentajeCreador(fila) {
  return PORCENTAJE_CREADOR;
}

// Ventas que todavía no se le han pagado al creador: D - I (nunca negativo)
function ventasPendientesBs(fila) {
  return redondear2(Math.max(0, fila.ventasBs - fila.liquidadoBs));
}

// Comisión en USD de un monto en Bs con un % y una tasa
function comisionUsd(montoBs, porcentaje, tasa) {
  return redondear2(montoBs * porcentaje / 100 / tasa);
}

// Busca el código sin distinguir mayúsculas ni espacios. Devuelve los datos de su fila o null.
function buscarFilaDescuento(codigo) {
  var buscado = String(codigo || "").trim().toUpperCase();
  if (!buscado) return null;
  var hoja = obtenerHoja(HOJA_DESCUENTOS, true);
  if (!hoja || hoja.getLastRow() < 2) return null;
  var filas = leerFilasDescuentos(hoja);
  for (var i = 0; i < filas.length; i++) {
    if (filas[i].codigo.toUpperCase() === buscado) return filas[i];
  }
  return null;
}

// Todas las filas de "Descuentos" (A-L) como objetos. Se leen los valores tal como se ven en la
// hoja (así "10%" llega como "10%" y no como 0.1), salvo los saldos H, J y L: esos con su valor
// real, porque se guardan con 4 decimales y se muestran con 2.
function leerFilasDescuentos(hoja) {
  if (hoja.getLastRow() < 2) return [];
  var columnas = Math.min(COLUMNA_POR_CONVERTIR, hoja.getMaxColumns());
  var rango = hoja.getRange(2, 1, hoja.getLastRow() - 1, columnas);
  var filas = rango.getDisplayValues();
  var crudos = rango.getValues();
  var resultado = [];
  for (var i = 0; i < filas.length; i++) {
    resultado.push({
      numero: i + 2,
      codigo: String(filas[i][0]).trim(),
      descuento: String(filas[i][1]).trim(),
      usos: limpiarMontoVES(filas[i][2]),
      ventasBs: limpiarMontoVES(filas[i][3]),
      creador: String(filas[i][4]).trim(),
      pin: String(filas[i][5]).trim(),
      comisionTotalUsd: limpiarMontoVES(crudos[i][7]),
      liquidadoBs: limpiarMontoVES(filas[i][8]),
      pendienteUsd: limpiarMontoVES(crudos[i][9]),
      porConvertirBs: limpiarMontoVES(crudos[i][COLUMNA_POR_CONVERTIR - 1])
    });
  }
  return resultado;
}

// Descuento que se aplica con este código: los de creador, siempre PORCENTAJE_CREADOR; los
// promocionales, el de la columna B. null = código no válido.
function descuentoDeFila(fila) {
  if (fila.creador) return { tipo: "porcentaje", valor: PORCENTAJE_CREADOR };
  return interpretarDescuento(fila.descuento);
}

// Los descuentos son SIEMPRE porcentaje: "10%", "10" o "12,5" -> 10 % / 12,5 % del precio.
// Debe ser mayor que 0 y menor que 100. Vacío, 0, 100 o texto -> null (código no válido).
function interpretarDescuento(texto) {
  var porcentaje = limpiarMontoVES(String(texto || "").replace("%", "").trim());
  return porcentaje > 0 && porcentaje < 100 ? { tipo: "porcentaje", valor: porcentaje } : null;
}

// ==========================================
// 🔄 RECÁLCULO DE G (Y CONVERSIÓN DE L) DE TODOS LOS CREADORES
// H y J son saldos que suma cada venta: aquí no se recalculan.
// Se ejecuta solo al cambiar la tasa (config!B1) o las columnas B-E / I de "Descuentos" (onEdit),
// cada hora si activas el recálculo automático, o desde el menú ⭐ Creadores.
// ==========================================
function recalcularComisiones() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    console.error("recalcularComisiones: el sistema estaba ocupado; vuelve a ejecutarla en unos segundos");
    return;
  }
  try {
    var hoja = obtenerHoja(HOJA_DESCUENTOS, true);
    if (!hoja) return;
    var tasa = leerTasaUsd();
    iniciarSaldosPorVenta(hoja, tasa);
    leerFilasDescuentos(hoja).forEach(function (fila) {
      if (!fila.codigo || !fila.creador) return;
      escribirPorcentajeCreador(hoja, fila);
      convertirPorConvertir(hoja, fila, tasa);
    });
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
}

// ==========================================
// ♻️ VENTAS ANTERIORES AL % ACTUAL (se ejecuta una vez desde el menú ⭐ Creadores)
// Al pasar a PORCENTAJE_CREADOR, lo ya ganado seguía con el % de su nivel de entonces. Esto
// recalcula cada venta de "movimientos_descuentos" con el % actual y la tasa DE ESA VENTA
// (sin tasa guardada: la de hoy), corrige F-H de cada movimiento y deja en cada creador:
//   H = suma de todas sus ventas + ventas de D que no están en movimientos (a la tasa de hoy)
//   J = H - lo ya pagado ("pagos_creadores"), nunca negativo. L queda vacía (ya está incluida).
// Una sola vez por porcentaje (propiedad "retroactivo_<%>"): repetirla no suma de nuevo.
// ==========================================
function pasarVentasAnterioresAlPorcentaje() {
  var ui = SpreadsheetApp.getUi();
  var props = PropertiesService.getScriptProperties();
  var clave = "retroactivo_" + PORCENTAJE_CREADOR;
  if (props.getProperty(clave)) {
    ui.alert("Las ventas anteriores ya se pasaron al " + PORCENTAJE_CREADOR + " % el " + props.getProperty(clave) + ".");
    return;
  }
  var tasaHoy = leerTasaUsd();
  if (!tasaHoy) {
    ui.alert("Falta la tasa del dólar en la pestaña 'config', celda B1.");
    return;
  }
  var respuesta = ui.alert("Ventas anteriores al " + PORCENTAJE_CREADOR + " %",
    "Se recalculará lo ganado por cada creador con el " + PORCENTAJE_CREADOR + " % en TODAS sus ventas, " +
    "cada una con la tasa de su día. Lo que ya les pagaste se descuenta del pendiente.\n\n¿Continuar?", ui.ButtonSet.YES_NO);
  if (respuesta !== ui.Button.YES) return;

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    ui.alert("El sistema está procesando una recarga. Intenta de nuevo en unos segundos.");
    return;
  }
  var resumen = [];
  try {
    var hoja = obtenerHoja(HOJA_DESCUENTOS);
    var creadores = {};
    leerFilasDescuentos(hoja).forEach(function (fila) {
      if (fila.codigo && fila.creador) creadores[fila.codigo.toUpperCase()] = { fila: fila, totalUsd: 0, ventasBs: 0, pagadoUsd: 0 };
    });

    // 1) Cada venta con el % actual y su propia tasa
    var hojaMov = obtenerHoja(HOJA_MOVIMIENTOS_DESCUENTOS, true);
    if (hojaMov && hojaMov.getLastRow() > 1) {
      var rango = hojaMov.getRange(2, 1, hojaMov.getLastRow() - 1, 8);
      var movs = rango.getValues();
      var cambiados = [];
      for (var i = 0; i < movs.length; i++) {
        var c = creadores[String(movs[i][1]).trim().toUpperCase()];
        var fg = [movs[i][5], movs[i][6], movs[i][7]];
        if (c) {
          var venta = limpiarMontoVES(movs[i][4]);
          var tasa = limpiarMontoVES(movs[i][6]) || tasaHoy;
          var comisionBs = redondear4(venta * PORCENTAJE_CREADOR / 100);
          var comisionUsdVenta = redondear4(comisionBs / tasa);
          c.ventasBs += venta;
          c.totalUsd += comisionUsdVenta;
          fg = [comisionBs, tasa, comisionUsdVenta];
        }
        cambiados.push(fg);
      }
      hojaMov.getRange(2, 6, cambiados.length, 3).setValues(cambiados);
    }

    // 2) Lo ya pagado a cada creador
    var hojaPagos = obtenerHoja(HOJA_PAGOS_CREADORES, true);
    if (hojaPagos && hojaPagos.getLastRow() > 1) {
      hojaPagos.getRange(2, 1, hojaPagos.getLastRow() - 1, COLUMNAS_PAGOS_CREADORES.length).getValues().forEach(function (pago) {
        var c = creadores[String(pago[1]).trim().toUpperCase()];
        if (c) c.pagadoUsd += limpiarMontoVES(pago[6]);
      });
    }

    // 3) Nuevos saldos H y J (y G al % actual)
    asegurarColumnas(hoja, COLUMNA_POR_CONVERTIR);
    Object.keys(creadores).forEach(function (codigo) {
      var c = creadores[codigo];
      var sinMovimientoBs = Math.max(0, c.fila.ventasBs - c.ventasBs);
      var totalUsd = redondear4(c.totalUsd + sinMovimientoBs * PORCENTAJE_CREADOR / 100 / tasaHoy);
      var pendienteUsd = redondear4(Math.max(0, totalUsd - c.pagadoUsd));
      hoja.getRange(c.fila.numero, 8).setValue(totalUsd).setNumberFormat("0.00");
      hoja.getRange(c.fila.numero, 10).setValue(pendienteUsd).setNumberFormat("0.00");
      hoja.getRange(c.fila.numero, COLUMNA_POR_CONVERTIR).setValue("");
      escribirPorcentajeCreador(hoja, c.fila);
      resumen.push(c.fila.codigo + ": total " + formatoDolar(c.fila.comisionTotalUsd) + " → " + formatoDolar(totalUsd) +
        ", por cobrar " + formatoDolar(c.fila.pendienteUsd) + " → " + formatoDolar(pendienteUsd));
    });
    props.setProperty("saldos_por_venta", props.getProperty("saldos_por_venta") || "retroactivo");
    props.setProperty(clave, Utilities.formatDate(new Date(), "America/Caracas", "dd/MM/yyyy HH:mm:ss"));
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  console.log("Ventas anteriores al " + PORCENTAJE_CREADOR + " %:\n" + resumen.join("\n"));
  ui.alert("Listo: ventas anteriores al " + PORCENTAJE_CREADOR + " %", resumen.join("\n") || "No hay creadores.", ui.ButtonSet.OK);
}

// Disparador simple de Google Sheets: se ejecuta solo cuando TÚ editas la hoja a mano
function onEdit(e) {
  try {
    if (!e || !e.range) return;
    var r = e.range;
    var nombre = r.getSheet().getName().trim().toLowerCase();
    var cubre = function (desde, hasta) { return r.getColumn() <= hasta && r.getLastColumn() >= desde; };
    var enTasa = nombre === HOJA_CONFIG && r.getRow() <= 1 && r.getLastRow() >= 1 && cubre(2, 2);
    var enDescuentos = nombre === HOJA_DESCUENTOS && r.getLastRow() >= 2 && cubre(2, 5);
    if (enTasa || enDescuentos) recalcularComisiones();
  } catch (err) {
    console.error("onEdit: " + err);
  }
}

// Menú "⭐ Creadores" en la hoja de cálculo (aparece al abrirla)
function onOpen() {
  SpreadsheetApp.getUi().createMenu("⭐ Creadores")
    .addItem("💵 Registrar pago del creador seleccionado", "registrarPagoCreador")
    .addItem("🔄 Actualizar % de comisión", "recalcularComisiones")
    .addItem("♻️ Pasar ventas anteriores al % actual", "pasarVentasAnterioresAlPorcentaje")
    .addSeparator()
    .addItem("⏰ Activar recálculo automático cada hora", "activarRecalculoHorario")
    .addToUi();
}

// Paga TODO lo pendiente del creador de la fila seleccionada en "Descuentos":
// J (pendiente) queda en 0, I (Liquidado) pasa a ser igual a D y el pago se anota en "pagos_creadores".
function registrarPagoCreador() {
  var ui = SpreadsheetApp.getUi();
  var libro = SpreadsheetApp.getActiveSpreadsheet();
  var hoja = libro.getActiveSheet();
  var numeroFila = libro.getActiveRange() ? libro.getActiveRange().getRow() : 0;
  if (hoja.getName().toLowerCase() !== HOJA_DESCUENTOS || numeroFila < 2) {
    ui.alert("Abre la pestaña 'Descuentos' y selecciona una celda de la fila del creador al que le pagaste.");
    return;
  }
  var fila = leerFilasDescuentos(hoja)[numeroFila - 2];
  if (!fila || !fila.creador) {
    ui.alert("La fila " + numeroFila + " no es de un creador (la columna E está vacía).");
    return;
  }
  var tasa = leerTasaUsd();
  if (!tasa) {
    ui.alert("Falta la tasa del dólar en la pestaña 'config', celda B1.");
    return;
  }
  if (!PropertiesService.getScriptProperties().getProperty("saldos_por_venta")) {
    ui.alert("Primero usa ⭐ Creadores > 🔄 Actualizar % de comisión (prepara los saldos de la comisión por venta).");
    return;
  }
  var porcentaje = porcentajeCreador(fila);
  var pendienteBs = ventasPendientesBs(fila);
  var pendienteUsd = redondear2(fila.pendienteUsd);
  if (fila.porConvertirBs > 0) {
    ui.alert(fila.codigo + " tiene comisión sin convertir en la columna L: usa primero 🔄 Actualizar % de comisión.");
    return;
  }
  if (pendienteUsd <= 0) {
    ui.alert(fila.codigo + " no tiene comisión pendiente.");
    return;
  }
  var respuesta = ui.alert("Registrar pago",
    "¿Le pagaste " + formatoDolar(pendienteUsd) + " a " + fila.creador + " (código " + fila.codigo + ")?\n\n" +
    "Esto deja su pendiente en $0,00.", ui.ButtonSet.YES_NO);
  if (respuesta !== ui.Button.YES) return;

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    ui.alert("El sistema está procesando una recarga. Intenta de nuevo en unos segundos.");
    return;
  }
  try {
    // Se vuelve a leer J dentro del candado: si entró una venta mientras confirmabas, esa queda pendiente
    var celdaPendiente = hoja.getRange(fila.numero, 10);
    var pendienteAhora = limpiarMontoVES(celdaPendiente.getValue());
    celdaPendiente.setValue(redondear4(Math.max(0, pendienteAhora - fila.pendienteUsd))).setNumberFormat("0.00");
    hoja.getRange(fila.numero, 9).setValue(fila.ventasBs).setNumberFormat("0.00");
    var hojaPagos = obtenerHoja(HOJA_PAGOS_CREADORES, true);
    if (!hojaPagos) {
      hojaPagos = libro.insertSheet(HOJA_PAGOS_CREADORES);
      hojaPagos.appendRow(COLUMNAS_PAGOS_CREADORES);
    }
    var fechaHora = Utilities.formatDate(new Date(), "America/Caracas", "dd/MM/yyyy HH:mm:ss");
    hojaPagos.appendRow([fechaHora, textoSeguro(fila.codigo), textoSeguro(fila.creador), pendienteBs, porcentaje / 100, tasa, pendienteUsd]);
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  ui.alert("Pago de " + formatoDolar(pendienteUsd) + " registrado para " + fila.codigo + ".");
}

// Crea (una sola vez) un activador que ejecuta recalcularComisiones cada hora. Útil si la tasa
// de config!B1 sale de una fórmula: los cambios de fórmulas no disparan onEdit.
function activarRecalculoHorario() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "recalcularComisiones") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("recalcularComisiones").timeBased().everyHours(1).create();
  SpreadsheetApp.getUi().alert("Listo: las comisiones se recalcularán solas cada hora.");
}

// Las metas semanales se eliminaron. Si quedó activo el activador de los lunes, al ejecutarse
// se borra solo (así no llegan correos de error por una función que ya no existe).
function revisarMetasSemanales() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "revisarMetasSemanales") ScriptApp.deleteTrigger(t);
  });
}

// ==========================================
// ⭐ 12: PANEL DE CREADORES (sin candado: solo lectura)
// El creador consulta con su código y su PIN (columna F, se lo das tú por WhatsApp).
// Sin PIN configurado no se muestran datos: el código es público, sus ganancias no.
// Total = columna H, pendiente = columna J: la suma de la comisión guardada en cada venta.
// ==========================================
function consultarCreador(datos) {
  var fila = buscarFilaDescuento(datos.codigo);
  if (!fila || !fila.creador) return responder({ status: "success", encontrado: false });
  if (!fila.pin) return responder({ status: "success", encontrado: false, sinPin: true });
  if (String(datos.pin || "").trim() !== fila.pin) return responder({ status: "success", encontrado: false });

  var tasaActual = leerTasaUsd();
  var porcentajeActual = porcentajeCreador(fila);
  // Antes de estrenar la comisión por venta, H y J pueden estar vacías: se muestra el cálculo anterior
  var saldosListos = Boolean(PropertiesService.getScriptProperties().getProperty("saldos_por_venta"));
  var comisionTotalUsd = saldosListos ? redondear2(fila.comisionTotalUsd)
    : tasaActual ? comisionUsd(fila.ventasBs, porcentajeActual, tasaActual) : null;
  var pendienteUsd = saldosListos ? redondear2(fila.pendienteUsd)
    : tasaActual ? comisionUsd(ventasPendientesBs(fila), porcentajeActual, tasaActual) : null;

  // Últimos movimientos: la comisión guardada en cada venta (columna H de "movimientos_descuentos";
  // las ventas viejas sin ella se estiman con la columna F y la tasa actual).
  // Se lee desde el final por bloques y se para al tener los 10 más recientes.
  var movimientos = [];
  var codigoBuscado = fila.codigo.toUpperCase();
  var hoja = obtenerHoja(HOJA_MOVIMIENTOS_DESCUENTOS, true);
  if (hoja) {
    recorrerDesdeElFinal(hoja, 8, function (mov) {
      if (String(mov[1]).trim().toUpperCase() !== codigoBuscado) return false;
      movimientos.push({
        fecha: mov[0] instanceof Date ? Utilities.formatDate(mov[0], "America/Caracas", "dd/MM/yyyy HH:mm") : String(mov[0]),
        juego: String(mov[2]),
        ventaBs: limpiarMontoVES(mov[4]),
        comisionUsd: comisionDeMovimiento(mov, tasaActual)
      });
      return movimientos.length >= MOVIMIENTOS_PANEL;
    });
  }

  return responder({
    status: "success", encontrado: true,
    codigo: fila.codigo,
    descuentoSeguidores: porcentajeActual,
    usos: fila.usos,
    ventasBs: fila.ventasBs,
    comisionPorcentaje: porcentajeActual,
    comisionTotalUsd: comisionTotalUsd,
    pendienteUsd: pendienteUsd,
    retiroMinimoUsd: RETIRO_MINIMO_USD,
    faltaParaRetiroUsd: pendienteUsd === null ? null : redondear2(Math.max(0, RETIRO_MINIMO_USD - pendienteUsd)),
    tasa: tasaActual,
    movimientos: movimientos
  });
}

// Comisión en USD guardada en una fila de "movimientos_descuentos" (F = Bs, H = USD de ese día)
function comisionDeMovimiento(fila, tasaActual) {
  if (fila[7] !== "" && fila[7] !== null) return redondear2(limpiarMontoVES(fila[7]));
  if (fila[5] !== "" && fila[5] !== null && tasaActual) return redondear2(limpiarMontoVES(fila[5]) / tasaActual);
  return null;
}

// Tasa Bs por USD de la pestaña "config", celda B1. null si falta o no es un número.
// El motivo exacto de un fallo queda en el registro de ejecuciones.
function leerTasaUsd() {
  var hoja = buscarHojaConfig();
  if (!hoja) {
    var nombres = SpreadsheetApp.getActiveSpreadsheet().getSheets().map(function (h) { return "'" + h.getName() + "'"; });
    console.error("Tasa: no existe la pestaña 'config' en esta hoja de cálculo. Pestañas encontradas: " + nombres.join(", "));
    return null;
  }
  var valor = hoja.getRange("B1").getValue();
  var tasa = limpiarMontoVES(valor);
  if (!(tasa > 0)) {
    console.error("Tasa: la celda B1 de la pestaña '" + hoja.getName() + "' no tiene un número válido (contiene: '" + valor + "')");
    return null;
  }
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty("ultima_tasa") !== String(tasa)) props.setProperty("ultima_tasa", String(tasa));
  return tasa;
}

// Última tasa que se leyó bien (para no perder la comisión de una venta si B1 falla un momento)
function ultimaTasaConocida() {
  var tasa = Number(PropertiesService.getScriptProperties().getProperty("ultima_tasa"));
  return tasa > 0 ? tasa : null;
}

// La pestaña de configuración aunque se llame "Config", "CONFIG" o tenga espacios sobrantes
function buscarHojaConfig() {
  var hojas = SpreadsheetApp.getActiveSpreadsheet().getSheets();
  for (var i = 0; i < hojas.length; i++) {
    if (hojas[i].getName().trim().toLowerCase() === HOJA_CONFIG) return hojas[i];
  }
  return null;
}

// Ejecútala desde el editor (▶) para comprobar qué tasa está leyendo el script
function probarTasa() {
  var tasa = leerTasaUsd();
  console.log(tasa ? "✅ Tasa leída correctamente: " + tasa + " Bs por USD" : "❌ No se pudo leer la tasa: mira el error justo arriba");
}

function hojaMovimientosDescuentos() {
  var hoja = obtenerHoja(HOJA_MOVIMIENTOS_DESCUENTOS, true);
  if (!hoja) {
    hoja = SpreadsheetApp.getActiveSpreadsheet().insertSheet(HOJA_MOVIMIENTOS_DESCUENTOS);
    hoja.appendRow(COLUMNAS_MOVIMIENTOS_DESCUENTOS);
  } else if (!String(hoja.getRange(1, 9).getValue() || "").trim()) {
    // Pestaña anterior al cambio: D pasa a ser "id jugador" e I guarda el id del pedido
    hoja.getRange(1, 4).setValue(COLUMNAS_MOVIMIENTOS_DESCUENTOS[3]);
    hoja.getRange(1, 9).setValue(COLUMNAS_MOVIMIENTOS_DESCUENTOS[8]);
  }
  return hoja;
}

// $2,20 (coma decimal, como se escribe en Venezuela)
function formatoDolar(n) {
  return "$" + Number(n).toFixed(2).replace(".", ",");
}

function redondear2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function redondear4(n) {
  return Math.round(Number(n) * 10000) / 10000;
}

// ==========================================
// FUNCIONES AUXILIARES
// ==========================================

function responder(objeto) {
  return ContentService.createTextOutput(JSON.stringify(objeto)).setMimeType(ContentService.MimeType.JSON);
}

// Recorre una pestaña (sin la fila de títulos) de la última fila a la primera, por bloques de
// 500 filas y con las primeras `columnas` columnas. alVisitar(fila) devuelve true para parar:
// así no se lee la pestaña entera cuando lo buscado está al final (lo más reciente).
function recorrerDesdeElFinal(hoja, columnas, alVisitar) {
  var BLOQUE = 500;
  for (var fin = hoja.getLastRow(); fin >= 2; fin -= BLOQUE) {
    var inicio = Math.max(2, fin - BLOQUE + 1);
    var filas = hoja.getRange(inicio, 1, fin - inicio + 1, columnas).getValues();
    for (var i = filas.length - 1; i >= 0; i--) if (alVisitar(filas[i])) return;
  }
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
  var texto = String(valor === undefined || valor === null ? "" : valor).slice(0, 3000);
  return /^[=+\-@]/.test(texto) ? "'" + texto : texto;
}

// Cambia el estado del pago con esa referencia completa (la fila más reciente).
// Si soloSiEstado se indica, solo cambia cuando el estado actual coincide.
// Devuelve true si cambió el estado. Al salir de "En proceso" se borra qué pedido lo tenía.
function cambiarEstadoPago(referencia, nuevoEstado, soloSiEstado) {
  var refBuscada = String(referencia || "").replace(/\s+/g, "");
  if (!refBuscada) return false;
  var hoja = obtenerHoja("pagos");
  var rows = hoja.getDataRange().getValues();
  for (var r = rows.length - 1; r >= 1; r--) {
    if (String(rows[r][2]).replace(/\s+/g, "") !== refBuscada) continue;
    if (soloSiEstado && String(rows[r][4]).trim().toLowerCase() !== soloSiEstado) return false;
    hoja.getRange(r + 1, 5).setValue(nuevoEstado);
    SpreadsheetApp.flush();
    olvidarPedidoDePago(refBuscada);
    actualizarEstadoFirebase(refBuscada, nuevoEstado);
    return true;
  }
  return false;
}

function olvidarPedidoDePago(referencia) {
  var props = PropertiesService.getScriptProperties();
  var idPedido = props.getProperty("proc_" + referencia);
  if (idPedido) props.deleteProperty("pedido_" + idPedido);
  props.deleteProperty("proc_" + referencia);
}

function hojaAsignaciones() {
  var hoja = obtenerHoja(HOJA_ASIGNACIONES, true);
  if (!hoja) {
    hoja = SpreadsheetApp.getActiveSpreadsheet().insertSheet(HOJA_ASIGNACIONES);
    hoja.appendRow(COLUMNAS_ASIGNACIONES);
  }
  return hoja;
}

// Busca (de la más reciente a la más antigua) la asignación de pines de un pedido
function buscarAsignacion(idPedido) {
  var hoja = obtenerHoja(HOJA_ASIGNACIONES, true);
  if (!idPedido || !hoja) return null;
  var rows = hoja.getDataRange().getValues();
  for (var i = rows.length - 1; i >= 1; i--) {
    if (String(rows[i][1]) !== idPedido) continue;
    return {
      fila: i + 1,
      columna: Number(rows[i][4]),
      pines: String(rows[i][5] || "").split(" | ").filter(function (p) { return p; }),
      estado: String(rows[i][6] || "")
    };
  }
  return null;
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
        var ref = String(rows[i][2]).replace(/\s+/g, "");
        hoja.getRange(i + 1, 5).setValue("Verificado");
        olvidarPedidoDePago(ref);
        actualizarEstadoFirebase(ref, "Verificado");
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
