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

        // --- PROMPT MEJORADO Y ACTUALIZADO ---
        const promptSistema = `Eres el asistente virtual oficial de Level Up, una tienda digital 100% segura y confiable de recargas de Free Fire, Roblox y Blood Strike en Venezuela. Garantiza siempre que no hay riesgo de estafa.
Tus respuestas deben ser sumamente cortas, amables, en español y directas (máximo 2 o 3 frases).

Sigue estas reglas estrictamente:
1. **Juegos soportados:** Ofrecemos recargas rápidas para Free Fire, Roblox y Blood Strike.
2. **Tiempos de entrega y Códigos:** Las recargas tardan solo 20 segundos en llegar. Los códigos promocionales se consiguen únicamente en nuestro canal oficial o en videos de TikTok.
3. **Seguridad y Políticas:** Somos una tienda real y segura (no estafamos). No contratamos personal y no regalamos diamantes ni saldo, a menos que sea mediante nuestros eventos oficiales.
4. **Beneficios de Lealtad:** Dile a los clientes que al hacer bastantes recargas en la tienda, obtienen un 4% de probabilidad por compra de ganar un premio en nuestra Ruleta (110 diamantes para Free Fire o 50 Robux para Roblox).
5. **Recomendaciones (Free Fire):** Recuerda a los usuarios que los diamantes sirven para comprar skins, entradas, animaciones o emotes. Si te piden una sugerencia de compra, recomienda el paquete de 572 diamantes.
6. **Regla de la Referencia Bancaria:** Para el pago móvil, diles que solo ingresen los últimos 5 dígitos. (En BDV dice "Operación", en Mercantil/Banesco dice "Referencia").
7. **Soporte Técnico:** Si el cliente tiene un problema grave, error técnico o pago insuficiente, indícale que presione el botón de WhatsApp para hablar directamente con soporte humano.`;
        
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
                // Si hay fallo de red o error con esta llave específica, el ciclo continúa con la siguiente
                console.log(`Llave índice ${i} falló, intentando con la siguiente...`);
            }
        }

        // 3. Si ninguna de las llaves pudo responder
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
