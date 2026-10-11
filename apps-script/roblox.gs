// =====================================================================
// LEVEL UP - Apps Script de ROBLOX (variable GAS_URL en Vercel). Usado por api/_lib/juegos/roblox.js.
//
// Cómo actualizarlo: pega este archivo en el proyecto de Apps Script de Roblox y luego
// Implementar > Gestionar implementaciones > editar (lápiz) > Versión: "Nueva versión" > Implementar.
// Así la URL /exec NO cambia y no hay que tocar Vercel.
//
// Pestañas de este libro: "PreciosRoblox" (fila 1 paquetes, fila 2 precios), "Codigos" (una
// columna por paquete) y "Exitosas" (A fecha, B usuario, C paquete, D referencia, E código,
// F comprobante, G cobrado Bs, H código de descuento).
// Los pagos se leen de la hoja de pagos compartida (ID_HOJA_PAGOS: C referencia, D monto, E estado).
//
// Seguridad (Configuración del proyecto > Propiedades del script), opcional:
//   TOKEN_VERCEL = el mismo valor que SCRIPT_RECARGAS_TOKEN en Vercel. Sin él, cualquiera que
//   conociera la URL /exec podría pedir códigos sin pasar por la tienda (ni por sus límites de
//   intentos) y mandar un precio con descuento inventado. Mientras no exista, no se comprueba.
//
// Descuentos: Vercel valida el código del cliente y manda "montoACobrar" (precio ya descontado).
// Solo se acepta si es menor que el precio de la hoja y no baja de DESCUENTO_MAXIMO; si no, se
// cobra el precio completo. El uso del código lo anota Vercel en la hoja de recargas de Free Fire.
// =====================================================================

const ID_HOJA_PAGOS = "1hYl8yGJzmlB2-O6VK9UghZFN5nI7S7Ld5uhA3Np-4X8";
const sheetNameCodigos = "Codigos";
const sheetNameExitosas = "Exitosas";
const sheetNamePreciosRoblox = "PreciosRoblox";

// Vercel espera la compra hasta 45 s: el candado no debe esperar más que eso
const ESPERA_CANDADO_MS = 25000;
// Diferencia que se tolera entre lo pagado y el precio (redondeos del banco), igual que Free Fire
const TOLERANCIA_BS = 0.50;
// Ningún descuento puede dejar el paquete por debajo de este % de su precio (freno ante abusos)
const DESCUENTO_MAXIMO = 0.5;

function doPost(e) {
  var datos;
  try {
    datos = JSON.parse((e && e.postData && e.postData.contents) || "{}");
  } catch (err) {
    return responder({ status: "error", message: "No se recibieron datos válidos." });
  }

  // Solo Vercel puede pedir precios o comprar (si la propiedad TOKEN_VERCEL existe)
  var token = PropertiesService.getScriptProperties().getProperty("TOKEN_VERCEL");
  if (token && String(datos.token || "") !== token) {
    return responder({ status: "error", message: "No autorizado" });
  }

  try {
    // Leer precios no toca pagos ni códigos: no espera el candado
    if (datos.tipo === "obtener_precios") return obtenerPrecios();
    if (datos.tipo !== "compra" && datos.tipo !== "verificacion") {
      return responder({ status: "error", message: "Tipo de solicitud no válido." });
    }

    // 🛡️ Candado: una sola compra de Roblox a la vez
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(ESPERA_CANDADO_MS)) {
      return responder({ status: "error", message: "⚠️ El servidor está procesando otra compra en este momento. Inténtalo de nuevo en unos segundos." });
    }
    try {
      return responder(procesarPagoYExtraerCodigo(datos));
    } finally {
      lock.releaseLock();
    }
  } catch (error) {
    // El detalle va al registro de ejecuciones, nunca al cliente
    console.error("Error en Roblox: " + (error && error.stack || error));
    return responder({ status: "error", message: "Error interno al procesar la compra. Intenta de nuevo en unos segundos." });
  }
}

