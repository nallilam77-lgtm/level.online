// =====================================================================
// LEVEL UP - Apps Script de ROBLOX (variable GAS_URL en Vercel). Usado por api/_lib/juegos/roblox.js.
//
// Cómo actualizarlo: pega este archivo en el proyecto de Apps Script de Roblox y luego
// Implementar > Gestionar implementaciones > editar (lápiz) > Versión: "Nueva versión" > Implementar.
// Así la URL /exec NO cambia y no hay que tocar Vercel.
//
// Pestañas de este libro: "PreciosRoblox" (fila 1 paquetes, fila 2 precios), "Codigos" (una
// columna por paquete) y "Exitosas" (A fecha, B usuario, C paquete, D referencia, E código,
// F comprobante, G cobrado Bs, H código de descuento, I id del pedido).
// Los pagos se leen de la hoja de pagos compartida (ID_HOJA_PAGOS: C referencia, D monto, E estado).
//
// Seguridad (Configuración del proyecto > Propiedades del script):
//   TOKEN_VERCEL = el mismo valor que SCRIPT_RECARGAS_TOKEN en Vercel. MUY RECOMENDADO: sin él,
//   cualquiera que conociera la URL /exec podría pedir códigos sin pasar por la tienda (ni por sus
//   límites de intentos) y mandar un precio con descuento inventado. Mientras no exista, no se
//   comprueba (y queda un aviso en el registro de ejecuciones).
//
// Descuentos: Vercel valida el código del cliente y manda "montoACobrar" (precio ya descontado).
// Solo se acepta si es menor que el precio de la hoja y no baja de DESCUENTO_MAXIMO; si no, se
// cobra el precio completo. El uso del código lo anota Vercel en la hoja de recargas de Free Fire.
//
// Stock: obtener_precios devuelve también cuántos códigos quedan de cada paquete. Vercel no se lo
// pasa tal cual al cliente: solo "disponible", "últimos" o "agotado".
//
// Orden de la compra (pensado para que un fallo a mitad nunca cobre sin entregar ni entregue dos
// veces el mismo código):
//   1. Se busca el pago y un código libre (sin tocar nada).
//   2. Se marca el pago "Usado" (comprobando antes que nadie lo usó entretanto).
//   3. Se marca el código "USADO-..." en su celda: ya no se puede entregar a nadie más.
//   4. Se anota la venta en "Exitosas" y se compacta la columna. Si esto falla, el cliente igual
//      recibe su código (el pago ya se gastó) y el detalle queda en el registro de ejecuciones.
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
// Marca de los códigos ya entregados que todavía no se quitaron de la columna
const PREFIJO_USADO = "USADO-";

