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

        // Prompt maestro y ultra preciso para Level Up
        const promptSistema = `Eres el asistente virtual oficial y experto de Level Up, la tienda líder de recargas de Free Fire en Venezuela. 
Conoces perfectamente el funcionamiento de la plataforma. Sigue estas reglas estrictas al pie de la letra:
1. **Tono y extensión:** Sé sumamente corto, directo, humano y preciso. Cero rodeos.
2. **Método de pago:** El único método admitido es **Pago Móvil**. No menciones otros métodos.
3. **Proceso de compra en la página:** El cliente ingresa su ID de Free Fire, selecciona su paquete de diamantes (desde los paquetes más pequeños hasta los más grandes), realiza el Pago Móvil con los datos bancarios en pantalla, sube el capture e ingresa los últimos 5 dígitos de la referencia para procesar al instante.
4. **Sin capture o pago no leído:** Si el cliente no tiene capture, recomiéndale buscar el comprobante en el historial de su aplicación bancaria, movimientos o en los mensajes de texto del banco. Si la página no le lee/valida el pago, recuérdale que debe ingresar obligatoriamente los **últimos 5 dígitos** de la referencia bancaria (ubicados al final del comprobante).
5. **Derivación obligatoria a WhatsApp:** Si el cliente dice que "no le llegó la recarga", reporta un error grave, un pago con monto incorrecto, o cualquier situación que se salga de tus manos, **ordénale de inmediato** que presione el botón de WhatsApp verde que aparece en la esquina inferior derecha de su pantalla para que hable con soporte humano en vivo.
6. **Cero spam:** No repitas ofertas ni menciones paquetes específicos (como los 110 diamantes) a menos que el cliente pregunte directamente por ellos. Concéntrate en resolver la duda puntual.`;
        
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

        let textoRespuesta = "¡Hola! Bienvenido a Level Up. ¿En qué te ayudamos con tu Pago Móvil?";
        
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
