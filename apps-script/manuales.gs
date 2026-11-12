// =====================================================================
// LEVEL UP - Apps Script de RECARGAS MANUALES: FC Mobile, COD Mobile y Clash Royale
// (variable SCRIPT_MANUALES en Vercel, cuando esté la página)
//
// El cliente elige el paquete, paga igual que en el resto de la tienda y deja sus datos de inicio de
// sesión y su WhatsApp. El pedido llega de una vez a la pestaña de su juego y la recarga se hace A MANO.
// Cualquier problema (código de verificación, clave errada, pago incompleto) se resuelve por WhatsApp.
//
// Va en una hoja de cálculo NUEVA. Pestañas (el menú 🎮 → 🧱 las crea todas):
//   Precios FC Mobile · Precios COD Mobile · Precios Clash Royale
//       columna A = títulos · desde la B: fila 1 = paquete ("105 de oro") · fila 2 = precio en DÓLARES (1,50)
//       · fila 3 = precio en Bs (fórmula: dólares × tasa de la pestaña "dolar"; no se escribe a mano)
//       Un paquete sin precio no se vende (no aparece en la página).
//   dolar        B1 = precio del dólar en Bs (menú 🎮 → 💲). Sin él no se vende nada.
//   FC Mobile · COD Mobile · Clash Royale
//       un pedido por fila: paquete, pago, inicio de sesión, correo, contraseña, WhatsApp y estado
// Los PAGOS se leen de la hoja central (ID_HOJA_PAGOS, la de Free Fire), igual que los demás juegos.
//
// Secciones:  1 Configuración · 2 Entrada (doGet / doPost) · 3 Precios · 4 Pedidos y pagos
//             5 Utilidades · 6 Menú
//
// Cómo publicarlo la PRIMERA vez: Implementar > Nueva implementación > Aplicación web > Ejecutar como: yo,
// Acceso: cualquier usuario. La URL /exec irá en SCRIPT_MANUALES (Vercel).
// Cómo actualizarlo después: Implementar > Gestionar implementaciones > editar (lápiz) > Versión: "Nueva
// versión" > Implementar. Así la URL /exec NO cambia.
//
// Seguridad:
//   - Propiedad del script TOKEN_VERCEL = el mismo valor que SCRIPT_RECARGAS_TOKEN en Vercel. Sin ella el
//     script responde "No autorizado" a todo lo que llegue por POST (leer precios por GET es público).
//   - Esta hoja guarda CONTRASEÑAS de clientes: no la compartas con nadie que no haga recargas. Al terminar
//     un pedido, márcalo ✅ COMPLETADO y usa 🎮 → 🧹 para borrar las contraseñas de los completados.
//
// Reglas:
//   - El precio sale SIEMPRE de esta hoja (nunca del cliente).
//   - Un pago encontrado pasa a "Usado" al registrar el pedido, aunque no alcance: el pedido queda
//     "⚠️ PAGO INCOMPLETO" y se completa por WhatsApp.
//   - registrar_pedido se puede repetir con el mismo idPedido (Vercel lo hace si no recibió la respuesta):
//     no duplica la fila ni toma otro pago.
// =====================================================================


// =====================================================================
// 1. CONFIGURACIÓN
// =====================================================================

const PROJECT_ID = "levelupstore-87d4d";
const COLLECTION_NAME = "Pagos";
const ID_HOJA_PAGOS = "1FTjXo7sKybYVmyGO9HBlyla0T2LHBfCB8yHEV70JyOA"; // Hoja central de pagos (la de Free Fire)

// Versión que la tienda lee en obtener_precios
const VERSION_SCRIPT = 1;

// Vercel espera hasta 15 s por intento: si el candado tarda más, mejor responder "ocupado"
const ESPERA_CANDADO_MS = 8000;
const MENSAJE_ERROR_INTERNO = "Error interno en el sistema de recargas. Intenta de nuevo en unos segundos.";

// Margen para pagos que llegan con céntimos de menos (igual que los otros juegos)
const MARGEN_PAGO_BS = 0.50;

