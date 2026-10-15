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
//
// Pago insuficiente: si Vercel manda la huella de la clave del cliente, el pago queda "Por completar"
// (ningún juego lo toma) y la compra en la pestaña "por_completar". Con tipo "completar" el cliente
// paga la diferencia: el usuario, el paquete y el precio salen de esa fila, y el código se busca
// ANTES de gastar el pago nuevo. Al entregar, TODOS los pagos quedan "Usado".
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

// --- Pagos por completar (el cliente pagó menos y paga la diferencia con otro pago) ---
// Una fila por pedido en este libro. N = huella SHA-256 de la clave del cliente (la clave nunca llega a
// la hoja). El pago que no alcanzó queda "Por completar" en la hoja de pagos: ningún juego lo toma.
const HOJA_POR_COMPLETAR = "por_completar";
const COLUMNAS_POR_COMPLETAR = ["fecha-hora", "id pedido", "usuario", "paquete", "precio (Bs)", "pagado (Bs)", "falta (Bs)",
  "referencias", "código descuento", "comprobante", "estado", "pedido que completó", "actualizado", "clave (huella)", "vence"];
const ESTADO_PAGO_POR_COMPLETAR = "Por completar";
const HORAS_PARA_COMPLETAR = 48;
const MAX_PAGOS_POR_PEDIDO = 4;

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
    if (datos.tipo !== "compra" && datos.tipo !== "verificacion" && datos.tipo !== "completar") {
      return responder({ status: "error", message: "Tipo de solicitud no válido." });
    }

    // 🛡️ Candado: una sola compra de Roblox a la vez (también al completar un pago)
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(ESPERA_CANDADO_MS)) {
      return responder({ status: "error", message: "⚠️ El servidor está procesando otra compra en este momento. Inténtalo de nuevo en unos segundos." });
    }
    try {
      return responder(datos.tipo === "completar" ? completarCompra(datos) : procesarPagoYExtraerCodigo(datos));
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
  var hojaPagos = abrirHojaPagos();
  if (!hojaPagos) {
    return { status: "error", message: "⚠️ No pudimos revisar tu pago en este momento. Intenta de nuevo en unos segundos." };
  }
  var pago = buscarPagoLibre(hojaPagos, referencia);
  if (pago.filaPago === -1) return { status: "error", message: mensajePagoNoDisponible(pago) };
  var filaPago = pago.filaPago, montoPagado = pago.montoPagado;

  if (montoPagado < precioACobrar - TOLERANCIA_BS) {
    var insuficiente = {
      status: "error", insuficiente: true, montoPagado: montoPagado, precioOficial: precioACobrar,
      message: "Pago insuficiente: encontramos " + formatoBs(montoPagado) + ", pero este paquete cuesta " + formatoBs(precioACobrar) + "."
    };
    // Vercel manda la huella de la clave del cliente: el pago queda "Por completar" y el pedido en
    // "por_completar" para que pague la diferencia (sin huella, como antes: el pago no se toca)
    var claveHash = String(datos.claveHash || "");
    if (/^[a-f0-9]{64}$/.test(claveHash) && idPedido && !buscarFilaPorCompletar(14, claveHash)) {
      var celdaPago = hojaPagos.getRange(filaPago, 5);
      var estadoPago = String(celdaPago.getValue()).trim().toLowerCase();
      if (estadoPago === "verificado" || estadoPago === "") {
        celdaPago.setValue(ESTADO_PAGO_POR_COMPLETAR);
        var falta = redondear2(precioACobrar - montoPagado);
        var fechaHora = ahora();
        hojaPorCompletar().appendRow([
          fechaHora, textoSeguro(idPedido), textoSeguro(usuario), textoSeguro(paquete), precioACobrar, montoPagado, falta,
          pago.referencia, textoSeguro(codigoDescuento), textoSeguro(urlCapture), "PENDIENTE: faltan " + formatoBs(falta), "",
          fechaHora, claveHash, new Date(Date.now() + HORAS_PARA_COMPLETAR * 3600 * 1000)
        ]);
        SpreadsheetApp.flush();
        insuficiente.porCompletar = true;
        insuficiente.falta = falta;
        insuficiente.horas = HORAS_PARA_COMPLETAR;
        insuficiente.message += " Faltan " + formatoBs(falta) + ": paga la diferencia y escribe la nueva referencia para completar tu compra.";
      }
    }
    return insuficiente;
  }

  // ---- Buscar un código libre (todavía sin tocarlo) ----
  var col = columnaDePaquete(hojaCodigos, numeroPaquete);
  if (col === -1) return { status: "error", message: "⚠️ Paquete no reconocido en el inventario de códigos." };

  var libre = buscarCodigoLibre(hojaCodigos, col);
  var codigo = libre.codigo, filaCodigo = libre.fila;
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

  entregarCodigo({
    hojaCodigos: hojaCodigos, hojaExitosas: hojaExitosas, col: col, filaCodigo: filaCodigo, codigo: codigo,
    usuario: usuario, paquete: paquete, referencia: referencia, urlCapture: urlCapture,
    precioACobrar: precioACobrar, codigoDescuento: codigoDescuento, idPedido: idPedido
  });
  return { status: "success", code: codigo, message: "¡Código canjeado con éxito!" };
}

