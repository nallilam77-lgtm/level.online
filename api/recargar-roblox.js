const PROJECT_ID = "levelupstore-87d4d";

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: "Método no permitido" });
  }

  // Convertidor inteligente para formatear montos en Bolívares
  const formatearVES = (monto) => {
    return Number(monto).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  try {
    const { producto, jugadorId, orderId, referencia, urlImagen } = req.body;

    // Validación estricta de campos obligatorios
    if (!referencia || !producto || !jugadorId || !orderId) {
      return res.status(200).json({ success: false, message: "Faltan datos obligatorios en la petición." });
    }

    // ==========================================
    // 1. EL CATÁLOGO MAESTRO DE ROBUX (Con sus precios exactos en Bs)
    // ==========================================
    const catalogoRobux = {
      "50":   { precio: 928.00 },
      "100":  { precio: 1693.00 },
      "275":  { precio: 2900.00 },
      "365":  { precio: 3937.00 },
      "420":  { precio: 4605.00 },
      "700":  { precio: 7571.00 },
      "1000": { precio: 9923.00 }
    };

    const numeroRobux = String(producto).replace(/[^0-9]/g, '');
    const paqueteSeleccionado = catalogoRobux[numeroRobux];

    if (!paqueteSeleccionado) {
      return res.status(200).json({ success: false, message: "Paquete de Roblox inválido o manipulado." });
    }

    const URL_GOOGLE_SCRIPT = process.env.SCRIPT_RECARGAS_URL;

    // ==========================================
    // 2. VERIFICAR Y BLOQUEAR EL PAGO EN GOOGLE SHEETS
    // ==========================================
    const resVerificacion = await fetch(URL_GOOGLE_SCRIPT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accion: "verificar_pago", referencia: referencia, monto: paqueteSeleccionado.precio })
    });
    
    const dataVerificacion = await resVerificacion.json();

    if (!dataVerificacion || !dataVerificacion.encontrado) {
      return res.status(200).json({ 
        success: false, 
        message: dataVerificacion.message || "No se encontró ningún pago con esa referencia." 
      });
    }

    // 🛡️ EXCEPCIÓN: Si el pago es insuficiente, devolvemos los montos exactos para la interfaz
    if (dataVerificacion.insuficiente) {
      await fetch(URL_GOOGLE_SCRIPT, { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify({ accion: "marcar_verificado", referencia: dataVerificacion.referencia }) 
      });
      
      const montoPagadoNum = Number(dataVerificacion.montoPagado) || 0;
      const diferencia = paqueteSeleccionado.precio - montoPagadoNum;

      return res.status(200).json({ 
        success: false, 
        insuficiente: true,
        montoPagado: formatearVES(montoPagadoNum),
        faltaPorPagar: formatearVES(diferencia > 0 ? diferencia : 0),
        message: `Pago insuficiente: Encontramos ${formatearVES(montoPagadoNum)} Bs, pero este paquete cuesta ${formatearVES(paqueteSeleccionado.precio)} Bs.` 
      });
    }

    // ==========================================
    // 3. BUSCAR STOCK DISPONIBLE EN LA BÓVEDA DE FIRESTORE ("codigos_roblox")
    // ==========================================
    const firestoreBaseUrl = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

    // Consulta flexible (soporta producto_id como texto o número)
    const queryBody = {
      structuredQuery: {
        from: [{ collectionId: "codigos_roblox" }],
        where: {
          compositeFilter: {
            op: "AND",
            filters: [
              {
                fieldFilter: {
                  field: { fieldPath: "producto_id" },
                  op: "IN",
                  value: {
                    arrayValue: {
                      values: [
                        { stringValue: String(numeroRobux) },
                        { integerValue: Number(numeroRobux) }
                      ]
                    }
                  }
                }
              },
              {
                fieldFilter: {
                  field: { fieldPath: "estado" },
                  op: "EQUAL",
                  value: { stringValue: "disponible" }
                }
              }
            ]
          }
        },
        limit: 1
      }
    };

    const stockRes = await fetch(`${firestoreBaseUrl}:runQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(queryBody)
    });
    const stockData = await stockRes.json();

    let pinDocName = null;
    let pinCodigo = null;

    if (stockData && stockData.length > 0 && stockData[0].document) {
      const pinDoc = stockData[0].document;
      pinDocName = pinDoc.name;
      pinCodigo = pinDoc.fields.codigo ? pinDoc.fields.codigo.stringValue : null;
    }

    if (!pinCodigo) {
      // Si no hay stock, devolvemos el pago a "Verificado" para proteger el dinero del cliente
      await fetch(URL_GOOGLE_SCRIPT, { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify({ accion: "marcar_verificado", referencia: dataVerificacion.referencia }) 
      });

      return res.status(200).json({ 
        success: false, 
        message: "Lo sentimos, no hay stock disponible en la bóveda para este paquete de Robux en este momento." 
      });
    }

    // ==========================================
    // 4. QUEMAR EL PAGO EN SHEETS (Marcar como Usado)
    // ==========================================
    await fetch(URL_GOOGLE_SCRIPT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accion: "marcar_usado", referencia: dataVerificacion.referencia })
    });

    const fechaActual = new Date().toISOString();

    // ==========================================
    // 5. ACTUALIZAR FIRESTORE (Marcar PIN como vendido y guardar pedido)
    // ==========================================
    const commitBody = {
      writes: [
        {
          update: {
            name: pinDocName,
            fields: {
              producto_id: { stringValue: String(numeroRobux) },
              codigo: { stringValue: pinCodigo },
              estado: { stringValue: "vendido" },
              orden_id: { stringValue: String(orderId) },
              jugador_id: { stringValue: String(jugadorId) },
              fecha_venta: { stringValue: fechaActual }
            }
          },
          updateMask: { fieldPaths: ["estado", "orden_id", "jugador_id", "fecha_venta"] }
        },
        {
          update: {
            name: `${firestoreBaseUrl}/pedidos/orden_${orderId}`,
            fields: {
              orderId: { stringValue: String(orderId) },
              categoria: { stringValue: "Roblox" },
              oferta: { stringValue: `${numeroRobux} Robux` },
              jugadorId: { stringValue: String(jugadorId) },
              montoUsd: { doubleValue: 0 },
              estado: { stringValue: "completed" },
              creadoEn: { stringValue: fechaActual }
            }
          }
        }
      ]
    };

    await fetch(`${firestoreBaseUrl}:commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(commitBody)
    });

    // 6. Retornar éxito con el PIN de Roblox obtenido
    return res.status(200).json({
      success: true,
      codigo: pinCodigo
    });

  } catch (error) {
    console.error("Error crítico en recargar-roblox.js:", error);
    return res.status(200).json({ success: false, message: "Falla interna del servidor al procesar la recarga." });
  }
};