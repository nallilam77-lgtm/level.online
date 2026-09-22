const PROJECT_ID = "levelupstore-87d4d";

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Método no permitido' });
  }

  try {
    const { producto, jugadorId, orderId, referencia } = req.body;

    if (!referencia || !producto) {
      return res.status(200).json({ success: false, message: 'Faltan datos en la petición.' });
    }

    const firestoreBaseUrl = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

    // 1. Consultar la colección "Pagos"
    const pagosRes = await fetch(`${firestoreBaseUrl}/Pagos`);
    const pagosData = await pagosRes.json();
    
    let pagoEncontradoDoc = null;
    let pagoDocName = null;

    if (pagosData.documents) {
      for (const doc of pagosData.documents) {
        // Extraer el ID real del documento (ej. ref_761007 o 761007)
        const rawDocId = doc.name.split('/').pop();
        const docIdClean = rawDocId.replace('ref_', '');
        
        // Verificar si los últimos dígitos coinciden con la referencia ingresada
        if (docIdClean.endsWith(String(referencia).trim())) {
          pagoDocName = doc.name;
          pagoEncontradoDoc = {
            estado: doc.fields.estado && doc.fields.estado.stringValue ? doc.fields.estado.stringValue : 'desconocido'
          };
          break;
        }
      }
    }

    if (!pagoEncontradoDoc) {
      return res.status(200).json({ success: false, message: 'No se encontró ningún pago con esa referencia.' });
    }

    if (pagoEncontradoDoc.estado === 'usado') {
      return res.status(200).json({ success: false, message: 'Esta referencia ya fue utilizada anteriormente.' });
    }

    // 2. Consultar stock disponible en "codigos_roblox"
    const queryBody = {
      structuredQuery: {
        from: [{ collectionId: "codigos_roblox" }],
        where: {
          compositeFilter: {
            op: "AND",
            filters: [
              { fieldFilter: { field: { fieldPath: "producto_id" }, op: "EQUAL", value: { stringValue: String(producto) } } },
              { fieldFilter: { field: { fieldPath: "estado" }, op: "EQUAL", value: { stringValue: "disponible" } } }
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
      return res.status(200).json({ success: false, message: 'Lo sentimos, no hay stock disponible para este paquete de Robux.' });
    }

    const fechaActual = new Date().toISOString();

    // 3. Ejecutar actualizaciones en Firestore mediante Commit REST API
    const commitBody = {
      writes: [
        {
          update: {
            name: pinDocName,
            fields: {
              producto_id: { stringValue: String(producto) },
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
            name: pagoDocName,
            fields: {
              estado: { stringValue: "usado" },
              jugador_asignado: { stringValue: String(jugadorId) },
              orden_asignada: { stringValue: String(orderId) }
            }
          },
          updateMask: { fieldPaths: ["estado", "jugador_asignado", "orden_asignada"] }
        },
        {
          update: {
            name: `${firestoreBaseUrl}/pedidos/orden_${orderId}`,
            fields: {
              orderId: { stringValue: String(orderId) },
              categoria: { stringValue: "Roblox" },
              oferta: { stringValue: `${producto} Robux` },
              jugadorId: { stringValue: String(jugadorId) },
              montoUsd: { doubleValue: 0 },
              estado: { stringValue: "completed" },
              creadoEn: { stringValue: fechaActual }
            }
          }
        }
      ]
    };

    const commitRes = await fetch(`${firestoreBaseUrl}:commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(commitBody)
    });

    if (!commitRes.ok) {
      const errorText = await commitRes.text();
      console.error("Error al hacer commit en Firestore:", errorText);
      return res.status(200).json({ success: false, message: 'Error al procesar la asignación del pin.' });
    }

    // 4. Retornar éxito con el PIN
    return res.status(200).json({
      success: true,
      codigo: pinCodigo
    });

  } catch (error) {
    console.error("Error crítico en recargar-roblox:", error);
    return res.status(200).json({ success: false, message: 'Error interno en el servidor al procesar la recarga.' });
  }
};