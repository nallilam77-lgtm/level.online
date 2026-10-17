// =====================================================================
// LEVEL UP - Apps Script de la RULETA (variable SCRIPT_RULETA_URL en Vercel). Usado por api/ruleta.js.
//
// Cómo actualizarlo: pega este archivo en el proyecto de Apps Script de la ruleta y luego
// Implementar > Gestionar implementaciones > editar (lápiz) > Versión: "Nueva versión" > Implementar.
// Así la URL /exec NO cambia y no hay que tocar Vercel.
//
// Qué hace: Vercel decide el premio y pide "girar". Este script busca el pago en la hoja de pagos
// (C: referencia, E: estado, F: marca de la ruleta), comprueba que sea una recarga completada
// ("Usado") que todavía no giró, escribe "listo" en F y anota el premio en la primera pestaña
// del libro donde está instalado este script.
//
// Seguridad (Configuración del proyecto > Propiedades del script), opcional:
//   TOKEN_VERCEL = el mismo valor que SCRIPT_RECARGAS_TOKEN en Vercel. Sin él, cualquiera que
//   conociera la URL /exec podría anotarse un premio. Mientras no exista, no se comprueba.
//
// Reintentos: si la misma referencia y el mismo jugador vuelven a pedir el giro (Vercel reintenta
// cuando Google falla o tarda), se devuelve el premio ya anotado. Nunca se gira dos veces y el
// cliente no pierde su giro por un fallo de red.
// =====================================================================

var ID_HOJA_PAGOS = "1FTjXo7sKybYVmyGO9HBlyla0T2LHBfCB8yHEV70JyOA";

// Vercel espera hasta 12 s por intento: si otro giro tarda más en soltar el candado, se responde
// "ocupado" (Vercel reintenta) en vez de trabajar para una petición que ya nadie espera.
var ESPERA_CANDADO_MS = 8000;

function doPost(e) {
  try {
    var datos = JSON.parse((e && e.postData && e.postData.contents) || "{}");

    var token = PropertiesService.getScriptProperties().getProperty("TOKEN_VERCEL");
    if (token && String(datos.token || "") !== token) {
      return responder({ status: "error", message: "No autorizado" });
    }

    var referencia = String(datos.referencia || "").replace(/\s+/g, "");
    var idJugador = String(datos.id_jugador || "").trim();
    var premio = String(datos.premio || "").trim();
    var juego = String(datos.juego || "Free Fire").trim();
    if (!/^\d{5}$/.test(referencia) || !idJugador || !premio) {
      return responder({ status: "error", message: "Faltan datos para la ruleta." });
    }

    // Candado: dos peticiones con la misma referencia no pueden girar a la vez
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(ESPERA_CANDADO_MS)) {
      return responder({ status: "error", ocupado: true, message: "La ruleta está ocupada. Intenta de nuevo en unos segundos." });
    }
    try {
      return responder(girar(referencia, idJugador, premio, juego));
    } finally {
      lock.releaseLock();
    }
  } catch (error) {
    console.error("Error en la ruleta: " + (error && error.stack || error));
    return responder({ status: "error", message: "Error interno de la ruleta. Intenta de nuevo en unos segundos." });
  }
}

function girar(ultimos5, idJugador, premio, juego) {
  var libroPagos = SpreadsheetApp.openById(ID_HOJA_PAGOS);
  var hojaPagos = libroPagos.getSheetByName("pagos") || libroPagos.getSheetByName("Pagos");
  if (!hojaPagos) {
    console.error("Ruleta: no existe la pestaña 'pagos' en la hoja " + ID_HOJA_PAGOS);
    return { status: "error", message: "La ruleta no está disponible en este momento." };
  }

  // De abajo hacia arriba: el pago "Usado" más reciente con esos 5 dígitos que todavía no giró.
  // Solo coincidencia exacta de los últimos 5 dígitos (como verificar_pago en recargas.gs).
  var rows = hojaPagos.getDataRange().getValues();
  var referenciaQueYaGiro = "";
  var hayPagoSinRecarga = false;
  for (var r = rows.length - 1; r >= 1; r--) {
    var referenciaCompleta = String(rows[r][2]).replace(/\s+/g, "");
    if (!referenciaCompleta || referenciaCompleta.slice(-5) !== ultimos5) continue;

    // Solo pagos con la recarga completada: antes giraba cualquier pago, aunque no se hubiera usado
    if (String(rows[r][4]).trim().toLowerCase() !== "usado") { hayPagoSinRecarga = true; continue; }

    var marca = String(rows[r][5]).trim().toLowerCase();
    if (marca === "listo" || marca === "usado") {
      if (!referenciaQueYaGiro) referenciaQueYaGiro = referenciaCompleta;
      continue;
    }

    hojaPagos.getRange(r + 1, 6).setValue("listo");
    SpreadsheetApp.flush();
    var fechaHora = Utilities.formatDate(new Date(), "America/Caracas", "dd/MM/yyyy HH:mm:ss");
    hojaPremios().appendRow([fechaHora, textoSeguro(idJugador), referenciaCompleta, textoSeguro(juego), textoSeguro(premio)]);
    SpreadsheetApp.flush();
    return { status: "success", premio: premio, message: "Validado y registrado" };
  }

  if (referenciaQueYaGiro) {
    // Reintento del mismo cliente (la primera respuesta no le llegó): mismo premio
    var anterior = premioAnotado(referenciaQueYaGiro, ultimos5, idJugador);
    if (anterior) return { status: "success", repetido: true, premio: anterior };
    return { status: "error", message: "⚠️ Esta recarga ya participó en la ruleta." };
  }
  if (hayPagoSinRecarga) {
    return { status: "error", message: "❌ Ese pago todavía no tiene una recarga completada." };
  }
  return { status: "error", message: "❌ Referencia inválida. No se detecta un pago exitoso." };
}

// Premio ya anotado para esta referencia y este jugador (las filas viejas tienen solo 5 dígitos)
function premioAnotado(referenciaCompleta, ultimos5, idJugador) {
  var filas = hojaPremios().getDataRange().getValues();
  for (var i = filas.length - 1; i >= 0; i--) {
    var ref = String(filas[i][2]).replace(/\s+/g, "");
    if (String(filas[i][1]).trim() !== idJugador) continue;
    if (ref === referenciaCompleta || ref === ultimos5) return String(filas[i][4] || "");
  }
  return "";
}

// Primera pestaña del libro donde está instalado este script (donde siempre se anotaron los premios)
function hojaPremios() {
  return SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
}

function responder(objeto) {
  return ContentService.createTextOutput(JSON.stringify(objeto)).setMimeType(ContentService.MimeType.JSON);
}

// Texto que se escribe en la hoja: si empieza como fórmula (= + - @) se guarda como texto
function textoSeguro(valor) {
  var texto = String(valor === undefined || valor === null ? "" : valor).slice(0, 300);
  return /^[=+\-@]/.test(texto) ? "'" + texto : texto;
}
