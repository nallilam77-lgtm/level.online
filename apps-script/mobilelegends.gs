// =====================================================================
// LEVEL UP - Apps Script de MOBILE LEGENDS (variable SCRIPT_MLBB en Vercel)
// Usado por: api/_lib/juegos/mobilelegends.js (precios y recarga por la API de Central One) y
// api/centralone-webhook.js (estado de cada pedido en tiempo real: idempotency_key "ml-…").
//
// Va en una hoja de cálculo NUEVA, solo para Mobile Legends. Pestañas (el menú 💎 → 🧱 las crea todas):
//   PreciosML      fila 1 paquete · 2 precio Bs (fórmula con el dólar) · 3 product_id · 4 costo USD · 5 stock
//   tasa_dolar     B1 = dólar en Bs · B2 = ganancia en %
//   pedidos        cada recarga aceptada por Central One y su estado (⏳ → ✅ / ❌ / ↩️), con ID y Zona
//   errores        lo que hay que resolver a mano (el pago ya está "Usado")
//   por_completar  pagos que no alcanzaron y esperan la diferencia (48 h)
//   resumen        ventas de hoy y del mes, estados y pendientes (fórmulas: se actualiza solo)
// Los PAGOS se leen de la hoja central (ID_HOJA_PAGOS, la de Free Fire) y cada recarga exitosa se anota
// también en la pestaña "finalizados" de Free Fire (ID_HOJA_FINALIZADOS), para tener todo en un lugar.
//
// Secciones:  1 Configuración · 2 Entrada (doGet / doPost) · 3 Pagos · 4 Recargas y pedidos de Central One
//             5 Utilidades · 6 Menú: productos de Central One, dólar y pestañas
//
// Cómo publicarlo la PRIMERA vez: Implementar > Nueva implementación > Aplicación web > Ejecutar como: yo,
// Acceso: cualquier usuario. La URL /exec va en SCRIPT_MLBB (Vercel).
// Cómo actualizarlo después: Implementar > Gestionar implementaciones > editar (lápiz) > Versión: "Nueva
// versión" > Implementar. Así la URL /exec NO cambia y no hay que tocar Vercel.
//
// Seguridad: propiedad del script TOKEN_VERCEL = el mismo valor que SCRIPT_RECARGAS_TOKEN en Vercel (si
// existe la variable en Vercel, crear la propiedad; mientras no exista, no se comprueba).
//
// Reglas que no se deben romper (las mismas de Blood Strike):
//   - Un pago encontrado NUNCA vuelve a "Verificado": ante cualquier error queda "Usado" y el pedido se
//     anota en "errores".
//   - Pago insuficiente: el pago queda "Por completar" (nadie más puede usarlo, tampoco desde otro juego) y
//     el pedido en "por_completar". El cliente paga la diferencia con su clave (Vercel solo manda la huella);
//     el jugador, la zona, el paquete y el precio salen de esa fila.
//   - registrar_finalizado ignora un idPedido ya anotado (Vercel lo repite si no recibió la respuesta).
// =====================================================================


// =====================================================================
// 1. CONFIGURACIÓN
// =====================================================================

const PROJECT_ID = "levelupstore-87d4d";
const COLLECTION_NAME = "Pagos";
const ID_HOJA_PAGOS = "1FTjXo7sKybYVmyGO9HBlyla0T2LHBfCB8yHEV70JyOA"; // Hoja central de pagos (la de Free Fire)
// Hoja donde está la pestaña "finalizados" de Free Fire (hoy es la misma hoja central)
const ID_HOJA_FINALIZADOS = ID_HOJA_PAGOS;
const HOJA_FINALIZADOS = "finalizados";
// Columnas de "finalizados" de Free Fire (solo se usan si hubiera que crear la pestaña)
const COLUMNAS_FINALIZADOS = ["fecha-hora", "id jugador", "paquete", "referencia", "códigos / orden", "comprobante"];

// Versión que la tienda lee en obtener_precios (y usar_complemento). Vercel exige 3 o más: verificar_pago
// idempotente (idPedido) y registrar_finalizado que ignora un idPedido ya anotado.
const VERSION_SCRIPT = 3;

// Vercel espera hasta 15 s por intento: si el candado tarda más que esto, es mejor responder
// "ocupado" (Vercel reintenta) que trabajar para una petición que ya nadie espera.
const ESPERA_CANDADO_MS = 8000;
// Webhook de Central One: espera 10 s como mucho (si no, lo reintenta más tarde)
const ESPERA_CANDADO_WEBHOOK_MS = 4000;
const MENSAJE_ERROR_INTERNO = "Error interno en el sistema de recargas. Intenta de nuevo en unos segundos.";

// --- Pagos por completar (el cliente pagó menos y paga la diferencia con otro pago) ---
// Una fila por pedido. O = huella SHA-256 de la clave del cliente (la clave nunca llega a la hoja).
const HOJA_POR_COMPLETAR = "por_completar";
const COLUMNAS_POR_COMPLETAR = ["fecha-hora", "id pedido", "id jugador", "zona", "paquete", "precio (Bs)", "pagado (Bs)",
  "falta (Bs)", "referencias", "código descuento", "comprobante", "estado", "pedido que completó", "actualizado",
  "clave (huella)", "vence"];
// Columnas (1 = A) de "por_completar" que se buscan
const PC_ID_PEDIDO = 2, PC_ESTADO = 12, PC_PEDIDO_QUE_COMPLETO = 13, PC_ACTUALIZADO = 14, PC_HUELLA = 15;
// Estado de "pagos" de un pago que no alcanzó: no es "Verificado", así que ningún otro pedido lo toma
const ESTADO_PAGO_POR_COMPLETAR = "Por completar";
const HORAS_PARA_COMPLETAR = 48;
const MAX_PAGOS_POR_PEDIDO = 4;

// --- Errores ---
const HOJA_ERRORES = "errores";
const COLUMNAS_ERRORES = ["fecha-hora", "id jugador (zona)", "paquete", "informe completo", "fase del fallo",
  "motivo técnico", "estado del pago", "id pedido", "referencia"];