// Pasos 3 y 4 de la compra, con el pago (o los pagos) ya "Usado": marca el código, anota la venta
// en "Exitosas" y compacta la columna. Un fallo aquí nunca deja al cliente sin su código.
function entregarCodigo(c) {
  var hojaCodigos = c.hojaCodigos, hojaExitosas = c.hojaExitosas, col = c.col, filaCodigo = c.filaCodigo, codigo = c.codigo;
  var usuario = c.usuario, paquete = c.paquete, referencia = c.referencia, urlCapture = c.urlCapture;
  var precioACobrar = c.precioACobrar, codigoDescuento = c.codigoDescuento, idPedido = c.idPedido;

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
}

// Completar un pago insuficiente (tipo "completar", con candado). Vercel manda la huella de la clave
// del cliente, los últimos 5 del pago nuevo y un idPedido. El usuario, el paquete y el precio salen
// de "por_completar". Si ya alcanza, el código se busca ANTES de gastar el pago nuevo.
function completarCompra(datos) {
  var claveHash = String(datos.claveHash || "");
  var referencia = String(datos.referencia || "").replace(/\s+/g, "");
  var idPedido = String(datos.idPedido || "").slice(0, 60);
  var noValido = function (mensaje) { return { status: "error", complementoInvalido: true, message: mensaje }; };
  if (!/^[a-f0-9]{64}$/.test(claveHash) || !/^\d{5}$/.test(referencia) || !idPedido) {
    return noValido("Datos inválidos para completar el pago.");
  }

  var fila = buscarFilaPorCompletar(14, claveHash);
  if (!fila) return noValido("No encontramos este pago por completar. Escríbenos por WhatsApp con tus referencias.");
  var hojaPc = hojaPorCompletar();
  var v = hojaPc.getRange(fila, 1, 1, COLUMNAS_POR_COMPLETAR.length).getValues()[0];
  if (String(v[10]).indexOf("PENDIENTE") !== 0) {
    return noValido("Este pago ya se completó o está en revisión. Si no recibiste tu código, escríbenos por WhatsApp.");
  }
  var vence = v[14] instanceof Date ? v[14].getTime() : new Date(v[14]).getTime();
  if (vence && Date.now() > vence) {
    hojaPc.getRange(fila, 11).setValue("⌛ VENCIDO: resolver por WhatsApp");
    hojaPc.getRange(fila, 13).setValue(ahora());
    return noValido("Pasaron más de " + HORAS_PARA_COMPLETAR + " horas: escríbenos por WhatsApp con tus referencias para completar tu compra.");
  }
  var referencias = String(v[7]).split(" + ").filter(function (r) { return r; });
  if (referencias.length >= MAX_PAGOS_POR_PEDIDO) {
    return noValido("Ya usaste el máximo de " + MAX_PAGOS_POR_PEDIDO + " pagos para esta compra: escríbenos por WhatsApp.");
  }

  var libro = SpreadsheetApp.getActiveSpreadsheet();
  var hojaCodigos = libro.getSheetByName(sheetNameCodigos);
  var hojaExitosas = libro.getSheetByName(sheetNameExitosas);
  var hojaPagos = abrirHojaPagos();
  if (!hojaCodigos || !hojaExitosas || !hojaPagos) {
    return { status: "error", message: "⚠️ No pudimos revisar tu pago en este momento. Intenta de nuevo en unos segundos." };
  }

  var pago = buscarPagoLibre(hojaPagos, referencia);
  if (pago.filaPago === -1) return { status: "error", message: mensajePagoNoDisponible(pago) };

  var usuario = String(v[2]), paquete = String(v[3]);
  var precio = limpiarMontoVES(v[4]);
  var pagado = redondear2(limpiarMontoVES(v[5]) + pago.montoPagado);
  var falta = redondear2(Math.max(0, precio - pagado));
  var celdaPago = hojaPagos.getRange(pago.filaPago, 5);
  var estadoAhora = String(celdaPago.getValue()).trim().toLowerCase();
  if (estadoAhora !== "verificado" && estadoAhora !== "") {
    return { status: "error", message: "⚠️ Ese pago se acaba de usar en otra recarga." };
  }

  if (pagado < precio - TOLERANCIA_BS) {
    // Tampoco alcanza: este pago también queda "Por completar" y la compra sigue pendiente
    celdaPago.setValue(ESTADO_PAGO_POR_COMPLETAR);
    referencias.push(pago.referencia);
    hojaPc.getRange(fila, 6, 1, 3).setValues([[pagado, falta, referencias.join(" + ")]]);
    hojaPc.getRange(fila, 11).setValue("PENDIENTE: faltan " + formatoBs(falta));
    hojaPc.getRange(fila, 13).setValue(ahora());
    SpreadsheetApp.flush();
    return {
      status: "error", insuficiente: true, porCompletar: true, montoPagado: pagado, precioOficial: precio, falta: falta,
      horas: HORAS_PARA_COMPLETAR,
      message: "Pago insuficiente: con este pago llevas " + formatoBs(pagado) + " y faltan " + formatoBs(falta) + ". Paga la diferencia y escribe la nueva referencia."
    };
  }

  // Alcanza: primero el código (si se agotó, el pago nuevo NO se toca y la compra sigue pendiente)
  var col = columnaDePaquete(hojaCodigos, paquete.replace(/[^0-9]/g, ""));
  var libre = col === -1 ? { codigo: null } : buscarCodigoLibre(hojaCodigos, col);
  if (!libre.codigo) {
    console.error("Roblox: pago completado pero sin códigos de '" + paquete + "' (fila " + fila + " de por_completar)");
    return { status: "error", agotado: true, message: "⚠️ Este paquete se agotó justo ahora. Tu pago anterior sigue guardado: escríbenos por WhatsApp y te lo entregamos." };
  }

  // Gastar TODOS los pagos de esta compra
  celdaPago.setValue("Usado");
  referencias.forEach(function (ref) { marcarPagoUsado(hojaPagos, ref); });
  referencias.push(pago.referencia);
  SpreadsheetApp.flush();
  hojaPc.getRange(fila, 6, 1, 3).setValues([[pagado, falta, referencias.join(" + ")]]);
  hojaPc.getRange(fila, 11, 1, 3).setValues([["✅ COMPLETADO Y ENTREGADO", textoSeguro(idPedido), ahora()]]);

  var codigoDescuento = String(v[8] || "");
  entregarCodigo({
    hojaCodigos: hojaCodigos, hojaExitosas: hojaExitosas, col: col, filaCodigo: libre.fila, codigo: libre.codigo,
    usuario: usuario, paquete: paquete, referencia: referencias.join(" + "), urlCapture: String(v[9] || "Sin comprobante"),
    precioACobrar: precio, codigoDescuento: codigoDescuento, idPedido: idPedido
  });
  // usuario, precio y código de descuento: para que Vercel anote el uso del código (no llegan al cliente)
  return { status: "success", code: libre.codigo, message: "¡Código canjeado con éxito!", usuario: usuario, precio: precio, codigoDescuento: codigoDescuento };
}

