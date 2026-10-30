// =====================================================================
// LEVEL UP - Apps Script de BLOOD STRIKE (variable SCRIPT_BLOOD en Vercel)
// Usado por: api/_lib/juegos/bloodstrike.js (precios y recarga por la API de Central One),
// api/centralone-webhook.js y api/fazer-webhook.js (estado de cada pedido en tiempo real; FazerCards
// solo para las órdenes anteriores al cambio de proveedor).
//
// Secciones:  1 Configuración · 2 Entrada (doGet / doPost) · 3 Pagos · 4 Recargas y FazerCards
//             5 Utilidades · 6 Menú: productos de Central One en la pestaña de precios
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
//   - Cada recarga por la API queda en la pestaña "fazer_card" (el nombre quedó de FazerCards; hoy
//     son pedidos de Central One); el webhook actualiza su estado (⏳ en proceso → ✅ completada /
//     ❌ fallida / ↩️ reembolsada).
//   - Pago insuficiente: el pago queda "Por completar" (nadie más puede usarlo, tampoco desde Free
//     Fire) y el pedido en la pestaña "por_completar". El cliente paga la diferencia con su clave
//     (Vercel solo manda la huella); el jugador, el paquete y el precio salen de esa fila.
// =====================================================================


// =====================================================================
// 1. CONFIGURACIÓN
// =====================================================================

const PROJECT_ID = "levelupstore-87d4d";
const COLLECTION_NAME = "Pagos";
const FOLDER_ID = "12-YApHdXIFtbIk9qzNCiUY0SVsimCecO"; // Carpeta de comprobantes
const ID_HOJA_PAGOS = "1FTjXo7sKybYVmyGO9HBlyla0T2LHBfCB8yHEV70JyOA"; // Hoja central de pagos

// Versión que la tienda lee en obtener_precios (y usar_complemento): con 2 o más, Vercel sabe que
// verificar_pago es idempotente (idPedido) y que puede reintentarlo tras un timeout sin bloquear otro
// pago; con 3 o más, que registrar_finalizado ignora un idPedido ya anotado (repite el cierre en segundo plano).
const VERSION_SCRIPT = 3;

// Vercel espera hasta 15 s por intento: si el candado tarda más que esto, es mejor responder
// "ocupado" (Vercel reintenta) que trabajar para una petición que ya nadie espera.
const ESPERA_CANDADO_MS = 8000;
// Webhook de FazerCards: solo espera 10 s (si no, lo reintenta en 1 minuto)
const ESPERA_CANDADO_WEBHOOK_MS = 4000;
const MENSAJE_ERROR_INTERNO = "Error interno en el sistema de recargas. Intenta de nuevo en unos segundos.";

// --- Pagos por completar (el cliente pagó menos y paga la diferencia con otro pago) ---
// Una fila por pedido. N = huella SHA-256 de la clave del cliente (la clave nunca llega a la hoja).
const HOJA_POR_COMPLETAR = "por_completar";
const COLUMNAS_POR_COMPLETAR = ["fecha-hora", "id pedido", "id jugador", "paquete", "precio (Bs)", "pagado (Bs)", "falta (Bs)",
  "referencias", "código descuento", "comprobante", "estado", "pedido que completó", "actualizado", "clave (huella)", "vence", "WhatsApp"];
// Estado de "pagos" de un pago que no alcanzó: no es "Verificado", así que ningún otro pedido lo toma
const ESTADO_PAGO_POR_COMPLETAR = "Por completar";
const HORAS_PARA_COMPLETAR = 48;
const MAX_PAGOS_POR_PEDIDO = 4;

// Los comprobantes muestran nombre/cédula del cliente: por defecto solo los ve el dueño de la carpeta.
const COMPARTIR_COMPROBANTES_CON_ENLACE = false;

// Columnas de "errores" (A-D son las de siempre; E-H agregan el detalle que manda Vercel)
const COLUMNAS_ERRORES = ["fecha-hora", "id", "producto", "informe completo", "fase del fallo", "motivo técnico", "estado del pago", "id pedido", "WhatsApp"];
// "finalizados": A-E de siempre; F = orden de FazerCards; G = WhatsApp del cliente
const TITULO_ORDEN_FINALIZADOS = "orden FazerCards";
const COLUMNA_WHATSAPP_FINALIZADOS = 7;

// --- FazerCards ---
// Una fila por recarga enviada a la API. La columna J ("estado") la actualiza el webhook.
const HOJA_FAZER = "fazer_card";
const COLUMNAS_FAZER = ["fecha-hora", "id jugador", "paquete", "oferta FazerCards", "referencia", "cobrado (Bs)",
  "comprobante", "id pedido", "orden FazerCards", "estado", "actualizado", "detalle", "WhatsApp"];
const ORDEN_FAZER_VALIDA = /^[A-Za-z0-9_.:-]{1,80}$/;
// processing/completed/failed/refund: FazerCards; confirmed/partially_completed/cancelled/refunded: Central One
const TEXTO_ESTADO_FAZER = { processing: "⏳ EN PROCESO", confirmed: "⏳ EN PROCESO", completed: "✅ COMPLETADA", failed: "❌ FALLIDA",
  partially_completed: "⚠️ ENTREGA PARCIAL", cancelled: "❌ CANCELADA", refund: "↩️ REEMBOLSADA", refunded: "↩️ REEMBOLSADA" };
// Estados en los que la recarga NO llegó al jugador (se anotan en "errores")
const ESTADOS_FALLO_FAZER = /^(failed|cancelled|partially_completed|refund)/;
const TEXTO_FALLO_FAZER = /FALLIDA|CANCELADA|PARCIAL|REEMBOLSADA/;
// Aviso del webhook que llegó antes de que la orden se anotara: se guarda este tiempo (máximo de CacheService)
const ESPERA_AVISO_FAZER_S = 21600;

