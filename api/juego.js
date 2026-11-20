import { cargarJuego } from './_lib/juegos/index.js';

// Consultas por juego: /api/juego?juego=<freefire|bloodstrike|roblox>&accion=<precios|verificar>
//   - precios   (GET):  catálogo del juego, con caché.
//   - verificar (POST): { id } -> valida el ID del jugador (Free Fire y Blood Strike).
//   - traer_productos (POST, solo administrador): copia el catálogo de Central One del juego a Supabase.
// El juego y la acción van siempre en la URL; el cuerpo solo lleva datos. Cada módulo de
// api/_lib/juegos/ declara sus acciones, valida sus datos y responde como los endpoints anteriores.
const ACCIONES_ARENA = {
  arena_config: 'config', arena_inscribir: 'inscribir', arena_push: 'guardarPush', arena_sala: 'sala', arena_evento: 'evento', arena_tic: 'tic',
};

export default async function handler(req, res) {
  try {
    // Panel admin → Resumen: saldo de Central One (solo administrador; _lib/precios.js). No es de un juego.
    // MacroDroid: cada pago que llega al teléfono (etapa 1 de los pagos en Supabase; _lib/pagos.js)
    if (req.query.accion === 'pago_recibido') return (await import('./_lib/pagos.js')).pagoRecibido(req, res);
    // Panel admin → Pagos: agregar un pago a mano y limpiar (solo administrador)
    if (req.query.accion === 'pago_manual') return (await import('./_lib/pagos.js')).pagoManual(req, res);
    if (req.query.accion === 'pagos_limpiar') return (await import('./_lib/pagos.js')).limpiarPagos(req, res);
    if (req.query.accion === 'pago_estado') return (await import('./_lib/pagos.js')).pagoEstado(req, res);
    // Pagos verificados a mano (_lib/pagos-manual.js): la tienda pregunta cómo va (público, por id). Aprobar o
    // rechazar va por /api/recargar?accion=solicitud_resolver (al aprobar se hace la recarga: necesita sus 180 s)
    if (req.query.accion === 'solicitud_estado') return (await import('./_lib/pagos-manual.js')).solicitudEstado(req, res);
    if (req.query.accion === 'saldo_centralone') return (await import('./_lib/precios.js')).saldoCentralOne(req, res);
    // Códigos de regalo (canjear.html; _lib/canjes.js): canjear (público, con límite de intentos) y la lista de canjes
    if (req.query.accion === 'canjear') return (await import('./_lib/canjes.js')).canjear(req, res);
    if (req.query.accion === 'canjes') return (await import('./_lib/canjes.js')).canjesPublicos(req, res);
    if (req.query.accion === 'reto_canje') return (await import('./_lib/canjes.js')).retoCanje(req, res);
    // Panel admin → Revisión: verificar en Central One y rehacer una recarga (solo administrador; _lib/revision.js)
    if (req.query.accion === 'revision_verificar') return (await import('./_lib/revision.js')).verificarRevision(req, res);
    if (req.query.accion === 'revision_rehacer') return (await import('./_lib/revision.js')).rehacerRevision(req, res);
    // Arena de Duelo de Acero (_lib/arena.js; aquí y no en un archivo propio: el plan de Vercel admite 12 funciones)
    if (Object.hasOwn(ACCIONES_ARENA, req.query.accion)) return (await import('./_lib/arena.js'))[ACCIONES_ARENA[req.query.accion]](req, res);
    // Panel → Resumen: respuesta COMPLETA de Central One al verificar un ID (solo administrador; _lib/validador.js)
    if (req.query.accion === 'verificar_crudo') return verificarCrudo(req, res);
    // Panel → Precios: un pedido que espera stock se cambia por otro paquete (solo administrador; _lib/esperas.js)
    if (req.query.accion === 'espera_cambiar') return (await import('./_lib/esperas.js')).cambiarEspera(req, res);
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

async function verificarCrudo(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ status: 'error', message: 'Método no permitido' });
  const { esAdminToken } = await import('./_lib/supabase.js');
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!(await esAdminToken(token))) return res.status(403).json({ status: 'error', message: 'Solo el administrador.' });
  const juego = String(req.body?.juego || '');
  const id = String(req.body?.id ?? '').trim();
  const zona = String(req.body?.zona ?? '').trim();
  if (!/^\d{3,20}$/.test(id) || (zona && !/^\d{1,8}$/.test(zona))) return res.status(400).json({ status: 'error', message: 'Escribe el ID (y la Zona ID) solo con números.' });
  try {
    const r = await (await import('./_lib/validador.js')).validarCrudo(juego, id, zona);
    if (r.error) return res.status(400).json({ status: 'error', message: r.error });
    return res.status(200).json({ status: 'success', ...r });
  } catch (error) {
    return res.status(503).json({ status: 'error', message: `Central One no respondió: ${error.name === 'TimeoutError' ? 'tiempo agotado' : error.message}` });
  }
}
