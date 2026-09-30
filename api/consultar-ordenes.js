function doGet(e) {
  var ID_HOJA_PRINCIPAL = '1hYl8yGJzmlB2-O6VK9UghZFN5nI7S7Ld5uhA3Np-4X8';
  var idBuscado = e.parameter.id;
  
  Logger.log("ID que mandó la web: " + idBuscado);
  
  if (!idBuscado) {
    return ContentService.createTextOutput(JSON.stringify([])).setMimeType(ContentService.MimeType.JSON);
  }

  try {
    var libroOriginal = SpreadsheetApp.openById(ID_HOJA_PRINCIPAL);
    var sheet = libroOriginal.getSheetByName("exitoso");
    
    if (!sheet) {
      Logger.log("No se encontró la pestaña exitoso");
      return ContentService.createTextOutput(JSON.stringify([])).setMimeType(ContentService.MimeType.JSON);
    }

    var data = sheet.getDataRange().getValues();
    var resultados = [];

    for (var i = data.length - 1; i >= 0; i--) {
      var idEnHoja = data[i][1] ? data[i][1].toString().trim() : ""; 
      var idSolicitado = idBuscado.toString().trim();
      
      // Imprimimos para depurar los primeros 3 registros que lea
      if(i > data.length - 4) {
        Logger.log("Comparando hoja: '" + idEnHoja + "' con buscado: '" + idSolicitado + "'");
      }

      if (idEnHoja === idSolicitado) {
        resultados.push({
          fecha: data[i][0] ? data[i][0].toString() : "",
          id: idEnHoja,
          paquete: data[i][2] ? data[i][2].toString() : ""
        });
        
        if (resultados.length >= 5) break; 
      }
    }
    
    Logger.log("Resultados encontrados: " + resultados.length);
    return ContentService.createTextOutput(JSON.stringify(resultados))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    Logger.log("Error: " + error.toString());
    return ContentService.createTextOutput(JSON.stringify([]))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
