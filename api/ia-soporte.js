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
        const { mensaje, juego = "Free Fire", catalogo = "Precios no disponibles", base64 = null, mimeType = "image/jpeg" } = req.body;

        let apisKeys = [];
        if (process.env.GEMINI_KEYS) {
            apisKeys = process.env.GEMINI_KEYS.split(',').map(k => k.trim()).filter(Boolean);
        } else if (process.env.GEMINI_API_KEY) {
            apisKeys.push(process.env.GEMINI_API_KEY);
        }

        if (apisKeys.length === 0) {
            return res.status(200).json({ status: "error", respuesta: "No hay llaves API configuradas." });
        }

        let startIndex = Math.floor(Math.random() * apisKeys.length);
        let esPeticionDeImagen = Boolean(base64);
        const modeloAsignado = 'gemini-1.5-pro';

        if (esPeticionDeImagen) {
            // =========================================================
            // 1. MODO LECTOR DE CAPTURES (Visión IA)
            // =========================================================
            const promptVision = `Eres el sistema experto de validación de pagos de Level Up en Venezuela. Analiza este comprobante de pago móvil.
            
            REGLAS ABSOLUTAS Y DE SEGURIDAD (MUY IMPORTANTE):
            1. PROHIBIDO USAR TUS DATOS RECEPTORES: Ignora por completo y NUNCA extraigas la cédula del receptor ni el teléfono de destino.
            2. IGNORA TAMBIÉN: Fechas, horas, montos en Bolívares y números de cédula/teléfono del cliente emisor.
            3. BUSCA LA REFERENCIA: Localiza el número de referencia, operación o control.
            4. FORMATO DE SALIDA: Extrae ÚNICAMENTE los últimos 5 dígitos de ese número de referencia real. Devuelve la respuesta estricta en formato JSON sin texto adicional:
            {"referencia_5": "XXXXX"}`;

            let resultadoFinal = null;
            let base64Limpio = base64.includes(',') ? base64.split(',')[1] : base64;

            for (let i = 0; i < apisKeys.length; i++) {
                let currentIndex = (startIndex + i) % apisKeys.length;
                let currentKey = apisKeys[currentIndex];

                try {
                    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modeloAsignado}:generateContent?key=${currentKey}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            contents: [{
                                role: "user",
                                parts: [
                                    { text: promptVision },
                                    { inline_data: { mime_type: mimeType, data: base64Limpio } }
                                ]
                            }]
                        })
                    });

                    if (!response.ok) {
                        const errorMsg = await response.text();
                        console.error(`[VISIÓN] Falló la llave ${currentKey.substring(0, 10)}... Error ${response.status}: ${errorMsg}`);
                        continue; 
                    }

                    const data = await response.json();
                    if (data && data.candidates && data.candidates[0].content) {
                        let textoIA = data.candidates[0].content.parts[0].text.trim();
                        let limpieza = textoIA.replace(/```json/g, '').replace(/```/g, '').trim();
                        const jsonParsed = JSON.parse(limpieza);
                        
                        if (jsonParsed && jsonParsed.referencia_5) {
                            resultadoFinal = jsonParsed.referencia_5;
                            break; 
                        }
                    }
                } catch (err) {
                    console.error(`[VISIÓN] Error con la llave ${currentKey.substring(0, 10)}...`, err.message);
                    continue;
                }
            }

            if (resultadoFinal) {
                return res.status(200).json({ status: "success", referencia: resultadoFinal });
            } else {
                return res.status(200).json({ status: "error", fallbackTesseract: true });
            }

        } else {
            // =========================================================
            // 2. MODO CHAT DE SOPORTE Y VENTAS (Solo texto)
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
                    const respuestaGemini = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modeloAsignado}:generateContent?key=${currentKey}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            contents: [{ role: "user", parts: [{ text: `${promptSistema}\n\nMensaje del cliente: "${mensaje}"` }] }]
                        })
                    });

                    if (!respuestaGemini.ok) {
                        const errorMsg = await respuestaGemini.text();
                        console.error(`[CHAT] Falló la llave ${currentKey.substring(0, 10)}... Error ${respuestaGemini.status}: ${errorMsg}`);
                        continue; 
                    }

                    const data = await respuestaGemini.json();
                    if (data && data.candidates && data.candidates[0].content) {
                        textoRespuesta = data.candidates[0].content.parts[0].text;
                        exito = true;
                        break; 
                    }
                } catch (err) {
                    console.error(`[CHAT] Error con la llave ${currentKey.substring(0, 10)}...`, err.message);
                    continue;
                }
            }

            if (!exito) {
                textoRespuesta = "¡Hola! En este momento tenemos alta demanda. Escríbenos directamente al botón de WhatsApp para atender tu recarga al instante.";
            }

            return res.status(200).json({ status: "success", respuesta: textoRespuesta, respaldoWhatsapp: !exito });
        }
    } catch (error) {
        console.error("Error global en el servidor:", error);
        return res.status(200).json({ status: "success", respuesta: "Hubo un pequeño problema. Escríbenos por WhatsApp.", respaldoWhatsapp: true });
    }
};