// Formas de iniciar sesión. "clave": pide contraseña · "telefono": acepta número de teléfono en vez de correo
const METODOS = {
  ea: { nombre: "Cuenta EA", clave: true, telefono: false },
  facebook: { nombre: "Facebook", clave: true, telefono: true },
  activision: { nombre: "Activision", clave: true, telefono: false },
  google: { nombre: "Google", clave: true, telefono: false },
  // Supercell ID no usa contraseña: entra con un código que llega al correo del cliente (se pide por WhatsApp)
  supercell: { nombre: "Supercell ID (correo con código)", clave: false, telefono: false }
};

// Cada juego: su pestaña de pedidos, su pestaña de precios, cómo se inicia sesión y paquetes de ejemplo
// (solo se escriben al crear la pestaña de precios; sin precio no se venden)
const JUEGOS = {
  fcmobile: {
    nombre: "FC Mobile", hojaPedidos: "FC Mobile", hojaPrecios: "Precios FC Mobile",
    metodos: ["ea", "facebook"], ejemplos: ["40 FC Points", "100 FC Points", "520 FC Points"]
  },
  codmobile: {
    nombre: "COD Mobile", hojaPedidos: "COD Mobile", hojaPrecios: "Precios COD Mobile",
    metodos: ["activision", "facebook", "google"], ejemplos: ["80 CP", "420 CP", "880 CP"]
  },
  clashroyale: {
    nombre: "Clash Royale", hojaPedidos: "Clash Royale", hojaPrecios: "Precios Clash Royale",
    metodos: ["supercell"], ejemplos: ["80 Gemas", "500 Gemas", "1200 Gemas"]
  }
};

// Pestañas de pedidos (una por juego, todas con las mismas columnas)
const COLUMNAS_PEDIDOS = ["fecha-hora", "id pedido", "paquete", "precio (Bs)", "pagado (Bs)", "referencia",
  "inicio de sesión", "correo / usuario", "contraseña", "WhatsApp", "estado", "nota", "comprobante"];
const COL_ID_PEDIDO = 2, COL_CLAVE = 9, COL_ESTADO = 11;
const ESTADOS = ["⏳ PENDIENTE", "🔄 EN PROCESO", "✅ COMPLETADO", "⚠️ PAGO INCOMPLETO", "❌ PROBLEMA"];
const COLOR_ESTADO = { "⏳ PENDIENTE": "#fff4c2", "🔄 EN PROCESO": "#cfe2ff", "✅ COMPLETADO": "#d1f2d9",
  "⚠️ PAGO INCOMPLETO": "#ffe0b3", "❌ PROBLEMA": "#f8d0d0" };
const CLAVE_BORRADA = "(borrada)";

// Pestaña de precios: fila 1 paquete · fila 2 precio en USD · fila 3 precio en Bs (fórmula), desde la
// columna B (la A lleva los títulos). El precio que se cobra lo calcula SIEMPRE este código (USD × dólar).
const COLUMNA_PRIMER_PAQUETE = 2;
// Pestaña "dolar": B1 = precio del dólar en Bs
const HOJA_DOLAR = "dolar";
const MAX_PAQUETES = 30;

// Límites de los datos del cliente
const MAX_USUARIO = 100;
const MAX_CLAVE = 100;


// =====================================================================
// 2. ENTRADA
// =====================================================================

// GET: solo los precios (públicos; la tienda los pide así para evitar redirecciones de POST)
function doGet(e) {
  var accion = (e && e.parameter && e.parameter.accion) ? e.parameter.accion : "";
  if (accion === "obtener_precios") return responder(obtenerPrecios());
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

  // Solo Vercel
  if (!tokenVercelValido(datos)) return responder({ status: "error", message: "No autorizado" });

  try {
    if (accion === "obtener_precios") return responder(obtenerPrecios());
    // Toca pagos: una a la vez
    if (accion === "registrar_pedido") return conCandado(function () { return registrarPedido(datos); });
    return responder({ status: "error", message: "Acción no válida" });
  } catch (error) {
    console.error("Error en acción " + accion + ": " + (error && error.stack || error));
    return responder({ status: "error", message: MENSAJE_ERROR_INTERNO });
  }
}