// --- Pedidos de Central One ---
// Una fila por recarga aceptada por la API. La columna L ("estado") la actualiza el webhook.
const HOJA_PEDIDOS = "pedidos";
const COLUMNAS_PEDIDOS = ["fecha-hora", "id jugador", "zona", "paquete", "producto Central One", "referencia",
  "cobrado (Bs)", "código descuento", "comprobante", "id pedido", "orden Central One", "estado", "actualizado", "detalle"];
const PED_ORDEN = 11, PED_ESTADO = 12;
const ORDEN_VALIDA = /^[A-Za-z0-9_.:-]{1,80}$/;
const TEXTO_ESTADO = { confirmed: "⏳ EN PROCESO", processing: "⏳ EN PROCESO", completed: "✅ COMPLETADA", delivered: "✅ COMPLETADA",
  failed: "❌ FALLIDA", partially_completed: "⚠️ ENTREGA PARCIAL", partially_delivered: "⚠️ ENTREGA PARCIAL",
  cancelled: "❌ CANCELADA", refunded: "↩️ REEMBOLSADA" };
// Estados en los que la recarga NO llegó (completa) al jugador (se anotan en "errores")
const ESTADOS_FALLO = /^(failed|cancelled|partially_|refund)/;
const TEXTO_FALLO = /FALLIDA|CANCELADA|PARCIAL|REEMBOLSADA/;
// Aviso del webhook que llegó antes de que el pedido se anotara: se guarda este tiempo (máximo de CacheService)
const ESPERA_AVISO_S = 21600;

// --- Pestaña de precios ("PreciosML") ---
// Fila 1 = paquete (lo que ve el cliente; se puede renombrar) · fila 2 = precio en Bs (fórmula:
// costo × dólar × (1 + ganancia %), con los datos de la pestaña "tasa_dolar")
// Fila 3 = product_id de Central One (lo llena el menú; NO tocar) · fila 4 = costo en USD · fila 5 = stock
// Una columna sin precio no se vende (no aparece en la tienda).
const HOJA_PRECIOS = "PreciosML";
const FILA_PRODUCTO = 3;
const FILA_COSTO = 4;
// Pestaña "tasa_dolar": B1 = precio del dólar en Bs · B2 = ganancia en % sobre el costo
const HOJA_TASA = "tasa_dolar";
const GANANCIA_INICIAL = 4;
const HOJA_RESUMEN = "resumen";

// --- Central One (menú 💎 Mobile Legends) ---
const URL_CENTRALONE = "https://portal.centraloneglobal.com/api/v1";
// Propiedad del script con la llave (menú 🔑). Basta con el permiso catalog:read.
const PROPIEDAD_LLAVE_CENTRALONE = "CENTRALONE_API_KEY";
const JUEGO_CENTRALONE = "mobilelegends";
// Regiones cuyos productos se traen (los de otras regiones se ignoran). Si el 🔄 dice que no hay de
// estas, te muestra las que sí hay: agrega la que corresponda a tus clientes (en mayúsculas).
const REGIONES_CENTRALONE = ["GLOBAL"];
// El 🔄 solo trae diamantes normales (nada de pases, membresías, doble diamante, eventos ni Mobile Legends:
// Adventure, que es otro juego) y solo los MAX_PRODUCTOS más baratos con stock.
const MAX_PRODUCTOS = 10;
const PRODUCTO_ESPECIAL = /adventure|pass|pase|member|starlight|twilight|weekly|semanal|double|doble|2x|x2|first|primera|special|especial|promo|event|evento|limited|limitad|bundle|pack|skin|gift|regalo/i;


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
    // Lectura: no toca pagos, así que NO espera el candado
    if (accion === "obtener_precios") return obtenerPrecios();
    // Webhook de Central One (api/centralone-webhook.js): espera menos el candado porque Central One corta a los 10 s
    if (accion === "estado_fazer") return conCandado(function () { return estadoPedidoApi(datos); }, ESPERA_CANDADO_WEBHOOK_MS);
    if (conCandadoAcciones.hasOwnProperty(accion)) {
      return conCandado(function () { return conCandadoAcciones[accion](datos); });
    }
    return responder({ status: "error", message: "Acción no válida" });
  } catch (error) {
    console.error("Error en acción " + accion + ": " + (error && error.stack || error));
    return responder({ status: "error", message: MENSAJE_ERROR_INTERNO });
  }
}

// 🛡️ Candado: una sola operación sobre pagos a la vez. "detalle" (mensaje de la excepción) lo copia Vercel
// al aviso de "errores"; nunca llega al cliente.
function conCandado(operacion, esperaMs) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(esperaMs || ESPERA_CANDADO_MS)) {
    return responder({ status: "error", ocupado: true, message: "⚠️ Sistema ocupado procesando otra transacción. Por favor, intenta de nuevo en unos segundos." });
  }
  try {
    return operacion();
  } catch (error) {
    console.error("Error dentro del candado: " + (error && error.stack || error));
    return responder({ status: "error", message: MENSAJE_ERROR_INTERNO, detalle: String(error && error.message || error).slice(0, 200) });
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
  if (!/^[A-Za-z0-9-]{8,64}$/.test(idPedido) || !/^[a-f0-9]{64}$/.test(claveHash) || !referencia ||
      !/^\d{5,15}$/.test(String(datos.idJugador || "")) || !/^\d{1,6}$/.test(String(datos.zona || ""))) {
    return responder({ status: "error", message: "Datos inválidos para guardar el pago por completar" });
  }
  if (buscarFilaPorCompletar(PC_ID_PEDIDO, idPedido)) return responder({ status: "success", repetido: true, horas: HORAS_PARA_COMPLETAR });
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
    fechaHora, idPedido, textoSeguro(datos.idJugador), textoSeguro(datos.zona), textoSeguro(datos.paquete), precio, pagado, falta,
    referencia, textoSeguro(datos.codigoDescuento || ""), textoSeguro(datos.comprobante || "Sin comprobante"),
    "PENDIENTE: faltan " + formatoBs(falta) + " Bs", "", fechaHora, claveHash,
    new Date(Date.now() + HORAS_PARA_COMPLETAR * 3600 * 1000)
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
  if (previa) return responder(Object.assign(JSON.parse(previa), { version: VERSION_SCRIPT }));

  var respuesta = completarConPago(buscarFilaPorCompletar(PC_HUELLA, claveHash), ultimos5, idPedido);
  if (respuesta.valido && respuesta.encontrado) cache.put("comp_" + idPedido, JSON.stringify(respuesta), 21600);
  SpreadsheetApp.flush();
  return responder(Object.assign(respuesta, { version: VERSION_SCRIPT }));
}

