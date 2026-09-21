export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Método no permitido' });
  }

  const apiKey = process.env.FAZER_API_KEY || "fc_cb682478a17afc111710344a"; 

  try {
    // Petición al endpoint oficial de balance de FazerCards
    const respuesta = await fetch("https://api.fzr.cards/api/v2/balance", {
      method: "GET",
      headers: {
        "X-Api-Key": apiKey,
        "Accept": "application/json"
      }
    });

    const data = await respuesta.json();
    
    if (data.ok) {
      // Devuelve el saldo limpio a tu panel de administración
      return res.status(200).json({ success: true, balance: data.balance });
    } else {
      return res.status(200).json({ success: false, error: "Error en la respuesta de FazerCards" });
    }

  } catch (error) {
    return res.status(500).json({ success: false, error: error.toString() });
  }
}