// 🛡️ Candado: una sola operación sobre pagos a la vez
function conCandado(operacion) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(ESPERA_CANDADO_MS)) {
    return responder({ status: "error", ocupado: true, message: "⚠️ Sistema ocupado procesando otra transacción. Por favor, intenta de nuevo en unos segundos." });
  }
  try {
    return responder(operacion());
  } catch (error) {
    console.error("Error dentro del candado: " + (error && error.stack || error));
    return responder({ status: "error", message: MENSAJE_ERROR_INTERNO });
  } finally {
    lock.releaseLock();
  }
}


// =====================================================================
// 3. PRECIOS
// =====================================================================

// { status, version, juegos: { fcmobile: { nombre, metodos: [{ id, nombre, clave, telefono }], catalogo: [{ paquete, precio }] } } }
// precio = Bs ("1.250,50"): el cliente solo ve Bs; los dólares se quedan en la hoja. Sin precio del dólar, los catálogos van vacíos.
function obtenerPrecios() {
  var tasa = precioDolar();
  var juegos = {};
  Object.keys(JUEGOS).forEach(function (id) {
    var juego = JUEGOS[id];
    juegos[id] = {
      nombre: juego.nombre,
      metodos: juego.metodos.map(function (m) {
        return { id: m, nombre: METODOS[m].nombre, clave: METODOS[m].clave, telefono: METODOS[m].telefono };
      }),
      catalogo: catalogoDe(juego, tasa).map(function (p) { return { paquete: p.paquete, precio: formatoBs(p.precio) }; })
    };
  });
  return { status: "success", version: VERSION_SCRIPT, juegos: juegos };
}

// Paquetes con precio de la pestaña de precios del juego: [{ paquete, usd, precio (Bs) }] (números).
// tasa: precio del dólar en Bs (si no se pasa, se lee de la pestaña "dolar").
function catalogoDe(juego, tasa) {
  if (tasa === undefined) tasa = precioDolar();
  if (!(tasa > 0)) return [];
  var hoja = obtenerHojaLocal(juego.hojaPrecios);
  if (!hoja || hoja.getLastColumn() < COLUMNA_PRIMER_PAQUETE) return [];
  var columnas = hoja.getLastColumn() - COLUMNA_PRIMER_PAQUETE + 1;
  var filas = hoja.getRange(1, COLUMNA_PRIMER_PAQUETE, 2, columnas).getValues();
  var paquetes = [], vistos = {};
  for (var i = 0; i < columnas && paquetes.length < MAX_PAQUETES; i++) {
    var paquete = String(filas[0][i] || "").trim();
    var usd = limpiarMontoVES(filas[1][i]);
    // Sin precio no se vende (se cobraría 0); un nombre repetido, solo el primero
    if (!paquete || !(usd > 0) || vistos[paquete.toLowerCase()]) continue;
    vistos[paquete.toLowerCase()] = true;
    paquetes.push({ paquete: paquete, usd: redondear2(usd), precio: redondear2(usd * tasa) });
  }
  return paquetes;
}

// Precio del dólar en Bs (pestaña "dolar", B1); 0 si falta
function precioDolar() {
  var hoja = obtenerHojaLocal(HOJA_DOLAR);
  return hoja ? limpiarMontoVES(hoja.getRange("B1").getValue()) : 0;
}


// =====================================================================
// 4. PEDIDOS Y PAGOS (hoja central, pestaña "pagos": A fecha · B teléfono · C referencia · D monto · E estado)
//    Estados del pago: Verificado -> Usado. Nunca vuelve a "Verificado".
// =====================================================================