function completarConPago(fila, ultimos5, idPedido) {
  var noValido = function (mensaje) { return { status: "success", valido: false, message: mensaje }; };
  if (!fila) return noValido("No encontramos este pago por completar. Escríbenos por WhatsApp con tus referencias.");
  var hoja = hojaPorCompletar();
  var v = hoja.getRange(fila, 1, 1, COLUMNAS_POR_COMPLETAR.length).getValues()[0];
  // v: 0 fecha · 1 id pedido · 2 jugador · 3 zona · 4 paquete · 5 precio · 6 pagado · 7 falta · 8 referencias
  //    9 código · 10 comprobante · 11 estado · 12 pedido que completó · 13 actualizado · 14 huella · 15 vence
  if (String(v[11]).indexOf("PENDIENTE") !== 0) {
    return noValido("Este pago ya se completó o está en revisión. Si no recibiste tu recarga, escríbenos por WhatsApp.");
  }
  var vence = v[15] instanceof Date ? v[15].getTime() : new Date(v[15]).getTime();
  if (vence && Date.now() > vence) {
    hoja.getRange(fila, PC_ESTADO).setValue("⌛ VENCIDO: resolver por WhatsApp");
    hoja.getRange(fila, PC_ACTUALIZADO).setValue(ahora());
    return noValido("Pasaron más de " + HORAS_PARA_COMPLETAR + " horas: escríbenos por WhatsApp con tus referencias para completar tu recarga.");
  }
  var referencias = String(v[8]).split(" + ").filter(function (r) { return r; });
  if (referencias.length >= MAX_PAGOS_POR_PEDIDO) {
    return noValido("Ya usaste el máximo de " + MAX_PAGOS_POR_PEDIDO + " pagos para este pedido: escríbenos por WhatsApp.");
  }

  var pago = tomarPago(ultimos5, idPedido);
  if (!pago.encontrado) return { status: "success", valido: true, encontrado: false, message: pago.message };

  var precio = limpiarMontoVES(v[5]);
  var pagado = redondear2(limpiarMontoVES(v[6]) + pago.montoPagado);
  var falta = redondear2(Math.max(0, precio - pagado));
  referencias.push(pago.referencia);
  hoja.getRange(fila, 7, 1, 3).setValues([[pagado, falta, referencias.join(" + ")]]);
  hoja.getRange(fila, PC_ACTUALIZADO).setValue(ahora());

  if (pagado < precio - 0.50) {
    // Tampoco alcanza: este pago también queda "Por completar" y el pedido sigue pendiente
    cambiarEstadoPago(pago.referencia, ESTADO_PAGO_POR_COMPLETAR, "en proceso");
    hoja.getRange(fila, PC_ESTADO).setValue("PENDIENTE: faltan " + formatoBs(falta) + " Bs");
    return { status: "success", valido: true, encontrado: true, completo: false, precio: precio, pagadoTotal: pagado, falta: falta };
  }
  // Completo: el último pago queda "En proceso" para este pedido; Vercel marca TODOS "Usado" al cerrar
  hoja.getRange(fila, PC_ESTADO, 1, 2).setValues([["⏳ COMPLETO: entregando la recarga", idPedido]]);
  return {
    status: "success", valido: true, encontrado: true, completo: true,
    idPedidoOriginal: String(v[1]), idJugador: String(v[2]), zona: String(v[3]), paquete: String(v[4]), precio: precio,
    pagadoTotal: pagado, referencias: referencias, codigoDescuento: String(v[9] || ""), comprobante: String(v[10] || "")
  };
}

// registrar_finalizado / registrar_error del pedido que completó el pago: estado final de su fila
function cerrarComplemento(idPedido, estado) {
  var fila = buscarFilaPorCompletar(PC_PEDIDO_QUE_COMPLETO, idPedido);
  if (!fila) return;
  var hoja = hojaPorCompletar();
  hoja.getRange(fila, PC_ESTADO).setValue(estado);
  hoja.getRange(fila, PC_ACTUALIZADO).setValue(ahora());
}

function hojaPorCompletar() {
  return hojaConTitulos(HOJA_POR_COMPLETAR, COLUMNAS_POR_COMPLETAR);
}

// Fila (la más reciente) de "por_completar" con ese valor exacto en esa columna
function buscarFilaPorCompletar(columna, valor) {
  return buscarFila(HOJA_POR_COMPLETAR, columna, valor);
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
// (p. ej. una referencia que la hoja muestra con otro formato), leyendo la columna entera.
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
// 4. RECARGAS Y PEDIDOS DE CENTRAL ONE
//    obtener_precios -> verificar_pago -> pedido en Central One (Vercel) -> marcar_usado
//    -> registrar_finalizado (éxito, con el pedido) o registrar_error (fallo)
// =====================================================================

// Sin candado: pestaña "PreciosML": fila 1 = paquetes, fila 2 = precios, fila 3 = product_id de Central
// One (Vercel lo usa para comprar y no lo muestra al cliente)
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
  return obtenerHojaLocal(HOJA_PRECIOS);
}

