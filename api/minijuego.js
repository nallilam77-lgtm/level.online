// MINIJUEGO "LLUVIA DE DIAMANTES" (public/minijuego.html). Tablas y funciones: supabase/minijuego.sql.
//   GET  /api/minijuego                      → { activo, sesion, fichas, costo, bsPorFicha, ranking, cierre }
//   GET  /api/minijuego?accion=ajustes       → { bsPorFicha, costo } (público, 5 min en la CDN: las tiendas
//                                              muestran "+N fichas" en cada paquete, js/fichas-tienda.js)
//   POST /api/minijuego?accion=empezar       → cobra las fichas y da { id, semilla, fichas }
//   POST /api/minijuego?accion=terminar      { id, registro } → { valida, puntos, fin, mejor, puesto }
// Todo con la sesión del cliente (cabecera Authorization, la agrega public/js/sesion.js); sin sesión solo
// se ve el ranking. Las fichas las da el disparador de Supabase al completarse una recarga.
//
// Seguridad: el servidor NO cree los puntos que manda el teléfono. Da la semilla al cobrar la partida y,
// al terminar, repite la partida con el motor compartido (public/js/lluvia-motor.js) usando el registro de
// movimientos del cofre: los puntos que valen son los que calcula aquí. Además la partida no puede
// terminar antes de lo que dura de verdad (no se puede "adelantar el reloj") ni quedar abierta para
// siempre. Cada partida se termina una sola vez.
import { randomInt } from 'node:crypto';
import { supabaseActivo, rpc, leer, actualizar, usuarioDelToken } from './_lib/supabase.js';
import { tokenDe } from './_lib/historial.js';
import { iniciosVE } from './_lib/semana.js';
import { registroValido, repetirPartida, PASO } from '../public/js/lluvia-motor.js';

const PUESTOS = 10;
const MAX_ABIERTA_MS = 20 * 60 * 1000;       // una partida abierta más de 20 min ya no se puede terminar
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Ajustes (Bs por ficha y costo): cambian poco, 5 min en memoria
let ajustes = null;
async function leerAjustes() {
  if (ajustes && Date.now() - ajustes.fecha < 5 * 60 * 1000) return ajustes;
  const [fila] = (await leer('juego_ajustes', { id: 1 }, 'bs_por_ficha,costo_partida')) || [];
  ajustes = { fecha: Date.now(), bsPorFicha: Number(fila?.bs_por_ficha) || 780, costo: Number(fila?.costo_partida) || 5 };
  return ajustes;
}

const limpiarRanking = (filas) => (Array.isArray(filas) ? filas : []).map((f) => ({
  puesto: Number(f.puesto) || 0,
  nombre: String(f.nombre || 'Jugador').slice(0, 40),
  foto: /^https:\/\/[^\s"'<>]{1,500}$/.test(String(f.foto || '')) ? f.foto : null,
  puntos: Number(f.puntos) || 0,
  soyYo: f.soy_yo === true,
}));

async function ranking(usuario) {
  const { semana } = iniciosVE();
  return limpiarRanking(await rpc('juego_ranking', { p_desde: semana, p_hasta: null, p_limite: PUESTOS, p_yo: usuario || null }));
}

async function estado(req, res, usuario) {
  const [aj, filas, fichas] = await Promise.all([
    leerAjustes(),
    ranking(usuario),
    usuario ? leer('juego_fichas', { usuario }, 'fichas') : null,
  ]);
  return res.status(200).json({
    status: 'success', activo: true, sesion: !!usuario,
    fichas: usuario ? Number(fichas?.[0]?.fichas) || 0 : 0,
    costo: aj.costo, bsPorFicha: aj.bsPorFicha,
    ranking: filas, cierre: iniciosVE().proximaSemana,
  });
}

async function empezar(req, res, usuario) {
  const semilla = randomInt(0, 2 ** 32);
  const r = await rpc('juego_empezar', { p_usuario: usuario, p_semilla: semilla });
  if (!r?.ok) {
    return res.status(200).json({ status: 'error', sinFichas: true, fichas: Number(r?.fichas) || 0, costo: Number(r?.costo) || 5, message: 'No tienes fichas suficientes.' });
  }
  return res.status(200).json({ status: 'success', id: r.id, semilla, fichas: r.fichas, costo: r.costo });
}

async function terminar(req, res, usuario) {
  const { id, registro } = req.body || {};
  if (typeof id !== 'string' || !UUID.test(id) || !registroValido(registro)) {
    return res.status(400).json({ status: 'error', message: 'Partida no válida.' });
  }
  const [partida] = (await leer('juego_partidas', { id, usuario }, 'semilla,estado,creada')) || [];
  if (!partida) return res.status(404).json({ status: 'error', message: 'Partida no encontrada.' });
  if (partida.estado !== 'abierta') return res.status(409).json({ status: 'error', message: 'Esta partida ya terminó.' });

  // El servidor juega la partida otra vez: estos son los puntos que valen
  const r = repetirPartida(Number(partida.semilla), registro);
  const duroMs = Date.now() - Date.parse(partida.creada);
  const minimoMs = r.ticks * PASO * 1000 * 0.9 - 2000;     // margen para la red y el arranque
  let motivo = '';
  if (r.usados !== registro.length) motivo = 'movimientos después del final';
  else if (duroMs < minimoMs) motivo = 'terminó antes de lo posible';
  else if (duroMs > MAX_ABIERTA_MS) motivo = 'partida vencida';
  const valida = !motivo;

  await actualizar('juego_partidas', `id=eq.${id}&usuario=eq.${usuario}&estado=eq.abierta`, {
    estado: valida ? 'valida' : 'invalida', puntos: r.puntos, ticks: r.ticks, registro,
    motivo: motivo || null, terminada: new Date().toISOString(),
  });
  if (!valida) console.warn(`⚠️ minijuego: partida ${id} inválida (${motivo}).`);

  const filas = await ranking(usuario);
  const yo = filas.find((f) => f.soyYo);
  return res.status(200).json({
    status: 'success', valida, puntos: r.puntos, fin: r.fin,
    mejor: yo ? yo.puntos : 0, puesto: yo ? yo.puesto : null, ranking: filas,
  });
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!supabaseActivo()) return res.status(200).json({ status: 'success', activo: false });
  if (req.method === 'GET' && req.query?.accion === 'ajustes') {
    try {
      const aj = await leerAjustes();
      res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300, stale-while-revalidate=3600');
      return res.status(200).json({ status: 'success', activo: true, bsPorFicha: aj.bsPorFicha, costo: aj.costo });
    } catch (error) {
      console.error('⚠️ minijuego (ajustes):', error.message);
      return res.status(503).json({ status: 'error', message: 'No disponible.' });
    }
  }
  const accion = req.method === 'GET' ? 'estado' : String(req.query?.accion || '');
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ status: 'error', message: 'Método no permitido' });
  try {
    const usuario = await usuarioDelToken(tokenDe(req));
    if (accion === 'estado') return await estado(req, res, usuario);
    if (!usuario) return res.status(401).json({ status: 'error', message: 'Inicia sesión para jugar.' });
    if (accion === 'empezar') return await empezar(req, res, usuario);
    if (accion === 'terminar') return await terminar(req, res, usuario);
    return res.status(400).json({ status: 'error', message: 'Acción no válida.' });
  } catch (error) {
    console.error(`⚠️ minijuego (${accion}):`, error.message);
    return res.status(503).json({ status: 'error', message: 'El juego no está disponible ahora. Intenta en un momento.' });
  }
}