// --- Pestaña de precios ("PreciosBlood") ---
// Fila 1 = paquete (lo que ve el cliente; se puede renombrar) · fila 2 = precio en Bs (fórmula:
// costo × dólar × (1 + ganancia %), con los datos de la pestaña "tasa_dolar")
// Fila 3 = product_id de Central One (lo llena el menú; NO tocar) · fila 4 = costo en USD · fila 5 = stock
// Una columna sin precio no se vende (no aparece en la tienda).
const FILA_PRODUCTO = 3;
const FILA_COSTO = 4;
// Pestaña "tasa_dolar": B1 = precio del dólar en Bs · B2 = ganancia en % sobre el costo
const HOJA_TASA = "tasa_dolar";
const GANANCIA_INICIAL = 4;

// --- Central One (menú 🩸 Blood Strike) ---
const URL_CENTRALONE = "https://portal.centraloneglobal.com/api/v1";
// Propiedad del script con la llave (menú 🔑). Basta con el permiso catalog:read.
const PROPIEDAD_LLAVE_CENTRALONE = "CENTRALONE_API_KEY";
const JUEGO_CENTRALONE = "bloodstrike";
// Solo se traen los productos de esta región (los de otras regiones se ignoran)
const REGION_CENTRALONE = "GLOBAL";


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
    bloquear_pedido: bloquearPedido,
    marcar_usado: marcarUsado,
    registrar_finalizado: registrarFinalizado,
    registrar_error: registrarError,
    pago_por_completar: guardarPorCompletar,
    usar_complemento: usarComplemento
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
//    Estados: Verificado -> En proceso (lo tomó un pedido) -> Usado (o "Por completar" si no alcanzó).
//    Nunca vuelve a "Verificado".
// =====================================================================

// Busca el pago por los últimos 5 dígitos y lo bloquea ("En proceso") para que nadie más lo use
function verificarPago(datos) {
  var ultimos5 = String(datos.referencia || "").replace(/\s+/g, "");
  if (!/^\d{5}$/.test(ultimos5)) {
    return responder({ status: "success", encontrado: false, message: "🔍 La referencia debe tener exactamente 5 dígitos." });
  }
  var precioRequerido = limpiarMontoVES(datos.monto);
  var pago = tomarPago(ultimos5, String(datos.idPedido || ""));
  if (!pago.encontrado) return responder({ status: "success", encontrado: false, message: pago.message });
  return responder({
    status: "success", encontrado: true, fila: pago.fila, telefono: pago.telefono,
    referencia: pago.referencia, montoPagado: pago.montoPagado,
    insuficiente: pago.montoPagado < (precioRequerido - 0.50), repetido: pago.repetido
  });
}

// Busca el pago con esos últimos 5 dígitos y lo bloquea ("En proceso") para este pedido.
// Devuelve { encontrado, fila, telefono, referencia, montoPagado, repetido } o { encontrado: false, message }.
function tomarPago(ultimos5, idPedido) {
  var hojaPagos = hojaCentralPagos();
  var rows = hojaPagos.getDataRange().getValues();
  var props = PropertiesService.getScriptProperties();
  var respuestaEncontrado = function (i, repetido) {
    return {
      encontrado: true, fila: i + 1, telefono: String(rows[i][1]).trim(),
      referencia: String(rows[i][2]).replace(/\s+/g, ""), montoPagado: limpiarMontoVES(rows[i][3]), repetido: repetido
    };
  };

  // De abajo hacia arriba: el pago disponible más reciente; los ya usados se saltan
  var hayUsado = false, hayEnProceso = false, hayPorCompletar = false;
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
    if (estadoActual === ESTADO_PAGO_POR_COMPLETAR.toLowerCase()) { hayPorCompletar = true; continue; }
    if (estadoActual !== "verificado" && estadoActual !== "") continue;

    // Primero se recuerda qué pedido lo toma (reintentos y bloquear_pedido) y después se bloquea:
    // si algo falla a mitad, bloquear_pedido igual encuentra el pago y lo deja "Usado"
    if (idPedido) {
      props.setProperty("proc_" + referenciaCompleta, idPedido);
      props.setProperty("pedido_" + idPedido, referenciaCompleta);
    }
    hojaPagos.getRange(i + 1, 5).setValue("En proceso");
    SpreadsheetApp.flush();
    actualizarEstadoFirebase(referenciaCompleta, "En proceso");
    return respuestaEncontrado(i, false);
  }

  if (hayEnProceso) return { encontrado: false, message: "⚠️ Otro cliente está procesando esta referencia en este momento." };
  if (hayPorCompletar) return { encontrado: false, message: "⏳ Este pago no alcanzó y está esperando que completes la diferencia: usa el botón \"Completar pago\" de la tienda o escríbenos por WhatsApp." };
  if (hayUsado) return { encontrado: false, message: "❌ Este pago ya fue validado y gastado." };
  return { encontrado: false, message: "🔍 Referencia no encontrada en el sistema." };
}

// Pedido que no pudo continuar (Vercel no recibió la respuesta): el pago que tomó ESTE pedido pasa a
// "Usado" y la recarga se hace a mano desde la pestaña "errores".
function bloquearPedido(datos) {
  var idPedido = String(datos.idPedido || "");
  if (!idPedido) return responder({ status: "error", message: "Falta idPedido" });
  var props = PropertiesService.getScriptProperties();
  var referencia = props.getProperty("pedido_" + idPedido);
  if (!referencia) return responder({ status: "success", referencia: "" }); // nunca llegó a tomar un pago
  if (props.getProperty("proc_" + referencia) === idPedido) cambiarEstadoPago(referencia, "Usado", "en proceso");
  return responder({ status: "success", referencia: referencia });
}