function procesarPagoYExtraerCodigo(datos) {
  var referencia = String(datos.referencia || "").replace(/\s+/g, "");
  var paquete = String(datos.producto || "").trim();
  var usuario = String(datos.user || datos.usuario || "").trim();
  var urlCapture = String(datos.url_capture || "Sin comprobante");

  if (!/^\d{5}$/.test(referencia)) {
    return { status: "error", message: "⚠️ Ingresa una referencia válida de 5 dígitos." };
  }
  if (!/^[A-Za-z0-9_]{2,30}$/.test(usuario) || !paquete) {
    return { status: "error", message: "⚠️ Datos de la compra incompletos." };
  }

  var libro = SpreadsheetApp.getActiveSpreadsheet();
  var numeroPaquete = paquete.replace(/[^0-9]/g, "");

  // ---- Precio del paquete (obligatorio: antes, sin precio en la hoja no se revisaba el monto) ----
  var precioOficial = precioDePaquete(libro, numeroPaquete);
  if (!(precioOficial > 0)) {
    console.error("Roblox: el paquete '" + paquete + "' no tiene precio en " + sheetNamePreciosRoblox);
    return { status: "error", message: "⚠️ Este paquete no está disponible en este momento." };
  }

  // ---- Precio a cobrar: con descuento solo si es razonable ----
  var precioACobrar = precioOficial;
  var codigoDescuento = "";
  if (datos.montoACobrar !== undefined && datos.montoACobrar !== null && datos.montoACobrar !== "") {
    var conDescuento = limpiarMontoVES(datos.montoACobrar);
    if (conDescuento > 0 && conDescuento <= precioOficial && conDescuento >= precioOficial * (1 - DESCUENTO_MAXIMO)) {
      precioACobrar = conDescuento;
      codigoDescuento = String(datos.codigoDescuento || "").slice(0, 30);
    } else {
      console.error("Roblox: montoACobrar fuera de rango (" + datos.montoACobrar + " para " + precioOficial + "); se cobra el precio completo");
    }
  }

  // ---- Buscar el pago ----
  var hojaPagos;
  try {
    var libroPagos = SpreadsheetApp.openById(ID_HOJA_PAGOS);
    hojaPagos = libroPagos.getSheetByName("pagos") || libroPagos.getSheetByName("Pagos") || libroPagos.getSheets()[0];
  } catch (err) {
    console.error("Roblox: no se pudo abrir la hoja de pagos: " + err);
    return { status: "error", message: "⚠️ No pudimos revisar tu pago en este momento. Intenta de nuevo en unos segundos." };
  }

  // De abajo hacia arriba, el pago disponible más reciente con esos 5 dígitos exactos.
  // Antes se tomaba el primero de arriba: un pago viejo "Usado" bloqueaba uno nuevo, y un pago
  // "En proceso" (que Free Fire estaba usando en ese momento) se podía gastar dos veces.
  var filas = hojaPagos.getDataRange().getValues();
  var filaPago = -1, montoPagado = 0, hayUsado = false, hayEnProceso = false;
  for (var i = filas.length - 1; i >= 1; i--) {
    var refCompleta = String(filas[i][2]).replace(/\s+/g, "");
    if (!refCompleta || refCompleta.slice(-5) !== referencia) continue;
    var estado = String(filas[i][4]).trim().toLowerCase();
    if (estado.indexOf("usad") === 0) { hayUsado = true; continue; }
    if (estado === "en proceso") { hayEnProceso = true; continue; }
    if (estado !== "verificado" && estado !== "") continue;
    filaPago = i + 1;
    montoPagado = limpiarMontoVES(filas[i][3]);
    break;
  }

  if (filaPago === -1) {
    if (hayEnProceso) return { status: "error", message: "⚠️ Ese pago se está procesando en otra recarga en este momento." };
    if (hayUsado) return { status: "error", message: "❌ Esta referencia ya fue utilizada anteriormente." };
    return { status: "error", message: "⚠️ Referencia no encontrada en el sistema de pagos." };
  }

  if (montoPagado < precioACobrar - TOLERANCIA_BS) {
    return {
      status: "error", insuficiente: true, montoPagado: montoPagado, precioOficial: precioACobrar,
      message: "Pago insuficiente: encontramos " + montoPagado + " Bs, pero este paquete cuesta " + precioACobrar + " Bs."
    };
  }

  // ---- Sacar un código del inventario ----
  var hojaCodigos = libro.getSheetByName(sheetNameCodigos);
  var hojaExitosas = libro.getSheetByName(sheetNameExitosas);
  if (!hojaCodigos || !hojaExitosas) {
    console.error("Roblox: faltan las pestañas '" + sheetNameCodigos + "' o '" + sheetNameExitosas + "'");
    return { status: "error", message: "⚠️ La tienda de Roblox no está disponible en este momento." };
  }

  var titulos = hojaCodigos.getRange(1, 1, 1, hojaCodigos.getLastColumn()).getValues()[0];
  var col = -1;
  for (var h = 0; h < titulos.length; h++) {
    if (numeroPaquete && String(titulos[h]).replace(/[^0-9]/g, "") === numeroPaquete) { col = h + 1; break; }
  }
  if (col === -1) return { status: "error", message: "⚠️ Paquete no reconocido en el inventario de códigos." };

  var ultimaFila = hojaCodigos.getLastRow();
  if (ultimaFila < 2) return { status: "error", message: "⚠️ Lo sentimos, stock agotado para este paquete." };
  var columna = hojaCodigos.getRange(2, col, ultimaFila - 1, 1).getValues();
  var codigo = null, filaCodigo = -1;
  for (var j = 0; j < columna.length; j++) {
    var celda = String(columna[j][0]).trim();
    if (celda && celda.indexOf("USADO-") !== 0) { codigo = celda; filaCodigo = j + 2; break; }
  }
  if (!codigo) return { status: "error", message: "⚠️ No hay códigos disponibles en este momento para este paquete." };

  // Justo antes de gastarlo, se vuelve a leer el estado del pago: Free Fire y Blood Strike usan
  // la misma hoja con su propio candado, así que pudo cambiar mientras se buscaba el código.
  var estadoAhora = String(hojaPagos.getRange(filaPago, 5).getValue()).trim().toLowerCase();
  if (estadoAhora !== "verificado" && estadoAhora !== "") {
    return { status: "error", message: "⚠️ Ese pago se acaba de usar en otra recarga." };
  }
  hojaPagos.getRange(filaPago, 5).setValue("Usado");
  SpreadsheetApp.flush();

  // Quitar el código y subir los de abajo (la columna queda sin huecos)
  if (filaCodigo < ultimaFila) {
    var abajo = hojaCodigos.getRange(filaCodigo + 1, col, ultimaFila - filaCodigo, 1).getValues();
    hojaCodigos.getRange(filaCodigo, col, abajo.length, 1).setValues(abajo);
    hojaCodigos.getRange(ultimaFila, col).clearContent();
  } else {
    hojaCodigos.getRange(filaCodigo, col).clearContent();
  }

  var fechaHora = Utilities.formatDate(new Date(), "America/Caracas", "dd/MM/yyyy HH:mm:ss");
  hojaExitosas.appendRow([
    fechaHora,                        // A: fecha
    textoSeguro(usuario),             // B: usuario
    textoSeguro(paquete),             // C: paquete
    textoSeguro(referencia),          // D: referencia
    textoSeguro(codigo),              // E: código entregado
    textoSeguro(urlCapture),          // F: comprobante
    precioACobrar,                    // G: cobrado (Bs)
    textoSeguro(codigoDescuento)      // H: código de descuento ("" si no usó)
  ]);
  SpreadsheetApp.flush();

  return { status: "success", code: codigo, message: "¡Código canjeado con éxito!" };
}

