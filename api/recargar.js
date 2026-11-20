import { cargarJuego } from './_lib/juegos/index.js';
import { conHistorial, prepararCompletarDesdePerfil } from './_lib/historial.js';

// Recargas: POST /api/recargar?juego=<freefire|bloodstrike|roblox> (maxDuration 180 en vercel.json).
// Cada módulo de api/_lib/juegos/ valida sus datos y mantiene sus propios tiempos y reglas de
// reintento (Roblox nunca reintenta la compra), así que el enrutador solo decide a quién llamar.
// Con sesión iniciada (cabecera Authorization), conHistorial guarda la recarga en el perfil del cliente
// después de responder (_lib/historial.js); sin sesión no hace nada.
export default async function handler(req, res) {
  try {
    // Panel admin → Pagos por aprobar: aprobar un pago a mano HACE la recarga del cliente aquí (180 s); solo administrador
    if (req.query.accion === 'solicitud_resolver') return (await import('./_lib/pagos-manual.js')).solicitudResolver(req, res);
    // El pago de alguien que esperaba en "Revisar pagos" llegó por la macro: se suelta solo (llamada interna)
    if (req.query.accion === 'solicitud_auto') return (await import('./_lib/pagos-manual.js')).solicitudAuto(req, res);
    // COMPATIBILIDAD TEMPORAL: la página anterior de Free Fire llamaba a /api/recargar sin ?juego.
    // Quitar este valor por defecto junto con las redirecciones de vercel.json.
    const juego = await cargarJuego(req.query.juego ?? 'freefire');
    if (!juego) {
      return res.status(400).json({ status: "error", message: "Juego no válido." });
    }

    const clave = String(req.query.juego ?? 'freefire');
    // Completar un pago insuficiente desde el perfil (cuenta de Level Up): se comprueba el dueño del pedido
    if (req.method === 'POST' && req.body && typeof req.body === 'object' && req.body.completarPedido !== undefined) {
      const rechazo = await prepararCompletarDesdePerfil(req, clave);
      if (rechazo) return res.status(rechazo.codigo).json(rechazo.cuerpo);
    }
    return await conHistorial(req, res, clave, () => juego.recargar(req, res));
  } catch (error) {
    // Fallo al cargar el módulo del juego (cada recarga maneja sus propios errores)
    console.error(`Error en api/recargar (${req.query.juego}):`, error.message);
    return res.status(500).json({ status: "error", message: "Falla interna del servidor." });
  }
}
