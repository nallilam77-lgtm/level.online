import { supabaseActivo, rpc } from './_lib/supabase.js';

// RULETA (desde 2026-11-15 en Supabase: supabase/ruleta.sql, función ruleta_girar). Antes usaba el Apps
// Script de la ruleta y la pestaña "pagos" de la hoja, que desde el 2026-11-14 ya no recibe pagos.
// Cada recarga completada (o en camino) de los últimos 3 días gira UNA vez: el cliente manda su ID y los
// 5 dígitos de la referencia, los mismos de la recarga. El premio se sortea aquí; Supabase lo anota en un
// solo paso y, si el mismo jugador repite el giro, devuelve el premio ya anotado.
// La ruleta es un extra: si algo falla se responde 503 claro y la compra no se ve afectada (nunca 500).
const JUEGOS = { 'Free Fire': 'freefire', 'Blood Strike': 'bloodstrike', 'Roblox': 'roblox', 'Mobile Legends': 'mobilelegends' };
const MENSAJE_NO_DISPONIBLE = "La ruleta no está disponible en este momento. Tu recarga no se ve afectada; intenta girar más tarde.";
const PREMIO_GANADOR = "100 Diamantes 💎";
const PREMIO_VACIO = "Vacío ❌";
// Probabilidad de ganar en cada giro, en % (se sortea solo en el servidor)
const PROBABILIDAD_GANAR = 1;
const MENSAJES = {
    sin_completar: "❌ Esa recarga todavía no se completó. Si quedó en revisión, escríbenos por WhatsApp.",
    en_cierre: "⏳ Tu recarga se está terminando de registrar. Intenta girar de nuevo en unos segundos.",
    no_existe: "❌ No encontramos una recarga completada con ese ID y esa referencia en los últimos 3 días.",
};
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ status: "error", message: "Método no permitido." });
    }

    try {
        const { id, referencia, juego = 'Free Fire' } = req.body || {};

        if (!referencia || !id) {
            return res.status(400).json({ status: "error", message: "Faltan datos de validación para la ruleta." });
        }
        // Mismos formatos que exigen los endpoints de recarga (ID numérico o usuario de Roblox)
        if (!/^[A-Za-z0-9_]{2,30}$/.test(String(id)) || !/^\d{5}$/.test(String(referencia)) || !Object.hasOwn(JUEGOS, juego)) {
            return res.status(400).json({ status: "error", message: "Datos con formato inválido para la ruleta." });
        }
        if (!supabaseActivo()) {
            console.error("❌ ruleta: Supabase no está configurado en Vercel");
            return res.status(503).json({ status: "error", message: MENSAJE_NO_DISPONIBLE });
        }

        // El premio se sortea en el servidor: Math.random() * 100 va de 0 a 99,99…, así que "< 1" es el 1 %
        const gano = Math.random() * 100 < PROBABILIDAD_GANAR;
        const girar = () => rpc('ruleta_girar', {
            p_juego: JUEGOS[juego], p_id_jugador: String(id), p_ultimos5: String(referencia),
            p_premio: gano ? PREMIO_GANADOR : PREMIO_VACIO, p_gano: gano,
        });
        let r = await girar();
        // La fila de la recarga se guarda justo después de responder al cliente: se espera y se repite
        // (caben en los 30 s de maxDuration)
        for (const espera of [3000, 5000]) {
            if (r?.motivo !== 'en_cierre') break;
            await esperar(espera);
            r = await girar();
        }

        if (!r?.ok) {
            const codigo = r?.motivo === 'en_cierre' ? 503 : 403;
            return res.status(codigo).json({ status: "error", message: MENSAJES[r?.motivo] || MENSAJES.no_existe });
        }

        const premio = String(r.premio);
        const ganador = premio === PREMIO_GANADOR;
        if (ganador && !r.repetido) console.info(`🎉 ruleta: ganó ${premio} · ${juego} · ID ${id}`);
        // Grados para la animación (180° = premio, 0° = vacío, según el conic-gradient de las tiendas)
        const vueltasBase = 1440; // 4 vueltas completas
        return res.status(200).json({
            status: "success",
            ganador,
            premio,
            gradosDestino: vueltasBase + (ganador ? 180 : 0),
        });
    } catch (error) {
        // Supabase caído, lento o sin la función (falta correr supabase/ruleta.sql)
        console.error("Error en ruleta.js:", error.message);
        return res.status(503).json({ status: "error", message: MENSAJE_NO_DISPONIBLE });
    }
}
