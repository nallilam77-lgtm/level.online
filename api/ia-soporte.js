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
        // AHORA RECIBIMOS EL JUEGO Y EL CATÁLOGO DESDE LA WEB
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

        // --- PROMPT OPTIMIZADO PARA TODOS LOS JUEGOS Y CATÁLOGO EN TIEMPO REAL ---
        const promptSistema = `Eres el Asistente de Ventas de Level Up. Tu trabajo es guiar al cliente PASO A PASO para que complete su recarga directamente desde este chat.
JUEGO ACTUAL DEL CLIENTE: ${juego}
PRECIOS Y PAQUETES DISPONIBLES AHORA MISMO:
${catalogo}

REGLA DE ORO: Responde muy corto, directo y amable. Cero textos largos. Usa SIEMPRE los precios exactos del catálogo.

DEBES SEGUIR ESTE FLUJO EXACTO:
PASO 1: Saluda y pregúntale: "¿Cuál es tu ID de jugador (o usuario) y qué paquete deseas comprar?".
PASO 2: Dependiendo del juego actual (${juego}), haz lo siguiente cuando el cliente te dé su ID y el paquete:
- Si el juego es "FREE FIRE": DEBES generar esta etiqueta exacta para verificar su nombre [ACCION_VERIFICAR:aqui_el_id:aqui_el_paquete]
  (Ejemplo: [ACCION_VERIFICAR:8792077932:100 diamantes] Dale al botón para confirmar tu nombre en el juego.)
- Si el juego es "BLOOD STRIKE", "ROBLOX" o cualquier otro: NO se verifica el ID. Pasa directamente a dar la etiqueta de pago CON los datos incluidos [ACCION_PAGO:aqui_el_id:aqui_el_paquete]
  (Ejemplo: [ACCION_PAGO:8792077932:51 de oro] ¡Excelente! Haz el pago a estos datos, sube tu comprobante y dale a Procesar Recarga.)
PASO 3: (Solo para Free Fire) Cuando el cliente confirme que su nombre verificado es correcto, genera la etiqueta de pago simple: [ACCION_PAGO]

INFO EXTRA:
- La referencia: Son los últimos 5 dígitos del pago móvil.
- Seguridad: Somos 100% seguros y rápidos.`;

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
            textoRespuesta = "¡Hola! En este momento tenemos alta demanda en el asistente virtual. Por favor, haz clic abajo en el botón de WhatsApp para atenderte de inmediato con tu recarga.";
        }

        return res.status(200).json({
            status: "success",
            respuesta: textoRespuesta,
            respaldoWhatsapp: !exito 
        });

    } catch (error) {
        return res.status(200).json({ 
            status: "success", 
            respuesta: "Hubo un problema de conexión. Escríbenos al soporte por WhatsApp para procesar tu recarga al instante.",
            respaldoWhatsapp: true
        });
    }
};