// Recarga exitosa: fila en "pedidos" (esta hoja) y en "finalizados" (hoja de Free Fire).
// Se puede repetir (Vercel lo hace si no recibió la respuesta): "pedidos" no repite un pedido de Central
// One ya anotado y "finalizados" no repite un idPedido ya anotado (marca fin_ de 6 h).
function registrarFinalizado(datos) {
  var idPedido = String(datos.idPedido || "");
  var cache = CacheService.getScriptCache();
  if (idPedido && cache.get("fin_" + idPedido)) {
    return responder({ status: "success", repetido: true, message: "Este pedido ya estaba en finalizados" });
  }
  var fechaHora = ahora();
  var orden = String(datos.ordenFazer || "");
  // 1) Registro propio primero: si la hoja de Free Fire falla, el pedido igual queda aquí
  if (orden) anotarPedidoApi(datos, fechaHora);

  // 2) "finalizados" de Free Fire: B = ID (las consultas por ID lo encuentran), C = paquete y zona
  hojaFinalizadosFreeFire().appendRow([
    fechaHora,
    textoSeguro(datos.idJugador),
    textoSeguro(String(datos.paquete || "") + " · Zona " + String(datos.zona || "?")),
    textoSeguro(datos.referencia || datos.referencias),
    textoSeguro(orden ? "API Directa (Central One, pedido " + orden + ")" : "API Directa (Central One)"),
    textoSeguro(datos.urlImagen || "Sin comprobante")
  ]);
  SpreadsheetApp.flush();
  // La fila ya está: desde aquí un reintento de Vercel NO la vuelve a anotar
  if (idPedido) cache.put("fin_" + idPedido, "1", 21600);

  // 3) Pedido que completó un pago insuficiente: su fila de "por_completar" queda cerrada (si falla, no
  //    tumba el cierre: se anota en "errores")
  try {
    cerrarComplemento(idPedido, "✅ COMPLETADO Y RECARGADO");
  } catch (err) {
    console.error("registrar_finalizado (" + idPedido + "): falló por_completar: " + (err && err.stack || err));
    registrarError({
      idJugador: datos.idJugador + " (" + datos.zona + ")", paquete: datos.paquete, idPedido: idPedido, referencia: datos.referencia,
      fase: "5. CIERRE (registrar_finalizado): la recarga SÍ está en finalizados",
      motivo: "No se pudo cerrar su fila de por_completar: " + String(err && err.message || err).slice(0, 120),
      estadoPago: "sin cambios", urlImagen: "Cerrar a mano la fila de por_completar del pedido " + idPedido
    });
  }
  SpreadsheetApp.flush();
  return responder({ status: "success", message: "Guardado correctamente" });
}

// Fallo (proveedor, pago insuficiente...): fila en "errores". NO cambia el estado del pago.
function registrarError(datos) {
  hojaConTitulos(HOJA_ERRORES, COLUMNAS_ERRORES).appendRow([
    ahora(),
    textoSeguro(datos.idJugador || "Desconocido"),
    textoSeguro(datos.paquete || "Desconocido"),
    textoSeguro(datos.urlImagen || datos.error || "Fallo en el proveedor Central One"),
    textoSeguro(datos.fase || ""),
    textoSeguro(datos.motivo || ""),
    textoSeguro(datos.estadoPago || ""),
    textoSeguro(datos.idPedido || ""),
    textoSeguro(datos.referencia || "")
  ]);
  cerrarComplemento(String(datos.idPedido || ""), "❌ ERROR: ver pestaña errores (pagos ya \"Usado\")");
  SpreadsheetApp.flush();
  return responder({ status: "success", message: "Error guardado correctamente" });
}

// --- Pestaña "pedidos" ---

// Nueva fila con el pedido que aceptó Central One. Si el webhook avisó antes, se aplica ese estado.
function anotarPedidoApi(datos, fechaHora) {
  var orden = String(datos.ordenFazer);
  if (buscarFila(HOJA_PEDIDOS, PED_ORDEN, orden)) return; // reintento de registrar_finalizado: ya está
  var hoja = hojaPedidos();
  hoja.appendRow([
    new Date(), // fecha real (no texto): la usan las fórmulas de "resumen"
    textoSeguro(datos.idJugador),
    textoSeguro(datos.zona),
    textoSeguro(datos.paquete),
    textoSeguro(datos.ofertaFazer || ""),
    textoSeguro(datos.referencia || datos.referencias),
    limpiarMontoVES(datos.montoCobrado),
    textoSeguro(datos.codigoDescuento || ""),
    textoSeguro(datos.urlImagen || "Sin comprobante"),
    textoSeguro(datos.idPedido || ""),
    textoSeguro(orden),
    textoEstado(datos.estadoFazer || "confirmed"),
    fechaHora,
    "pedido aceptado por Central One"
  ]);
  var cache = CacheService.getScriptCache();
  var guardado = cache.get("aviso_" + orden);
  if (guardado) {
    var aviso = JSON.parse(guardado);
    aplicarEstadoPedido(hoja.getLastRow(), aviso.estado, aviso.evento);
    cache.remove("aviso_" + orden);
  }
}

// Webhook de Central One (acción estado_fazer, con candado): nuevo estado de un pedido.
// Se puede repetir: el mismo estado dos veces no cambia nada.
function estadoPedidoApi(datos) {
  var orden = String(datos.ordenFazer || "");
  var estado = String(datos.estado || "").toLowerCase();
  if (!ORDEN_VALIDA.test(orden) || !/^[a-z_]{1,30}$/.test(estado)) {
    return responder({ status: "error", message: "Datos de Central One inválidos" });
  }
  // Central One no garantiza el orden de los avisos: uno con "sequence" menor que el último ya anotado
  // para este pedido es viejo y no debe pisar al nuevo
  var secuencia = Number(datos.secuencia) || 0;
  var cache = CacheService.getScriptCache();
  if (secuencia) {
    var ultima = Number(cache.get("seq_" + orden)) || 0;
    if (secuencia < ultima) return responder({ status: "success", encontrado: true, ignorado: "aviso anterior al último anotado" });
    cache.put("seq_" + orden, String(secuencia), ESPERA_AVISO_S);
  }
  var fila = buscarFila(HOJA_PEDIDOS, PED_ORDEN, orden);
  if (!fila) {
    // El pedido aún no se anotó (el aviso llegó antes que registrar_finalizado): se guarda unas horas
    cache.put("aviso_" + orden, JSON.stringify({ estado: estado, evento: String(datos.evento || "") }), ESPERA_AVISO_S);
    return responder({ status: "success", encontrado: false });
  }
  aplicarEstadoPedido(fila, estado, datos.evento);
  SpreadsheetApp.flush();
  return responder({ status: "success", encontrado: true });
}

