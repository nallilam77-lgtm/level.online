module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ status: "error", respuesta: "Método no permitido." });
    }

    try {
        const { mensaje } = req.body;
        const apiKey = process.env.GEMINI_API_KEY; 

        if (!apiKey) {
            return res.status(200).json({ 
                status: "success", 
                respuesta: "Error: Falta configurar la GEMINI_API_KEY en Vercel." 
            });
        }

        const promptSistema = "Eres el asistente virtual oficial de Level Up, una tienda digital de recargas de Free Fire y juegos en Venezuela. Responde de forma amable, clara y directa. Ayuda a los clientes con sus dudas sobre pagos (Binance, Zinli, Pago Móvil), tiempos de entrega y recargas. Recuérdales que cada recarga válida les da una oportunidad en la ruleta con un 2% de probabilidad de ganar 100 diamantes extra.";
        
        // Actualizado al modelo actual compatible con la API v1beta
        const respuestaGemini = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [
                    { role: "user", parts: [{ text: `${promptSistema}\n\nMensaje del cliente: "${mensaje}"` }] }
                ]
            })
        });

        const data = await respuestaGemini.json();

        let textoRespuesta = "¡Hola! Bienvenido a Level Up. ¿En qué te puedo ayudar con tu recarga?";
        
        if (data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0].text) {
            textoRespuesta = data.candidates[0].content.parts[0].text;
        } else if (data && data.error) {
            textoRespuesta = `Error de API Google: ${data.error.message}`;
        }

        return res.status(200).json({
            status: "success",
            respuesta: textoRespuesta
        });

    } catch (error) {
        return res.status(200).json({ 
            status: "success", 
            respuesta: `Error en servidor: ${error.message}` 
        });
    }
};
