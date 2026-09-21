export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Método no permitido' });
  }

  const apiKeyFazer = process.env.FAZER_API_KEY || "fc_cb682478a17afc111710344a"; 
  const projectIdFirebase = "levelupstore-87d4d";

  try {
    // 1. Consultar las órdenes directamente desde la API oficial de FazerCards
    const respuestaFazer = await fetch("https://api.fzr.cards/api/v2/orders", {
      method: "GET",
      headers: {
        "X-Api-Key": apiKeyFazer,
        "Accept": "application/json"
      }
    });

    const dataFazer = await respuestaFazer.json();
    if (!dataFazer.ok || !dataFazer.items) {
      return res.status(400).json({ success: false, error: "No se pudieron obtener las órdenes de FazerCards" });
    }

    const ordenes = dataFazer.items;
    let contador = 0;

    // 2. Recorrer cada orden y guardarla o actualizarla en Firebase Firestore
    for (const orden of ordenes) {
      const orderId = orden.id; // Ejemplo: ord-1470392
      const urlFirebase = `https://firestore.googleapis.com/v1/projects/${projectIdFirebase}/databases/(default)/documents/pedidos/${orderId}`;
      
      const jugadorId = (orden.fields && orden.fields.player_id) ? orden.fields.player_id : "N/A";

      const payloadFirestore = {
        fields: {
          orderId: { stringValue: orderId },
          titulo: { stringValue: orden.title || "" },
          tipo: { stringValue: orden.kind || "" },
          categoria: { stringValue: orden.category_name || "" },
          oferta: { stringValue: orden.offer_name || "" },
          montoUsd: { doubleValue: parseFloat(orden.total_usd || 0) },
          estado: { stringValue: orden.status || "" },
          creadoEn: { stringValue: orden.created_at || "" },
          completadoEn: { stringValue: orden.completed_at || "En proceso" },
          jugadorId: { stringValue: jugadorId }
        }
      };

      // PATCH actualiza el documento si ya existe o lo crea si es nuevo
      await fetch(urlFirebase, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payloadFirestore)
      });

      contador++;
    }

    return res.status(200).json({ 
      success: true, 
      message: `Sincronización automática completa. Órdenes procesadas: ${contador}` 
    });

  } catch (error) {
    return res.status(500).json({ success: false, error: error.toString() });
  }
}