function doPost(e) {
  var datos;
  try {
    datos = JSON.parse((e && e.postData && e.postData.contents) || "{}");
  } catch (err) {
    return responder({ status: "error", message: "No se recibieron datos válidos." });
  }
  if (!datos || typeof datos !== "object") {
    return responder({ status: "error", message: "No se recibieron datos válidos." });
  }

  // Solo Vercel puede pedir precios o comprar (si la propiedad TOKEN_VERCEL existe)
  var token = PropertiesService.getScriptProperties().getProperty("TOKEN_VERCEL");
  if (token) {
    if (!mismoTexto(String(datos.token || ""), token)) {
      return responder({ status: "error", message: "No autorizado" });
    }
  } else {
    console.warn("Roblox: falta la propiedad TOKEN_VERCEL; cualquiera con la URL /exec puede usar este script");
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
  var idPedido = String(datos.idPedido || "").slice(0, 60);

  if (!/^\d{5}$/.test(referencia)) {
    return { status: "error", message: "⚠️ Ingresa una referencia válida de 5 dígitos." };
  }
  if (!/^[A-Za-z0-9_]{2,30}$/.test(usuario) || !paquete || paquete.length > 60) {
    return { status: "error", message: "⚠️ Datos de la compra incompletos." };
  }

  var libro = SpreadsheetApp.getActiveSpreadsheet();
  var numeroPaquete = paquete.replace(/[^0-9]/g, "");
  if (!numeroPaquete) return { status: "error", message: "⚠️ Paquete no reconocido." };

  // ---- Precio del paquete (obligatorio: sin precio en la hoja no se vende) ----
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

  // ---- Pestañas de este libro (antes de tocar nada) ----
  var hojaCodigos = libro.getSheetByName(sheetNameCodigos);
  var hojaExitosas = libro.getSheetByName(sheetNameExitosas);
  if (!hojaCodigos || !hojaExitosas) {
    console.error("Roblox: faltan las pestañas '" + sheetNameCodigos + "' o '" + sheetNameExitosas + "'");
    return { status: "error", message: "⚠️ La tienda de Roblox no está disponible en este momento." };
  }

  // ---- Buscar el pago ----
  var hojaPagos;
  try {
    var libroPagos = SpreadsheetApp.openById(ID_HOJA_PAGOS);
    // Solo la pestaña "pagos": antes, si no existía, se usaba la primera pestaña del libro
    hojaPagos = libroPagos.getSheetByName("pagos") || libroPagos.getSheetByName("Pagos");
  } catch (err) {
    console.error("Roblox: no se pudo abrir la hoja de pagos: " + err);
  }
  if (!hojaPagos) {
    console.error("Roblox: no se encontró la pestaña 'pagos' en la hoja " + ID_HOJA_PAGOS);
    return { status: "error", message: "⚠️ No pudimos revisar tu pago en este momento. Intenta de nuevo en unos segundos." };
  }

  // De abajo hacia arriba, el pago disponible más reciente con esos 5 dígitos exactos.
  // Se saltan los "Usado" (un pago viejo no bloquea uno nuevo) y los "En proceso" (Free Fire lo
  // está usando en ese momento). Solo se leen las columnas A-E.
  var ultimaPago = hojaPagos.getLastRow();
  var filas = ultimaPago > 1 ? hojaPagos.getRange(2, 1, ultimaPago - 1, 5).getValues() : [];
  var filaPago = -1, montoPagado = 0, hayUsado = false, hayEnProceso = false;
  for (var i = filas.length - 1; i >= 0; i--) {
    var refCompleta = String(filas[i][2]).replace(/\s+/g, "");
    if (!refCompleta || refCompleta.slice(-5) !== referencia) continue;
    var estado = String(filas[i][4]).trim().toLowerCase();
    if (estado.indexOf("usad") === 0) { hayUsado = true; continue; }
    if (estado === "en proceso") { hayEnProceso = true; continue; }
    if (estado !== "verificado" && estado !== "") continue;
    filaPago = i + 2;
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
      message: "Pago insuficiente: encontramos " + formatoBs(montoPagado) + ", pero este paquete cuesta " + formatoBs(precioACobrar) + "."
    };
  }

  // ---- Buscar un código libre (todavía sin tocarlo) ----
  var col = columnaDePaquete(hojaCodigos, numeroPaquete);
  if (col === -1) return { status: "error", message: "⚠️ Paquete no reconocido en el inventario de códigos." };

  var ultimaFila = hojaCodigos.getLastRow();
  var columna = ultimaFila > 1 ? hojaCodigos.getRange(2, col, ultimaFila - 1, 1).getValues() : [];
  var codigo = null, filaCodigo = -1;
  for (var j = 0; j < columna.length; j++) {
    var celda = String(columna[j][0]).trim();
    if (codigoLibre(celda)) { codigo = celda; filaCodigo = j + 2; break; }
  }
  if (!codigo) return { status: "error", agotado: true, message: "⚠️ Este paquete se acaba de agotar. Elige otro o escríbenos por WhatsApp." };

  // ---- Gastar el pago ----
  // Justo antes, se vuelve a leer su estado: Free Fire y Blood Strike usan la misma hoja con su
  // propio candado, así que pudo cambiar mientras se buscaba el código.
  var celdaEstado = hojaPagos.getRange(filaPago, 5);
  var estadoAhora = String(celdaEstado.getValue()).trim().toLowerCase();
  if (estadoAhora !== "verificado" && estadoAhora !== "") {
    return { status: "error", message: "⚠️ Ese pago se acaba de usar en otra recarga." };
  }
  celdaEstado.setValue("Usado");
  SpreadsheetApp.flush();

  // ---- Marcar el código como entregado: desde aquí nadie más puede recibirlo ----
  try {
    hojaCodigos.getRange(filaCodigo, col).setValue(PREFIJO_USADO + codigo);
    SpreadsheetApp.flush();
  } catch (err) {
    // El pago ya se gastó: el cliente recibe su código igual. Hay que marcarlo a mano.
    console.error("Roblox: NO se pudo marcar como usado el código de la fila " + filaCodigo + " (columna " + col +
      ") entregado a " + usuario + " (ref " + referencia + "). Quítalo a mano del inventario. " + err);
  }

  // ---- Registro y limpieza: un fallo aquí nunca deja al cliente sin su código ----
  try {
    var fechaHora = Utilities.formatDate(new Date(), "America/Caracas", "dd/MM/yyyy HH:mm:ss");
    hojaExitosas.appendRow([
      fechaHora,                        // A: fecha
      textoSeguro(usuario),             // B: usuario
      textoSeguro(paquete),             // C: paquete
      textoSeguro(referencia),          // D: referencia
      textoSeguro(codigo),              // E: código entregado
      textoSeguro(urlCapture),          // F: comprobante
      precioACobrar,                    // G: cobrado (Bs)
      textoSeguro(codigoDescuento),     // H: código de descuento ("" si no usó)
      textoSeguro(idPedido)             // I: id del pedido en Vercel
    ]);
  } catch (err) {
    console.error("Roblox: venta entregada pero NO anotada en Exitosas | usuario " + usuario + " | " + paquete +
      " | ref " + referencia + " | código " + codigo + " | " + precioACobrar + " Bs | " + err);
  }
  try {
    quitarCodigoDeLaColumna(hojaCodigos, col, filaCodigo);
  } catch (err) {
    // Queda la marca USADO-...: no se vuelve a entregar, solo ocupa una celda
    console.error("Roblox: no se pudo compactar la columna " + col + " de Codigos: " + err);
  }
  SpreadsheetApp.flush();

  return { status: "success", code: codigo, message: "¡Código canjeado con éxito!" };
}