// Pago insuficiente (Vercel, con candado): el pago que tomó ESTE pedido pasa a "Por completar" y el
// pedido queda en "por_completar" con la huella de la clave del cliente. Se puede repetir (mismo idPedido).
function guardarPorCompletar(datos) {
  var idPedido = String(datos.idPedido || "");
  var referencia = String(datos.referencia || "").replace(/\s+/g, "");
  var claveHash = String(datos.claveHash || "");
  if (!/^[A-Za-z0-9-]{8,64}$/.test(idPedido) || !/^[a-f0-9]{64}$/.test(claveHash) || !referencia || !/^\d{5,15}$/.test(String(datos.idJugador || ""))) {
    return responder({ status: "error", message: "Datos inválidos para guardar el pago por completar" });
  }
  if (buscarFilaPorCompletar(2, idPedido)) return responder({ status: "success", repetido: true, horas: HORAS_PARA_COMPLETAR });
  // Solo el pago que este mismo pedido acaba de bloquear
  if (PropertiesService.getScriptProperties().getProperty("proc_" + referencia) !== idPedido) {
    return responder({ status: "error", message: "Ese pago no lo tiene este pedido" });
  }
  if (!cambiarEstadoPago(referencia, ESTADO_PAGO_POR_COMPLETAR, "en proceso")) {
    return responder({ status: "error", message: "El pago ya no está en proceso" });
  }
  var precio = limpiarMontoVES(datos.precio);
  var pagado = limpiarMontoVES(datos.pagado);
  var falta = redondear2(Math.max(0, precio - pagado));
  var fechaHora = ahora();
  hojaPorCompletar().appendRow([
    fechaHora, idPedido, textoSeguro(datos.idJugador), textoSeguro(datos.paquete), precio, pagado, falta,
    referencia, textoSeguro(datos.codigoDescuento || ""), textoSeguro(datos.comprobante || "Sin comprobante"),
    "PENDIENTE: faltan " + formatoBs(falta) + " Bs", "", fechaHora, claveHash,
    new Date(Date.now() + HORAS_PARA_COMPLETAR * 3600 * 1000), enlaceWhatsapp(datos.telefono)
  ]);
  SpreadsheetApp.flush();
  return responder({ status: "success", horas: HORAS_PARA_COMPLETAR });
}

// Completar (Vercel, con candado): el cliente manda su clave (Vercel envía la huella) y los últimos 5
// del pago nuevo. Se puede repetir: la respuesta de cada idPedido se guarda 6 h.
function usarComplemento(datos) {
  var idPedido = String(datos.idPedido || "");
  var claveHash = String(datos.claveHash || "");
  var ultimos5 = String(datos.referencia || "").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9-]{8,64}$/.test(idPedido) || !/^[a-f0-9]{64}$/.test(claveHash) || !/^\d{5}$/.test(ultimos5)) {
    return responder({ status: "success", valido: false, message: "Datos inválidos para completar el pago." });
  }
  var cache = CacheService.getScriptCache();
  var previa = cache.get("comp_" + idPedido);
  // version: con 3 o más, Vercel sabe que puede repetir registrar_finalizado de este pedido
  if (previa) return responder(Object.assign(JSON.parse(previa), { version: VERSION_SCRIPT }));

  var respuesta = completarConPago(buscarFilaPorCompletar(14, claveHash), ultimos5, idPedido);
  if (respuesta.valido && respuesta.encontrado) cache.put("comp_" + idPedido, JSON.stringify(respuesta), 21600);
  SpreadsheetApp.flush();
  return responder(Object.assign(respuesta, { version: VERSION_SCRIPT }));
}

function completarConPago(fila, ultimos5, idPedido) {
  var noValido = function (mensaje) { return { status: "success", valido: false, message: mensaje }; };
  if (!fila) return noValido("No encontramos este pago por completar. Escríbenos por WhatsApp con tus referencias.");
  var hoja = hojaPorCompletar();
  var v = hoja.getRange(fila, 1, 1, COLUMNAS_POR_COMPLETAR.length).getValues()[0];
  if (String(v[10]).indexOf("PENDIENTE") !== 0) {
    return noValido("Este pago ya se completó o está en revisión. Si no recibiste tu recarga, escríbenos por WhatsApp.");
  }
  var vence = v[14] instanceof Date ? v[14].getTime() : new Date(v[14]).getTime();
  if (vence && Date.now() > vence) {
    hoja.getRange(fila, 11).setValue("⌛ VENCIDO: resolver por WhatsApp");
    hoja.getRange(fila, 13).setValue(ahora());
    return noValido("Pasaron más de " + HORAS_PARA_COMPLETAR + " horas: escríbenos por WhatsApp con tus referencias para completar tu recarga.");
  }
  var referencias = String(v[7]).split(" + ").filter(function (r) { return r; });
  if (referencias.length >= MAX_PAGOS_POR_PEDIDO) {
    return noValido("Ya usaste el máximo de " + MAX_PAGOS_POR_PEDIDO + " pagos para este pedido: escríbenos por WhatsApp.");
  }

  var pago = tomarPago(ultimos5, idPedido);
  if (!pago.encontrado) return { status: "success", valido: true, encontrado: false, message: pago.message };

  var precio = limpiarMontoVES(v[4]);
  var pagado = redondear2(limpiarMontoVES(v[5]) + pago.montoPagado);
  var falta = redondear2(Math.max(0, precio - pagado));
  referencias.push(pago.referencia);
  hoja.getRange(fila, 6, 1, 3).setValues([[pagado, falta, referencias.join(" + ")]]);
  hoja.getRange(fila, 13).setValue(ahora());

  if (pagado < precio - 0.50) {
    // Tampoco alcanza: este pago también queda "Por completar" y el pedido sigue pendiente
    cambiarEstadoPago(pago.referencia, ESTADO_PAGO_POR_COMPLETAR, "en proceso");
    hoja.getRange(fila, 11).setValue("PENDIENTE: faltan " + formatoBs(falta) + " Bs");
    return { status: "success", valido: true, encontrado: true, completo: false, precio: precio, pagadoTotal: pagado, falta: falta };
  }
  // Completo: el último pago queda "En proceso" para este pedido; Vercel marca TODOS "Usado" al cerrar
  hoja.getRange(fila, 11, 1, 2).setValues([["⏳ COMPLETO: entregando la recarga", idPedido]]);
  return {
    status: "success", valido: true, encontrado: true, completo: true,
    idPedidoOriginal: String(v[1]), idJugador: String(v[2]), paquete: String(v[3]), precio: precio, pagadoTotal: pagado,
    referencias: referencias, codigoDescuento: String(v[8] || ""), comprobante: String(v[9] || ""),
    telefono: String(v[15] || "")
  };
}

