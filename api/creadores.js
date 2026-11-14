import { supabaseActivo, rpc, usuarioDelToken } from './_lib/supabase.js';
import { tokenDe } from './_lib/historial.js';

// Panel de creadores (creadores.html), SOLO con "Entrar con Google" desde 2026-11-13:
// POST { cuenta: true } + Authorization: Bearer <token de la sesión> -> los códigos cuyo correo puso el
// administrador en admin.html (función creador_por_usuario de supabase/codigos.sql). El usuario sale del
// token (Supabase lo comprueba), nunca de lo que mande la página. El creador no puede darse acceso solo.
// El código + PIN ya no abre el panel (el PIN queda guardado en "codigos" solo como dato del creador).
const RETIRO_MINIMO_USD = 3;

const numero = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
// Sin tasa del dólar en la hoja, los montos en USD llegan como null (no se inventan)
const numeroONulo = (v) => (v === null || v === undefined || v === '' ? null : numero(v));

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ status: "error", message: "Método no permitido" });
  // Desde 2026-11-13 el panel es SOLO con Google: el código + PIN ya no abre nada
  if (req.body?.cuenta !== true) {
    return res.status(410).json({ status: "error", encontrado: false, message: "Ahora entras a tu panel con tu cuenta de Google. Pídenos tu acceso por WhatsApp." });
  }
  return panelPorCuenta(req, res);
}

// "Entrar con Google": el usuario sale del token (Supabase lo comprueba), nunca de lo que mande la página
async function panelPorCuenta(req, res) {
  if (!supabaseActivo()) return res.status(503).json({ status: "error", message: "El panel no está disponible ahora. Intenta de nuevo en unos minutos." });
  const usuario = await usuarioDelToken(tokenDe(req));
  if (!usuario) return res.status(401).json({ status: "error", sesion: false, message: "Tu sesión venció. Vuelve a entrar con Google." });
  try {
    const d = await rpc('creador_por_usuario', { p_usuario: usuario });
    const codigos = (Array.isArray(d?.codigos) ? d.codigos : []).filter(Boolean).map((c) => {
      const pendienteUsd = numeroONulo(c.pendienteUsd);
      return {
        ...respuestaPanel({
          ...c, descuentoSeguidores: c.porcentaje, comisionPorcentaje: c.porcentaje, retiroMinimoUsd: RETIRO_MINIMO_USD,
          faltaParaRetiroUsd: pendienteUsd !== null ? Math.max(0, Math.round((RETIRO_MINIMO_USD - pendienteUsd) * 100) / 100) : null,
        }),
        activo: c.activo !== false,
      };
    });
    return res.status(200).json({ status: "success", correo: String(d?.correo || ''), codigos });
  } catch (error) {
    console.error("Error en el panel de creadores (Google):", error.message);
    return res.status(503).json({ status: "error", message: "No pudimos abrir tu panel ahora. Intenta de nuevo en unos segundos." });
  }
}

const NOMBRES_JUEGO = {
  freefire: 'Free Fire', bloodstrike: 'Blood Strike', mobilelegends: 'Mobile Legends', roblox: 'Roblox',
  fcmobile: 'FC Mobile', codmobile: 'COD Mobile', clashroyale: 'Clash Royale',
};

function respuestaPanel(datos) {
  const movimientos = Array.isArray(datos.movimientos) ? datos.movimientos.slice(0, 10) : [];
  return {
    status: "success",
    encontrado: true,
    codigo: String(datos.codigo),
    descuentoSeguidores: numero(datos.descuentoSeguidores),
    usos: numero(datos.usos),
    ventasBs: numero(datos.ventasBs),
    comisionPorcentaje: numero(datos.comisionPorcentaje),
    comisionTotalUsd: numeroONulo(datos.comisionTotalUsd),
    pendienteUsd: numeroONulo(datos.pendienteUsd),
    retiroMinimoUsd: numero(datos.retiroMinimoUsd),
    faltaParaRetiroUsd: numeroONulo(datos.faltaParaRetiroUsd),
    tasa: datos.tasa ? numero(datos.tasa) : null,
    movimientos: movimientos.map((m) => ({
      fecha: String(m.fecha || '').slice(0, 20),
      juego: String(NOMBRES_JUEGO[m.juego] || m.juego || '').slice(0, 20),
      ventaBs: numero(m.ventaBs),
      comisionUsd: numeroONulo(m.comisionUsd),
    })),
  };
}
