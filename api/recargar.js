const PROJECT_ID = "levelupstore-87d4d"; 
const COLLECTION_NAME = "Pagos";
const FOLDER_ID = "12-YApHdXIFtbIk9qzNCiUY0SVsimCecO"; 

function doPost(e) {
  var lock = LockService.getScriptLock();
  
  try {
    lock.waitLock(20000); 
    
    var libro = SpreadsheetApp.getActiveSpreadsheet();
    var hoja = libro.getSheetByName("pagos") || libro.getSheetByName("Pagos");
    var hojaFinalizados = libro.getSheetByName("finalizados") || libro.getSheetByName("Finalizados"); 
    var hojaCodigos = libro.getSheetByName("codigos") || libro.getSheetByName("Codigos");
    
    var datos = JSON.parse(e.postData.contents);
    var accion = datos.accion || "";

    // ==========================================
    // 0: MACRODROID (GUARDAR PAGO AUTOMÁTICO)
    // ==========================================
    if (!accion && (datos.referencia || datos.monto || datos.telefono)) {
      var fechaHora = Utilities.formatDate(new Date(), "America/Caracas", "dd/MM/yyyy HH:mm:ss");
      var tel = datos.telefono || "";
      var ref = String(datos.referencia || "").trim();
      var monto = datos.monto || "0";
      
      hoja.appendRow([fechaHora, tel, ref, monto, "Verificado"]);
      SpreadsheetApp.flush();

      return ContentService.createTextOutput(JSON.stringify({ 
        status: "success", message: "Pago guardado automáticamente" 
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // ==========================================
    // 1: VERIFICAR PAGO SIMPLE (Devuelve el monto exacto)
    // ==========================================
    else if (accion === "verificar_pago_simple") {
      var ultimos5 = String(datos.referencia || "").trim().replace(/\s+/g, '');
      var rows = hoja.getDataRange().getValues();
      var filaEncontradaIndex = -1;

      for (var i = rows.length - 1; i >= 1; i--) {
        var referenciaCompleta = String(rows[i][2]).trim().replace(/\s+/g, '');
        if (referenciaCompleta.endsWith(ultimos5) && referenciaCompleta !== "") {
          filaEncontradaIndex = i;
          break;
        }
      }

      if (filaEncontradaIndex === -1 && ultimos5.length >= 4) {
        for (var j = rows.length - 1; j >= 1; j--) {
          var refComp2 = String(rows[j][2]).trim().replace(/\s+/g, '');
          if (refComp2.indexOf(ultimos5) !== -1 && refComp2 !== "") {
            filaEncontradaIndex = j;
            break;
          }
        }
      }

      if (filaEncontradaIndex !== -1) {
        var refEncontrada = String(rows[filaEncontradaIndex][2]).trim().replace(/\s+/g, '');
        var estadoActual = String(rows[filaEncontradaIndex][4]).trim().toLowerCase();
        
        if (estadoActual === "usado") {
          return ContentService.createTextOutput(JSON.stringify({ status: "success", encontrado: false, message: "❌ Este pago ya fue validado y gastado anteriormente." })).setMimeType(ContentService.MimeType.JSON);
        }
        if (estadoActual === "en proceso") {
          return ContentService.createTextOutput(JSON.stringify({ status: "success", encontrado: false, message: "⚠️ Esta referencia está siendo procesada en este momento." })).setMimeType(ContentService.MimeType.JSON);
        }

        var filaNum = filaEncontradaIndex + 1;
        var montoEncontrado = limpiarMontoVES(rows[filaEncontradaIndex][3]);

        // Bloquear temporalmente la celda
        hoja.getRange(filaNum, 5).setValue("En proceso");
        SpreadsheetApp.flush(); 

        return ContentService.createTextOutput(JSON.stringify({
          status: "success",
          encontrado: true,
          referencia: refEncontrada,
          montoPagado: montoEncontrado
        })).setMimeType(ContentService.MimeType.JSON);
      }

      return ContentService.createTextOutput(JSON.stringify({ status: "success", encontrado: false, message: "🔍 Referencia bancaria no encontrada en el sistema." })).setMimeType(ContentService.MimeType.JSON);
    }

    // ==========================================
    // 2: OBTENER Y QUEMAR CÓDIGOS DE INVENTARIO
    // ==========================================
    else if (accion === "obtener_codigo") {
      var diamantesBuscados = String(datos.diamantes).replace(/[^0-9]/g, ''); 
      var cantidadNecesaria = (diamantesBuscados === "220") ? 2 : 1;
      var columnaBuscar = (diamantesBuscados === "220") ? "110" : diamantesBuscados;

      var headers = hojaCodigos.getRange(1, 1, 1, hojaCodigos.getLastColumn()).getValues()[0];
      var colIndex = -1;
      
      for (var h = 0; h < headers.length; h++) {
         if (String(headers[h]).replace(/[^0-9]/g, '') === columnaBuscar) {
             colIndex = h + 1;
             break;
         }
      }

      if (colIndex === -1) {
        return ContentService.createTextOutput(JSON.stringify({ 
          status: "error", message: "Columna de códigos no configurada para " + columnaBuscar 
        })).setMimeType(ContentService.MimeType.JSON);
      }

      var codigosAsignados = [];
      var values = hojaCodigos.getRange(2, colIndex, hojaCodigos.getLastRow(), 1).getValues();

      for (var i = 0; i < values.length && codigosAsignados.length < cantidadNecesaria; i++) {
        if (values[i][0] && String(values[i][0]).trim() !== "") {
          codigosAsignados.push({ fila: i + 2, codigo: String(values[i][0]).trim() });
        }
      }

      if (codigosAsignados.length < cantidadNecesaria) {
         return ContentService.createTextOutput(JSON.stringify({ 
           status: "error", message: "⚠️ ¡Nos quedamos sin stock! Faltan pines de " + columnaBuscar + " diamantes." 
         })).setMimeType(ContentService.MimeType.JSON);
      }

      for (var k = 0; k < codigosAsignados.length; k++) {
        hojaCodigos.getRange(codigosAsignados[k].fila, colIndex).clearContent();
      }
      SpreadsheetApp.flush();

      var pinesPuros = codigosAsignados.map(function(c) { return c.codigo; });

      return ContentService.createTextOutput(JSON.stringify({ 
        status: "success", pines: pinesPuros 
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // ==========================================
    // 3: MARCAR COMO USADO (Éxito definitivo)
    // ==========================================
    else if (accion === "marcar_usado") {
      var refBuscada = String(datos.referencia || "").trim();
      var rows = hoja.getDataRange().getValues();
      if (refBuscada) {
        for (var r = rows.length - 1; r >= 1; r--) {
          if (String(rows[r][2]).trim() === refBuscada) {
            hoja.getRange(r + 1, 5).setValue("Usado");
            SpreadsheetApp.flush();
            break; 
          }
        }
        actualizarEstadoFirebase(refBuscada, "Usado");
      }
      return ContentService.createTextOutput(JSON.stringify({ status: "success" })).setMimeType(ContentService.MimeType.JSON);
    }

    // ==========================================
    // 4: DEVOLVER A VERIFICADO (Si hubo error en recarga)
    // ==========================================
    else if (accion === "marcar_verificado") {
      var refBuscada = String(datos.referencia || "").trim();
      var rows = hoja.getDataRange().getValues();
      if (refBuscada) {
        for (var r = rows.length - 1; r >= 1; r--) {
          if (String(rows[r][2]).trim() === refBuscada) {
            hoja.getRange(r + 1, 5).setValue("Verificado");
            SpreadsheetApp.flush();
            break;
          }
        }
        actualizarEstadoFirebase(refBuscada, "Verificado");
      }
      return ContentService.createTextOutput(JSON.stringify({ status: "success" })).setMimeType(ContentService.MimeType.JSON);
    }

    // ==========================================
    // 5: SUBIR IMAGEN A DRIVE
    // ==========================================
    else if (accion === "subir_imagen") {
      var carpeta = DriveApp.getFolderById(FOLDER_ID);
      var archivoBase64 = datos.base64.split(",")[1]; 
      var blob = Utilities.newBlob(Utilities.base64Decode(archivoBase64), datos.mimeType, datos.nombre);
      var archivo = carpeta.createFile(blob);
      archivo.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      return ContentService.createTextOutput(JSON.stringify({ status: "success", url: archivo.getUrl() })).setMimeType(ContentService.MimeType.JSON);
    }

    // ==========================================
    // 6: REGISTRAR EN FINALIZADOS CON CÓDIGOS USADOS
    // ==========================================
    else if (accion === "registrar_finalizado") {
      var fechaHora = Utilities.formatDate(new Date(), "America/Caracas", "dd/MM/yyyy HH:mm:ss");
      var idJugador = datos.idJugador || "";
      var paquete = datos.paquete || "";
      var referencias = datos.referencias || ""; 
      var codigosUsados = datos.codigosUsados || "No especificado"; 
      var urlImagen = datos.urlImagen || "Sin comprobante";
      
      hojaFinalizados.appendRow([
        fechaHora,      
        idJugador,      
        paquete,        
        referencias,    
        codigosUsados,  
        urlImagen       
      ]);
      SpreadsheetApp.flush();

      try {
        UrlFetchApp.fetch("https://levelupstore.online/api/sincronizar-pedidos", { "method": "get", "muteHttpExceptions": true });
      } catch (err) {}

      return ContentService.createTextOutput(JSON.stringify({ status: "success", message: "Guardado en finalizados correctamente" })).setMimeType(ContentService.MimeType.JSON);
    }

    // ==========================================
    // 7: OBTENER PRECIOS
    // ==========================================
    else if (accion === "obtener_precios") {
      var hojaPrecios = libro.getSheetByName("precios") || libro.getSheetByName("Precios");
      if (!hojaPrecios) return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "Falta pestaña precios" })).setMimeType(ContentService.MimeType.JSON);

      var rows = hojaPrecios.getDataRange().getValues();
      var paquetes = [];
      if (rows.length >= 2) {
        var titulos = rows[0]; 
        var precios = rows[1]; 
        for (var i = 0; i < titulos.length; i++) {
          if (titulos[i] && String(titulos[i]).trim() !== "") {
            paquetes.push({ diamantes: String(titulos[i]).trim(), precio: precios[i] });
          }
        }
      }
      return ContentService.createTextOutput(JSON.stringify({ status: "success", catalogo: paquetes })).setMimeType(ContentService.MimeType.JSON);
    }

    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "Acción no válida" })).setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({ 
      status: "error", 
      message: "⚠️ Sistema ocupado procesando otra transacción. Por favor, intenta de nuevo en unos segundos." 
    })).setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}

function actualizarEstadoFirebase(referencia, nuevoEstado) {
  const docId = "ref_" + referencia;
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${COLLECTION_NAME}/${docId}?updateMask.fieldPaths=estado`;
  const token = ScriptApp.getOAuthToken();
  const payload = { fields: { estado: { stringValue: String(nuevoEstado) } } };

  const options = {
    method: "patch", contentType: "application/json", headers: { "Authorization": "Bearer " + token },
    payload: JSON.stringify(payload), muteHttpExceptions: true
  };
  UrlFetchApp.fetch(url, options);
}

function limpiarMontoVES(valor) {
  if (typeof valor === 'number') return valor;
  if (!valor) return 0;
  
  var m = String(valor).trim().replace(/[^0-9.,]/g, '');
  if (!m) return 0;
  
  if (m.includes(',') && m.includes('.')) {
    if (m.lastIndexOf(',') > m.lastIndexOf('.')) { m = m.replace(/\./g, '').replace(',', '.'); }
    else { m = m.replace(/,/g, ''); }
  } else if (m.includes('.')) {
    var partes = m.split('.');
    if (partes.length > 2 || (partes.length === 2 && partes[1].length === 3)) { m = m.replace(/\./g, ''); }
  } else if (m.includes(',')) {
    m = m.replace(',', '.');
  }
  return parseFloat(m) || 0;
}
