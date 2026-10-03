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
        const { mensaje, juego = "Free Fire", catalogo = "Precios no disponibles" } = req.body;

        let apisKeys = [];
        if (process.env.GEMINI_KEYS) {
            apisKeys = process.env.GEMINI_KEYS.split(',').map(k => k.trim()).filter(Boolean);
        } else if (process.env.GEMINI_API_KEY) {
            apisKeys.push(process.env.GEMINI_API_KEY);
        }

        if (apisKeys.length === 0) {
            return res.status(200).json({ 
                status: "success", 
                respuesta: "¡Hola! Por el momento el asistente está en mantenimiento. Escríbenos al botón de WhatsApp para atenderte de inmediato." 
            });
        }

        // --- PROMPT OPTIMIZADO PARA RESOLVER PROBLEMAS Y DERIVAR A WHATSAPP ---
        const promptSistema = `Eres el Asistente Experto de Soporte y Ventas de Level Up. 
JUEGO ACTUAL: ${juego}
CATÁLOGO Y PRECIOS ACTUALES:
${catalogo}

REGLAS ABSOLUTAS:
1. Sé extremadamente breve (máximo 1 o 2 líneas). Ve al grano.
2. TU ÚNICO OBJETIVO: Ayudar al cliente exclusivamente si tiene un problema o duda en algún paso de la recarga (dar el ID, elegir paquete, pagar o subir comprobante).
3. REGLA DE DERIVACIÓN: Si el cliente presenta un problema complejo, un error de pago que no entiendes, un reclamo, o algo que se salga de los pasos normales de recarga, DEBES indicarle amablemente que haga clic en el botón de WhatsApp para solucionárselo de inmediato.

FLUJO DE AYUDA PASO A PASO:
- Si saluda o no sabe qué hacer: Pregúntale: "¿Cuál es tu ID de jugador y qué paquete deseas?"
- Si da su ID y paquete (para Free Fire): Genera [ACCION_VERIFICAR:id:paquete]
- Si da su ID y paquete (para Blood Strike o Roblox): Genera [ACCION_PAGO:id:paquete]
- Si el sistema ya confirmó el ID de Free Fire: Genera [ACCION_PAGO] para mostrar los datos de pago.`;

        let textoRespuesta = "";
        let exito = false;
        let data = null;

        for (let i = 0; i < apisKeys.length; i++) {
            const currentKey = apisKeys[i];
            try {
                const respuestaGemini = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${currentKey}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [
                            { role: "user", parts: [{ text: `${promptSistema}\n\nMensaje del cliente: "${mensaje}"` }] }
                        ]
                    })
                });

                data = await respuestaGemini.json();

                if (data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0].text) {
                    textoRespuesta = data.candidates[0].content.parts[0].text;
                    exito = true;
                    break;
                }
            } catch (err) {
                console.log(`Llave índice ${i} falló, intentando con la siguiente...`);
            }
        }

        if (!exito) {
            textoRespuesta = "¡Hola! En este momento tenemos alta demanda. Escríbenos directamente al botón de WhatsApp para atender tu recarga al instante.";
        }

        return res.status(200).json({
            status: "success",
            respuesta: textoRespuesta,
            respaldoWhatsapp: !exito 
        });

    } catch (error) {
        return res.status(200).json({ 
            status: "success", 
            respuesta: "Hubo un pequeño problema. Escríbenos al soporte por WhatsApp para procesar tu recarga al instante.",
            respaldoWhatsapp: true
        });
    }
};