// Pestaña "pagos" de la hoja compartida. null (y aviso en el registro) si no se puede abrir.
function abrirHojaPagos() {
  var hojaPagos = null;
  try {
    var libroPagos = SpreadsheetApp.openById(ID_HOJA_PAGOS);
    // Solo la pestaña "pagos": antes, si no existía, se usaba la primera pestaña del libro
    hojaPagos = libroPagos.getSheetByName("pagos") || libroPagos.getSheetByName("Pagos");
  } catch (err) {
    console.error("Roblox: no se pudo abrir la hoja de pagos: " + err);
  }
  if (!hojaPagos) console.error("Roblox: no se encontró la pestaña 'pagos' en la hoja " + ID_HOJA_PAGOS);
  return hojaPagos;
}

// De abajo hacia arriba, el pago disponible más reciente con esos 5 dígitos exactos.
// Se saltan los "Usado" (un pago viejo no bloquea uno nuevo), los "En proceso" (otra tienda lo está
// usando) y los "Por completar" (esperan la diferencia). Solo se leen las columnas A-E.
// { filaPago (-1 si no hay), montoPagado, referencia, hayUsado, hayEnProceso, hayPorCompletar }
function buscarPagoLibre(hojaPagos, referencia) {
  var ultimaPago = hojaPagos.getLastRow();
  var filas = ultimaPago > 1 ? hojaPagos.getRange(2, 1, ultimaPago - 1, 5).getValues() : [];
  var r = { filaPago: -1, montoPagado: 0, referencia: "", hayUsado: false, hayEnProceso: false, hayPorCompletar: false };
  for (var i = filas.length - 1; i >= 0; i--) {
    var refCompleta = String(filas[i][2]).replace(/\s+/g, "");
    if (!refCompleta || refCompleta.slice(-5) !== referencia) continue;
    var estado = String(filas[i][4]).trim().toLowerCase();
    if (estado.indexOf("usad") === 0) { r.hayUsado = true; continue; }
    if (estado === "en proceso") { r.hayEnProceso = true; continue; }
    if (estado === ESTADO_PAGO_POR_COMPLETAR.toLowerCase()) { r.hayPorCompletar = true; continue; }
    if (estado !== "verificado" && estado !== "") continue;
    r.filaPago = i + 2;
    r.montoPagado = limpiarMontoVES(filas[i][3]);
    r.referencia = refCompleta;
    break;
  }
  return r;
}

