export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ status: "error", message: "Método no permitido." });
    }

    try {
        const { id, referencia, juego } = req.body;

        if (!referencia || !id) {
            return res.status(400).json({ status: "error", message: "Faltan datos de validación para la ruleta." });
        }

        // 1. Primero consultamos/enviamos a Google Apps Script para que valide
        // si la referencia ya usó su giro de ruleta (esto lo programamos en tu GAS).
        const URL_GOOGLE_SCRIPT = "https://script.google.com/macros/s/AKfycbyhe8ufv-upqgOuJ2RjAUIxulHel27Ns563cHbqFJI-rpt_vxyoZ3tZ-zqNfSm4ByYUUg/exec";

        // NOTA: Aquí evaluamos la probabilidad del 2% de forma estricta en servidor
        const numeroAleatorio = Math.random() * 100;
        let ganoPremio = numeroAleatorio <= 2; // Exactamente el 2% (de 0 a 2)
        let premioStr = ganoPremio ? "100 Diamantes 💎" : "Vacío ❌";

        const respuestaScript = await fetch(URL_GOOGLE_SCRIPT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                accion: "girar_ruleta", // Identificador opcional para tu Google Script
                referencia: referencia,
                id_jugador: id,
                juego: juego || "Free Fire",
                premio: premioStr
            })
        });

        const resultadoGAS = await respuestaScript.json();

        // Si Google Script detecta que la referencia ya jugó o hubo un error de BD
        if (resultadoGAS.status === "error") {
            return res.status(403).json({ 
                status: "error", 
                message: resultadoGAS.message || "Esta referencia ya participó en la ruleta o no es válida." 
            });
        }

        // Si el Google Script determinó que ya había girado previamente (por seguridad extra)
        if (resultadoGAS.yaGiro) {
            return res.status(400).json({
                status: "error",
                message: "Esta referencia de pago ya consumió su intento en la ruleta."
            });
        }

        // 2. Calcular grados para la animación de la ruleta visual en el cliente
        // Suponiendo que 180deg es el premio y 0deg es vacío (según tu diseño conic-gradient)
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
