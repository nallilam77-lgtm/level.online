module.exports = async (req, res) => {
    // Headers de CORS para permitir la conexión desde el frontend
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

    // Preflight request
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    // Solo aceptamos peticiones POST
    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, message: "Método no permitido." });
    }

    try {
        const { playerId } = req.body;

        if (!playerId) {
            return res.status(400).json({ success: false, message: "ID de jugador no proporcionado." });
        }

        // Llamamos a tu NUEVA variable de entorno en Vercel
        const scriptUrl = process.env.SCRIPT_RECARGAS_VERIFICACION;
        
        if (!scriptUrl) {
            console.error("Falta la variable SCRIPT_RECARGAS_VERIFICACION en Vercel");
            return res.status(500).json({ success: false, message: "Error interno de configuración." });
        }

        // Hacemos la petición a la nueva hoja de cálculo de Google
        const respuestaGoogle = await fetch(`${scriptUrl}?id=${playerId}`);
        const data = await respuestaGoogle.json();

        // Si la hoja no devuelve nada o el ID no tiene recargas exitosas
        if (!data || data.length === 0) {
            return res.status(200).json({ success: true, recargas: [] });
        }

        // Formateamos los datos para que el index.html los lea y muestre correctamente
        const recargasFormateadas = data.map(fila => {
            return {
                paquete: fila.paquete,   // Ejemplo: "572 Diamantes" 
                fecha: fila.fecha,       // Ejemplo: "29/09/2026 19:20"
                estado: "Completed"      // Siempre completado porque lee de la pestaña "exitoso"
            };
        });

        // Enviamos la respuesta exitosa al cliente
        return res.status(200).json({
            success: true,
            recargas: recargasFormateadas
        });

    } catch (error) {
        console.error("Error consultando la hoja de cálculo:", error);
        return res.status(500).json({ success: false, message: "Error de conexión con la base de datos." });
    }
};