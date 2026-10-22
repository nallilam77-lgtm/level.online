import { llamarScript, LECTURA_APPS_SCRIPT } from './_lib/externo.js';

// La ruleta es un extra: si su Apps Script no está configurado o no responde,
// se avisa al cliente con un 503 claro y la compra no se ve afectada (nunca 500).
const JUEGOS_PERMITIDOS = ['Free Fire', 'Blood Strike', 'Roblox', 'Mobile Legends'];
const MENSAJE_NO_DISPONIBLE = "La ruleta no está disponible en este momento. Tu recarga no se ve afectada; intenta girar más tarde.";
const PREMIO_GANADOR = "100 Diamantes 💎";
const PREMIO_VACIO = "Vacío ❌";

// URL del Apps Script de la ruleta (trim: al pegarla en Vercel se cuelan espacios o saltos de línea)
function obtenerUrlRuleta() {
    const url = (process.env.SCRIPT_RULETA_URL || "").trim();
    if (!url) {
        console.error("❌ Falta la variable SCRIPT_RULETA_URL en Vercel (Settings > Environment Variables).");
        return null;
    }
    if (!url.startsWith("https://")) {
        console.error("❌ SCRIPT_RULETA_URL debe ser la URL https del Apps Script (https://script.google.com/macros/s/.../exec).");
        return null;
    }
    return url;
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ status: "error", message: "Método no permitido." });
    }

    try {
        const { id, referencia, juego } = req.body || {};

        if (!referencia || !id) {
            return res.status(400).json({ status: "error", message: "Faltan datos de validación para la ruleta." });
        }
        // Mismos formatos que exigen los endpoints de recarga (ID numérico o usuario de Roblox)
        if (!/^[A-Za-z0-9_]{2,30}$/.test(String(id)) || !/^\d{5}$/.test(String(referencia))
            || (juego !== undefined && !JUEGOS_PERMITIDOS.includes(juego))) {
            return res.status(400).json({ status: "error", message: "Datos con formato inválido para la ruleta." });
        }

        // 1. Primero consultamos/enviamos a Google Apps Script para que valide
        // si la referencia ya usó su giro de ruleta (esto lo programamos en tu GAS).
        const URL_GOOGLE_SCRIPT = obtenerUrlRuleta();
        if (!URL_GOOGLE_SCRIPT) {
            return res.status(503).json({ status: "error", message: MENSAJE_NO_DISPONIBLE });
        }

        // NOTA: Aquí evaluamos la probabilidad del 2% de forma estricta en servidor
        const numeroAleatorio = Math.random() * 100;
        let ganoPremio = numeroAleatorio <= 2; // Exactamente el 2% (de 0 a 2)
        let premioStr = ganoPremio ? PREMIO_GANADOR : PREMIO_VACIO;

        // apps-script/ruleta.gs es idempotente: si la misma referencia y el mismo jugador repiten
        // el giro, devuelve el premio ya anotado. Por eso se puede reintentar cuando Google falla o
        // tarda al despertar (antes, un solo fallo dejaba al cliente sin su giro).
        // El token es opcional: el script solo lo exige si tiene la propiedad TOKEN_VERCEL.
        const token = (process.env.SCRIPT_RECARGAS_TOKEN || '').trim();
        const cuerpo = {
            accion: "girar_ruleta",
            referencia: String(referencia),
            id_jugador: String(id),
            juego: juego || "Free Fire",
            premio: premioStr,
            ...(token && { token })
        };
        const inicio = Date.now();
        let resultadoGAS = await llamarScript(URL_GOOGLE_SCRIPT, cuerpo, LECTURA_APPS_SCRIPT);

        // El pago sigue "En proceso": la recarga se cierra en segundo plano justo después de responder
        // al cliente (cerrarEnSegundoPlano). Se repite una vez, solo si cabe en maxDuration (30 s):
        // como mucho 8 s de la primera llamada + 5 s de espera + 12 s del reintento.
        if (resultadoGAS?.enCierre && Date.now() - inicio < 8000) {
            await new Promise((r) => setTimeout(r, 5000));
            resultadoGAS = await llamarScript(URL_GOOGLE_SCRIPT, cuerpo, { tiempoMs: 12000 });
        }

        if (resultadoGAS?.enCierre) {
            return res.status(503).json({ status: "error", message: resultadoGAS.message || "Tu recarga se está terminando de registrar. Intenta girar de nuevo en unos segundos." });
        }

        if (resultadoGAS?.ocupado) {
            return res.status(503).json({ status: "error", message: "La ruleta está ocupada. Espera unos segundos e intenta de nuevo." });
        }

        // Si Google Script detecta que la referencia ya jugó o hubo un error de BD
        if (resultadoGAS?.status === "error") {
            return res.status(403).json({ 
                status: "error", 
                message: resultadoGAS.message || "Esta referencia ya participó en la ruleta o no es válida." 
            });
        }

        // Si el Google Script determinó que ya había girado previamente (por seguridad extra)
        if (resultadoGAS?.yaGiro) {
            return res.status(400).json({
                status: "error",
                message: "Esta referencia de pago ya consumió su intento en la ruleta."
            });
        }

        // Reintento de un giro ya hecho: manda el premio que quedó anotado, no el recién sorteado
        if (resultadoGAS?.repetido && resultadoGAS.premio) {
            premioStr = String(resultadoGAS.premio);
            ganoPremio = premioStr === PREMIO_GANADOR;
        }

        // 2. Calcular grados para la animación de la ruleta visual en el cliente
        // Suponiendo que 180deg es el premio y 0deg es vacío (según tu diseño conic-gradient)
        const vueltasBase = 1440; // 4 vueltas completas
        const gradosDestino = ganoPremio ? (vueltasBase + 180) : (vueltasBase + 0);

        return res.status(200).json({
            status: "success",
            ganador: ganoPremio,
            premio: premioStr,
            gradosDestino: gradosDestino
        });

    } catch (error) {
        // Apps Script lento (más de 20 s con reintento), caído o devolviendo HTML, u otro fallo inesperado
        console.error("Error en ruleta.js:", error.message);
        const mensaje = error.tiempoAgotado
            ? "La ruleta está tardando en responder. Espera un minuto e intenta de nuevo; si te dice que ya giraste, escríbenos por WhatsApp."
            : MENSAJE_NO_DISPONIBLE;
        return res.status(503).json({ status: "error", message: mensaje });
    }
}