// =====================================================================
// LEVEL UP - Apps Script de RECARGAS FREE FIRE (variable SCRIPT_RECARGAS_URL en Vercel)
// Usado por: api/_lib/juegos/freefire.js, api/_lib/descuentos.js, api/subir-imagen.js y MacroDroid.
//
// Secciones:  1 Configuración · 2 Entrada (doPost) · 3 Pagos · 4 Pines y recargas
//             5 Ruleta · 6 Descuentos y creadores · 7 Menús de la hoja · 8 Utilidades
//
// Cómo actualizarlo: pega este archivo en el editor de Apps Script y luego
// Implementar > Gestionar implementaciones > editar (lápiz) > Versión: "Nueva versión" > Implementar.
// Así la URL /exec NO cambia y no hay que tocar Vercel.
//
// Seguridad (Configuración del proyecto > Propiedades del script), ambas opcionales:
//   TOKEN_VERCEL     = el mismo valor que SCRIPT_RECARGAS_TOKEN en Vercel.
//   MACRODROID_CLAVE = clave que MacroDroid envía en el campo "clave" del JSON.
// Mientras una propiedad no exista, esa comprobación se omite.
// ORDEN: primero configura Vercel/MacroDroid, después crea la propiedad.
//
// Reglas que no se deben romper:
//   - Cada pedido trae un idPedido: repetir verificar_pago u obtener_codigo devuelve el mismo
//     resultado (Vercel puede reintentar sin sacar pines de más).
//   - Un pago encontrado NUNCA vuelve a "Verificado": ante cualquier error queda "Usado" y el
//     pedido se anota en "errores" (por eso ya no existen liberar_pedido ni marcar_verificado).
//   - Free Fire tiene 3 modos (menú "🖐️ Recargas Free Fire"): MANUAL (todo a "sin_codigo"),
//     BOT (pines de "codigos" + bot de Railway) y API (FazerCards: pestaña "fazer_card", con el
//     estado que avisa FazerCards en tiempo real). Sin pines o sin oferta de FazerCards, el pedido
//     va a "sin_codigo" para hacerlo a mano. En los tres, al cliente se le responde recarga exitosa.
//   - Pago insuficiente: el pago queda "Por completar" (nadie más puede usarlo) y el pedido en la
//     pestaña "por_completar". El cliente paga la diferencia con su clave (Vercel solo manda la huella);
//     el jugador, el paquete y el precio salen de esa fila, nunca del navegador.
// =====================================================================


// =====================================================================
// 1. CONFIGURACIÓN
// =====================================================================

const PROJECT_ID = "levelupstore-87d4d";
const COLLECTION_NAME = "Pagos";
const FOLDER_ID = "12-YApHdXIFtbIk9qzNCiUY0SVsimCecO";

// Versión que la tienda lee en obtener_precios (y usar_complemento): con 2 o más, Vercel sabe que
// verificar_pago y obtener_codigo son idempotentes (idPedido) y que puede reintentarlos tras un timeout;
// con 3 o más, que registrar_finalizado ignora un idPedido ya anotado (repite el cierre en segundo plano).
const VERSION_SCRIPT = 3;

// --- Candado (una sola operación sobre pagos/pines a la vez) ---
// Vercel espera hasta 15 s por intento: si el candado tarda más que esto en liberarse,
// es mejor responder "ocupado" (Vercel reintenta) que trabajar para una petición que ya nadie espera.
const ESPERA_CANDADO_MS = 8000;
// MacroDroid espera 30 s: un pago nuevo puede esperar más que Vercel a que termine una recarga
// (con 8 s, si había una recarga en curso, el pago se rechazaba como "ocupado" y NO se guardaba).
const ESPERA_CANDADO_MACRODROID_MS = 20000;
// Webhook de FazerCards: solo espera 10 s (si no, lo reintenta en 1 minuto)
const ESPERA_CANDADO_WEBHOOK_MS = 4000;
const MENSAJE_ERROR_INTERNO = "Error interno en el sistema de recargas. Intenta de nuevo en unos segundos.";

// --- Pagos por completar (el cliente pagó menos y paga la diferencia con otro pago) ---
// Una fila por pedido. N = huella SHA-256 de la clave del cliente (la clave nunca llega a la hoja).
const HOJA_POR_COMPLETAR = "por_completar";
const COLUMNAS_POR_COMPLETAR = ["fecha-hora", "id pedido", "id jugador", "paquete", "precio (Bs)", "pagado (Bs)", "falta (Bs)",
  "referencias", "código descuento", "comprobante", "estado", "pedido que completó", "actualizado", "clave (huella)", "vence"];
// Estado de "pagos" de un pago que no alcanzó: no es "Verificado", así que ningún otro pedido lo toma
const ESTADO_PAGO_POR_COMPLETAR = "Por completar";
const HORAS_PARA_COMPLETAR = 48;
const MAX_PAGOS_POR_PEDIDO = 4;

// --- Pines y recargas manuales ---
// Pestaña de auditoría: qué pines se entregaron a cada pedido y qué pasó con ellos
const HOJA_ASIGNACIONES = "asignaciones_pines";
const COLUMNAS_ASIGNACIONES = ["fecha", "id pedido", "referencia", "columna", "n.º columna", "pines", "estado"];
// Estado en "asignaciones_pines" de un pedido que pasó a "sin_codigo" (no salió ningún pin)
const ESTADO_SIN_CODIGO = "SIN CÓDIGO";
// Recargas pagadas que no tenían pines: se hacen a mano. Marca la casilla "¿hecha?" al terminar.
const HOJA_SIN_CODIGO = "sin_codigo";
const COLUMNAS_SIN_CODIGO = ["fecha-hora", "id jugador", "paquete", "referencia", "cobrado (Bs)", "comprobante", "código descuento", "id pedido", "¿hecha?"];
// Interruptor (menú "🖐️ Recargas Free Fire"), valor guardado en esta propiedad:
//   "manual"     = TODOS los pedidos van a "sin_codigo" aunque haya pines (también si no se eligió nada)
//   "automatico" = BOT: se usan los pines y solo van a "sin_codigo" si faltan
//   "api"        = FazerCards: Vercel envía la orden; solo van a "sin_codigo" los paquetes sin oferta
const PROPIEDAD_MODO_RECARGA = "MODO_RECARGA_FF";

// --- FazerCards (modo API) ---
// Una fila por pedido enviado a la API. La columna K ("estado") la actualiza el webhook de
// FazerCards (api/fazer-webhook.js -> estado_fazer) cada vez que la orden cambia de estado.
const HOJA_FAZER = "fazer_card";
const COLUMNAS_FAZER = ["fecha-hora", "id jugador", "paquete", "oferta FazerCards", "referencia", "cobrado (Bs)",
  "comprobante", "código descuento", "id pedido", "orden FazerCards", "estado", "actualizado", "detalle"];
// Estado en "asignaciones_pines" de un pedido que va por la API (no salió ningún pin)
const ESTADO_API = "API FAZERCARDS";
const OFERTA_FAZER_VALIDA = /^[A-Za-z0-9_.:-]{1,80}$/;
const TEXTO_ESTADO_FAZER = { processing: "⏳ EN PROCESO", completed: "✅ COMPLETADA", failed: "❌ FALLIDA", refund: "↩️ REEMBOLSADA", refunded: "↩️ REEMBOLSADA" };
// Aviso del webhook que llegó antes de que la orden se anotara: se guarda este tiempo (máximo de CacheService)
const ESPERA_AVISO_FAZER_S = 21600;
// Columnas de la pestaña "errores" (A-E son las de siempre; F-L agregan el detalle)
const COLUMNAS_ERRORES = ["fecha-hora", "id", "estado de los pines", "producto", "informe completo",
  "fase del fallo", "referencia", "estado del pago", "motivo técnico", "comprobante", "id pedido", "pines asignados al pedido"];
// Columnas de "finalizados" (solo se usan si hay que crear la pestaña)
const COLUMNAS_FINALIZADOS = ["fecha-hora", "id jugador", "paquete", "referencia", "códigos / orden", "comprobante"];
// Los comprobantes muestran nombre/cédula del cliente: por defecto solo los ve el dueño de la carpeta.
const COMPARTIR_COMPROBANTES_CON_ENLACE = false;

// --- Ruleta ---
// Pestaña donde se anotan los ganadores (para entregar el premio) y máximo de pagos
// con los mismos últimos 5 dígitos que se devuelven a Vercel
const HOJA_RULETA = "ruleta";
const COLUMNAS_RULETA = ["fecha-hora", "id jugador", "referencia", "paquete", "premio", "estado de entrega"];
const MAX_CANDIDATOS_RULETA = 5;