// Quita la celda del código entregado y sube los de abajo (la columna queda sin huecos).
// Se vuelve a leer la columna: solo se borra si la celda todavía tiene la marca de usado.
function quitarCodigoDeLaColumna(hoja, col, fila) {
  var ultimaFila = hoja.getLastRow();
  if (fila > ultimaFila) return;
  if (String(hoja.getRange(fila, col).getValue()).indexOf(PREFIJO_USADO) !== 0) return;
  if (fila < ultimaFila) {
    var abajo = hoja.getRange(fila + 1, col, ultimaFila - fila, 1).getValues();
    hoja.getRange(fila, col, abajo.length, 1).setValues(abajo);
  }
  hoja.getRange(ultimaFila, col).clearContent();
}

// Un código se puede entregar si la celda tiene texto y no lleva la marca de usado
function codigoLibre(celda) {
  return Boolean(celda) && celda.indexOf(PREFIJO_USADO) !== 0;
}

// Columna (1, 2...) del paquete en "Codigos" según los números del título. -1 si no está.
function columnaDePaquete(hojaCodigos, numeroPaquete) {
  var ultimaColumna = hojaCodigos.getLastColumn();
  if (ultimaColumna < 1) return -1;
  var titulos = hojaCodigos.getRange(1, 1, 1, ultimaColumna).getValues()[0];
  for (var h = 0; h < titulos.length; h++) {
    if (String(titulos[h]).replace(/[^0-9]/g, "") === numeroPaquete) return h + 1;
  }
  return -1;
}

