export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Método no permitido' });
  }

  const { playerId } = req.body;
  if (!playerId) {
    return res.status(400).json({ success: false, message: 'Falta el ID de jugador' });
  }

  const apiKeyFazer = process.env.FAZER_API_KEY || "fc_cb682478a17afc111710344a";

  try {
    const respuestaFazer = await fetch("https://api.fzr.cards/api/v2/orders", {
      method: "GET",
      headers: {
        "X-Api-Key": apiKeyFazer,
        "Accept": "application/json"
      }
    });

    const dataFazer = await respuestaFazer.json();
    if (!dataFazer.ok || !dataFazer.items) {
      return res.status(400).json({ success: false, message: "No se pudieron obtener las órdenes del proveedor." });
    }

    // Filtramos las órdenes que coincidan con el ID del jugador
    const ordenesJugador = dataFazer.items.filter(orden => {
      return orden.fields && String(orden.fields.player_id) === String(playerId);
    });

    // Ordenamos de más reciente a más antigua y tomamos solo las últimas 2
    ordenesJugador.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const ultimasDos = ordenesJugador.slice(0, 2).map(orden => ({
      idOrden: orden.id,
      paquete: orden.offer_name || orden.title,
      estado: orden.status,
      fecha: orden.created_at
    }));

    return res.status(200).json({ success: true, recargas: ultimasDos });

  } catch (error) {
    return res.status(500).json({ success: false, message: "Error al conectar con la API de FazerCards." });
  }
}