// --- Descuentos y creadores (detalle de columnas en la sección 6) ---
// Acepta "Descuentos" o "descuentos". Columna B: siempre porcentaje ("10%" o "10" = 10 %).
const HOJA_DESCUENTOS = "descuentos";
// Todos los códigos de creador dan este % de descuento al cliente y el creador gana ese MISMO %
// de cada venta. Sin niveles, sin metas semanales y sin límite de creadores.
const PORCENTAJE_CREADOR = 1.5;
// Mínimo para retirar (sobre J, el pendiente)
const RETIRO_MINIMO_USD = 3;
// Columna L: comisión en Bs de ventas hechas sin ninguna tasa conocida (se pasa a H y J al haber tasa)
const COLUMNA_POR_CONVERTIR = 12;
// Pestaña con la tasa: B1 = Bs por 1 USD
const HOJA_CONFIG = "config";
// Historial de ventas con código. D = id del jugador que recargó; I = id del pedido
// (evita anotar dos veces la misma venta). Las filas viejas tienen el id del pedido en D.
const HOJA_MOVIMIENTOS_DESCUENTOS = "movimientos_descuentos";
const COLUMNAS_MOVIMIENTOS_DESCUENTOS = ["fecha-hora", "código", "juego", "id jugador", "venta (Bs)", "comisión (Bs)", "tasa Bs/USD", "comisión (USD)", "id pedido"];
// Ventas que muestra el panel de cada creador en "Últimos movimientos"
const MOVIMIENTOS_PANEL = 10;
// Registro de cada pago a un creador (lo crea el menú ⭐ Creadores > Registrar pago)
const HOJA_PAGOS_CREADORES = "pagos_creadores";
const COLUMNAS_PAGOS_CREADORES = ["fecha-hora", "código", "creador", "ventas liquidadas (Bs)", "comisión (%)", "tasa Bs/USD", "pagado (USD)"];


// =====================================================================
// 2. ENTRADA: toda petición llega a doPost
//    - MacroDroid (sin "accion"): guarda un pago nuevo.
//    - Vercel (con "accion" y token): lecturas sin candado o cambios con candado.
// =====================================================================

function doPost(e) {
  var datos;
  try {
    datos = JSON.parse((e && e.postData && e.postData.contents) || "{}");
  } catch (err) {
    return responder({ status: "error", message: "JSON inválido" });
  }
  var accion = String(datos.accion || "");
  var props = PropertiesService.getScriptProperties();

  // MacroDroid: no envía "accion"
  if (!accion && (datos.referencia || datos.monto || datos.telefono)) {
    var claveMacro = props.getProperty("MACRODROID_CLAVE");
    if (claveMacro && String(datos.clave || "") !== claveMacro) {
      return responder({ status: "error", message: "No autorizado" });
    }
    return conCandado(function () { return guardarPagoMacroDroid(datos); }, ESPERA_CANDADO_MACRODROID_MS);
  }

  // Todas las demás acciones solo las puede pedir Vercel
  var tokenVercel = props.getProperty("TOKEN_VERCEL");
  if (tokenVercel && String(datos.token || "") !== tokenVercel) {
    return responder({ status: "error", message: "No autorizado" });
  }

  // Lecturas y subidas: no tocan pagos ni pines, así que NO esperan el candado
  // (el premio de la ruleta lo decide y lo guarda Vercel en Firestore; aquí solo se anota)
  var sinCandado = {
    obtener_precios: obtenerPrecios,
    subir_imagen: subirImagen,
    consultar_ruleta: consultarRuleta,
    registrar_premio_ruleta: registrarPremioRuleta,
    validar_descuento: validarDescuento,
    consultar_creador: consultarCreador
  };
  // Cambian pagos, pines o contadores: una a la vez
  var conCandadoAcciones = {
    verificar_pago: verificarPago,
    obtener_codigo: obtenerCodigo,
    devolver_codigos: devolverCodigos,
    bloquear_pedido: bloquearPedido,
    marcar_usado: marcarUsado,
    registrar_finalizado: registrarFinalizado,
    registrar_error: registrarError,
    registrar_uso_descuento: registrarUsoDescuento,
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

// 🛡️ Candado: una sola operación sobre pagos/pines a la vez
function conCandado(operacion, esperaMs) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(esperaMs || ESPERA_CANDADO_MS)) {
    return responder({ status: "error", ocupado: true, message: "⚠️ Sistema ocupado procesando otra transacción. Por favor, intenta de nuevo en unos segundos." });
  }
  try {
    return operacion();
  } catch (error) {
    console.error("Error dentro del candado: " + (error && error.stack || error));
    // detalle: solo lo lee Vercel para la pestaña "errores" (nunca llega al cliente)
    return responder({ status: "error", message: MENSAJE_ERROR_INTERNO, detalle: String(error && error.message || error).slice(0, 200) });
  } finally {
    lock.releaseLock();
  }
}


// =====================================================================
// 3. PAGOS (pestaña "pagos": A fecha · B teléfono · C referencia · D monto · E estado)
//    Estados: Verificado -> En proceso (lo tomó un pedido) -> Usado. Nunca vuelve atrás.
// =====================================================================

// MacroDroid: guarda el pago que llegó al teléfono
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

  var fechaHora = ahora();
  hoja.appendRow([fechaHora, textoSeguro(datos.telefono), ref, textoSeguro(datos.monto || "0"), "Verificado"]);
  SpreadsheetApp.flush();
  // Dónde quedó (se ve en la variable de respuesta de MacroDroid): si una columna tiene fórmulas o
  // datos sueltos muy abajo, appendRow escribe después de ellos y la fila "no aparece" arriba.
  return responder({ status: "success", message: "Pago guardado automáticamente",
    libro: SpreadsheetApp.getActiveSpreadsheet().getName(), hoja: hoja.getName(), fila: hoja.getLastRow() });
}

// Busca el pago por los últimos 5 dígitos y lo bloquea ("En proceso") para que nadie más lo use
function verificarPago(datos) {
  var hoja = obtenerHoja("pagos");
  var ultimos5 = String(datos.referencia || "").replace(/\s+/g, "");
  if (!/^\d{5}$/.test(ultimos5)) {
    return responder({ status: "success", encontrado: false, message: "🔍 La referencia debe tener exactamente 5 dígitos." });
  }
  var precioRequerido = limpiarMontoVES(datos.monto);
  var pago = tomarPago(hoja, ultimos5, String(datos.idPedido || ""));
  if (!pago.encontrado) return responder({ status: "success", encontrado: false, message: pago.message });
  return responder({
    status: "success", encontrado: true, fila: pago.fila, telefono: pago.telefono,
    referencia: pago.referencia, montoPagado: pago.montoPagado,
    insuficiente: pago.montoPagado < (precioRequerido - 0.50), repetido: pago.repetido
  });
}

// Busca el pago con esos últimos 5 dígitos y lo bloquea ("En proceso") para este pedido.
// Devuelve { encontrado, fila, telefono, referencia, montoPagado, repetido } o { encontrado: false, message }.
// Solo coincidencia EXACTA de los últimos 5 dígitos (se eliminó la búsqueda "contiene":
// multiplicaba las posibilidades de acertar el pago de otro cliente probando números).
// De abajo hacia arriba, se elige el pago disponible más reciente y se saltan los ya usados,
// así un pago viejo "Usado" con los mismos 5 dígitos no bloquea uno nuevo.
function tomarPago(hoja, ultimos5, idPedido) {
  var rows = hoja.getDataRange().getValues();
  var props = PropertiesService.getScriptProperties();
  var respuestaEncontrado = function (i, repetido) {
    return {
      encontrado: true, fila: i + 1, telefono: String(rows[i][1]).trim(),
      referencia: String(rows[i][2]).replace(/\s+/g, ""), montoPagado: limpiarMontoVES(rows[i][3]), repetido: repetido
    };
  };

  var hayUsado = false, hayEnProceso = false, hayPorCompletar = false;
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
    if (estadoActual === ESTADO_PAGO_POR_COMPLETAR.toLowerCase()) { hayPorCompletar = true; continue; }
    if (estadoActual !== "verificado" && estadoActual !== "") continue;

    // Primero se recuerda qué pedido lo toma (reintentos y bloquear_pedido) y después se bloquea:
    // si algo falla a mitad, bloquear_pedido igual encuentra el pago y lo deja "Usado"
    if (idPedido) {
      props.setProperty("proc_" + referenciaCompleta, idPedido);
      props.setProperty("pedido_" + idPedido, referenciaCompleta);
    }
    hoja.getRange(i + 1, 5).setValue("En proceso");
    SpreadsheetApp.flush();
    actualizarEstadoFirebase(referenciaCompleta, "En proceso");
    return respuestaEncontrado(i, false);
  }

  if (hayEnProceso) return { encontrado: false, message: "⚠️ Otro cliente está procesando esta referencia en este momento." };
  if (hayPorCompletar) return { encontrado: false, message: "⏳ Este pago no alcanzó y está esperando que completes la diferencia: usa el botón \"Completar pago\" de la tienda o escríbenos por WhatsApp." };
  if (hayUsado) return { encontrado: false, message: "❌ Este pago ya fue validado y gastado en otra recarga." };
  return { encontrado: false, message: "🔍 Referencia no encontrada en el sistema." };
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

  var pago = tomarPago(obtenerHoja("pagos"), ultimos5, idPedido);
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
    referencias: referencias, codigoDescuento: String(v[8] || ""), comprobante: String(v[9] || "")
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
  var hoja = obtenerHoja(HOJA_POR_COMPLETAR, true);
  if (!hoja) {
    hoja = SpreadsheetApp.getActiveSpreadsheet().insertSheet(HOJA_POR_COMPLETAR, 0);
    hoja.appendRow(COLUMNAS_POR_COMPLETAR);
    hoja.getRange(1, 1, 1, COLUMNAS_POR_COMPLETAR.length).setFontWeight("bold");
    hoja.setFrozenRows(1);
  }
  return hoja;
}