// Vercel (con candado). datos: { juego, paquete, referencia (últimos 5), metodo, usuario, clave, telefono, idPedido, comprobante }
// Respuesta: { status: "success", registrado: true, insuficiente, precio, pagado, falta, repetido }
//         o  { status: "success", registrado: false, message }  (no se tocó ningún pago)
function registrarPedido(datos) {
  var rechazo = function (mensaje) { return { status: "success", registrado: false, message: mensaje }; };

  var idPedido = String(datos.idPedido || "");
  if (!/^[A-Za-z0-9-]{8,64}$/.test(idPedido)) return { status: "error", message: "Falta idPedido" };
  var idJuego = String(datos.juego || "");
  if (!JUEGOS.hasOwnProperty(idJuego)) return rechazo("Juego no válido.");
  var juego = JUEGOS[idJuego];

  // Reintento de Vercel: el pedido ya está anotado, se responde lo mismo sin tocar nada
  var hoja = hojaPedidos(juego);
  var filaPrevia = buscarFila(hoja, COL_ID_PEDIDO, idPedido);
  if (filaPrevia) return respuestaDeFila(hoja, filaPrevia, true);

  // Paquete y precio: de la hoja, nunca del cliente
  var nombrePaquete = String(datos.paquete || "").trim().toLowerCase();
  var paquete = catalogoDe(juego).filter(function (p) { return p.paquete.toLowerCase() === nombrePaquete; })[0];
  if (!paquete) return rechazo("Ese paquete ya no está disponible. Recarga la página y elige de nuevo.");
  // Si el dólar cambió mientras el cliente pagaba, se cobra el precio nuevo: lo que falte queda como
  // ⚠️ PAGO INCOMPLETO y se resuelve por WhatsApp (MARGEN_PAGO_BS cubre los céntimos)

  var idMetodo = String(datos.metodo || "");
  if (juego.metodos.indexOf(idMetodo) === -1) return rechazo("Elige cómo inicias sesión en " + juego.nombre + ".");
  var metodo = METODOS[idMetodo];

  var usuario = String(datos.usuario || "").trim();
  var esCorreo = usuario.length <= MAX_USUARIO && /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(usuario);
  var esTelefono = metodo.telefono && /^\+?\d{7,15}$/.test(usuario.replace(/[\s-]/g, ""));
  if (!esCorreo && !esTelefono) {
    return rechazo(metodo.telefono ? "Escribe el correo o el teléfono de tu cuenta de " + metodo.nombre + "." : "Escribe un correo válido de tu cuenta de " + metodo.nombre + ".");
  }
  if (esTelefono && !esCorreo) usuario = usuario.replace(/[\s-]/g, "");

  // La contraseña se guarda tal cual (sin recortar espacios): solo se limita el largo
  var clave = metodo.clave ? String(datos.clave || "") : "";
  if (metodo.clave && (!clave || clave.length > MAX_CLAVE)) return rechazo("Escribe la contraseña de tu cuenta de " + metodo.nombre + ".");

  var whatsapp = enlaceWhatsapp(datos.telefono);
  if (!whatsapp) return rechazo("Escribe un número de WhatsApp venezolano válido (ej. 0414-1234567): por ahí te escribimos si algo falla.");

  var ultimos5 = String(datos.referencia || "").replace(/\s+/g, "");
  if (!/^\d{5}$/.test(ultimos5)) return rechazo("🔍 La referencia debe tener exactamente 5 dígitos.");

  var pago = tomarPago(ultimos5, idPedido);
  if (!pago.encontrado) return rechazo(pago.message);

  var insuficiente = pago.montoPagado < paquete.precio - MARGEN_PAGO_BS;
  var falta = insuficiente ? redondear2(paquete.precio - pago.montoPagado) : 0;
  hoja.appendRow([
    ahora(), idPedido, textoSeguro(paquete.paquete), paquete.precio, pago.montoPagado, textoSeguro(pago.referencia),
    metodo.nombre, textoSeguro(usuario), textoSeguro(clave), whatsapp,
    insuficiente ? "⚠️ PAGO INCOMPLETO" : "⏳ PENDIENTE",
    insuficiente ? "Faltan " + formatoBs(falta) + " Bs: escribir al cliente" : (metodo.clave ? "" : "Pedir por WhatsApp el código que llega al correo"),
    textoSeguro(datos.comprobante || "Sin comprobante")
  ]);
  SpreadsheetApp.flush();
  PropertiesService.getScriptProperties().deleteProperty("man_" + pago.referencia);
  return { status: "success", registrado: true, repetido: false, insuficiente: insuficiente,
    precio: formatoBs(paquete.precio), pagado: formatoBs(pago.montoPagado), falta: formatoBs(falta) };
}

