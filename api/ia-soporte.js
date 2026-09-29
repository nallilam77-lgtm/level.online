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

        // 1. Extraer todas las llaves de la variable GEMINI_KEYS separadas por comas
        let apisKeys = [];
        if (process.env.GEMINI_KEYS) {
            apisKeys = process.env.GEMINI_KEYS.split(',').map(k => k.trim()).filter(Boolean);
        } else if (process.env.GEMINI_API_KEY) {
            // Respaldo por si quedó la clásica suelta
            apisKeys.push(process.env.GEMINI_API_KEY);
        }

        if (apisKeys.length === 0) {
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
        
        let textoRespuesta = "";
        let exito = false;
        let data = null;

        // 2. Bucle inteligente de rotación: Prueba cada llave de la lista en orden
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

                // Verificar si la respuesta fue exitosa y trajo contenido válido
                if (data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0].text) {
                    textoRespuesta = data.candidates[0].content.parts[0].text;
                    exito = true;
                    break; // ¡Encontró una llave funcional! Rompemos el ciclo de inmediato.
                }
            } catch (err) {
                // Si hay fallo de red o error con esta llave específica, el ciclo continúa con la siguiente de manera silenciosa
                console.log(`Llave índice ${i} falló, intentando con la siguiente...`);
            }
        }

        // 3. Si ninguna de las llaves pudo responder (todas agotadas o con error)
        if (!exito) {
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