// Fila (la más reciente) de "por_completar" con ese valor exacto en esa columna
// (2 = id pedido, 12 = pedido que completó, 14 = huella de la clave)
function buscarFilaPorCompletar(columna, valor) {
  var hoja = obtenerHoja(HOJA_POR_COMPLETAR, true);
  if (!valor || !hoja || hoja.getLastRow() < 2) return 0;
  var celdas = hoja.getRange(2, columna, hoja.getLastRow() - 1, 1)
    .createTextFinder(String(valor)).matchEntireCell(true).matchCase(true).findAll();
  return celdas.length ? celdas[celdas.length - 1].getRow() : 0;
}

// Pedido que no pudo continuar (Vercel no recibió la respuesta de verificar_pago): el pago que
// tomó ESTE pedido pasa a "Usado" y la recarga se hace a mano desde la pestaña "errores".
function bloquearPedido(datos) {
  var idPedido = String(datos.idPedido || "");
  if (!idPedido) return responder({ status: "error", message: "Falta idPedido" });
  var props = PropertiesService.getScriptProperties();
  var referencia = props.getProperty("pedido_" + idPedido);
  if (!referencia) return responder({ status: "success", referencia: "" }); // nunca llegó a tomar un pago
  if (props.getProperty("proc_" + referencia) === idPedido) cambiarEstadoPago(referencia, "Usado", "en proceso");
  return responder({ status: "success", referencia: referencia });
}

// Éxito definitivo o pago bloqueado para revisión
function marcarUsado(datos) {
  var cambiado = cambiarEstadoPago(datos.referencia, "Usado", null);
  return responder({ status: "success", cambiado: cambiado });
}