// Precio (número) del paquete en "PreciosRoblox": fila 1 nombres, fila 2 precios. 0 si no está.
function precioDePaquete(libro, numeroPaquete) {
  var hoja = libro.getSheetByName(sheetNamePreciosRoblox);
  if (!hoja || !numeroPaquete) return 0;
  var ultimaColumna = hoja.getLastColumn();
  if (ultimaColumna < 1) return 0;
  var filas = hoja.getRange(1, 1, 2, ultimaColumna).getValues();
  for (var p = 0; p < filas[0].length; p++) {
    if (String(filas[0][p]).replace(/[^0-9]/g, "") === numeroPaquete) return limpiarMontoVES(filas[1][p]);
  }
  return 0;
}

// Sin candado: solo lectura. Precios { "800 Robux": 1700, ... } y códigos libres por paquete
// { "800 Robux": 4, ... } (Vercel convierte la cantidad en disponible / últimos / agotado).
function obtenerPrecios() {
  var libro = SpreadsheetApp.getActiveSpreadsheet();
  var hoja = libro.getSheetByName(sheetNamePreciosRoblox);
  if (!hoja) return responder({ status: "error", message: "Hoja de precios no encontrada." });
  var ultimaColumna = hoja.getLastColumn();
  var precios = {};
  var stock = {};
  var libresPorNumero = contarCodigosLibres(libro.getSheetByName(sheetNameCodigos));
  if (ultimaColumna > 0) {
    var filas = hoja.getRange(1, 1, 2, ultimaColumna).getValues();
    for (var i = 0; i < filas[0].length; i++) {
      var titulo = String(filas[0][i]).trim();
      if (!titulo) continue;
      precios[titulo] = filas[1][i];
      stock[titulo] = libresPorNumero[titulo.replace(/[^0-9]/g, "")] || 0;
    }
  }
  return responder({ status: "success", precios: precios, stock: stock });
}

// { "800": 4, "1700": 0, ... }: códigos libres de cada columna de "Codigos", por el número del título
function contarCodigosLibres(hojaCodigos) {
  var conteo = {};
  if (!hojaCodigos) return conteo;
  var ultimaFila = hojaCodigos.getLastRow();
  var ultimaColumna = hojaCodigos.getLastColumn();
  if (ultimaFila < 1 || ultimaColumna < 1) return conteo;
  var valores = hojaCodigos.getRange(1, 1, ultimaFila, ultimaColumna).getValues();
  for (var c = 0; c < ultimaColumna; c++) {
    var numero = String(valores[0][c]).replace(/[^0-9]/g, "");
    if (!numero) continue;
    var libres = 0;
    for (var f = 1; f < valores.length; f++) if (codigoLibre(String(valores[f][c]).trim())) libres++;
    conteo[numero] = (conteo[numero] || 0) + libres;
  }
  return conteo;
}

function responder(objeto) {
  return ContentService.createTextOutput(JSON.stringify(objeto)).setMimeType(ContentService.MimeType.JSON);
}

// Compara dos textos sin cortar en la primera diferencia (no revela por tiempos cuánto acertó)
function mismoTexto(a, b) {
  if (a.length !== b.length) return false;
  var diferencia = 0;
  for (var i = 0; i < a.length; i++) diferencia |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diferencia === 0;
}

// Texto que se escribe en la hoja: si empieza como fórmula (= + - @) se guarda como texto
function textoSeguro(valor) {
  var texto = String(valor === undefined || valor === null ? "" : valor).slice(0, 3000);
  return /^[=+\-@]/.test(texto) ? "'" + texto : texto;
}

// 1700 -> "1.700,00 Bs"
function formatoBs(n) {
  var partes = (Math.round(Number(n) * 100) / 100).toFixed(2).split(".");
  return partes[0].replace(/\B(?=(\d{3})+(?!\d))/g, ".") + "," + partes[1] + " Bs";
}

// Montos en Bs: "1.234,56", "1234.56", "1.234" o número -> número (igual que recargas.gs).
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