// Si el pedido falló o se reembolsó, la recarga NO llegó al jugador: se anota UNA vez en "errores"
// para hacerla a mano (el pago ya está "Usado").
function aplicarEstadoPedido(fila, estado, evento) {
  var hoja = hojaPedidos();
  var v = hoja.getRange(fila, 1, 1, COLUMNAS_PEDIDOS.length).getValues()[0];
  // v: 1 jugador · 2 zona · 3 paquete · 5 referencia · 9 id pedido · 10 orden · 11 estado
  var anterior = String(v[11]);
  var texto = textoEstado(estado);
  if (anterior === texto) return;
  var cuenta = v[1] + " (" + v[2] + ")";
  var datosPedido = " | JUGADOR: " + cuenta + " | PAQUETE: " + v[3] + " | REFERENCIA: " + v[5] + " | PEDIDO: " + v[9];
  var fallo = ESTADOS_FALLO.test(estado);
  if (fallo && !TEXTO_FALLO.test(anterior)) {
    var motivo = "Central One marcó el pedido " + v[10] + " como " + estado + ": la recarga NO llegó (completa) al jugador";
    registrarError({
      idJugador: cuenta, paquete: v[3], idPedido: v[9], referencia: v[5],
      fase: "4. RECARGA EN LA API DEL PROVEEDOR - aviso posterior del webhook",
      motivo: motivo,
      estadoPago: "USADO: hacer la recarga a mano o devolver el pago",
      urlImagen: motivo + datosPedido
    });
  }
  // Central One: un pedido "failed" puede entregarse después (y se cobra). Si ya estaba en "errores"
  // para hacerla a mano, se avisa para no recargar dos veces.
  if ((estado === "completed" || estado === "delivered") && /FALLIDA|CANCELADA/.test(anterior)) {
    var aviso = "ATENCIÓN: el pedido " + v[10] + " figuraba como fallido y Central One lo ENTREGÓ después: NO hacer la recarga a mano (si ya se hizo, el jugador recibió dos)";
    registrarError({
      idJugador: cuenta, paquete: v[3], idPedido: v[9], referencia: v[5],
      fase: "4. RECARGA EN LA API DEL PROVEEDOR - entrega posterior a un fallo",
      motivo: aviso,
      estadoPago: "USADO (correcto): la recarga sí llegó",
      urlImagen: aviso + datosPedido
    });
  }
  hoja.getRange(fila, PED_ESTADO, 1, 3).setValues([[texto, ahora(),
    textoSeguro("aviso " + String(evento || "del proveedor") + (fallo ? " - anotado en errores" : ""))]]);
}

function hojaPedidos() {
  var hoja = hojaConTitulos(HOJA_PEDIDOS, COLUMNAS_PEDIDOS);
  if (hoja.getRange("A2").getNumberFormat() !== "dd/MM/yyyy HH:mm:ss") {
    hoja.getRange("A2:A").setNumberFormat("dd/MM/yyyy HH:mm:ss");
    hoja.getRange("G2:G").setNumberFormat("#,##0.00");
  }
  return hoja;
}

