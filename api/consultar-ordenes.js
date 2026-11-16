import { faltaConfiguracion } from './_lib/validacion.js';
import { obtenerIp, permitirUso } from './_lib/limitador.js';
import { supabaseActivo, leer } from './_lib/supabase.js';

// Estado del pedido en Supabase -> lo que ve el cliente (clase: color de la etiqueta en index.html)
const ESTADOS = {
    completado: ['Entregada', 'completed'], en_proceso: ['En proceso', 'processing'], pendiente: ['Recibido', 'processing'],
    incompleto: ['Pago incompleto', 'pending'], en_revision: ['En revisión', 'pending'], problema: ['Con problema', 'pending'],
    reembolsado: ['Reembolsada', 'pending'],
};

// SOLO Supabase (desde 2026-11-16): todos los pedidos están ahí desde el 2026-11-13 (_lib/historial.js).
// La hoja (SCRIPT_RECARGAS_VERIFICACION) ya no se consulta: los pedidos anteriores al 13-nov no salen.
// Los IDs de Roblox se guardan en minúsculas; los demás son números.
async function recargasEnSupabase(playerId) {
    const filas = await leer('recargas', { id_jugador: String(playerId).toLowerCase() }, 'paquete,estado,creado,motivo_fallo,nota_admin&order=creado.desc&limit=5');
    return (Array.isArray(filas) ? filas : []).map((f) => {
        let [estado, clase] = ESTADOS[f.estado] || ['En revisión', 'pending'];
        // Pago que no llegó y está en "Revisar pagos" del panel (_lib/pagos-manual.js). La nota no sale de aquí.
        if (f.estado === 'pendiente' && String(f.nota_admin || '').startsWith('🖐️ Pago por verificar')) estado = 'Pendiente';   // el cliente no sabe que se revisa a mano
        // Rechazado desde "Revisar pagos": el motivo lo escribió el administrador para el cliente
        // (motivo_fallo "pago_rechazado"; el texto va en nota_admin tras PREFIJO_RECHAZO de _lib/pagos-manual.js)
        const PREFIJO = '❌ Pago rechazado: ';
        const nota = String(f.nota_admin || '');
        const motivo = f.estado === 'problema' && f.motivo_fallo === 'pago_rechazado'
            ? (nota.startsWith(PREFIJO) ? nota.slice(PREFIJO.length, PREFIJO.length + 200) : 'No pudimos confirmar tu pago.') : '';
        if (motivo) estado = 'Pago rechazado';
        return { paquete: f.paquete, fecha: f.creado, estado, clase, ...(motivo && { motivo }) };
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

        if (!supabaseActivo()) {
            return faltaConfiguracion(res, ["SUPABASE_URL", "SUPABASE_SECRET_KEY"], { success: false, message: "La consulta de recargas no está disponible en este momento." });
        }

        // Frena que alguien pruebe IDs uno tras otro para ver las recargas de otros
        const minutosEspera = await permitirUso(`consulta:${obtenerIp(req)}`);
        if (minutosEspera > 0) {
            return res.status(429).json({ success: false, message: `Hiciste demasiadas consultas. Espera ${minutosEspera} minutos e intenta de nuevo.` });
        }

        const recargas = await recargasEnSupabase(playerId);
        return res.status(200).json({ success: true, recargas });

    } catch (error) {
        console.error("⚠️ consultar-ordenes: Supabase no respondió:", error.message);
        return res.status(503).json({ success: false, message: "Error de conexión con la base de datos. Intenta de nuevo en un momento." });
    }
}
