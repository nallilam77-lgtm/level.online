export default async function handler(req, res) {
    // Solo permitimos peticiones POST
    if (req.method !== 'POST') {
        return res.status(405).json({ status: "error", message: "Método no permitido." });
    }

    try {
        const { mensaje } = req.body;

        if (!mensaje) {
            return res.status(400).json({ status: "error", message: "Falta el mensaje del usuario." });
        }

        // 1. Instrucciones de cómo debe comportarse el Bot de Level Up
        const promptSistema = "Eres el asistente virtual oficial de Level Up, una tienda digital de recargas de Free Fire y juegos en Venezuela. Responde de forma amable, clara y directa. Ayuda a los clientes con sus dudas sobre pagos (Binance, Zinli, Pago Móvil), tiempos de entrega y recargas. Recuérdales que cada recarga válida les da una oportunidad en la ruleta con un 2% de probabilidad de ganar 100 diamantes extra.";

        // 2. Llamamos a la API Key desde las variables ocultas de Vercel (Seguridad máxima)
        const apiKey = process.env.GEMINI_API_KEY; 

        if (!apiKey) {
            return res.status(500).json({ status: "error", respuesta: "El servidor no tiene configurada la clave de IA." });
        }
        
        // 3. Conexión con Gemini 1.5 Flash
        const respuestaGemini = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [
                    { role: "user", parts: [{ text: `${promptSistema}\n\nMensaje del cliente: "${mensaje}"` }] }
                ],
                // Configuración de tokens para que aguante respuestas largas sin cortarse
                generationConfig: {
                    maxOutputTokens: 800, 
                    temperature: 0.7      
                }
            })
        });

        const data = await respuestaGemini.json();
        
        // Extraemos el texto limpio que respondió la IA
        const textoRespuesta = data.candidates?.[0]?.content?.parts?.[0]?.text || "¡Hola! Un asesor humano de Level Up te atenderá en breve.";

        return res.status(200).json({
            status: "success",
            respuesta: textoRespuesta
        });

    } catch (error) {
        return res.status(500).json({ 
            status: "error", 
            respuesta: "Disculpa, el sistema de soporte presenta una pausa temporal. Escríbenos por WhatsApp." 
        });
    }
}