function textoEstado(estado) {
  var e = String(estado || "").toLowerCase();
  return (TEXTO_ESTADO[e] || "❔ " + e.toUpperCase()) + " (" + e + ")";
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

// Pestaña de esta hoja; si no existe se crea con sus títulos en negrita y la fila 1 fija
function hojaConTitulos(nombre, columnas) {
  var hoja = obtenerHojaLocal(nombre);
  if (!hoja) {
    hoja = SpreadsheetApp.getActiveSpreadsheet().insertSheet(nombre);
    hoja.appendRow(columnas);
    hoja.getRange(1, 1, 1, columnas.length).setFontWeight("bold");
    hoja.setFrozenRows(1);
  }
  return hoja;
}

// Fila (la más reciente) de esa pestaña con ese valor exacto en esa columna, o 0. TextFinder sobre una
// columna: dentro del candado nunca se lee una pestaña entera que crece.
function buscarFila(nombreHoja, columna, valor) {
  var hoja = obtenerHojaLocal(nombreHoja);
  if (!valor || !hoja || hoja.getLastRow() < 2) return 0;
  var celdas = hoja.getRange(2, columna, hoja.getLastRow() - 1, 1)
    .createTextFinder(String(valor)).matchEntireCell(true).matchCase(true).findAll();
  return celdas.length ? celdas[celdas.length - 1].getRow() : 0;
}

function hojaCentralPagos() {
  var libroPagos = SpreadsheetApp.openById(ID_HOJA_PAGOS);
  var hoja = libroPagos.getSheetByName("pagos") || libroPagos.getSheetByName("Pagos");
  if (!hoja) throw new Error("Falta la pestaña 'pagos' en la hoja central");
  return hoja;
}

// Pestaña "finalizados" de Free Fire (se crea si falta, con las columnas de recargas.gs)
function hojaFinalizadosFreeFire() {
  var libro = SpreadsheetApp.openById(ID_HOJA_FINALIZADOS);
  var hoja = libro.getSheetByName(HOJA_FINALIZADOS) || libro.getSheetByName("Finalizados");
  if (!hoja) {
    hoja = libro.insertSheet(HOJA_FINALIZADOS);
    hoja.appendRow(COLUMNAS_FINALIZADOS);
    hoja.getRange(1, 1, 1, COLUMNAS_FINALIZADOS.length).setFontWeight("bold");
    hoja.setFrozenRows(1);
  }
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
// 6. MENÚ: PRODUCTOS DE CENTRAL ONE, DÓLAR Y PESTAÑAS
//    🔑 guarda la llave (propiedad del script, nunca en la hoja) · 🔄 reemplaza la pestaña de precios con
//    los productos de Mobile Legends de tu catálogo; el precio en Bs se calcula solo con el dólar y la
//    ganancia de "tasa_dolar" (💲 los cambia: todos los precios se recalculan) · 🧱 crea las pestañas.
// =====================================================================

function onOpen() {
  SpreadsheetApp.getUi().createMenu("💎 Mobile Legends")
    .addItem("🔄 Traer productos y precios de Central One", "traerProductosCentralOne")
    .addItem("💲 Cambiar dólar y ganancia", "cambiarDolarYGanancia")
    .addSeparator()
    .addItem("🔑 Guardar llave de Central One", "guardarLlaveCentralOne")
    .addItem("🧱 Crear / reparar pestañas", "prepararPestanas")
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
  ui.alert("✅ Llave guardada. Ahora: menú 💎 Mobile Legends → 🔄 Traer productos y precios de Central One.");
}

// 💲 El dólar (B1) y la ganancia (B2) de "tasa_dolar": todos los precios de PreciosML se recalculan solos
function cambiarDolarYGanancia() {
  var ui = SpreadsheetApp.getUi();
  var hoja = hojaDeTasa();
  var dolarActual = limpiarMontoVES(hoja.getRange("B1").getValue());
  var gananciaActual = hoja.getRange("B2").getValue();

  var r = ui.prompt("Precio del dólar",
    "Dólar actual: " + (dolarActual > 0 ? formatoBs(dolarActual) + " Bs" : "sin definir") + ".\n" +
    "Escribe el nuevo precio en Bs (ej: 215,40) o deja vacío para no cambiarlo:", ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  var textoDolar = r.getResponseText().trim();
  if (textoDolar) {
    var dolar = limpiarMontoVES(textoDolar);
    if (!(dolar > 0) || dolar > 1000000) { ui.alert("Ese precio del dólar no es válido. No se cambió nada."); return; }
    hoja.getRange("B1").setValue(dolar);
  }

  var g = ui.prompt("Ganancia",
    "Ganancia actual: " + gananciaActual + " %.\nEscribe la nueva ganancia en % (ej: 4) o deja vacío para no cambiarla:", ui.ButtonSet.OK_CANCEL);
  if (g.getSelectedButton() === ui.Button.OK && g.getResponseText().trim()) {
    var ganancia = limpiarMontoVES(g.getResponseText().trim());
    if (!(ganancia >= 0) || ganancia > 300) { ui.alert("Esa ganancia no es válida. Se dejó " + gananciaActual + " %."); }
    else hoja.getRange("B2").setValue(ganancia);
  }
  SpreadsheetApp.flush();
  ui.alert("✅ Dólar a " + formatoBs(limpiarMontoVES(hoja.getRange("B1").getValue())) + " Bs y ganancia de " + hoja.getRange("B2").getValue() +
    " %. Los precios de " + HOJA_PRECIOS + " ya se recalcularon; la tienda los muestra en ~2 minutos.");
}

function traerProductosCentralOne() {
  var ui = SpreadsheetApp.getUi();
  var llave = PropertiesService.getScriptProperties().getProperty(PROPIEDAD_LLAVE_CENTRALONE);
  if (!llave) {
    ui.alert("Primero guarda la llave: menú 💎 Mobile Legends → 🔑 Guardar llave de Central One.");
    return;
  }
  var hoja = hojaDePrecios() || SpreadsheetApp.getActiveSpreadsheet().insertSheet(HOJA_PRECIOS, 0);

  var respuesta = UrlFetchApp.fetch(URL_CENTRALONE + "/catalog", {
    headers: { Authorization: "Bearer " + llave }, muteHttpExceptions: true
  });
  var codigo = respuesta.getResponseCode();
  if (codigo !== 200) {
    var porque = codigo === 401 ? " (llave inválida, revocada o cuenta inactiva)" : codigo === 403 ? " (la llave no tiene el permiso catalog:read)" : codigo === 429 ? " (demasiadas consultas: espera un minuto)" : "";
    ui.alert("Central One respondió HTTP " + codigo + porque + ". No se cambió nada.");
    return;
  }
  var delJuego = (JSON.parse(respuesta.getContentText()).items || []).filter(function (p) {
    return String(p.product_family_name + " " + p.name).toLowerCase().replace(/[^a-z0-9]/g, "").indexOf(JUEGO_CENTRALONE) !== -1;
  });
  if (!delJuego.length) {
    ui.alert("Tu catálogo de Central One no tiene productos de Mobile Legends habilitados. No se cambió nada.");
    return;
  }
  var productos = delJuego.filter(function (p) { return REGIONES_CENTRALONE.indexOf(String(p.region || "").trim().toUpperCase()) !== -1; });
  if (!productos.length) {
    var regiones = delJuego.map(function (p) { return String(p.region || "sin región"); })
      .filter(function (r, i, lista) { return lista.indexOf(r) === i; });
    ui.alert("Hay " + delJuego.length + " producto(s) de Mobile Legends, pero ninguno de la región " + REGIONES_CENTRALONE.join(" / ") +
      " (regiones que hay: " + regiones.join(", ") + "). Agrega la correcta en REGIONES_CENTRALONE del código. No se cambió nada.");
    return;
  }
  // Solo diamantes normales con stock ("86 Diamantes"): sin pases ni productos especiales
  var globales = productos.length;
  productos = productos.filter(function (p) {
    var nombre = String(p.product_family_name + " " + p.name).replace(/mobile\s*legends\s*:?\s*bang\s*bang/ig, "");
    return p.in_stock !== false && !PRODUCTO_ESPECIAL.test(nombre) && /^\d+ Diamantes$/.test(nombreCortoML(p.name));
  });
  if (!productos.length) {
    ui.alert("Hay " + globales + " producto(s) de Mobile Legends " + REGIONES_CENTRALONE.join(" / ") + ", pero ninguno es de diamantes normales con stock. No se cambió nada.");
    return;
  }
  productos.sort(function (a, b) { return Number(a.reseller_price) - Number(b.reseller_price); });

  // Un solo producto por paquete de la tienda (misma clave con la que Vercel reconoce el paquete): si
  // Central One tiene varios (otra región, otro SKU), queda el que tiene stock y, entre ellos, el más
  // barato (la lista ya va de menor a mayor precio). Con dos columnas iguales la tienda no vendería ninguna.
  var elegido = {}, repetidos = [];
  productos.forEach(function (p) {
    var clave = clavePaqueteML(nombreCortoML(p.name));
    var actual = elegido[clave];
    if (!actual) { elegido[clave] = p; return; }
    var mejor = (actual.in_stock === false && p.in_stock !== false) ? p : actual;
    repetidos.push(mejor === p ? actual : p);
    elegido[clave] = mejor;
  });
  productos = productos.filter(function (p) { return elegido[clavePaqueteML(nombreCortoML(p.name))] === p; });
  // Los primeros MAX_PRODUCTOS (la lista va del más barato al más caro)
  var sobran = Math.max(0, productos.length - MAX_PRODUCTOS);
  productos = productos.slice(0, MAX_PRODUCTOS);

  var hojaTasa = hojaDeTasa();
  var dolar = limpiarMontoVES(hojaTasa.getRange("B1").getValue());
  var seguir = ui.alert("Traer productos de Central One",
    "Se reemplaza TODA la pestaña \"" + hoja.getName() + "\" con los " + productos.length + " paquete(s) de diamantes normales más baratos de Mobile Legends " + REGIONES_CENTRALONE.join(" / ") +
    (repetidos.length ? " (se quitaron " + repetidos.length + " repetido(s))" : "") + (sobran ? " (quedan fuera " + sobran + " más caros)" : "") + ".\n\n" +
    "El precio en Bs se calcula solo: costo en USD × dólar (pestaña \"" + HOJA_TASA + "\", B1) + la ganancia (B2). " +
    "Los productos sin stock no se traen.\n\n¿Seguir?",
    ui.ButtonSet.YES_NO);
  if (seguir !== ui.Button.YES) return;

  // Fila 2: fórmula en notación R1C1 (Apps Script las escribe en inglés, con comas, sea cual sea el idioma
  // de la hoja). R[2]C = la celda del costo, 2 filas más abajo en la misma columna. Sin dólar o sin costo, vacía.
  var tasa = "'" + HOJA_TASA + "'!R1C2", ganancia = "'" + HOJA_TASA + "'!R2C2", costo = "R[" + (FILA_COSTO - 2) + "]C";
  var formula = "=IF(OR(" + tasa + "=\"\"," + costo + "=\"\"),\"\",ROUND(" + costo + "*" + tasa + "*(1+" + ganancia + "/100),2))";
  var valores = [[], [], [], [], []];
  var formulas = [];
  productos.forEach(function (p) {
    valores[0].push(textoSeguro(nombreCortoML(p.name)));
    valores[1].push("");
    valores[2].push(textoSeguro(p.product_id));
    valores[3].push(Number(p.reseller_price) || "");
    valores[4].push((p.in_stock === false ? "SIN STOCK" : "con stock") + (p.region ? " · " + textoSeguro(p.region) : ""));
    formulas.push(p.in_stock === false ? "" : formula);
  });
  hoja.clear();
  hoja.getRange(1, 1, 5, productos.length).setValues(valores);
  hoja.getRange(2, 1, 1, productos.length).setFormulasR1C1([formulas]);
  hoja.getRange(1, 1, 1, productos.length).setFontWeight("bold");
  hoja.getRange(2, 1, 1, productos.length).setNumberFormat("#,##0.00");
  hoja.getRange(FILA_COSTO, 1, 1, productos.length).setNumberFormat("0.0000\" USD\"");
  hoja.getRange(FILA_PRODUCTO, 1, 3, productos.length).setFontColor("#888888");
  hoja.getRange(2, 1).setNote("Fila 2: precio en Bs = costo (fila 4) × dólar × (1 + ganancia %). El dólar y la ganancia " +
    "se cambian con el menú 💎 → 💲 (o en la pestaña \"" + HOJA_TASA + "\"). Si escribes un número encima, ese producto queda con precio fijo hasta el próximo 🔄.");
  hoja.getRange(FILA_PRODUCTO, 1).setNote("Fila 3: product_id de Central One, NO la toques (con él se compra). " +
    "Fila 4: costo en USD · fila 5: stock (del momento del 🔄). La fila 1 se puede renombrar: los diamantes como \"86 Diamantes\" y los pases sin números.");
  hoja.setFrozenRows(1);
  SpreadsheetApp.flush();
  ui.alert("✅ Listo: " + productos.length + " producto(s)." +
    (repetidos.length ? " Se quitaron " + repetidos.length + " repetido(s): " + repetidos.slice(0, 8).map(function (p) {
      return nombreCortoML(p.name) + " (" + p.reseller_price + " " + p.currency + (p.region ? ", " + p.region : "") + ")";
    }).join(", ") + (repetidos.length > 8 ? "…" : "") + "." : "") + (dolar > 0
    ? " Precios calculados con el dólar a " + formatoBs(dolar) + " Bs y " + hojaTasa.getRange("B2").getValue() + " % de ganancia."
    : " ⚠️ Falta el precio del dólar: menú 💎 → 💲 Cambiar dólar y ganancia. Hasta entonces no se vende nada.") +
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
      ["Cambia B1 o B2 (o usa el menú 💎 → 💲) y todos los precios de " + HOJA_PRECIOS + " se recalculan solos.", ""]
    ]);
    hoja.getRange("A1:A2").setFontWeight("bold");
    hoja.getRange("B1").setNumberFormat("#,##0.00").setBackground("#fff2cc");
    hoja.getRange("B2").setBackground("#fff2cc");
    hoja.getRange("A3").setFontColor("#888888");
    hoja.setColumnWidth(1, 200);
  }
  return hoja;
}

// 🧱 Crea las pestañas que falten (no borra ni cambia datos) y rehace las fórmulas de "resumen"
function prepararPestanas() {
  if (!hojaDePrecios()) {
    var precios = SpreadsheetApp.getActiveSpreadsheet().insertSheet(HOJA_PRECIOS, 0);
    precios.getRange("A1").setValue("Usa el menú 💎 → 🔄 Traer productos y precios de Central One");
  }
  hojaDeTasa();
  hojaPedidos();
  hojaConTitulos(HOJA_ERRORES, COLUMNAS_ERRORES);
  hojaPorCompletar();
  hojaResumen();
  SpreadsheetApp.flush();
  SpreadsheetApp.getUi().alert("✅ Pestañas listas: " + [HOJA_PRECIOS, HOJA_TASA, HOJA_PEDIDOS, HOJA_ERRORES, HOJA_POR_COMPLETAR, HOJA_RESUMEN].join(", ") +
    ". Los finalizados van a la pestaña \"" + HOJA_FINALIZADOS + "\" de la hoja de Free Fire.");
}

// "resumen": solo fórmulas sobre las otras pestañas (no la escribe ninguna recarga)
function hojaResumen() {
  var hoja = obtenerHojaLocal(HOJA_RESUMEN) || SpreadsheetApp.getActiveSpreadsheet().insertSheet(HOJA_RESUMEN);
  var p = "'" + HOJA_PEDIDOS + "'!", estado = p + "L2:L", fecha = p + "A2:A", cobrado = p + "G2:G";
  var inicioMes = "EOMONTH(TODAY(),-1)+1";
  var filas = [
    ["MOBILE LEGENDS · RESUMEN", ""],
    ["Recargas de hoy", "=COUNTIFS(" + fecha + ",\">=\"&TODAY())"],
    ["Cobrado hoy (Bs)", "=SUMIFS(" + cobrado + "," + fecha + ",\">=\"&TODAY())"],
    ["Recargas del mes", "=COUNTIFS(" + fecha + ",\">=\"&" + inicioMes + ")"],
    ["Cobrado del mes (Bs)", "=SUMIFS(" + cobrado + "," + fecha + ",\">=\"&" + inicioMes + ")"],
    ["✅ Completadas (total)", "=COUNTIF(" + estado + ",\"✅*\")"],
    ["⏳ En proceso", "=COUNTIF(" + estado + ",\"⏳*\")"],
    ["❌ Fallidas / ⚠️ parciales / ↩️ reembolsadas", "=COUNTIF(" + estado + ",\"❌*\")+COUNTIF(" + estado + ",\"⚠️*\")+COUNTIF(" + estado + ",\"↩️*\")"],
    ["Filas en errores (revisar)", "=COUNTA('" + HOJA_ERRORES + "'!A2:A)"],
    ["Pagos por completar pendientes", "=COUNTIF('" + HOJA_POR_COMPLETAR + "'!L2:L,\"PENDIENTE*\")"],
    ["Dólar (Bs)", "='" + HOJA_TASA + "'!B1"],
    ["Ganancia (%)", "='" + HOJA_TASA + "'!B2"]
  ];
  hoja.getRange(1, 1, filas.length, 2).clearContent();
  hoja.getRange(1, 1, filas.length, 1).setValues(filas.map(function (f) { return [f[0]]; }));
  filas.forEach(function (f, i) { if (f[1]) hoja.getRange(i + 1, 2).setFormula(f[1]); });
  hoja.getRange("A1").setFontWeight("bold").setFontSize(12);
  hoja.getRange(2, 1, filas.length - 1, 1).setFontWeight("bold");
  hoja.getRange("B3").setNumberFormat("#,##0.00");
  hoja.getRange("B5").setNumberFormat("#,##0.00");
  hoja.getRange("B11").setNumberFormat("#,##0.00");
  hoja.setColumnWidth(1, 320);
  return hoja;
}

// Nombres de Central One (en inglés) en español. Las palabras semanal, crepúsculo, estelar y plus NO se cambian
// al renombrar: Vercel reconoce cada pase por ellas (PALABRAS_PASES de api/_lib/juegos/mobilelegends.js).
const TRADUCCIONES_ML = [
  [/weekly\s*diamonds?\s*pass|diamonds?\s*weekly\s*pass/ig, "Pase Semanal de Diamantes"],
  [/weekly\s*pass/ig, "Pase Semanal"],
  [/twilight\s*pass/ig, "Pase Crepúsculo"],
  [/starlight\s*member(ship)?\s*plus|starlight\s*plus/ig, "Membresía Estelar Plus"],
  [/starlight\s*member(ship)?|starlight/ig, "Membresía Estelar"],
  [/\bweekly\b/ig, "Semanal"],
  [/\bmonthly\b/ig, "Mensual"],
  [/\bpass\b/ig, "Pase"],
  [/\b(bundle|pack)\b/ig, "Paquete"],
  [/\bmembership\b/ig, "Membresía"],
  [/\bdiamonds?\b/ig, "Diamantes"],
];

function traducirNombreML(texto) {
  var t = String(texto || "");
  TRADUCCIONES_ML.forEach(function (par) { t = t.replace(par[0], par[1]); });
  return t.replace(/\s+/g, " ").trim();
}

// "Mobile Legends 86 Diamonds" -> "86 Diamantes" (como espera la tienda);
// "MLBB Weekly Diamond Pass" -> "Pase Semanal de Diamantes"
function nombreCortoML(nombre) {
  var original = String(nombre || "").trim();
  var t = original.replace(/mobile\s*legends(\s*:?\s*bang\s*bang)?|\bmlbb\b/ig, "").replace(/^[\s\-–|:·]+|[\s\-–|:·]+$/g, "").trim();
  var numero = t.match(/\d[\d.,]*/);
  var esPase = /pass|pase|member|starlight|twilight|weekly|semanal/i.test(t);
  if (numero && !esPase && /diamond|diamante/i.test(t)) return numero[0].replace(/[.,]/g, "") + " Diamantes";
  return traducirNombreML(t) || original;
}

// Clave con la que la tienda reconoce un paquete. DEBE ser igual a clavePaquete de
// api/_lib/juegos/mobilelegends.js: los diamantes por su número ("86 Diamantes" -> "86") y los pases por
// una palabra más su número si lo tienen ("Pase Semanal x2" -> "weekly_pass_2").
function clavePaqueteML(texto) {
  var t = String(texto || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  var nombre = t.replace(/mobile\s*legends|mlbb|bang\s*bang|diamantes|diamante|diamonds|diamond/g, " ").replace(/[^a-z]+/g, " ").trim();
  var numero = t.replace(/mobile\s*legends|mlbb/g, " ").replace(/[^0-9]/g, "");
  if (!nombre) return numero;
  var pases = [[/semanal|weekly/, "weekly_pass"], [/crepusculo|twilight/, "twilight_pass"], [/(estelar|starlight) plus/, "starlight_plus"], [/estelar|starlight/, "starlight"]];
  var base = nombre.replace(/ /g, "_");
  for (var i = 0; i < pases.length; i++) if (pases[i][0].test(nombre)) { base = pases[i][1]; break; }
  return numero ? base + "_" + numero : base;
}