// Respuesta de un pedido ya anotado (reintento con el mismo idPedido)
function respuestaDeFila(hoja, fila, repetido) {
  var v = hoja.getRange(fila, 1, 1, COLUMNAS_PEDIDOS.length).getValues()[0];
  var precio = limpiarMontoVES(v[3]), pagado = limpiarMontoVES(v[4]);
  var insuficiente = pagado < precio - MARGEN_PAGO_BS;
  return { status: "success", registrado: true, repetido: repetido, insuficiente: insuficiente,
    precio: formatoBs(precio), pagado: formatoBs(pagado), falta: formatoBs(insuficiente ? redondear2(precio - pagado) : 0) };
}

// Busca el pago "Verificado" más reciente con esos últimos 5 dígitos y lo deja "Usado" para este pedido.
// Antes de marcarlo se anota man_<referencia> = idPedido: si algo falla antes de escribir la fila del
// pedido, el reintento (mismo idPedido) reconoce el pago como suyo y no lo da por gastado.
// Devuelve { encontrado, referencia, montoPagado } o { encontrado: false, message }.
function tomarPago(ultimos5, idPedido) {
  var hojaPagos = hojaCentralPagos();
  var rows = hojaPagos.getDataRange().getValues();
  var props = PropertiesService.getScriptProperties();
  var hayUsado = false, hayEnProceso = false, hayPorCompletar = false;

  for (var i = rows.length - 1; i >= 1; i--) {
    var referencia = String(rows[i][2]).replace(/\s+/g, "");
    if (!referencia || referencia.slice(-5) !== ultimos5) continue;
    var encontrado = { encontrado: true, referencia: referencia, montoPagado: redondear2(limpiarMontoVES(rows[i][3])) };

    var estado = String(rows[i][4]).trim().toLowerCase();
    if (estado === "usado" || estado === "usada") {
      if (props.getProperty("man_" + referencia) === idPedido) return encontrado; // lo tomó este mismo pedido
      hayUsado = true; continue;
    }
    if (estado === "en proceso") { hayEnProceso = true; continue; }
    if (estado === "por completar") { hayPorCompletar = true; continue; }
    if (estado !== "verificado" && estado !== "") continue;

    props.setProperty("man_" + referencia, idPedido);
    hojaPagos.getRange(i + 1, 5).setValue("Usado");
    anotarHoraUsado(hojaPagos, i + 1);
    SpreadsheetApp.flush();
    actualizarEstadoFirebase(referencia, "Usado");
    return encontrado;
  }

  if (hayEnProceso) return { encontrado: false, message: "⚠️ Otro cliente está procesando esta referencia en este momento." };
  if (hayPorCompletar) return { encontrado: false, message: "⏳ Este pago está esperando que completes la diferencia en otro pedido: escríbenos por WhatsApp." };
  if (hayUsado) return { encontrado: false, message: "❌ Este pago ya fue validado y gastado." };
  return { encontrado: false, message: "🔍 Referencia no encontrada en el sistema. Si acabas de pagar, espera un minuto e intenta de nuevo." };
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
    if (respuesta.getResponseCode() >= 300) console.error("Firebase respondió " + respuesta.getResponseCode() + " para " + docId);
  } catch (err) {
    console.error("No se pudo actualizar Firebase para " + referencia + ": " + err);
  }
}


// =====================================================================
// 5. UTILIDADES
// =====================================================================

function responder(objeto) {
  return ContentService.createTextOutput(JSON.stringify(objeto)).setMimeType(ContentService.MimeType.JSON);
}

