export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ status: "error", message: "Método no permitido." });
    }

    try {
        const { id, referencia, juego } = req.body;

        if (!referencia || !id) {
            return res.status(400).json({ status: "error", message: "Faltan datos de validación." });
        }

        // 1. Probabilidad estricta del 0.1% controlada en el servidor (Inquebrantable)
        const numeroAleatorio = Math.random() * 100;
        let ganoPremio = false;
        let premioStr = "Vacío ❌";
        
        if (numeroAleatorio <= 2) {
            ganoPremio = true;
            premioStr = "100 Diamantes 💎";
        }

        // 2. Enviar los datos a tu Google Apps Script para quemar la referencia en Excel
        const URL_GOOGLE_SCRIPT = "https://script.google.com/macros/s/AKfycbyhe8ufv-upqgOuJ2RjAUIxulHel27Ns563cHbqFJI-rpt_vxyoZ3tZ-zqNfSm4ByYUUg/exec";

        const respuestaScript = await fetch(URL_GOOGLE_SCRIPT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                referencia: referencia,
                id_jugador: id,
                juego: juego || "Free Fire",
                premio: premioStr
            })
        });

        const resultadoGAS = await respuestaScript.json();

        if (resultadoGAS.status === "error") {
            return res.status(403).json({ 
                status: "error", 
                message: resultadoGAS.message 
            });
        }

        // 3. Calcular grados para la animación de la ruleta
        const vueltasBase = 1440; // 4 vueltas completas
        const gradosDestino = ganoPremio ? (vueltasBase + 180) : (vueltasBase + 0);

        return res.status(200).json({
            status: "success",
            ganador: ganoPremio,
            premio: premioStr,
            gradosDestino: gradosDestino
        });

    } catch (error) {
        return res.status(500).json({ 
            status: "error", 
            message: "Fallo temporal en los servidores de la ruleta." 
        });
    }
}
