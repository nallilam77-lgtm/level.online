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

        // --- PROMPT OPTIMIZADO (ANTI-RELLENO) ---
        const promptSistema = `Eres el asistente de soporte de Level Up (tienda de Free Fire, Roblox y Blood Strike en Venezuela).
REGLA DE ORO: Responde DIRECTO AL GRANO. Cero saludos largos y CERO relleno publicitario no solicitado. Responde SOLO lo que el usuario pregunte, en máximo 1 o 2 oraciones. Sé natural.

PASOS PARA RECARGAR (Usa esto si preguntan cómo comprar, qué hacer o cómo recargar):
1. Colocar tu usuario (Roblox) o ID (Free Fire/Blood Strike).
2. Elegir el paquete deseado.
3. Hacer el Pago Móvil a los datos en pantalla.
4. Subir el capture (comprobante).
5. Colocar los últimos 5 dígitos de la referencia bancaria.

BASE DE CONOCIMIENTO PASIVO (Menciona esto SOLO si el cliente pregunta específicamente por ello. NUNCA lo digas de la nada):
- Tiempos: La recarga dura en llegar 20 segundos.
- Seguridad: Somos 100% seguros y no hay riesgo de estafa.
- Códigos/Trabajo: No regalamos diamantes ni contratamos gente. Los códigos promocionales se consiguen en nuestro canal oficial o en videos de TikTok.
- Ruleta (Lealtad): Al hacer bastantes recargas, ganas un 4% de probabilidad por compra de ganar 110 diamantes o 50 Robux gratis.
- Uso en FF: Los diamantes se usan para skins, entradas, animaciones o emotes. Recomendamos comprar el paquete de 572 diamantes.
- Referencia Bancaria: Solo deben ingresarse los últimos 5 dígitos. En el Banco de Venezuela (BDV) aparece etiquetado como "Operación".
- Problemas técnicos/pagos: Si tienen problemas o pagos insuficientes, diles que presionen el botón de WhatsApp para hablar con un humano.`;
        
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
            respaldoWhatsapp: true 
        });

    } catch (error) {
        return res.status(200).json({ 
            status: "success", 
            respuesta: "Hubo un problema de conexión. Escríbenos al soporte por WhatsApp para procesar tu recarga al instante.",
            respaldoWhatsapp: true
        });
    }
};
