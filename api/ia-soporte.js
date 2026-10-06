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
        const { mensaje, juego = "Free Fire", catalogo = "Precios no disponibles" } = req.body || {};

        // La lectura de comprobantes la hace Tesseract en el navegador (public/js/lector-referencia.js)
        if (typeof mensaje !== 'string' || !mensaje.trim() || mensaje.length > 1000
            || typeof juego !== 'string' || juego.length > 40
            || typeof catalogo !== 'string' || catalogo.length > 8000) {
            return res.status(400).json({ status: "error", respuesta: "Mensaje inválido." });
        }

        let apisKeys = [];
        if (process.env.GEMINI_KEYS) {
            apisKeys = process.env.GEMINI_KEYS.split(',').map(k => k.trim()).filter(Boolean);
        } else if (process.env.GEMINI_API_KEY) {
            apisKeys.push(process.env.GEMINI_API_KEY);
        }

        if (apisKeys.length === 0) {
            console.error("[CHAT] No hay llaves de Gemini configuradas (GEMINI_KEYS / GEMINI_API_KEY).");
            return res.status(200).json({ status: "success", respuesta: "Escríbenos por WhatsApp para atender tu recarga al instante.", respaldoWhatsapp: true });
        }

        let startIndex = Math.floor(Math.random() * apisKeys.length);
        // gemini-1.5-* fue retirado por Google (responde 404); se puede cambiar sin tocar código con GEMINI_MODEL
        const modeloAsignado = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

        // =========================================================
        // CHAT DE SOPORTE Y VENTAS (Solo texto)
        // =========================================================
        const promptSistema = `Eres el Asistente Experto de Soporte y Ventas de Level Up. 
JUEGO ACTUAL: ${juego}
CATÁLOGO Y PRECIOS ACTUALES:
${catalogo}

REGLAS ABSOLUTAS:
1. Sé extremadamente breve (máximo 1 o 2 líneas). Ve al grano.
2. TU ÚNICO OBJETIVO: Ayudar al cliente exclusivamente si tiene un problema o duda en algún paso de la recarga.
3. REGLA DE DERIVACIÓN: Si el cliente presenta un problema complejo, un error de pago que no entiendes, o algo fuera de lo normal, DEBES indicarle amablemente que haga clic en el botón de WhatsApp.

FLUJO DE AYUDA:
- Si saluda o no sabe qué hacer: Pregúntale: "¿Cuál es tu ID de jugador y qué paquete deseas?"
- Si da su ID y paquete (Free Fire): Genera [ACCION_VERIFICAR:id:paquete]
- Si da su ID y paquete (Blood Strike o Roblox): Genera [ACCION_PAGO:id:paquete]
- Si el sistema ya confirmó el ID de Free Fire: Genera [ACCION_PAGO]`;

        let textoRespuesta = "";
        let exito = false;

        for (let i = 0; i < apisKeys.length; i++) {
            let currentIndex = (startIndex + i) % apisKeys.length;
            let currentKey = apisKeys[currentIndex];

            try {
                const respuestaGemini = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modeloAsignado}:generateContent`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': currentKey },
                    body: JSON.stringify({
                        contents: [{ role: "user", parts: [{ text: `${promptSistema}\n\nMensaje del cliente: "${mensaje}"` }] }]
                    })
                });

                if (!respuestaGemini.ok) {
                    const errorMsg = await respuestaGemini.text();
                    console.error(`[CHAT] Falló la llave #${currentIndex + 1}. Error ${respuestaGemini.status}: ${errorMsg}`);
                    continue; 
                }

                const data = await respuestaGemini.json();
                if (data && data.candidates && data.candidates[0].content) {
                    textoRespuesta = data.candidates[0].content.parts[0].text;
                    exito = true;
                    break; 
                }
            } catch (err) {
                console.error(`[CHAT] Error con la llave #${currentIndex + 1}`, err.message);
                continue;
            }
        }

        if (!exito) {
            textoRespuesta = "¡Hola! En este momento tenemos alta demanda. Escríbenos directamente al botón de WhatsApp para atender tu recarga al instante.";
        }

        return res.status(200).json({ status: "success", respuesta: textoRespuesta, respaldoWhatsapp: !exito });
    } catch (error) {
        console.error("Error global en el servidor:", error);
        return res.status(200).json({ status: "success", respuesta: "Hubo un pequeño problema. Escríbenos por WhatsApp.", respaldoWhatsapp: true });
    }
};