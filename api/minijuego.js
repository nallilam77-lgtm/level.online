// MINIJUEGO "LLUVIA DE DIAMANTES" (public/minijuego.html). Tablas y funciones: supabase/minijuego.sql.
//   GET  /api/minijuego                      → { activo, sesion, fichas, costo, bsPorFicha, ranking, cierre }
//   GET  /api/minijuego?accion=ajustes       → { bsPorFicha, costo } (público, 5 min en la CDN: las tiendas
//                                              muestran "+N fichas" en cada paquete, js/fichas-tienda.js)
//   POST /api/minijuego?accion=empezar       { clave } → cobra las fichas y da { id, semilla, fichas }
//                                              (misma clave = misma partida: un reintento no cobra dos veces)
//   POST /api/minijuego?accion=terminar      { id, registro } → { valida, puntos, fin, mejor, puesto }
// Todo con la sesión del cliente (cabecera Authorization, la agrega public/js/sesion.js); sin sesión solo
// se ve el ranking. Las fichas las da el disparador de Supabase al completarse una recarga.
//
// Seguridad: el servidor NO cree los puntos que manda el teléfono. Da la semilla al cobrar la partida y,
// al terminar, repite la partida con el motor compartido (public/js/lluvia-motor.js) usando el registro de
// movimientos del cofre: los puntos que valen son los que calcula aquí. Además el tiempo REAL de la
// partida tiene que cuadrar con lo que duró el juego: ni más corto (adelantar el reloj) ni mucho más largo
// (jugar en cámara lenta o pausar para pensar). Cada partida se termina una sola vez. Las partidas
// demasiado perfectas quedan marcadas "revisar" (posible programa que juega solo): cuentan, pero hay que
// revisarlas antes de pagar el premio (función juego_revision de supabase/minijuego.sql).
import { randomInt } from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import { supabaseActivo, rpc, leer, actualizar, usuarioDelToken } from './_lib/supabase.js';
import { tokenDe } from './_lib/historial.js';
import { iniciosVE } from './_lib/semana.js';
import { registroValido, repetirPartida, PASO } from '../public/js/lluvia-motor.js';

const PUESTOS = 10;
// Tiempo real permitido para una partida de N segundos de juego: entre N × 0,98 − 1 s (la respuesta de
// "empezar" tarda en llegar, así que el tiempo real siempre es algo mayor) y N × 1,05 + 8 s (margen para
// una notificación o un teléfono lento; más que eso es cámara lenta o pausa). Además, máximo 5 minutos.
const REAL_MIN = (s) => s * 980 - 1000;
const REAL_MAX = (s) => s * 1050 + 8000;
const MAX_ABIERTA_MS = 5 * 60 * 1000;
// Los movimientos de cada partida (~25 KB) solo hacen falta para revisar al ganador: pasadas 3 semanas se
// borran (quedan puntos y estadísticas). Así la base gratis (500 MB) no se llena con los meses.
const GUARDAR_REGISTRO_MS = 21 * 24 * 60 * 60 * 1000;
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
  const clave = typeof req.body?.clave === 'string' && UUID.test(req.body.clave) ? req.body.clave : null;
  const semilla = randomInt(0, 2 ** 32);
  const r = await rpc('juego_empezar', { p_usuario: usuario, p_semilla: semilla, p_clave: clave });
  if (!r?.ok) {
    return res.status(200).json({ status: 'error', sinFichas: true, fichas: Number(r?.fichas) || 0, costo: Number(r?.costo) || 5, message: 'No tienes fichas suficientes.' });
  }
  // r.semilla: la de la base (si es un reintento con la misma clave, la de esa partida)
  return res.status(200).json({ status: 'success', id: r.id, semilla: Number(r.semilla ?? semilla), fichas: r.fichas, costo: r.costo });
}

// Demasiado perfecta para una persona: 80 diamantes o más (casi todo el minuto) perdiendo menos del 7 %,
// o el minuto completo sin un solo golpe. No la invalida: la marca para revisarla antes de pagar.
function partidaSospechosa({ stats, ticks }) {
  const { atrapados = 0, escapados = 0, golpes = 0 } = stats || {};
  const total = atrapados + escapados;
  return (atrapados >= 80 && atrapados / total >= 0.93) || (ticks >= 3600 && golpes === 0 && atrapados >= 30);
}

// Lo que ve el cliente cuando una partida no vale (sin detalles que ayuden a hacer trampa)
function motivoParaCliente(motivo) {
  if (/pausa|vencida/.test(motivo)) return 'La partida estuvo en pausa demasiado tiempo. No salgas del juego mientras juegas.';
  return 'No pudimos comprobar esta partida.';
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
  const juegoS = r.ticks * PASO;
  let motivo = '';
  if (r.usados !== registro.length) motivo = 'movimientos después del final';
  else if (duroMs < REAL_MIN(juegoS)) motivo = 'terminó antes de lo posible';
  else if (duroMs > MAX_ABIERTA_MS) motivo = 'partida vencida';
  else if (duroMs > REAL_MAX(juegoS)) motivo = `duró ${Math.round(duroMs / 1000)} s reales para ${Math.round(juegoS)} s de juego (pausa o cámara lenta)`;
  const valida = !motivo;
  const revisar = valida && partidaSospechosa(r);

  await actualizar('juego_partidas', `id=eq.${id}&usuario=eq.${usuario}&estado=eq.abierta`, {
    estado: valida ? 'valida' : 'invalida', puntos: r.puntos, ticks: r.ticks, registro,
    stats: r.stats, revisar, motivo: motivo || null, terminada: new Date().toISOString(),
  });
  if (!valida) console.warn(`⚠️ minijuego: partida ${id} inválida (${motivo}).`);
  if (revisar) console.warn(`⚠️ minijuego: partida ${id} marcada para revisar (${JSON.stringify(r.stats)}).`);
  // Limpieza de vez en cuando (1 de cada 50 partidas), después de responder
  if (Math.random() < 0.02) {
    const antes = encodeURIComponent(new Date(Date.now() - GUARDAR_REGISTRO_MS).toISOString());
    waitUntil(actualizar('juego_partidas', `terminada=lt.${antes}&registro=not.is.null`, { registro: null })
      .catch((error) => console.error('⚠️ minijuego: no se pudieron borrar registros viejos:', error.message)));
  }

  const filas = await ranking(usuario);
  const yo = filas.find((f) => f.soyYo);
  return res.status(200).json({
    status: 'success', valida, motivo: valida ? '' : motivoParaCliente(motivo), puntos: r.puntos, fin: r.fin,
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