// registrar_finalizado / registrar_error del pedido que completó el pago: estado final de su fila
function cerrarComplemento(idPedido, estado) {
  var fila = buscarFilaPorCompletar(12, idPedido);
  if (!fila) return;
  var hoja = hojaPorCompletar();
  hoja.getRange(fila, 11).setValue(estado);
  hoja.getRange(fila, 13).setValue(ahora());
}

function hojaPorCompletar() {
  var hoja = obtenerHojaLocal(HOJA_POR_COMPLETAR);
  if (!hoja) {
    hoja = SpreadsheetApp.getActiveSpreadsheet().insertSheet(HOJA_POR_COMPLETAR, 0);
    hoja.appendRow(COLUMNAS_POR_COMPLETAR);
    hoja.getRange(1, 1, 1, COLUMNAS_POR_COMPLETAR.length).setFontWeight("bold");
    hoja.setFrozenRows(1);
  }
  asegurarTituloWhatsapp(hoja, COLUMNAS_POR_COMPLETAR.length);
  return hoja;
}

// Fila (la más reciente) de "por_completar" con ese valor exacto en esa columna
// (2 = id pedido, 12 = pedido que completó, 14 = huella de la clave)
function buscarFilaPorCompletar(columna, valor) {
  var hoja = obtenerHojaLocal(HOJA_POR_COMPLETAR);
  if (!valor || !hoja || hoja.getLastRow() < 2) return 0;
  var celdas = hoja.getRange(2, columna, hoja.getLastRow() - 1, 1)
    .createTextFinder(String(valor)).matchEntireCell(true).matchCase(true).findAll();
  return celdas.length ? celdas[celdas.length - 1].getRow() : 0;
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
  var fila = filaDePago(hoja, refBuscada);
  if (!fila) return false;
  if (soloSiEstado && String(hoja.getRange(fila, 5).getValue()).trim().toLowerCase() !== soloSiEstado) return false;
  hoja.getRange(fila, 5).setValue(nuevoEstado);
  SpreadsheetApp.flush();
  olvidarPedidoDePago(refBuscada);
  actualizarEstadoFirebase(refBuscada, nuevoEstado);
  return true;
}

// Fila (la más reciente) de "pagos" con esa referencia completa, o 0. Primero con TextFinder sobre la
// columna C (la hoja central la comparten todos los juegos y no para de crecer) y, si no la encuentra
// (p. ej. una referencia que la hoja muestra con otro formato), leyendo la columna entera como antes.
function filaDePago(hoja, refBuscada) {
  var ultima = hoja.getLastRow();
  if (ultima < 2) return 0;
  var columna = hoja.getRange(2, 3, ultima - 1, 1);
  var celdas = columna.createTextFinder(refBuscada).matchEntireCell(true).findAll();
  for (var i = celdas.length - 1; i >= 0; i--) {
    if (String(celdas[i].getValue()).replace(/\s+/g, "") === refBuscada) return celdas[i].getRow();
  }
  var valores = columna.getValues();
  for (var r = valores.length - 1; r >= 0; r--) {
    if (String(valores[r][0]).replace(/\s+/g, "") === refBuscada) return r + 2;
  }
  return 0;
}