function mensajePagoNoDisponible(pago) {
  if (pago.hayEnProceso) return "⚠️ Ese pago se está procesando en otra recarga en este momento.";
  if (pago.hayPorCompletar) return "⏳ Este pago no alcanzó y está esperando que completes la diferencia: usa el botón \"Completar pago\" de la tienda o escríbenos por WhatsApp.";
  if (pago.hayUsado) return "❌ Esta referencia ya fue utilizada anteriormente.";
  return "⚠️ Referencia no encontrada en el sistema de pagos.";
}

// Primer código libre de la columna (todavía sin tocarlo): { codigo, fila } o { codigo: null }
function buscarCodigoLibre(hojaCodigos, col) {
  var ultimaFila = hojaCodigos.getLastRow();
  var columna = ultimaFila > 1 ? hojaCodigos.getRange(2, col, ultimaFila - 1, 1).getValues() : [];
  for (var j = 0; j < columna.length; j++) {
    var celda = String(columna[j][0]).trim();
    if (codigoLibre(celda)) return { codigo: celda, fila: j + 2 };
  }
  return { codigo: null, fila: -1 };
}

// "Por completar" -> "Usado" del pago con esa referencia completa (la fila más reciente)
function marcarPagoUsado(hojaPagos, referencia) {
  var ultima = hojaPagos.getLastRow();
  var refs = ultima > 1 ? hojaPagos.getRange(2, 3, ultima - 1, 1).getValues() : [];
  for (var i = refs.length - 1; i >= 0; i--) {
    if (String(refs[i][0]).replace(/\s+/g, "") === referencia) {
      hojaPagos.getRange(i + 2, 5).setValue("Usado");
      return;
    }
  }
}

function hojaPorCompletar() {
  var libro = SpreadsheetApp.getActiveSpreadsheet();
  var hoja = libro.getSheetByName(HOJA_POR_COMPLETAR);
  if (!hoja) {
    hoja = libro.insertSheet(HOJA_POR_COMPLETAR, 0);
    hoja.appendRow(COLUMNAS_POR_COMPLETAR);
    hoja.getRange(1, 1, 1, COLUMNAS_POR_COMPLETAR.length).setFontWeight("bold");
    hoja.setFrozenRows(1);
  }
  return hoja;
}

// Fila (la más reciente) de "por_completar" con ese valor exacto en esa columna (14 = huella de la clave)
function buscarFilaPorCompletar(columna, valor) {
  var hoja = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(HOJA_POR_COMPLETAR);
  if (!valor || !hoja || hoja.getLastRow() < 2) return 0;
  var celdas = hoja.getRange(2, columna, hoja.getLastRow() - 1, 1)
    .createTextFinder(String(valor)).matchEntireCell(true).matchCase(true).findAll();
  return celdas.length ? celdas[celdas.length - 1].getRow() : 0;
}

// Fecha y hora de Venezuela con el formato de las pestañas
function ahora() {
  return Utilities.formatDate(new Date(), "America/Caracas", "dd/MM/yyyy HH:mm:ss");
}

function redondear2(n) {
  return Math.round(Number(n) * 100) / 100;
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
