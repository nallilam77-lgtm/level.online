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
                respuesta: "¡Hola! Por el momento el asistente está en mantenimiento. Escríbenos al botón de WhatsApp para atenderte de inmediato." 
            });
        }

        const promptSistema = `Eres el asistente virtual oficial y experto de Level Up, una tienda digital de recargas de Free Fire y pasarelas en Venezuela. 
Tus respuestas deben ser sumamente cortas, amables, en español y directas (máximo 2 o 3 frases). 
Conoces a fondo cómo ubicar el número de referencia según el banco del cliente para pagos móviles:
1. **Banco de Venezuela (BDV):** Aparece etiquetado como "Operación:" (recuerda que el sistema web pide obligatoriamente los **últimos 5 dígitos**).
2. **Mercantil (Tpago) / Banesco / Provincial / Tesoro:** Aparece como "Nro. de referencia:", "Referencia:" o en el comprobante digital.
3. **Regla de oro de los 5 dígitos:** Si te preguntan por la referencia, recuérdales ingresar únicamente los **últimos 5 dígitos** de su comprobante de pago móvil.
4. Si el cliente tiene un problema grave de recarga, error técnico o pago insuficiente, recuérdale que puede usar el botón de WhatsApp humano para soporte directo.`;
        
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

        let textoRespuesta = "¡Hola! Bienvenido a Level Up. ¿En qué te ayudamos con tu Pago Móvil o tu recarga de Free Fire?";
        
        if (data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0].text) {
            textoRespuesta = data.candidates[0].content.parts[0].text;
        } else if (data && data.error) {
            // Mensaje amigable ocultando el error técnico de cuota de la API
            textoRespuesta = "¡Hola! En este momento tenemos alta demanda en el asistente virtual. Por favor, haz clic abajo en el botón de WhatsApp para atenderte de inmediato con tu recarga.";
        }

        return res.status(200).json({
            status: "success",
            respuesta: textoRespuesta,
            respaldoWhatsapp: true 
        });

    } catch (error) {
        return res.status(200).json({ 
            status: "success", 
            respuesta: "¡Hola! Hubo un pequeño inconveniente de conexión. Escríbenos al soporte por WhatsApp para procesar tu recarga al instante.",
            respaldoWhatsapp: true
        });
    }
};