// Precio (número) del paquete en "PreciosRoblox": fila 1 nombres, fila 2 precios. 0 si no está.
function precioDePaquete(libro, numeroPaquete) {
  var hoja = libro.getSheetByName(sheetNamePreciosRoblox);
  if (!hoja || !numeroPaquete) return 0;
  var ultimaColumna = hoja.getLastColumn();
  if (ultimaColumna < 1) return 0;
  var titulos = hoja.getRange(1, 1, 1, ultimaColumna).getValues()[0];
  var precios = hoja.getRange(2, 1, 1, ultimaColumna).getValues()[0];
  for (var p = 0; p < titulos.length; p++) {
    if (String(titulos[p]).replace(/[^0-9]/g, "") === numeroPaquete) return limpiarMontoVES(precios[p]);
  }
  return 0;
}

function obtenerPrecios() {
  var hoja = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetNamePreciosRoblox);
  if (!hoja) return responder({ status: "error", message: "Hoja de precios no encontrada." });
  var ultimaColumna = hoja.getLastColumn();
  var precios = {};
  if (ultimaColumna > 0) {
    var titulos = hoja.getRange(1, 1, 1, ultimaColumna).getValues()[0];
    var valores = hoja.getRange(2, 1, 1, ultimaColumna).getValues()[0];
    for (var i = 0; i < titulos.length; i++) {
      if (titulos[i] !== "") precios[titulos[i]] = valores[i];
    }
  }
  return responder({ status: "success", precios: precios });
}

function responder(objeto) {
  return ContentService.createTextOutput(JSON.stringify(objeto)).setMimeType(ContentService.MimeType.JSON);
}

// Texto que se escribe en la hoja: si empieza como fórmula (= + - @) se guarda como texto
function textoSeguro(valor) {
  var texto = String(valor === undefined || valor === null ? "" : valor).slice(0, 3000);
  return /^[=+\-@]/.test(texto) ? "'" + texto : texto;
}

// Montos en Bs: "1.234,56", "1234.56", "1.234" o número -> número (igual que recargas.gs).
// Antes "1234.56" se leía como 123456 y un pago corto podía pasar como suficiente.
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
