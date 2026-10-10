import { cargarJuego } from './_lib/juegos/index.js';

// Recargas: POST /api/recargar?juego=<freefire|bloodstrike|roblox> (maxDuration 180 en vercel.json).
// Cada módulo de api/_lib/juegos/ valida sus datos y mantiene sus propios tiempos y reglas de
// reintento (Roblox nunca reintenta la compra), así que el enrutador solo decide a quién llamar.
export default async function handler(req, res) {
  try {
    // COMPATIBILIDAD TEMPORAL: la página anterior de Free Fire llamaba a /api/recargar sin ?juego.
    // Quitar este valor por defecto junto con las redirecciones de vercel.json.
    const juego = await cargarJuego(req.query.juego ?? 'freefire');
    if (!juego) {
      return res.status(400).json({ status: "error", message: "Juego no válido." });
    }

    return await juego.recargar(req, res);
  } catch (error) {
    // Fallo al cargar el módulo del juego (cada recarga maneja sus propios errores)
    console.error(`Error en api/recargar (${req.query.juego}):`, error.message);
    return res.status(500).json({ status: "error", message: "Falla interna del servidor." });
  }
}