function olvidarPedidoDePago(referencia) {
  var props = PropertiesService.getScriptProperties();
  var idPedido = props.getProperty("proc_" + referencia);
  if (idPedido) props.deleteProperty("pedido_" + idPedido);
  props.deleteProperty("proc_" + referencia);
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

// Sin candado: pestaña "PreciosBlood" (o "precios"): fila 1 = paquetes, fila 2 = precios,
// fila 3 = product_id de Central One (Vercel lo usa para comprar y no lo muestra al cliente)
function obtenerPrecios() {
  var hojaPrecios = hojaDePrecios();
  if (!hojaPrecios) return responder({ status: "error", message: "Falta pestaña de precios" });

  var rows = hojaPrecios.getDataRange().getValues();
  var paquetes = [];
  if (rows.length >= 2) {
    for (var i = 0; i < rows[0].length; i++) {
      var titulo = String(rows[0][i] || "").trim();
      // Sin precio no se vende: se cobraría 0
      if (!titulo || !(limpiarMontoVES(rows[1][i]) > 0)) continue;
      // Un precio calculado llega como número (1144.4): se manda como se escribe en Bs ("1.144,40")
      var paquete = { diamantes: titulo, precio: typeof rows[1][i] === "number" ? formatoBs(rows[1][i]) : rows[1][i] };
      var producto = rows.length >= FILA_PRODUCTO ? String(rows[FILA_PRODUCTO - 1][i] || "").trim() : "";
      if (producto) paquete.producto = producto;
      paquetes.push(paquete);
    }
  }
  return responder({ status: "success", catalogo: paquetes, version: VERSION_SCRIPT });
}

function hojaDePrecios() {
  var libroLocal = SpreadsheetApp.getActiveSpreadsheet();
  return libroLocal.getSheetByName("PreciosBlood") || libroLocal.getSheetByName("precios") || libroLocal.getSheetByName("Precios");
}

// Recarga exitosa: fila en "finalizados" y, si vino por la API, fila en "fazer_card"
function registrarFinalizado(datos) {
  // Vercel repite el cierre en segundo plano si no recibió la respuesta: el mismo pedido no se anota dos veces
  var idPedido = String(datos.idPedido || "");
  if (idPedido && CacheService.getScriptCache().get("fin_" + idPedido)) {
    return responder({ status: "success", repetido: true, message: "Este pedido ya estaba en finalizados" });
  }
  var hojaFinalizados = obtenerHojaLocal("finalizados");
  if (!hojaFinalizados) return responder({ status: "error", message: "Falta la pestaña finalizados" });
  var fechaHora = ahora();
  var orden = String(datos.ordenFazer || "");
  if (orden && !String(hojaFinalizados.getRange(1, 6).getValue() || "").trim()) {
    hojaFinalizados.getRange(1, 6).setValue(TITULO_ORDEN_FINALIZADOS);
  }
  asegurarTituloWhatsapp(hojaFinalizados, COLUMNA_WHATSAPP_FINALIZADOS);
  hojaFinalizados.appendRow([
    fechaHora,
    textoSeguro(datos.idJugador),
    textoSeguro(datos.paquete),
    textoSeguro(datos.referencia || datos.referencias),
    textoSeguro(datos.urlImagen || "Sin comprobante"),
    textoSeguro(orden),
    enlaceWhatsapp(datos.telefono)
  ]);
  if (orden) anotarOrdenFazer(datos, fechaHora);
  // Pedido que completó un pago insuficiente: su fila de "por_completar" queda cerrada
  cerrarComplemento(String(datos.idPedido || ""), "✅ COMPLETADO Y RECARGADO");
  SpreadsheetApp.flush();
  if (idPedido) CacheService.getScriptCache().put("fin_" + idPedido, "1", 21600);
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
  asegurarTituloWhatsapp(hojaErrores, COLUMNAS_ERRORES.length);

  hojaErrores.appendRow([
    ahora(),
    textoSeguro(datos.idJugador || "Desconocido"),
    textoSeguro(datos.paquete || "Desconocido"),
    textoSeguro(datos.urlImagen || datos.error || "Fallo en Proveedor FazerCards"),
    textoSeguro(datos.fase || ""),
    textoSeguro(datos.motivo || ""),
    textoSeguro(datos.estadoPago || ""),
    textoSeguro(datos.idPedido || ""),
    enlaceWhatsapp(datos.telefono)
  ]);
  cerrarComplemento(String(datos.idPedido || ""), "❌ ERROR: ver pestaña errores (pagos ya \"Usado\")");
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
    "orden aceptada por el proveedor",
    enlaceWhatsapp(datos.telefono)
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
  // Central One no garantiza el orden de los avisos: uno con "sequence" menor que el último ya anotado
  // para este pedido es viejo y no debe pisar al nuevo (FazerCards no manda secuencia: 0)
  var secuencia = Number(datos.secuencia) || 0;
  if (secuencia) {
    var cacheSecuencia = CacheService.getScriptCache();
    var ultima = Number(cacheSecuencia.get("seq_" + orden)) || 0;
    if (secuencia < ultima) return responder({ status: "success", encontrado: true, ignorado: "aviso anterior al último anotado" });
    cacheSecuencia.put("seq_" + orden, String(secuencia), ESPERA_AVISO_FAZER_S);
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
  var fallo = ESTADOS_FALLO_FAZER.test(estado);
  if (fallo && !TEXTO_FALLO_FAZER.test(anterior)) {
    var motivo = "El proveedor marcó la orden " + valores[8] + " como " + estado + ": la recarga NO llegó (completa) al jugador";
    registrarError({
      idJugador: valores[1], paquete: valores[2], idPedido: valores[7], telefono: valores[12],
      fase: "4. RECARGA EN LA API DEL PROVEEDOR - aviso posterior del webhook",
      motivo: motivo,
      estadoPago: "USADO: hacer la recarga a mano o devolver el pago",
      urlImagen: motivo + " | JUGADOR: " + valores[1] + " | PAQUETE: " + valores[2] + " | REFERENCIA: " + valores[4] + " | PEDIDO: " + valores[7]
    });
  }
  // Central One: un pedido "failed" puede entregarse después (y se cobra). Si ya estaba en "errores"
  // para hacerla a mano, se avisa para no recargar dos veces.
  if (estado === "completed" && /FALLIDA|CANCELADA/.test(anterior)) {
    var aviso = "ATENCIÓN: la orden " + valores[8] + " figuraba como fallida y el proveedor la ENTREGÓ después: NO hacer la recarga a mano (si ya se hizo, el jugador recibió dos)";
    registrarError({
      idJugador: valores[1], paquete: valores[2], idPedido: valores[7], telefono: valores[12],
      fase: "4. RECARGA EN LA API DEL PROVEEDOR - entrega posterior a un fallo",
      motivo: aviso,
      estadoPago: "USADO (correcto): la recarga sí llegó",
      urlImagen: aviso + " | JUGADOR: " + valores[1] + " | PAQUETE: " + valores[2] + " | REFERENCIA: " + valores[4] + " | PEDIDO: " + valores[7]
    });
  }
  hoja.getRange(fila, 10).setValue(texto);
  hoja.getRange(fila, 11).setValue(ahora());
  hoja.getRange(fila, 12).setValue(textoSeguro("aviso " + String(evento || "del proveedor") + (fallo ? " - anotado en errores" : "")));
}

function hojaFazer() {
  var hoja = obtenerHojaLocal(HOJA_FAZER);
  if (!hoja) {
    hoja = SpreadsheetApp.getActiveSpreadsheet().insertSheet(HOJA_FAZER, 0);
    hoja.appendRow(COLUMNAS_FAZER);
    hoja.getRange(1, 1, 1, COLUMNAS_FAZER.length).setFontWeight("bold");
    hoja.setFrozenRows(1);
  }
  asegurarTituloWhatsapp(hoja, COLUMNAS_FAZER.length);
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
// WhatsApp del cliente (opcional; Vercel manda "+58…" ya validado o ""). En la hoja queda como enlace
// https://wa.me/58… : un toque abre el chat con el cliente. Cualquier otra cosa queda vacía.
function enlaceWhatsapp(telefono) {
  var digitos = String(telefono || "").replace(/\D/g, "");
  return /^584\d{9}$/.test(digitos) ? "https://wa.me/" + digitos : "";
}

// Pestaña creada antes de la columna "WhatsApp" (siempre la última): se agrega su título
// (y la columna, si se habían borrado las columnas vacías)
function asegurarTituloWhatsapp(hoja, columna) {
  if (hoja.getMaxColumns() < columna) hoja.insertColumnsAfter(hoja.getMaxColumns(), columna - hoja.getMaxColumns());
  var celda = hoja.getRange(1, columna);
  if (!String(celda.getValue() || "").trim()) celda.setValue("WhatsApp").setFontWeight("bold");
}

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

// 1.234,50 (montos en Bs como se escriben en Venezuela)
function formatoBs(n) {
  var partes = Number(n).toFixed(2).split(".");
  return partes[0].replace(/\B(?=(\d{3})+(?!\d))/g, ".") + "," + partes[1];
}

function redondear2(n) {
  return Math.round(Number(n) * 100) / 100;
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


// =====================================================================
// 6. MENÚ: PRODUCTOS DE CENTRAL ONE EN LA PESTAÑA DE PRECIOS
//    🔑 guarda la llave (propiedad del script, nunca en la hoja) · 🔄 reemplaza la pestaña de precios
//    con el oro, los pases y las membresías de Blood Strike de tu catálogo (esProductoTiendaBlood); el precio en Bs se calcula solo con el dólar y
//    la ganancia de la pestaña "tasa_dolar" (cambias el dólar y todos los precios cambian).
// =====================================================================

function onOpen() {
  SpreadsheetApp.getUi().createMenu("🩸 Blood Strike")
    .addItem("🔄 Traer productos de Central One", "traerProductosCentralOne")
    .addItem("🔑 Guardar llave de Central One", "guardarLlaveCentralOne")
    .addToUi();
}

function guardarLlaveCentralOne() {
  var ui = SpreadsheetApp.getUi();
  var r = ui.prompt("Llave de Central One",
    "Pega la llave (empieza por co_live_). Basta con el permiso catalog:read. Se guarda en las propiedades del script, no en la hoja.",
    ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  var llave = r.getResponseText().trim();
  if (!/^co_live_[A-Za-z0-9_-]{8,200}$/.test(llave)) {
    ui.alert("Esa no parece una llave de Central One (empieza por co_live_). No se guardó nada.");
    return;
  }
  PropertiesService.getScriptProperties().setProperty(PROPIEDAD_LLAVE_CENTRALONE, llave);
  ui.alert("✅ Llave guardada. Ahora: menú 🩸 Blood Strike → 🔄 Traer productos de Central One.");
}

function traerProductosCentralOne() {
  var ui = SpreadsheetApp.getUi();
  var llave = PropertiesService.getScriptProperties().getProperty(PROPIEDAD_LLAVE_CENTRALONE);
  if (!llave) {
    ui.alert("Primero guarda la llave: menú 🩸 Blood Strike → 🔑 Guardar llave de Central One.");
    return;
  }
  var hoja = hojaDePrecios();
  if (!hoja) {
    ui.alert("No encuentro la pestaña de precios (PreciosBlood). No se cambió nada.");
    return;
  }

  var respuesta = UrlFetchApp.fetch(URL_CENTRALONE + "/catalog", {
    headers: { Authorization: "Bearer " + llave }, muteHttpExceptions: true
  });
  var codigo = respuesta.getResponseCode();
  if (codigo !== 200) {
    var porque = codigo === 401 ? " (llave inválida, revocada o cuenta inactiva)" : codigo === 403 ? " (la llave no tiene el permiso catalog:read)" : codigo === 429 ? " (demasiadas consultas: espera un minuto)" : "";
    ui.alert("Central One respondió HTTP " + codigo + porque + ". No se cambió nada.");
    return;
  }
  var deBlood = (JSON.parse(respuesta.getContentText()).items || []).filter(function (p) {
    return String(p.product_family_name + " " + p.name).toLowerCase().replace(/[^a-z0-9]/g, "").indexOf(JUEGO_CENTRALONE) !== -1;
  });
  if (!deBlood.length) {
    ui.alert("Tu catálogo de Central One no tiene productos de Blood Strike habilitados. No se cambió nada.");
    return;
  }
  var productos = deBlood.filter(function (p) { return String(p.region || "").trim().toUpperCase() === REGION_CENTRALONE; });
  if (!productos.length) {
    var regiones = deBlood.map(function (p) { return String(p.region || "sin región"); })
      .filter(function (r, i, lista) { return lista.indexOf(r) === i; });
    ui.alert("Hay " + deBlood.length + " producto(s) de Blood Strike, pero ninguno de la región " + REGION_CENTRALONE +
      " (regiones que hay: " + regiones.join(", ") + "). No se cambió nada.");
    return;
  }
  // Solo oro, pases y membresías: cofres, cupones, preventas y ofertas no se traen
  var deRegion = productos.length;
  productos = productos.filter(function (p) { return esProductoTiendaBlood(nombreCortoBlood(p.name)); });
  var descartados = deRegion - productos.length;
  if (!productos.length) {
    ui.alert("Hay " + deRegion + " producto(s) de Blood Strike " + REGION_CENTRALONE + ", pero ninguno es oro, pase o membresía. No se cambió nada.");
    return;
  }
  productos.sort(function (a, b) { return Number(a.reseller_price) - Number(b.reseller_price); });

  // Un solo producto por paquete de la tienda (misma clave con la que Vercel reconoce el paquete): si
  // Central One tiene varios (otra región, otro SKU), queda el que tiene stock y, entre ellos, el más
  // barato (la lista ya va de menor a mayor precio). Con dos columnas iguales la tienda no vendería ninguna.
  var elegido = {}, repetidos = [];
  productos.forEach(function (p) {
    var clave = clavePaqueteBlood(nombreCortoBlood(p.name));
    var actual = elegido[clave];
    if (!actual) { elegido[clave] = p; return; }
    var mejor = (actual.in_stock === false && p.in_stock !== false) ? p : actual;
    repetidos.push(mejor === p ? actual : p);
    elegido[clave] = mejor;
  });
  productos = productos.filter(function (p) { return elegido[clavePaqueteBlood(nombreCortoBlood(p.name))] === p; });

  var hojaTasa = hojaDeTasa();
  var dolar = limpiarMontoVES(hojaTasa.getRange("B1").getValue());
  var seguir = ui.alert("Traer productos de Central One",
    "Se reemplaza TODA la pestaña \"" + hoja.getName() + "\" con " + productos.length + " producto(s) de Blood Strike " + REGION_CENTRALONE +
    (repetidos.length ? " (se quitaron " + repetidos.length + " repetido(s))" : "") + ".\n\n" +
    (descartados ? "Se dejan fuera " + descartados + " producto(s) que no son oro, pases ni membresías (cofres, cupones, preventas, ofertas).\n\n" : "") +
    "El precio en Bs se calcula solo: costo en USD × dólar (pestaña \"" + HOJA_TASA + "\", B1) + la ganancia (B2). " +
    "Los productos sin stock quedan sin precio y no se venden.\n\n¿Seguir?",
    ui.ButtonSet.YES_NO);
  if (seguir !== ui.Button.YES) return;

  // Fila 2: fórmula en notación R1C1 (Apps Script las escribe en inglés, con comas, sea cual sea el idioma
  // de la hoja). R[2]C = la celda del costo, 2 filas más abajo en la misma columna. Sin dólar o sin costo, vacía.
  var tasa = "'" + HOJA_TASA + "'!R1C2", ganancia = "'" + HOJA_TASA + "'!R2C2", costo = "R[" + (FILA_COSTO - 2) + "]C";
  var formula = "=IF(OR(" + tasa + "=\"\"," + costo + "=\"\"),\"\",ROUND(" + costo + "*" + tasa + "*(1+" + ganancia + "/100),2))";
  var valores = [[], [], [], [], []];
  var formulas = [];
  productos.forEach(function (p) {
    valores[0].push(textoSeguro(nombreCortoBlood(p.name)));
    valores[1].push("");
    valores[2].push(textoSeguro(p.product_id));
    valores[3].push(Number(p.reseller_price) || "");
    valores[4].push((p.in_stock === false ? "SIN STOCK" : "con stock") + (p.region ? " · " + textoSeguro(p.region) : ""));
    formulas.push(p.in_stock === false ? "" : formula);
  });
  hoja.clearContents();
  hoja.getRange(1, 1, 5, productos.length).setValues(valores);
  hoja.getRange(2, 1, 1, productos.length).setFormulasR1C1([formulas]);
  hoja.getRange(1, 1, 1, productos.length).setFontWeight("bold");
  hoja.getRange(2, 1, 1, productos.length).setNumberFormat("#,##0.00");
  hoja.getRange(FILA_COSTO, 1, 1, productos.length).setNumberFormat("0.0000\" USD\"");
  hoja.getRange(FILA_PRODUCTO, 1, 3, productos.length).setFontColor("#888888");
  hoja.getRange(2, 1).setNote("Fila 2: precio en Bs = costo (fila 4) × dólar × (1 + ganancia %). El dólar y la ganancia " +
    "se cambian en la pestaña \"" + HOJA_TASA + "\". Si escribes un número encima, ese producto queda con precio fijo hasta el próximo 🔄.");
  hoja.getRange(FILA_PRODUCTO, 1).setNote("Fila 3: product_id de Central One, NO la toques (con él se compra). " +
    "Fila 4: costo en USD · fila 5: stock (del momento del 🔄). La fila 1 se puede renombrar: el oro como \"105 Oro\" y los pases sin números.");
  SpreadsheetApp.flush();
  ui.alert("✅ Listo: " + productos.length + " producto(s)." +
    (repetidos.length ? " Se quitaron " + repetidos.length + " repetido(s): " + repetidos.slice(0, 8).map(function (p) {
      return nombreCortoBlood(p.name) + " (" + p.reseller_price + " " + p.currency + (p.region ? ", " + p.region : "") + ")";
    }).join(", ") + (repetidos.length > 8 ? "…" : "") + "." : "") + (dolar > 0
    ? " Precios calculados con el dólar a " + formatoBs(dolar) + " Bs y " + hojaTasa.getRange("B2").getValue() + " % de ganancia."
    : " ⚠️ Falta el precio del dólar: escríbelo en la pestaña \"" + HOJA_TASA + "\", celda B1. Hasta entonces no se vende nada.") +
    " La tienda tarda hasta ~2 minutos en mostrar los cambios.");
}

// Pestaña "tasa_dolar" (se crea la primera vez): B1 = dólar en Bs (lo escribes tú) · B2 = ganancia en %
function hojaDeTasa() {
  var hoja = obtenerHojaLocal(HOJA_TASA);
  if (!hoja) {
    hoja = SpreadsheetApp.getActiveSpreadsheet().insertSheet(HOJA_TASA);
    hoja.getRange("A1:B3").setValues([
      ["Precio del dólar (Bs)", ""],
      ["Ganancia (%)", GANANCIA_INICIAL],
      ["Cambia B1 o B2 y todos los precios de PreciosBlood se recalculan solos.", ""]
    ]);
    hoja.getRange("A1:A2").setFontWeight("bold");
    hoja.getRange("B1").setNumberFormat("#,##0.00").setBackground("#fff2cc");
    hoja.getRange("B2").setBackground("#fff2cc");
    hoja.getRange("A3").setFontColor("#888888");
    hoja.setColumnWidth(1, 200);
  }
  return hoja;
}

// Nombres de Central One (en inglés) en español. Primero las frases completas y después palabras sueltas.
// Las palabras temporada, nivel, élite, premium y bolsa NO se cambian: Vercel reconoce cada pase por ellas
// (PALABRAS_PASES de api/_lib/juegos/bloodstrike.js).
const TRADUCCIONES_BLOOD = [
  [/strike\s*pass\s*elite|elite\s*strike\s*pass/ig, "Pase Strike Élite"],
  [/strike\s*pass\s*premium|premium\s*strike\s*pass/ig, "Pase Strike Premium"],
  [/lucky\s*bag\s*week(ly)?|weekly\s*lucky\s*bag/ig, "Bolsa de la Suerte Semanal"],
  [/lucky\s*bag/ig, "Bolsa de la Suerte"],
  [/season\s*pass/ig, "Pase de Temporada"],
  [/level\s*up\s*pass|level\s*pass/ig, "Pase de Nivel"],
  [/weekly\s*card/ig, "Tarjeta Semanal"],
  [/monthly\s*card/ig, "Tarjeta Mensual"],
  [/weekly\s*(bundle|pack)/ig, "Paquete Semanal"],
  [/monthly\s*(bundle|pack)/ig, "Paquete Mensual"],
  [/\bweekly\b/ig, "Semanal"],
  [/\bmonthly\b/ig, "Mensual"],
  [/\bweek\b/ig, "Semana"],
  [/\bmonth\b/ig, "Mes"],
  [/\bpass\b/ig, "Pase"],
  [/\belite\b/ig, "Élite"],
  [/\b(bundle|pack)\b/ig, "Paquete"],
  [/\bcard\b/ig, "Tarjeta"],
  [/\bmembership\b/ig, "Membresía"],
  [/\bgift\b/ig, "Regalo"],
  [/\bbag\b/ig, "Bolsa"],
  // Nombres de eventos y colaboraciones (sin números: con un número la tienda lo mostraría como oro)
  [/\b7DS\b|seven\s*deadly\s*sins/ig, "Siete Pecados Capitales"],
  [/attack\s*on\s*titan/ig, "Ataque a los Titanes"],
  [/golden\s*elegy/ig, "Elegía Dorada"],
  [/eternal\s*valor/ig, "Valor Eterno"],
  [/\bunplugged\b/ig, "Desconectado"],
  [/\btitan\b/ig, "Titán"],
  [/ultra\s*skin/ig, "Skin Ultra"],
];

// Formas completas de nombre (en inglés el orden es otro): [patrón, cómo se arma en español]. Las partes
// que captura el patrón se traducen con TRADUCCIONES_BLOOD. Ninguna usa temporada/nivel/élite/premium/
// bolsa/lucky: con esas palabras la tienda lo confundiría con un pase.
const FORMAS_BLOOD = [
  // "Attack on Titan Featured Titan II Stash Voucher" -> "Cupón de Botín Titán II (Ataque a los Titanes)"
  [/^(.*?)\s*featured\s+(.*?)\s*stash\s+voucher$/i, function (a, b) { return "Cupón de Botín " + (b ? b + (a ? " (" + a + ")" : "") : a); }],
  // "Tokyo Revengers Featured Valor Voucher II" -> "Cupón de Valor Tokyo Revengers II"
  [/^(.*?)\s*featured\s+valor\s+voucher\s*(.*)$/i, function (a, b) { return "Cupón de Valor " + a + (b ? " " + b : ""); }],
  // "Tokyo Revengers Upgrade Point Chest" -> "Cofre de Mejora Tokyo Revengers"
  [/^(.*?)\s*upgrade\s+point\s+chest$/i, function (a) { return "Cofre de Mejora " + a; }],
  // "Ultra Skin Lucky Chest" -> "Cofre de la Suerte Skin Ultra"
  [/^(.*?)\s*lucky\s+chest$/i, function (a) { return "Cofre de la Suerte " + a; }],
  // "Pre-order for Eternal Valor Unplugged" / "Golden Elegy Eternal Valor Pre-order" -> "Preventa …"
  [/^pre-?order\s+(?:for\s+)?(.*)$/i, function (a) { return "Preventa " + a; }],
  [/^(.*?)\s*pre-?order$/i, function (a) { return "Preventa " + a; }],
  // "Enable Cornucopia" -> "Activar Cornucopia"
  [/^enable\s+(.*)$/i, function (a) { return "Activar " + a; }],
];

function traducirPartesBlood(texto) {
  var t = String(texto || "");
  TRADUCCIONES_BLOOD.forEach(function (par) { t = t.replace(par[0], par[1]); });
  return t.replace(/\s+/g, " ").trim();
}

function traducirNombreBlood(texto) {
  for (var i = 0; i < FORMAS_BLOOD.length; i++) {
    var partes = String(texto).match(FORMAS_BLOOD[i][0]);
    if (partes) return FORMAS_BLOOD[i][1].apply(null, partes.slice(1).map(traducirPartesBlood)).replace(/\s+/g, " ").trim();
  }
  return traducirPartesBlood(texto);
}

// "Blood Strike 105 Gold" -> "105 Oro" (como espera la tienda); "Blood Strike Season Pass" -> "Pase de Temporada"
function nombreCortoBlood(nombre) {
  var original = String(nombre || "").trim();
  var t = original.replace(/blood\s*strike/ig, "").replace(/^[\s\-–|:·]+|[\s\-–|:·]+$/g, "").trim();
  var numero = t.match(/\d[\d.,]*/);
  if (numero && /gold|oro|\bbc\b|coin|moneda/i.test(t)) return numero[0] + " Oro";
  return traducirNombreBlood(t) || original;
}

// Lo único que se trae con el 🔄 (nombre ya en español, de nombreCortoBlood): oro ("105 Oro"), pases
// ("Pase de Temporada", "Pase Strike Élite"…, y la "Bolsa de la Suerte Semanal") y membresías ("Tarjeta Semanal")
function esProductoTiendaBlood(nombreCorto) {
  var n = String(nombreCorto || "").trim();
  return /^\d[\d.,]*\s+Oro$/i.test(n) || /^(Pase|Bolsa de la Suerte)\b/i.test(n) || /^(Tarjeta|Membresía)\b/i.test(n);
}

// Clave con la que la tienda reconoce un paquete. DEBE ser igual a clavePaquete de
// api/_lib/juegos/bloodstrike.js: el oro por su número ("105 Oro" -> "105") y los pases por una palabra.
function clavePaqueteBlood(texto) {
  var t = String(texto || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  var nombre = t.replace(/oro|gold|monedas|diamantes|blood strike|\bbc\b/g, " ").replace(/[^a-z]+/g, " ").trim();
  if (!nombre) return t.replace(/[^0-9]/g, "");
  var pases = [[/elite/, "strike_pass_elite"], [/premium/, "strike_pass_premium"], [/bolsa|lucky/, "lucky_bag_week"],
    [/temporada|season/, "season_pass"], [/nivel|level/, "level_up_pass"]];
  for (var i = 0; i < pases.length; i++) if (pases[i][0].test(nombre)) return pases[i][1];
  return nombre.replace(/ /g, "_");
}