// Columna G de "pagos": fecha y hora en que el pago pasó a "Usado" (como texto, para que Sheets no
// voltee el día y el mes)
const COLUMNA_HORA_USADO = 7;
function anotarHoraUsado(hoja, fila) {
  hoja.getRange(fila, COLUMNA_HORA_USADO).setNumberFormat("@").setValue(ahora());
}

// Fecha y hora de Venezuela con el formato de todas las pestañas
function ahora() {
  return Utilities.formatDate(new Date(), "America/Caracas", "dd/MM/yyyy HH:mm:ss");
}

function obtenerHojaLocal(nombre) {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(nombre);
}

// WhatsApp del cliente: acepta 0414-1234567, 414 1234567, +58 414… En la hoja queda como enlace
// https://wa.me/58… (un toque abre el chat). Cualquier otra cosa: "".
function enlaceWhatsapp(telefono) {
  var d = String(telefono || "").replace(/\D/g, "");
  if (/^04\d{9}$/.test(d)) d = "58" + d.slice(1);
  else if (/^4\d{9}$/.test(d)) d = "58" + d;
  return /^584\d{9}$/.test(d) ? "https://wa.me/" + d : "";
}

// Pestaña de pedidos del juego (se crea con títulos, lista de estados y colores si falta)
function hojaPedidos(juego) {
  var hoja = obtenerHojaLocal(juego.hojaPedidos);
  if (hoja) return hoja;
  hoja = SpreadsheetApp.getActiveSpreadsheet().insertSheet(juego.hojaPedidos);
  hoja.appendRow(COLUMNAS_PEDIDOS);
  hoja.getRange(1, 1, 1, COLUMNAS_PEDIDOS.length).setFontWeight("bold").setBackground("#1f2937").setFontColor("#ffffff");
  hoja.setFrozenRows(1);
  hoja.getRange(2, 4, hoja.getMaxRows() - 1, 2).setNumberFormat("#,##0.00");
  // Referencia, correo/usuario y contraseña como texto: "001234" no pierde los ceros ni se vuelve número
  hoja.getRange(2, 6, hoja.getMaxRows() - 1, 1).setNumberFormat("@");
  hoja.getRange(2, 8, hoja.getMaxRows() - 1, 2).setNumberFormat("@");
  // Estado: lista desplegable (se puede escribir otra cosa) y un color por estado
  var columnaEstado = hoja.getRange(2, COL_ESTADO, hoja.getMaxRows() - 1, 1);
  columnaEstado.setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(ESTADOS, true).setAllowInvalid(true).build());
  hoja.setConditionalFormatRules(ESTADOS.map(function (estado) {
    return SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(estado).setBackground(COLOR_ESTADO[estado]).setRanges([columnaEstado]).build();
  }));
  hoja.setColumnWidth(COL_ESTADO, 170);
  hoja.setColumnWidth(COLUMNAS_PEDIDOS.length, 260);
  return hoja;
}

