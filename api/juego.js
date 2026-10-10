import { cargarJuego } from './_lib/juegos/index.js';

// Consultas por juego: /api/juego?juego=<freefire|bloodstrike|roblox>&accion=<precios|verificar>
//   - precios   (GET):  catálogo del juego, con caché.
//   - verificar (POST): { id } -> valida el ID del jugador (solo Free Fire).
// El juego y la acción van siempre en la URL; el cuerpo solo lleva datos. Cada módulo de
// api/_lib/juegos/ declara sus acciones, valida sus datos y responde como los endpoints anteriores.
export default async function handler(req, res) {
  try {
    const juego = await cargarJuego(req.query.juego);
    if (!juego) {
      return res.status(400).json({ status: "error", message: "Juego no válido." });
    }

    const { accion } = req.query;
    if (typeof accion !== 'string' || !Object.hasOwn(juego.acciones, accion)) {
      return res.status(400).json({ status: "error", message: "Acción no disponible para este juego." });
    }

    return await juego.acciones[accion](req, res);
  } catch (error) {
    // Fallo al cargar el módulo del juego u otro error no controlado por la acción
    console.error(`Error en api/juego (${req.query.juego}/${req.query.accion}):`, error.message);
    return res.status(500).json({ status: "error", message: "Falla interna del servidor." });
  }
}
