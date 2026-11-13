import { pedirJSON, LECTURA_APPS_SCRIPT } from './_lib/externo.js';
import { faltaConfiguracion } from './_lib/validacion.js';
import { obtenerIp, permitirUso } from './_lib/limitador.js';
import { supabaseActivo, leer } from './_lib/supabase.js';

// Estado del pedido en Supabase -> lo que ve el cliente (clase: color de la etiqueta en index.html)
const ESTADOS = {
    completado: ['Entregada', 'completed'], en_proceso: ['En proceso', 'processing'], pendiente: ['Recibido', 'processing'],
    incompleto: ['Pago incompleto', 'pending'], en_revision: ['En revisión', 'pending'], problema: ['Con problema', 'pending'],
    reembolsado: ['Reembolsada', 'pending'],
};

// Desde 2026-11-13 todos los pedidos están en Supabase (_lib/historial.js): se buscan ahí primero (rápido y
// con el estado real). Los IDs de Roblox se guardan en minúsculas; los demás son números.
async function recargasEnSupabase(playerId) {
    if (!supabaseActivo()) return [];
    const filas = await leer('recargas', { id_jugador: String(playerId).toLowerCase() }, 'paquete,estado,creado&order=creado.desc&limit=5');
    return (Array.isArray(filas) ? filas : []).map((f) => {
        const [estado, clase] = ESTADOS[f.estado] || ['En revisión', 'pending'];
        return { paquete: f.paquete, fecha: f.creado, estado, clase };
    });
}

export default async function handler(req, res) {
    // Headers de CORS: solo el dominio de la tienda (igual que vercel.json)
    res.setHeader('Access-Control-Allow-Origin', 'https://levelupstore.online');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Preflight request
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    // Solo aceptamos peticiones POST
    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, message: "Método no permitido." });
    }

    try {
        const { playerId } = req.body || {};

        if (!playerId) {
            return res.status(400).json({ success: false, message: "ID de jugador no proporcionado." });
        }
        // IDs de Free Fire / Blood Strike (números) o usuarios de Roblox (letras, números y _)
        if (!/^[A-Za-z0-9_]{2,30}$/.test(String(playerId))) {
            return res.status(400).json({ success: false, message: "ID de jugador con formato inválido." });
        }

        // Frena que alguien pruebe IDs uno tras otro para ver las recargas de otros
        const minutosEspera = await permitirUso(`consulta:${obtenerIp(req)}`);
        if (minutosEspera > 0) {
            return res.status(429).json({ success: false, message: `Hiciste demasiadas consultas. Espera ${minutosEspera} minutos e intenta de nuevo.` });
        }

        try {
            const recargas = await recargasEnSupabase(playerId);
            if (recargas.length) return res.status(200).json({ success: true, recargas });
        } catch (error) {
            console.error("⚠️ consultar-ordenes: Supabase no respondió, se consulta la hoja:", error.message);
        }

        // Pedidos de antes de Supabase (o Supabase caído): la hoja de cálculo, como siempre
        const scriptUrl = process.env.SCRIPT_RECARGAS_VERIFICACION;
        
        if (!scriptUrl) {
            return faltaConfiguracion(res, ["SCRIPT_RECARGAS_VERIFICACION"], { success: false, message: "La consulta de recargas no está disponible en este momento." });
        }

        // Hacemos la petición a la nueva hoja de cálculo de Google
        // Consulta sin efectos secundarios: presupuesto de lectura (20 s con 1 reintento)
        const data = await pedirJSON(`${scriptUrl}?id=${encodeURIComponent(playerId)}`, { metodo: 'GET', ...LECTURA_APPS_SCRIPT });

        // Si la hoja no devuelve nada o el ID no tiene recargas exitosas
        if (!Array.isArray(data) || data.length === 0) {
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
        console.error("Error consultando la hoja de cálculo:", error.message);
        return res.status(error.name === 'ErrorExterno' ? 503 : 500).json({ success: false, message: "Error de conexión con la base de datos." });
    }
}