// Cambia el estado del pago con esa referencia completa (la fila más reciente).
// Si soloSiEstado se indica, solo cambia cuando el estado actual coincide.
// Devuelve true si cambió el estado. Al salir de "En proceso" se borra qué pedido lo tenía.
function cambiarEstadoPago(referencia, nuevoEstado, soloSiEstado) {
  var refBuscada = String(referencia || "").replace(/\s+/g, "");
  if (!refBuscada) return false;
  var hoja = obtenerHoja("pagos");
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
// columna C (marcar_usado corre en cada recarga, dentro del candado) y, si no la encuentra (p. ej. una
// referencia que la hoja muestra con otro formato), leyendo la columna entera como antes.
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

// Ejecutar a mano desde el editor si quedaron pagos trabados en "En proceso": pasan a "Usado"
// (nunca a "Verificado", para que nadie los gaste dos veces). Revisa "errores" para entregar esas recargas.
function bloquearPagosAtascados() {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var hoja = obtenerHoja("pagos");
    var rows = hoja.getDataRange().getValues();
    for (var i = 1; i < rows.length; i++) {
      if (String(rows[i][4]).trim().toLowerCase() === "en proceso") {
        var ref = String(rows[i][2]).replace(/\s+/g, "");
        hoja.getRange(i + 1, 5).setValue("Usado");
        olvidarPedidoDePago(ref);
        actualizarEstadoFirebase(ref, "Usado");
      }
    }
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
}

// Menú "🖐️ Recargas Free Fire" > "🧹 Marcar como Usado...": repara los pagos cuya recarga está en
// "finalizados" pero que siguen "En proceso" o "Verificado" (antes Vercel podía no marcarlos si el
// candado estaba ocupado). Pide confirmación con la lista y toma el candado.
function marcarUsadosLosFinalizados() {
  var ui = SpreadsheetApp.getUi();
  var hojaFin = obtenerHoja("finalizados", true);
  if (!hojaFin || hojaFin.getLastRow() < 2) { ui.alert("La pestaña 'finalizados' está vacía."); return; }
  var finalizadas = {};
  hojaFin.getRange(2, 4, hojaFin.getLastRow() - 1, 1).getValues().forEach(function (f) {
    var ref = String(f[0]).replace(/\s+/g, "");
    if (ref) finalizadas[ref] = true;
  });

  var hoja = obtenerHoja("pagos");
  // Fila de "pagos" (1, 2...) -> referencia, si su recarga está en "finalizados" y el pago no está "Usado"
  var sinMarcar = function () {
    var rows = hoja.getDataRange().getValues();
    var lista = [];
    for (var i = 1; i < rows.length; i++) {
      var ref = String(rows[i][2]).replace(/\s+/g, "");
      var estado = String(rows[i][4]).trim().toLowerCase();
      if (ref && finalizadas[ref] && (estado === "en proceso" || estado === "verificado" || estado === "")) {
        lista.push({ fila: i + 1, ref: ref, estado: String(rows[i][4]).trim() || "(vacío)" });
      }
    }
    return lista;
  };

  // La confirmación se pide SIN el candado: mientras decides, las recargas siguen funcionando
  var pendientes = sinMarcar();
  if (!pendientes.length) { ui.alert("Todo en orden: no hay pagos finalizados sin marcar como Usado."); return; }
  var lista = pendientes.map(function (p) { return "Fila " + p.fila + ": " + p.ref + " (" + p.estado + ")"; });
  var respuesta = ui.alert("Pagos finalizados sin marcar", "Se marcarán como \"Usado\":\n\n" +
    lista.slice(0, 40).join("\n") + (lista.length > 40 ? "\n... y " + (lista.length - 40) + " más" : "") +
    "\n\n¿Continuar?", ui.ButtonSet.YES_NO);
  if (respuesta !== ui.Button.YES) return;

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { ui.alert("El sistema está procesando una recarga. Intenta de nuevo en unos segundos."); return; }
  var reparadas = [];
  try {
    // Se vuelve a leer dentro del candado: una fila pudo cambiar o moverse mientras confirmabas
    sinMarcar().forEach(function (p) {
      hoja.getRange(p.fila, 5).setValue("Usado");
      olvidarPedidoDePago(p.ref);
      actualizarEstadoFirebase(p.ref, "Usado");
      reparadas.push(p.ref);
    });
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  console.log("Pagos finalizados marcados como Usado: " + reparadas.join(", "));
  ui.alert("Listo: " + reparadas.length + " pago(s) marcados como \"Usado\".");
}


// =====================================================================
// 4. PINES Y RECARGAS
//    obtener_precios -> obtener_codigo (pines o "sin_codigo") -> bot de Railway (en Vercel)
//    -> registrar_finalizado (éxito) o registrar_error + devolver_codigos (fallo)
// =====================================================================

// Sin candado: solo lectura de la pestaña "precios" (fila 1: paquetes, fila 2: precios)
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

// Saca (y borra) los pines del inventario "codigos". Sin pines o en modo manual: "sin_codigo".
function obtenerCodigo(datos) {
  var idPedido = String(datos.idPedido || "");
  // Reintento de la MISMA petición: se devuelven los mismos pines, sin sacar otros del inventario
  if (idPedido) {
    var previa = buscarAsignacion(idPedido);
    if (previa) {
      if (previa.estado.indexOf(ESTADO_SIN_CODIGO) === 0) {
        return responder({ status: "success", pines: [], manual: true, repetido: true });
      }
      if (previa.estado.indexOf(ESTADO_API) === 0) {
        return responder({ status: "success", pines: [], api: true, repetido: true });
      }
      if (previa.estado.indexOf("ASIGNADOS") !== 0) {
        return responder({ status: "error", message: "Los pines de este pedido ya no están asignados (" + previa.estado + ")." });
      }
      return responder({ status: "success", pines: previa.pines, repetido: true });
    }
  }

  // Modo manual: no se toca el inventario, el pedido va directo a "sin_codigo"
  var modo = modoRecarga();
  if (modo === "manual" && puedeIrASinCodigo(datos, idPedido)) return pasarASinCodigo(datos, idPedido, "modo manual activado");
  // Modo API: la recarga la hace FazerCards (Vercel envía la orden); sin oferta para el paquete, a mano
  if (modo === "api" && puedeIrASinCodigo(datos, idPedido)) {
    return OFERTA_FAZER_VALIDA.test(String(datos.ofertaFazer || "")) ? pasarAFazer(datos, idPedido)
      : pasarASinCodigo(datos, idPedido, "modo API: el paquete no tiene oferta de FazerCards (OFERTAS_FAZER en Vercel)");
  }

  var hojaCodigos = obtenerHoja("codigos");
  var diamantesBuscados = clavePaquete(datos.diamantes);
  var cantidadNecesaria = (diamantesBuscados === "220") ? 2 : 1;
  var columnaBuscar = (diamantesBuscados === "220") ? "110" : diamantesBuscados;

  var headers = hojaCodigos.getRange(1, 1, 1, hojaCodigos.getLastColumn()).getValues()[0];
  var colIndex = -1;
  for (var h = 0; h < headers.length; h++) {
    if (clavePaquete(headers[h]) === columnaBuscar) { colIndex = h + 1; break; }
  }
  if (!columnaBuscar || colIndex === -1) {
    if (puedeIrASinCodigo(datos, idPedido)) return pasarASinCodigo(datos, idPedido, "no hay columna " + columnaBuscar + " en codigos");
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
    // No se saca ningún pin (con 220 y un solo pin de 110, ese pin se queda en el inventario)
    if (puedeIrASinCodigo(datos, idPedido)) return pasarASinCodigo(datos, idPedido, "sin pines de " + columnaBuscar);
    return responder({ status: "error", message: "⚠️ ¡Nos quedamos sin stock! Faltan pines de " + columnaBuscar + " diamantes." });
  }

  // Borrar los códigos usados de inmediato
  for (var k = 0; k < codigosAsignados.length; k++) {
    hojaCodigos.getRange(codigosAsignados[k].fila, colIndex).clearContent();
  }
  var pines = codigosAsignados.map(function (c) { return c.codigo; });

  // Auditoría: qué pines salieron del inventario, para qué pedido y de qué columna
  if (idPedido) {
    var fechaHora = ahora();
    hojaAsignaciones().appendRow([fechaHora, idPedido, textoSeguro(datos.referencia || ""),
      textoSeguro(String(headers[colIndex - 1])), colIndex, pines.join(" | "), "ASIGNADOS"]);
  }
  SpreadsheetApp.flush();

  return responder({ status: "success", pines: pines });
}

// Clave de un paquete (igual que en api/_lib/juegos/freefire.js): "110 💎" -> "110"; las tarjetas
// por su nombre: "Tarjeta semanal" -> "semanal", "Semanal Lite" -> "semanal_lite", "Tarjeta mensual"
// -> "mensual". Así una columna "Tarjeta semanal" en "codigos" guarda los pines de esa tarjeta.
function clavePaquete(texto) {
  var t = String(texto || "").toLowerCase();
  if (/semanal|weekly/.test(t)) return /lite/.test(t) ? "semanal_lite" : "semanal";
  if (/mensual|monthly/.test(t)) return "mensual";
  return t.replace(/[^0-9]/g, "");
}

// La tienda lo pide (manualSiNoHay) y el pedido trae su id: sin id no se podría evitar
// anotarlo dos veces si Vercel repite la petición.
function puedeIrASinCodigo(datos, idPedido) {
  return datos.manualSiNoHay === true && /^[A-Za-z0-9-]{8,64}$/.test(idPedido) && /^\d{5,15}$/.test(String(datos.idJugador || ""));
}

// Anota el pedido en "sin_codigo" para hacerlo a mano y lo marca en "asignaciones_pines"
// (así un reintento del mismo pedido no lo anota otra vez). Corre dentro del candado.
function pasarASinCodigo(datos, idPedido, motivo) {
  var fechaHora = ahora();
  var hoja = hojaSinCodigo();
  hoja.appendRow([
    fechaHora,
    textoSeguro(datos.idJugador),
    textoSeguro(datos.paquete || (String(datos.diamantes || "") + " diamantes")),
    textoSeguro(datos.referencia || ""),
    limpiarMontoVES(datos.montoCobrado),
    textoSeguro(datos.comprobante || "Sin comprobante"),
    textoSeguro(datos.codigoDescuento || ""),
    idPedido,
    false
  ]);
  hoja.getRange(hoja.getLastRow(), COLUMNAS_SIN_CODIGO.length).insertCheckboxes();
  hojaAsignaciones().appendRow([fechaHora, idPedido, textoSeguro(datos.referencia || ""),
    textoSeguro(motivo), "", "", ESTADO_SIN_CODIGO + " (recarga manual en la pestaña " + HOJA_SIN_CODIGO + ")"]);
  SpreadsheetApp.flush();
  return responder({ status: "success", pines: [], manual: true });
}

function hojaSinCodigo() {
  var hoja = obtenerHoja(HOJA_SIN_CODIGO, true);
  if (!hoja) {
    hoja = SpreadsheetApp.getActiveSpreadsheet().insertSheet(HOJA_SIN_CODIGO, 0);
    hoja.appendRow(COLUMNAS_SIN_CODIGO);
    hoja.getRange(1, 1, 1, COLUMNAS_SIN_CODIGO.length).setFontWeight("bold");
    hoja.setFrozenRows(1);
  }
  return hoja;
}

// "manual" | "bot" | "api" (ver PROPIEDAD_MODO_RECARGA)
function modoRecarga() {
  var modo = PropertiesService.getScriptProperties().getProperty(PROPIEDAD_MODO_RECARGA);
  return modo === "automatico" ? "bot" : modo === "api" ? "api" : "manual";
}

function activarModoManual() { cambiarModoRecarga("manual"); }
function activarModoAutomatico() { cambiarModoRecarga("automatico"); }
function activarModoApi() { cambiarModoRecarga("api"); }
function verModoRecarga() { cambiarModoRecarga(null); }

function cambiarModoRecarga(modo) {
  if (modo) PropertiesService.getScriptProperties().setProperty(PROPIEDAD_MODO_RECARGA, modo);
  var textos = {
    manual: "🖐️ MODO MANUAL: todos los pedidos van a la pestaña \"" + HOJA_SIN_CODIGO + "\" para que los hagas tú. No se usan los pines.",
    bot: "⚡ MODO BOT: se usan los pines de \"codigos\" y los canjea el bot. Solo van a \"" + HOJA_SIN_CODIGO + "\" los paquetes sin pines.",
    api: "🛒 MODO API: cada pedido se envía a FazerCards y queda en la pestaña \"" + HOJA_FAZER + "\" con su estado en tiempo real. " +
      "Los paquetes sin oferta de FazerCards van a \"" + HOJA_SIN_CODIGO + "\"."
  };
  SpreadsheetApp.getUi().alert("Recargas de Free Fire", textos[modoRecarga()], SpreadsheetApp.getUi().ButtonSet.OK);
}

// Modo API: anota el pedido en "fazer_card" (todavía sin orden) y responde { api: true }; Vercel
// envía la orden y registrar_finalizado anota su número. Corre dentro del candado.
function pasarAFazer(datos, idPedido) {
  var fechaHora = ahora();
  hojaFazer().appendRow([
    fechaHora,
    textoSeguro(datos.idJugador),
    textoSeguro(datos.paquete || (String(datos.diamantes || "") + " diamantes")),
    textoSeguro(datos.ofertaFazer),
    textoSeguro(datos.referencia || ""),
    limpiarMontoVES(datos.montoCobrado),
    textoSeguro(datos.comprobante || "Sin comprobante"),
    textoSeguro(datos.codigoDescuento || ""),
    idPedido,
    "",
    "📤 POR ENVIAR",
    fechaHora,
    ""
  ]);
  hojaAsignaciones().appendRow([fechaHora, idPedido, textoSeguro(datos.referencia || ""),
    textoSeguro("oferta " + datos.ofertaFazer), "", "", ESTADO_API + " - POR ENVIAR (pestaña " + HOJA_FAZER + ")"]);
  SpreadsheetApp.flush();
  return responder({ status: "success", pines: [], api: true });
}

function hojaFazer() {
  var hoja = obtenerHoja(HOJA_FAZER, true);
  if (!hoja) {
    hoja = SpreadsheetApp.getActiveSpreadsheet().insertSheet(HOJA_FAZER, 0);
    hoja.appendRow(COLUMNAS_FAZER);
    hoja.getRange(1, 1, 1, COLUMNAS_FAZER.length).setFontWeight("bold");
    hoja.setFrozenRows(1);
  }
  return hoja;
}

// Fila (la más reciente) de "fazer_card" cuyo valor en esa columna es exactamente ese (9 = id pedido,
// 10 = orden). TextFinder: la pestaña no para de crecer y esto corre dentro del candado.
function buscarFilaFazer(columna, valor) {
  var hoja = obtenerHoja(HOJA_FAZER, true);
  if (!valor || !hoja || hoja.getLastRow() < 2) return 0;
  var celdas = hoja.getRange(2, columna, hoja.getLastRow() - 1, 1)
    .createTextFinder(String(valor)).matchEntireCell(true).matchCase(true).findAll();
  return celdas.length ? celdas[celdas.length - 1].getRow() : 0;
}

// cambios: { orden, estado, detalle } (los que falten no se tocan). L = momento del cambio.
function actualizarFilaFazer(fila, cambios) {
  var hoja = hojaFazer();
  if (cambios.orden !== undefined) hoja.getRange(fila, 10).setValue(textoSeguro(cambios.orden));
  if (cambios.estado !== undefined) hoja.getRange(fila, 11).setValue(textoSeguro(cambios.estado));
  if (cambios.detalle !== undefined) hoja.getRange(fila, 13).setValue(textoSeguro(cambios.detalle));
  hoja.getRange(fila, 12).setValue(ahora());
}

function textoEstadoFazer(estado) {
  var e = String(estado || "").toLowerCase();
  return (TEXTO_ESTADO_FAZER[e] || "❔ " + e.toUpperCase()) + " (" + e + ")";
}

// registrar_finalizado de un pedido por API: la orden que aceptó FazerCards queda en su fila. Si son
// varias ("ord1,ord2": 220 = dos de 110), cada una en su propia fila para que el webhook la siga.
// Si el webhook avisó antes de este momento, se aplica ahora ese estado.
function anotarOrdenFazer(idPedido, orden, estado) {
  var fila = buscarFilaFazer(9, idPedido);
  if (!fila) return;
  var ordenes = String(orden || "").split(",").filter(function (o) { return o; });
  if (!ordenes.length) ordenes = [""];
  if (ordenes[0] && buscarFilaFazer(10, ordenes[0])) return; // reintento de registrar_finalizado: ya está
  var hoja = hojaFazer();
  var base = hoja.getRange(fila, 1, 1, COLUMNAS_FAZER.length).getValues()[0]
    .map(function (x) { return typeof x === "string" ? textoSeguro(x) : x; });
  var filas = [fila];
  for (var n = 1; n < ordenes.length; n++) {
    hoja.appendRow(base);
    filas.push(hoja.getLastRow());
  }
  var cache = CacheService.getScriptCache();
  ordenes.forEach(function (o, i) {
    actualizarFilaFazer(filas[i], { orden: o, estado: textoEstadoFazer(estado || "processing"),
      detalle: ordenes.length > 1 ? "orden " + (i + 1) + " de " + ordenes.length + " aceptada por FazerCards" : "orden aceptada por FazerCards" });
    var guardado = o && cache.get("fazer_" + o);
    if (guardado) {
      var aviso = JSON.parse(guardado);
      aplicarEstadoFazer(filas[i], aviso.estado, aviso.evento);
      cache.remove("fazer_" + o);
    }
  });
}

// Webhook de FazerCards (acción estado_fazer, con candado): nuevo estado de una orden.
// Se puede repetir: el mismo estado dos veces no cambia nada.
function estadoFazer(datos) {
  var orden = String(datos.ordenFazer || "");
  var estado = String(datos.estado || "").toLowerCase();
  if (!OFERTA_FAZER_VALIDA.test(orden) || !/^[a-z_]{1,30}$/.test(estado)) {
    return responder({ status: "error", message: "Datos de FazerCards inválidos" });
  }
  var fila = buscarFilaFazer(10, orden);
  if (!fila) {
    // La orden aún no se anotó (el aviso llegó antes que registrar_finalizado) o es de otro juego
    // (Blood Strike usa la misma cuenta): se guarda unas horas por si aparece
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
  var valores = hojaFazer().getRange(fila, 1, 1, COLUMNAS_FAZER.length).getValues()[0];
  var anterior = String(valores[10]);
  var texto = textoEstadoFazer(estado);
  if (anterior === texto) return;
  var fallo = estado === "failed" || estado.indexOf("refund") === 0;
  if (fallo && !/FALLIDA|REEMBOLSADA/.test(anterior)) {
    var motivo = "FazerCards marcó la orden " + valores[9] + " como " + estado + ": la recarga NO llegó al jugador";
    registrarError({
      idJugador: valores[1], paquete: valores[2], referencia: valores[4], idPedido: valores[8], comprobante: valores[6],
      fase: "4. RECARGA DE FREE FIRE EN LA API DEL PROVEEDOR (FazerCards) - aviso posterior del webhook",
      motivo: motivo,
      estadoPines: "NO APLICA: recarga directa por API, sin pines",
      estadoPago: "USADO: hacer la recarga a mano o devolver el pago",
      urlImagen: motivo + " | JUGADOR: " + valores[1] + " | PAQUETE: " + valores[2] + " | REFERENCIA: " + valores[4] + " | PEDIDO: " + valores[8]
    });
  }
  actualizarFilaFazer(fila, { estado: texto, detalle: "aviso " + String(evento || "de FazerCards") + (fallo ? " - anotado en errores" : "") });
}

// Devuelve al inventario los pines de un pedido (el bot nunca los recibió o no los procesó)
function devolverCodigos(datos) {
  var idPedido = String(datos.idPedido || "");
  if (!idPedido) return responder({ status: "error", message: "Falta idPedido" });

  var asignacion = buscarAsignacion(idPedido);
  if (!asignacion) {
    // obtener_codigo nunca llegó a sacar pines para este pedido
    return responder({ status: "success", pines: [], sinAsignacion: true });
  }
  // Pedido en "sin_codigo": la fila se queda (el pago se bloquea, así que hay que hacerla a mano)
  if (asignacion.estado.indexOf(ESTADO_SIN_CODIGO) === 0) return responder({ status: "success", pines: [], manual: true });
  // Pedido por API sin pines: si la orden no llegó a enviarse, queda "NO ENVIADA" para hacerla a mano
  if (asignacion.estado.indexOf(ESTADO_API) === 0) {
    if (asignacion.estado.indexOf("POR ENVIAR") !== -1) {
      hojaAsignaciones().getRange(asignacion.fila, 7).setValue(textoSeguro(ESTADO_API + " - NO ENVIADA " + ahora() + " - " + String(datos.motivo || "sin motivo")));
      var filaFazer = buscarFilaFazer(9, idPedido);
      if (filaFazer) actualizarFilaFazer(filaFazer, { estado: "🚫 NO ENVIADA: hacer a mano", detalle: String(datos.motivo || "") });
      SpreadsheetApp.flush();
    }
    return responder({ status: "success", pines: [], api: true });
  }
  if (asignacion.estado.indexOf("ANULADO") === 0) return responder({ status: "success", pines: [] }); // idempotente (pedidos viejos)
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

  var fechaHora = ahora();
  hojaAsignaciones().getRange(asignacion.fila, 7).setValue(
    textoSeguro("DEVUELTOS AL INVENTARIO " + fechaHora + " - " + String(datos.motivo || "sin motivo")));
  SpreadsheetApp.flush();
  return responder({ status: "success", pines: asignacion.pines });
}

function hojaAsignaciones() {
  return hojaConTitulos(HOJA_ASIGNACIONES, COLUMNAS_ASIGNACIONES);
}

// Busca la asignación de pines (la más reciente) de un pedido. TextFinder sobre la columna B: corre
// dentro del candado en obtener_codigo, registrar_finalizado y registrar_error, y la pestaña no para de
// crecer (antes se leía entera en cada pedido; en modo API eso hacía que obtener_codigo pasara de 15 s).
function buscarAsignacion(idPedido) {
  var hoja = obtenerHoja(HOJA_ASIGNACIONES, true);
  if (!idPedido || !hoja || hoja.getLastRow() < 2) return null;
  var celdas = hoja.getRange(2, 2, hoja.getLastRow() - 1, 1)
    .createTextFinder(idPedido).matchEntireCell(true).matchCase(true).findAll();
  if (!celdas.length) return null;
  var fila = celdas[celdas.length - 1].getRow();
  var v = hoja.getRange(fila, 1, 1, COLUMNAS_ASIGNACIONES.length).getValues()[0];
  return {
    fila: fila,
    columna: Number(v[4]),
    pines: String(v[5] || "").split(" | ").filter(function (p) { return p; }),
    estado: String(v[6] || "")
  };
}

// Recarga exitosa: fila en "finalizados", pines como USADOS y uso del código de descuento
function registrarFinalizado(datos) {
  // Vercel repite el cierre en segundo plano si no recibió la respuesta: el mismo pedido no se anota dos veces
  var idPedido = String(datos.idPedido || "");
  if (idPedido && CacheService.getScriptCache().get("fin_" + idPedido)) {
    return responder({ status: "success", repetido: true, message: "Este pedido ya estaba en finalizados" });
  }
  // Si falta la pestaña se crea (antes un error aquí hacía fallar el cierre de TODAS las recargas)
  var hojaFinalizados = hojaConTitulos("finalizados", COLUMNAS_FINALIZADOS);
  var fechaHora = ahora();
  hojaFinalizados.appendRow([
    fechaHora,                                           // A
    textoSeguro(datos.idJugador),                        // B
    textoSeguro(datos.paquete),                          // C
    textoSeguro(datos.referencias || datos.referencia),  // D
    textoSeguro(datos.codigosUsados || "No especificado"), // E
    textoSeguro(datos.urlImagen || "Sin comprobante")    // F
  ]);
  SpreadsheetApp.flush();
  // La fila ya está: desde aquí un reintento de Vercel NO la vuelve a anotar, aunque falle un paso de abajo
  if (idPedido) CacheService.getScriptCache().put("fin_" + idPedido, "1", 21600);

  // Pasos secundarios: cada uno por separado; si uno falla se anota el motivo y la recarga sigue en "finalizados"
  var fallos = [];
  var paso = function (nombre, funcion) {
    try {
      funcion();
    } catch (err) {
      console.error("registrar_finalizado (" + idPedido + "): falló " + nombre + ": " + (err && err.stack || err));
      fallos.push(nombre + ": " + String(err && err.message || err).slice(0, 120));
    }
  };
  var asignacion = null;
  paso("asignaciones_pines", function () {
    asignacion = buscarAsignacion(idPedido);
    // Auditoría: los pines de este pedido quedan como usados
    if (asignacion && asignacion.estado.indexOf("ASIGNADOS") === 0) {
      hojaAsignaciones().getRange(asignacion.fila, 7).setValue("USADOS (recarga finalizada " + fechaHora + ")");
    }
    if (asignacion && asignacion.estado.indexOf(ESTADO_API) === 0) {
      hojaAsignaciones().getRange(asignacion.fila, 7).setValue(
        textoSeguro(ESTADO_API + " - ENVIADA (orden " + (datos.ordenFazer || "sin id") + ", " + fechaHora + ")"));
    }
  });
  // Modo API: la orden de FazerCards y su estado quedan en "fazer_card"
  if (datos.ordenFazer) {
    paso("fazer_card", function () { anotarOrdenFazer(idPedido, String(datos.ordenFazer), datos.estadoFazer); });
  }
  // Pedido que completó un pago insuficiente: su fila de "por_completar" queda cerrada
  paso("por_completar", function () { cerrarComplemento(idPedido, "✅ COMPLETADO Y RECARGADO"); });
  // Código de descuento usado en esta recarga: +1 uso y el monto cobrado en la pestaña "Descuentos"
  if (datos.codigoDescuento) {
    paso("descuentos", function () { sumarUsoDescuento(datos.codigoDescuento, datos.montoCobrado, "Free Fire", idPedido, datos.idJugador); });
  }
  // Lo que falló queda a la vista en "errores" (la recarga sí está en "finalizados")
  if (fallos.length) {
    paso("aviso en errores", function () {
      registrarError({
        idJugador: datos.idJugador, paquete: datos.paquete, referencia: datos.referencias || datos.referencia,
        idPedido: idPedido, comprobante: datos.urlImagen,
        fase: "5. CIERRE (registrar_finalizado): la recarga SÍ está en finalizados",
        motivo: "Faltó completar: " + fallos.join(" | "),
        estadoPines: "NO APLICA", estadoPago: "sin cambios",
        urlImagen: "Revisar a mano: " + fallos.join(" | ")
      });
    });
  }
  SpreadsheetApp.flush();
  // (Se quitó la llamada a /api/sincronizar-pedidos: ese endpoint no existe en la tienda
  //  y la petición alargaba el candado en cada recarga.)
  return responder({ status: "success", message: "Guardado en finalizados correctamente", fallos: fallos });
}

// Fallo del bot o de FazerCards: fila en "errores" con los pines del pedido. NO cambia el estado del pago.
function registrarError(datos) {
  // Si la pestaña no existe se crea (antes, sin ella los pines del error se perdían en silencio)
  var hojaErrores = hojaConTitulos("errores", COLUMNAS_ERRORES);
  if (!String(hojaErrores.getRange(1, 6).getValue() || "").trim()) {
    // Pestaña antigua de 5 columnas: se agregan los títulos de las columnas nuevas (F-L)
    hojaErrores.getRange(1, 6, 1, COLUMNAS_ERRORES.length - 5).setValues([COLUMNAS_ERRORES.slice(5)]);
  }

  // Pines que el sistema asignó a este pedido, según la pestaña de auditoría
  var asignacion = buscarAsignacion(String(datos.idPedido || ""));
  var pinesAsignados = asignacion
    ? asignacion.pines.join(" | ") + " (estado: " + asignacion.estado + ")"
    : (datos.idPedido ? "ninguno: no salieron pines del inventario para este pedido" : "");

  var fechaHora = ahora();
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
  // Modo API: la fila del pedido en "fazer_card" muestra que hubo un error
  var filaFazer = buscarFilaFazer(9, String(datos.idPedido || ""));
  if (filaFazer) actualizarFilaFazer(filaFazer, { estado: "❌ ERROR (ver pestaña errores)", detalle: datos.motivo || "" });
  cerrarComplemento(String(datos.idPedido || ""), "❌ ERROR: ver pestaña errores (pagos ya \"Usado\")");
  SpreadsheetApp.flush();

  // YA NO cambia el estado del pago. Antes lo devolvía a "Verificado", y si Vercel marcaba
  // "Usado" al mismo tiempo, el pago podía quedar libre para usarse otra vez tras un fallo
  // del bot (con pines quizá ya canjeados). Vercel decide el estado final después de
  // registrar el error: siempre marcar_usado (un pago nunca vuelve a "Verificado").
  return responder({ status: "success", message: "Error guardado correctamente y códigos respaldados" });
}

// Comprobante de pago a la carpeta de Drive
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


// =====================================================================
// 5. RULETA (el giro lo guarda Vercel en Firestore "GirosRuleta"; aquí solo se lee y se anota)
// =====================================================================

// Sin candado: devuelve los pagos "Usado" (recarga completada) cuya referencia coincide, del más
// reciente al más antiguo, con el jugador y paquete de "finalizados" si aparecen.
// La columna F de "pagos" es la marca de la ruleta anterior ("listo"/"usado"): esos pagos
// ya giraron con el sistema viejo y se informan como ruletaAnterior.
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

// Anota un ganador en la pestaña "ruleta" (solo para entregar el premio)
function registrarPremioRuleta(datos) {
  var hoja = hojaConTitulos(HOJA_RULETA, COLUMNAS_RULETA);
  var fechaHora = ahora();
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


// =====================================================================
// 6. DESCUENTOS Y CREADORES (pestaña "Descuentos", común a Free Fire, Blood Strike y Roblox)
//    A: código | B: descuento en % (solo promos; los de creador dan siempre PORCENTAJE_CREADOR)
//    C: usos | D: dinero movido (Bs) | E: creador (vacío = promo normal) | F: PIN del panel
//    G: % actual del creador (lo escribe el script) | H: comisión total (USD)
//    I: liquidado (Bs, referencia) | J: pendiente (USD) | K: sin uso | L: por convertir (Bs)
//
//    H y J son SALDOS: cada venta les suma SU comisión (% y tasa de ese día) y Registrar pago
//    deja J en 0. Nunca se recalculan desde D; si corriges uno a mano, ese valor queda.
//    El precio con descuento lo calcula Vercel; aquí solo se lee el código y se anotan los usos
//    (Free Fire dentro de registrar_finalizado; los demás juegos con registrar_uso_descuento).
// =====================================================================

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
    var fechaHora = ahora();
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
  props.setProperty("saldos_por_venta", ahora());
  SpreadsheetApp.flush();
  console.log("Comisión por venta activada: saldos iniciales de H y J guardados con la tasa " + tasa);
}

// G = % actual del creador (lo que ganará en sus PRÓXIMAS ventas; no cambia lo ya ganado)
function escribirPorcentajeCreador(hoja, fila) {
  hoja.getRange(fila.numero, 7).setValue(porcentajeCreador(fila) / 100).setNumberFormat("0.00%");
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

function hojaMovimientosDescuentos() {
  var hoja = hojaConTitulos(HOJA_MOVIMIENTOS_DESCUENTOS, COLUMNAS_MOVIMIENTOS_DESCUENTOS);
  if (!String(hoja.getRange(1, 9).getValue() || "").trim()) {
    // Pestaña anterior al cambio: D pasa a ser "id jugador" e I guarda el id del pedido
    hoja.getRange(1, 4).setValue(COLUMNAS_MOVIMIENTOS_DESCUENTOS[3]);
    hoja.getRange(1, 9).setValue(COLUMNAS_MOVIMIENTOS_DESCUENTOS[8]);
  }
  return hoja;
}

// Si la hoja no tiene tantas columnas, las agrega al final
function asegurarColumnas(hoja, cantidad) {
  if (hoja.getMaxColumns() < cantidad) hoja.insertColumnsAfter(hoja.getMaxColumns(), cantidad - hoja.getMaxColumns());
}

// --- Panel de creadores (sin candado: solo lectura) ---
// El creador consulta con su código y su PIN (columna F, se lo das tú por WhatsApp).
// Sin PIN configurado no se muestran datos: el código es público, sus ganancias no.
// Total = columna H, pendiente = columna J.
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

// --- Tasa del dólar (config!B1) ---
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

// --- Acciones del menú ⭐ Creadores ---

// Actualiza G (% actual) y pasa a USD lo que quedó en L. H y J NO se recalculan.
// Se ejecuta al cambiar la tasa o B-E de "Descuentos" (onEdit), cada hora si activas el
// recálculo automático, o desde el menú.
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

// Una sola vez por porcentaje (propiedad "retroactivo_<%>"): recalcula cada venta de
// "movimientos_descuentos" con el % actual y la tasa DE ESA VENTA (sin tasa guardada: la de hoy),
// corrige F-H de cada movimiento y deja en cada creador:
//   H = suma de todas sus ventas + ventas de D que no están en movimientos (a la tasa de hoy)
//   J = H - lo ya pagado ("pagos_creadores"), nunca negativo. L queda vacía (ya está incluida).
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
    props.setProperty(clave, ahora());
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  console.log("Ventas anteriores al " + PORCENTAJE_CREADOR + " %:\n" + resumen.join("\n"));
  ui.alert("Listo: ventas anteriores al " + PORCENTAJE_CREADOR + " %", resumen.join("\n") || "No hay creadores.", ui.ButtonSet.OK);
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
    var hojaPagos = hojaConTitulos(HOJA_PAGOS_CREADORES, COLUMNAS_PAGOS_CREADORES);
    var fechaHora = ahora();
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


// =====================================================================
// 7. MENÚS Y DISPARADORES DE LA HOJA
// =====================================================================

// Menús "🖐️ Recargas Free Fire" y "⭐ Creadores" (aparecen al abrir la hoja)
function onOpen() {
  SpreadsheetApp.getUi().createMenu("🖐️ Recargas Free Fire")
    .addItem("🖐️ Todas manuales (pestaña sin_codigo)", "activarModoManual")
    .addItem("⚡ Bot con códigos de canjeo (pines)", "activarModoAutomatico")
    .addItem("🛒 API de FazerCards (pestaña fazer_card)", "activarModoApi")
    .addSeparator()
    .addItem("❓ Ver modo actual", "verModoRecarga")
    .addItem("🧹 Marcar como Usado los pagos ya finalizados", "marcarUsadosLosFinalizados")
    .addSeparator()
    .addItem("🩺 Diagnóstico de la hoja (qué la hace lenta)", "diagnosticarHoja")
    .addItem("✂️ Quitar filas y columnas vacías", "quitarFilasYColumnasVacias")
    .addItem("🗄️ Archivar filas antiguas (" + DIAS_PARA_ARCHIVAR + " días)", "archivarFilasAntiguas")
    .addItem("🚚 Copiar datos desde la hoja vieja (mudanza)", "copiarDesdeHojaVieja")
    .addToUi();
  SpreadsheetApp.getUi().createMenu("⭐ Creadores")
    .addItem("💵 Registrar pago del creador seleccionado", "registrarPagoCreador")
    .addItem("🔄 Actualizar % de comisión", "recalcularComisiones")
    .addItem("♻️ Pasar ventas anteriores al % actual", "pasarVentasAnterioresAlPorcentaje")
    .addSeparator()
    .addItem("⏰ Activar recálculo automático cada hora", "activarRecalculoHorario")
    .addToUi();
}

// Disparador simple: se ejecuta solo cuando TÚ editas a mano la tasa (config!B1) o B-E de "Descuentos"
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


// --- Mantenimiento (menú "🖐️ Recargas Free Fire"): la hoja se vuelve lenta al crecer ---
// Cada operación de Vercel corre con el candado: si la hoja tarda, todas las demás esperan y agotan
// su tiempo. Estas tres acciones la aligeran sin tocar pagos ni pedidos pendientes.

// Qué se archiva: filas con más de DIAS_PARA_ARCHIVAR días (columna A) que ya están cerradas.
// Lo pendiente (pagos sin usar, pines asignados, órdenes en proceso, recargas manuales sin hacer,
// premios sin entregar, pagos por completar) se queda siempre.
const DIAS_PARA_ARCHIVAR = 30;
const REGLAS_ARCHIVO = {
  pagos: function (f) { return String(f[4]).trim().toLowerCase() === "usado"; },
  asignaciones_pines: function (f) { return !/^ASIGNADOS|POR ENVIAR/.test(String(f[6])); },
  finalizados: function () { return true; },
  errores: function () { return true; },
  fazer_card: function (f) { return !/EN PROCESO|POR ENVIAR/.test(String(f[10])); },
  sin_codigo: function (f) { return f[8] === true; },
  ruleta: function (f) { return String(f[5]).trim().toUpperCase() !== "PENDIENTE"; },
  por_completar: function (f) { return !/^PENDIENTE|COMPLETO: entregando/.test(String(f[10])); },
  movimientos_descuentos: function () { return true; }
};

// Muestra el tamaño de cada pestaña, el total de celdas (límite de Google: 10 millones) y los activadores
function diagnosticarHoja() {
  var libro = SpreadsheetApp.getActiveSpreadsheet();
  var total = 0;
  var pestanas = libro.getSheets().map(function (h) {
    var celdas = h.getMaxRows() * h.getMaxColumns();
    total += celdas;
    return { celdas: celdas, texto: h.getName() + ": " + Math.max(0, h.getLastRow() - 1) + " filas con datos, " +
      celdas + " celdas, " + h.getConditionalFormatRules().length + " reglas de formato condicional" };
  }).sort(function (a, b) { return b.celdas - a.celdas; });
  var activadores = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction() + " (" + t.getEventType() + ")"; });
  var texto = "Total: " + total + " celdas de 10.000.000 permitidas.\n\n" +
    pestanas.map(function (p) { return p.texto; }).join("\n") +
    "\n\nActivadores: " + (activadores.length ? activadores.join(", ") : "ninguno") +
    "\n\nMás de 5.000 filas en pagos, asignaciones_pines o finalizados: usa 🗄️ Archivar. Muchas celdas y pocas filas: usa ✂️ Quitar vacías. Activadores repetidos: bórralos en Apps Script > Activadores.";
  console.log(texto);
  SpreadsheetApp.getUi().alert("Diagnóstico de la hoja", texto, SpreadsheetApp.getUi().ButtonSet.OK);
}

// Borra las filas vacías del final de cada pestaña (deja 50 de reserva) y las columnas vacías
// de la derecha (deja 2). Las celdas vacías también pesan y cuentan para el límite.
function quitarFilasYColumnasVacias() {
  var ui = SpreadsheetApp.getUi();
  if (ui.alert("Quitar filas y columnas vacías", "Se borran solo filas y columnas SIN datos al final de cada pestaña. ¿Continuar?", ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { ui.alert("El sistema está procesando una recarga. Intenta de nuevo en unos segundos."); return; }
  var antes = 0, despues = 0;
  try {
    SpreadsheetApp.getActiveSpreadsheet().getSheets().forEach(function (h) {
      antes += h.getMaxRows() * h.getMaxColumns();
      var ultimaFila = Math.max(h.getLastRow(), h.getFrozenRows() + 1);
      var filasDeMas = h.getMaxRows() - ultimaFila - 50;
      if (filasDeMas > 0) h.deleteRows(ultimaFila + 51, filasDeMas);
      var ultimaColumna = Math.max(h.getLastColumn(), h.getFrozenColumns() + 1);
      var columnasDeMas = h.getMaxColumns() - ultimaColumna - 2;
      if (columnasDeMas > 0) h.deleteColumns(ultimaColumna + 3, columnasDeMas);
      despues += h.getMaxRows() * h.getMaxColumns();
    });
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  ui.alert("Listo: de " + antes + " a " + despues + " celdas.");
}

// Copia el archivo como respaldo y mueve a un archivo NUEVO de tu Drive las filas cerradas con más
// de DIAS_PARA_ARCHIVAR días (ver REGLAS_ARCHIVO). Con el candado: las recargas esperan mientras corre,
// así que úsalo cuando haya pocas ventas. Las filas se borran por bloques (no se reescribe la pestaña:
// las fórmulas, formatos y casillas de las filas que se quedan no cambian).
function archivarFilasAntiguas() {
  var ui = SpreadsheetApp.getUi();
  var aviso = "1) Se guarda una copia completa de este archivo como respaldo.\n" +
    "2) Las filas con más de " + DIAS_PARA_ARCHIVAR + " días ya cerradas (pagos Usado, finalizados, errores, órdenes terminadas...) " +
    "pasan a un archivo nuevo en tu Drive.\n\nLo pendiente NO se toca. Las recargas esperan mientras corre: hazlo cuando haya pocas ventas.\n\n¿Continuar?";
  if (ui.alert("Archivar filas antiguas", aviso, ui.ButtonSet.YES_NO) !== ui.Button.YES) return;

  var libro = SpreadsheetApp.getActiveSpreadsheet();
  var fecha = Utilities.formatDate(new Date(), "America/Caracas", "yyyy-MM-dd HH.mm");
  DriveApp.getFileById(libro.getId()).makeCopy("RESPALDO " + libro.getName() + " " + fecha);

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { ui.alert("El sistema está procesando una recarga. Intenta de nuevo en unos segundos."); return; }
  var limite = Date.now() - DIAS_PARA_ARCHIVAR * 24 * 3600 * 1000;
  var archivo = null;
  var resumen = [];
  try {
    Object.keys(REGLAS_ARCHIVO).forEach(function (nombre) {
      var hoja = obtenerHoja(nombre, true);
      if (!hoja || hoja.getLastRow() < 2) return;
      var columnas = hoja.getLastColumn();
      var filas = hoja.getRange(2, 1, hoja.getLastRow() - 1, columnas).getValues();
      var mover = [];
      for (var i = 0; i < filas.length; i++) {
        var momento = momentoDeFila(filas[i][0]);
        if (momento && momento < limite && REGLAS_ARCHIVO[nombre](filas[i])) mover.push(i);
      }
      if (!mover.length) return;

      if (!archivo) archivo = SpreadsheetApp.create("ARCHIVO " + libro.getName() + " hasta " + fecha);
      var destino = archivo.insertSheet(hoja.getName());
      destino.getRange(1, 1, 1, columnas).setValues(hoja.getRange(1, 1, 1, columnas).getValues());
      destino.getRange(2, 1, mover.length, columnas).setValues(mover.map(function (i) {
        return filas[i].map(function (v) { return typeof v === "string" ? textoSeguro(v) : v; });
      }));
      SpreadsheetApp.flush();

      // Google no deja borrar todas las filas sin inmovilizar: si se vacía la pestaña, queda una fila en blanco
      if (hoja.getMaxRows() - Math.max(hoja.getFrozenRows(), 1) <= mover.length) hoja.insertRowsAfter(hoja.getMaxRows(), 1);
      // De abajo hacia arriba, un bloque de filas seguidas a la vez
      for (var k = mover.length - 1; k >= 0; k--) {
        var fin = mover[k], inicio = fin;
        while (k > 0 && mover[k - 1] === inicio - 1) { k--; inicio--; }
        hoja.deleteRows(inicio + 2, fin - inicio + 1);
      }
      resumen.push(hoja.getName() + ": " + mover.length + " filas");
    });
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  if (!archivo) { ui.alert("No hay filas cerradas con más de " + DIAS_PARA_ARCHIVAR + " días."); return; }
  var vacia = archivo.getSheets()[0];
  if (archivo.getSheets().length > 1 && vacia.getLastRow() === 0) archivo.deleteSheet(vacia);
  console.log("Archivado en " + archivo.getUrl() + ": " + resumen.join(", "));
  ui.alert("Listo", "Movidas al archivo \"" + archivo.getName() + "\" (en tu Drive):\n\n" + resumen.join("\n") +
    "\n\nRespaldo completo: \"RESPALDO " + libro.getName() + " " + fecha + "\".", ui.ButtonSet.OK);
}

// Momento (ms) de la columna A: fecha de la hoja o texto "dd/MM/yyyy HH:mm:ss". 0 si no se entiende
// (esa fila no se archiva).
function momentoDeFila(valor) {
  if (valor instanceof Date) return valor.getTime();
  var m = String(valor || "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1])).getTime() : 0;
}


// --- Mudanza a una hoja nueva (menú "🖐️ Recargas Free Fire" > 🚚, se ejecuta EN LA HOJA NUEVA) ---
// Copia desde la hoja vieja solo valores y formatos (sin fórmulas, formato condicional ni filas vacías):
// completas las pestañas de PESTANAS_COMPLETAS y las que el script no conoce; de las de REGLAS_ARCHIVO,
// lo pendiente y lo de los últimos DIAS_PARA_ARCHIVAR días. Se puede repetir: una pestaña que ya tiene
// datos no se toca, salvo "pagos", que solo recibe los pagos nuevos y el estado que avanzó en la vieja.
const PESTANAS_COMPLETAS = ["precios", "codigos", "descuentos", "config", "pagos_creadores", "movimientos_descuentos"];

function copiarDesdeHojaVieja() {
  var ui = SpreadsheetApp.getUi();
  var libro = SpreadsheetApp.getActiveSpreadsheet();
  var pedido = ui.prompt("Copiar desde la hoja vieja",
    "Pega el enlace (o el ID) de la hoja VIEJA.\n\nSe copian completos: precios, códigos, descuentos, config y creadores. " +
    "De pagos, pedidos y registros: lo pendiente y lo de los últimos " + DIAS_PARA_ARCHIVAR + " días.\n" +
    "Se puede repetir: la segunda vez solo trae los pagos nuevos y actualiza su estado.", ui.ButtonSet.OK_CANCEL);
  if (pedido.getSelectedButton() !== ui.Button.OK) return;
  var texto = pedido.getResponseText().trim();
  var enlace = texto.match(/\/d\/([A-Za-z0-9_-]{20,})/);
  var id = enlace ? enlace[1] : texto;
  if (!/^[A-Za-z0-9_-]{20,}$/.test(id) || id === libro.getId()) { ui.alert("Ese no es el enlace de la hoja vieja."); return; }
  var vieja;
  try {
    vieja = SpreadsheetApp.openById(id);
  } catch (err) {
    ui.alert("No se pudo abrir la hoja vieja: " + err.message);
    return;
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { ui.alert("El sistema está procesando una recarga. Intenta de nuevo en unos segundos."); return; }
  var limite = Date.now() - DIAS_PARA_ARCHIVAR * 24 * 3600 * 1000;
  var resumen = [];
  try {
    vieja.getSheets().forEach(function (origen) {
      var nombre = origen.getName();
      var clave = nombre.trim().toLowerCase();
      var columnas = origen.getLastColumn();
      var ultima = origen.getLastRow();
      if (!columnas || !ultima) return;
      var rango = origen.getRange(1, 1, ultima, columnas);
      var valores = rango.getValues();
      var formatos = rango.getNumberFormats();
      var regla = PESTANAS_COMPLETAS.indexOf(clave) === -1 ? REGLAS_ARCHIVO[clave] : null;
      var elegidas = [];
      for (var i = 1; i < valores.length; i++) {
        if (regla) {
          var momento = momentoDeFila(valores[i][0]);
          if (momento && momento < limite && regla(valores[i])) continue; // cerrada y vieja: se queda en la hoja vieja
        }
        elegidas.push(i);
      }

      var destino = libro.getSheetByName(nombre);
      if (destino && destino.getLastRow() > 1) {
        resumen.push(nombre + ": " + (clave === "pagos" ? sincronizarPagos(destino, valores, formatos, elegidas) : "ya tenía datos, no se tocó"));
        return;
      }
      if (!destino) destino = libro.insertSheet(nombre);
      var filas = [0].concat(elegidas); // 0 = títulos
      escribirFilasCopiadas(destino, 1, filas, valores, formatos);
      destino.setFrozenRows(1);
      destino.getRange(1, 1, 1, columnas).setFontWeight("bold");
      if (clave === HOJA_SIN_CODIGO && filas.length > 1) {
        destino.getRange(2, COLUMNAS_SIN_CODIGO.length, filas.length - 1, 1)
          .setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build());
      }
      resumen.push(nombre + ": " + elegidas.length + " filas");
    });

    // Los saldos H y J de los creadores vienen copiados: que nunca se vuelvan a calcular desde cero
    var props = PropertiesService.getScriptProperties();
    if (!props.getProperty("saldos_por_venta")) props.setProperty("saldos_por_venta", "copiado de la hoja vieja " + ahora());
    var claveRetroactivo = "retroactivo_" + PORCENTAJE_CREADOR;
    if (!props.getProperty(claveRetroactivo)) props.setProperty(claveRetroactivo, "copiado de la hoja vieja " + ahora());
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  leerTasaUsd();
  // La pestaña vacía que trae un archivo nuevo ("Hoja 1")
  libro.getSheets().forEach(function (h) {
    if (!vieja.getSheetByName(h.getName()) && h.getLastRow() === 0 && libro.getSheets().length > 1) libro.deleteSheet(h);
  });
  ui.alert("Copia terminada", resumen.join("\n") +
    "\n\nAhora: elige el modo en este menú, crea TOKEN_VERCEL y MACRODROID_CLAVE en las propiedades del script y cambia las URL e ID (ver los pasos).",
    ui.ButtonSet.OK);
}

// Escribe las filas `filas` (índices de valores) desde la fila `desde` del destino, con sus formatos
function escribirFilasCopiadas(destino, desde, filas, valores, formatos) {
  var columnas = valores[0].length;
  asegurarColumnas(destino, columnas);
  var hasta = desde + filas.length - 1;
  if (destino.getMaxRows() < hasta) destino.insertRowsAfter(destino.getMaxRows(), hasta - destino.getMaxRows());
  var celdas = destino.getRange(desde, 1, filas.length, columnas);
  celdas.setNumberFormats(filas.map(function (i) { return formatos[i]; }));
  celdas.setValues(filas.map(function (i) {
    return valores[i].map(function (v) { return typeof v === "string" ? textoSeguro(v) : v; });
  }));
}

// Segunda copia de "pagos": agrega los que no están y pasa al estado de la hoja vieja los que avanzaron
// allí. Un pago nunca retrocede: "Usado" en la hoja nueva no se toca.
function sincronizarPagos(destino, valores, formatos, elegidas) {
  var ultima = destino.getLastRow();
  var actuales = destino.getRange(2, 3, ultima - 1, 3).getValues(); // C referencia .. E estado
  var filaDe = {};
  actuales.forEach(function (f, i) {
    var ref = String(f[0]).replace(/\s+/g, "");
    if (ref) filaDe[ref] = i + 2;
  });
  var nuevas = [];
  var cambiados = 0;
  elegidas.forEach(function (i) {
    var ref = String(valores[i][2]).replace(/\s+/g, "");
    if (!ref) return;
    var fila = filaDe[ref];
    if (!fila) { nuevas.push(i); return; }
    var estadoViejo = String(valores[i][4]).trim();
    var estadoNuevo = String(actuales[fila - 2][2]).trim().toLowerCase();
    if (estadoViejo.toLowerCase() === estadoNuevo || estadoNuevo === "usado") return;
    if (estadoViejo.toLowerCase() === "usado" || estadoNuevo === "" || estadoNuevo === "verificado") {
      destino.getRange(fila, 5).setValue(estadoViejo);
      cambiados++;
    }
  });
  if (nuevas.length) escribirFilasCopiadas(destino, ultima + 1, nuevas, valores, formatos);
  return nuevas.length + " pagos nuevos, " + cambiados + " estados actualizados";
}


// =====================================================================
// 8. UTILIDADES
// =====================================================================

function responder(objeto) {
  return ContentService.createTextOutput(JSON.stringify(objeto)).setMimeType(ContentService.MimeType.JSON);
}

// Fecha y hora de Venezuela con el formato de todas las pestañas
function ahora() {
  return Utilities.formatDate(new Date(), "America/Caracas", "dd/MM/yyyy HH:mm:ss");
}

// Acepta "pagos" o "Pagos". Con opcional=true devuelve null si no existe.
function obtenerHoja(nombre, opcional) {
  var libro = SpreadsheetApp.getActiveSpreadsheet();
  var hoja = libro.getSheetByName(nombre) || libro.getSheetByName(nombre.charAt(0).toUpperCase() + nombre.slice(1));
  if (!hoja && !opcional) throw new Error("Falta la pestaña '" + nombre + "'");
  return hoja;
}

// La pestaña con ese nombre; si no existe, la crea con su fila de títulos
function hojaConTitulos(nombre, columnas) {
  var hoja = obtenerHoja(nombre, true);
  if (!hoja) {
    hoja = SpreadsheetApp.getActiveSpreadsheet().insertSheet(nombre);
    hoja.appendRow(columnas);
  }
  return hoja;
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

// Texto que se escribe en la hoja: si empieza como fórmula (= + - @) se guarda como texto
function textoSeguro(valor) {
  var texto = String(valor === undefined || valor === null ? "" : valor).slice(0, 3000);
  return /^[=+\-@]/.test(texto) ? "'" + texto : texto;
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

// 1.234,50 (montos en Bs como se escriben en Venezuela)
function formatoBs(n) {
  var partes = Number(n).toFixed(2).split(".");
  return partes[0].replace(/\B(?=(\d{3})+(?!\d))/g, ".") + "," + partes[1];
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

function forzarPermisos() {
  UrlFetchApp.fetch("https://www.google.com");
  Logger.log("Permisos concedidos con éxito");
}
