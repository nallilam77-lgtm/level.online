import { cargarJuego } from './_lib/juegos/index.js';

// Consultas por juego: /api/juego?juego=<freefire|bloodstrike|roblox>&accion=<precios|verificar>
//   - precios   (GET):  catálogo del juego, con caché.
//   - verificar (POST): { id } -> valida el ID del jugador (Free Fire y Blood Strike).
//   - traer_productos (POST, solo administrador): copia el catálogo de Central One del juego a Supabase.
// El juego y la acción van siempre en la URL; el cuerpo solo lleva datos. Cada módulo de
// api/_lib/juegos/ declara sus acciones, valida sus datos y responde como los endpoints anteriores.
export default async function handler(req, res) {
  try {
    // Panel admin → Resumen: saldo de Central One (solo administrador; _lib/precios.js). No es de un juego.
    // MacroDroid: cada pago que llega al teléfono (etapa 1 de los pagos en Supabase; _lib/pagos.js)
    if (req.query.accion === 'pago_recibido') return (await import('./_lib/pagos.js')).pagoRecibido(req, res);
    // Panel admin → Pagos: agregar un pago a mano y limpiar (solo administrador)
    if (req.query.accion === 'pago_manual') return (await import('./_lib/pagos.js')).pagoManual(req, res);
    if (req.query.accion === 'pagos_limpiar') return (await import('./_lib/pagos.js')).limpiarPagos(req, res);
    if (req.query.accion === 'saldo_centralone') return (await import('./_lib/precios.js')).saldoCentralOne(req, res);
    const juego = await cargarJuego(req.query.juego);
    if (!juego) {
      return res.status(400).json({ status: "error", message: "Juego no válido." });
    }

    const { accion } = req.query;
    // Panel admin → Precios: "🔄 Traer productos de Central One" (solo administrador; _lib/precios.js)
    if (accion === 'traer_productos') return (await import('./_lib/precios.js')).traerProductos(req, res, req.query.juego);
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