// Fila (la más reciente) de esa pestaña con ese valor exacto en esa columna, o 0
function buscarFila(hoja, columna, valor) {
  if (!valor || hoja.getLastRow() < 2) return 0;
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

// Token de Vercel OBLIGATORIO: la propiedad del script TOKEN_VERCEL debe existir y coincidir con
// SCRIPT_RECARGAS_TOKEN de Vercel. Sin la propiedad, el script no atiende a nadie por POST.
function tokenVercelValido(datos) {
  var esperado = PropertiesService.getScriptProperties().getProperty("TOKEN_VERCEL");
  if (!esperado) {
    console.error("Falta la propiedad del script TOKEN_VERCEL: se rechazan todas las peticiones");
    return false;
  }
  return mismoTexto(String((datos && datos.token) || ""), esperado);
}

// Compara sin cortar en la primera diferencia (no revela por el tiempo cuántos caracteres acertó)
function mismoTexto(a, b) {
  if (a.length !== b.length) return false;
  var diferencia = 0;
  for (var i = 0; i < a.length; i++) diferencia |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diferencia === 0;
}


// =====================================================================
// 6. MENÚ
//    🧱 crea las pestañas de precios y de pedidos de los 3 juegos (no borra nada que ya exista)
//    🧹 borra las contraseñas de los pedidos ✅ COMPLETADO
// =====================================================================

function onOpen() {
  SpreadsheetApp.getUi().createMenu("🎮 Recargas manuales")
    .addItem("🧱 Crear hojas y precios", "crearHojasYPrecios")
    .addItem("💲 Cambiar precio del dólar", "cambiarPrecioDolar")
    .addItem("🧹 Borrar contraseñas de pedidos completados", "borrarClavesCompletados")
    .addToUi();
}

function crearHojasYPrecios() {
  var creadas = [];
  if (!obtenerHojaLocal(HOJA_DOLAR)) { hojaDolar(); creadas.push(HOJA_DOLAR); }
  Object.keys(JUEGOS).forEach(function (id) {
    var juego = JUEGOS[id];
    if (!obtenerHojaLocal(juego.hojaPrecios)) { crearHojaPrecios(juego); creadas.push(juego.hojaPrecios); }
    if (!obtenerHojaLocal(juego.hojaPedidos)) { hojaPedidos(juego); creadas.push(juego.hojaPedidos); }
  });
  // La pestaña vacía "Hoja 1" de una hoja nueva sobra
  var libro = SpreadsheetApp.getActiveSpreadsheet();
  ["Hoja 1", "Sheet1"].forEach(function (nombre) {
    var vacia = libro.getSheetByName(nombre);
    if (vacia && libro.getSheets().length > 1 && vacia.getLastRow() === 0) libro.deleteSheet(vacia);
  });
  SpreadsheetApp.flush();
  SpreadsheetApp.getUi().alert(creadas.length
    ? "✅ Pestañas creadas: " + creadas.join(", ") + ".\n\n1) Menú 🎮 → 💲 Cambiar precio del dólar.\n2) En cada pestaña de precios escribe el paquete en la fila 1 (ej. \"105 de oro\") y su precio en DÓLARES justo debajo, en la fila 2 (ej. 1,50). La fila 3 calcula sola el precio en Bs. Un paquete sin precio no aparece en la página."
    : "Todas las pestañas ya existían: no se cambió nada.");
}

// Columna A = títulos · desde la B: fila 1 paquete, fila 2 precio USD, fila 3 precio Bs (fórmula)
// (los ejemplos van sin precio)
function crearHojaPrecios(juego) {
  var hoja = SpreadsheetApp.getActiveSpreadsheet().insertSheet(juego.hojaPrecios);
  hoja.getRange("A1:A3").setValues([["Paquete →"], ["Precio USD →"], ["Precio Bs →"]]).setFontWeight("bold").setBackground("#1f2937").setFontColor("#ffffff");
  hoja.getRange(1, COLUMNA_PRIMER_PAQUETE, 1, juego.ejemplos.length).setValues([juego.ejemplos]);
  hoja.getRange(1, COLUMNA_PRIMER_PAQUETE, 1, MAX_PAQUETES).setFontWeight("bold");
  hoja.getRange(2, COLUMNA_PRIMER_PAQUETE, 1, MAX_PAQUETES).setNumberFormat("\"$\"#,##0.00");
  // Fila 3: Bs = USD (fila 2) × dólar ('dolar'!B1), en notación R1C1 (Apps Script las escribe en inglés,
  // con comas, sea cual sea el idioma de la hoja). Solo para que veas el precio: el cobro lo calcula el código.
  var tasa = "'" + HOJA_DOLAR + "'!R1C2";
  var formula = "=IF(OR(R[-1]C=\"\"," + tasa + "=\"\"),\"\",ROUND(R[-1]C*" + tasa + ",2))";
  var formulas = [];
  for (var i = 0; i < MAX_PAQUETES; i++) formulas.push(formula);
  hoja.getRange(3, COLUMNA_PRIMER_PAQUETE, 1, MAX_PAQUETES).setFormulasR1C1([formulas])
    .setNumberFormat("#,##0.00\" Bs\"").setFontColor("#666666").setBackground("#f3f4f6");
  hoja.setFrozenColumns(1);
  hoja.setColumnWidth(1, 110);
  hoja.getRange("A1").setNote("Fila 1: nombre del paquete tal como lo verá el cliente. Fila 2: precio en DÓLARES. " +
    "Fila 3: precio en Bs (se calcula solo con el dólar de la pestaña \"" + HOJA_DOLAR + "\"; no la toques). " +
    "Sin precio, el paquete no se vende. Para quitar uno, borra su columna. Máximo " + MAX_PAQUETES + " paquetes.");
  hoja.getRange("A5").setValue("Métodos de inicio de sesión de " + juego.nombre + ": " +
    juego.metodos.map(function (m) { return METODOS[m].nombre; }).join(", ")).setFontColor("#888888");
  return hoja;
}

// Pestaña "dolar": A1 título · B1 precio del dólar en Bs
function hojaDolar() {
  var hoja = obtenerHojaLocal(HOJA_DOLAR);
  if (hoja) return hoja;
  hoja = SpreadsheetApp.getActiveSpreadsheet().insertSheet(HOJA_DOLAR, 0);
  hoja.getRange("A1").setValue("Precio del dólar (Bs) →").setFontWeight("bold").setBackground("#1f2937").setFontColor("#ffffff");
  hoja.getRange("B1").setNumberFormat("#,##0.00").setFontWeight("bold").setBackground("#fff4c2");
  hoja.getRange("A3").setValue("Cámbialo aquí en B1 o con el menú 🎮 → 💲. Todos los precios en Bs se recalculan solos. Sin precio del dólar no se vende nada.")
    .setFontColor("#888888");
  hoja.setColumnWidth(1, 190);
  return hoja;
}

function cambiarPrecioDolar() {
  var ui = SpreadsheetApp.getUi();
  var hoja = hojaDolar();
  var actual = precioDolar();
  var respuesta = ui.prompt("Precio del dólar", "Precio actual: " + (actual > 0 ? formatoBs(actual) + " Bs" : "sin precio") +
    "\n\nEscribe el nuevo precio en Bs (ej. 236,50):", ui.ButtonSet.OK_CANCEL);
  if (respuesta.getSelectedButton() !== ui.Button.OK) return;
  var nuevo = limpiarMontoVES(respuesta.getResponseText());
  if (!(nuevo > 0)) { ui.alert("Ese precio no es válido. No se cambió nada."); return; }
  hoja.getRange("B1").setValue(redondear2(nuevo));
  SpreadsheetApp.flush();
  ui.alert("✅ Dólar a " + formatoBs(nuevo) + " Bs. Los precios en Bs de los 3 juegos ya están recalculados.");
}

function borrarClavesCompletados() {
  var ui = SpreadsheetApp.getUi();
  var seguir = ui.alert("Borrar contraseñas",
    "Se borra la contraseña de cada pedido con estado ✅ COMPLETADO en las pestañas de los 3 juegos. ¿Seguir?",
    ui.ButtonSet.YES_NO);
  if (seguir !== ui.Button.YES) return;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { ui.alert("Hay un pedido entrando en este momento: intenta de nuevo en unos segundos."); return; }
  var borradas = 0;
  try {
    Object.keys(JUEGOS).forEach(function (id) {
      var hoja = obtenerHojaLocal(JUEGOS[id].hojaPedidos);
      if (!hoja || hoja.getLastRow() < 2) return;
      var rango = hoja.getRange(2, COL_CLAVE, hoja.getLastRow() - 1, COL_ESTADO - COL_CLAVE + 1);
      var valores = rango.getValues();
      var claves = valores.map(function (fila) {
        var completado = String(fila[COL_ESTADO - COL_CLAVE]).indexOf("COMPLETADO") !== -1;
        if (completado && fila[0] !== "" && fila[0] !== CLAVE_BORRADA) { borradas++; return [CLAVE_BORRADA]; }
        return [fila[0]];
      });
      hoja.getRange(2, COL_CLAVE, claves.length, 1).setValues(claves);
    });
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  ui.alert("✅ Contraseñas borradas: " + borradas + ".");
}
