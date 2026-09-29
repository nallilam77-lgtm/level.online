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

        // Prompt ultra corto, preciso y enfocado únicamente en Pago Móvil
        const promptSistema = "Eres el asistente oficial de Level Up (recargas de Free Fire en Venezuela). Sé muy corto, directo y preciso. El único método de pago es Pago Móvil. Guía al cliente: 1. Ingresa su ID, 2. Selecciona su paquete, 3. Paga por Pago Móvil con los datos en pantalla, 4. Sube el capture e ingresa los últimos 5 dígitos de la referencia para procesar al instante. Recuérdale que al finalizar tiene oportunidad de girar la ruleta y ganar 100 diamantes extra.";
        
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

        let textoRespuesta = "¡Hola! Bienvenido a Level Up. ¿En qué te ayudamos con tu recarga por Pago Móvil?";
        
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
