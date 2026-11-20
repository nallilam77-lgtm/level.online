// =========================================================================
// ARENA (torneo pagado, ranking y avisos de Duelo de Acero; juego-servidor/ARENA.md, supabase/arena.sql)
//
// Todo por api/juego.js (el plan de Vercel admite 12 funciones), máximo 30 s por llamada.
// Para la página (public/arena.html):
//   GET  /api/juego?accion=arena_config     → { activo, juegos: [{ juego, nombre, paquete, precio, zona }], push }
//   POST /api/juego?accion=arena_inscribir  (con sesión) { idInscripcion, modo, juego, id, zona, nombre, referencia }
//   POST /api/juego?accion=arena_push       (con sesión) { endpoint, keys: { p256dh, auth } }
//   (mis partidas y el ranking los lee la página directo de Supabase: arena_mias / arena_ranking_semana)
// Para el Worker del juego (cabecera X-Arena con el secreto de arena-secretos.js):
//   GET  /api/juego?accion=arena_sala&id=…  → la partida y sus jugadores
//   POST /api/juego?accion=arena_evento     { tipo: 'empezo' | 'resultado' | 'ranking', … }
//   POST /api/juego?accion=arena_tic        (cada minuto, desde el cron del Worker): vencimientos, avisos y entregas
//
// Cobro de la inscripción: las mismas reglas que la tienda (COMMON_MISTAKES 2c). El pago se toma con
// pagos_tomar usando el id de la inscripción como pedido (un reintento con el mismo id lo encuentra) y se
// marca "usado" DESPUÉS de inscribir. Si no alcanza, queda usado y el cliente sigue por WhatsApp.
// =========================================================================
import { supabaseActivo, rpc, leer, usuarioDelToken } from './supabase.js';
import { MENSAJES_PAGO, MARGEN_BS, cambiarPago } from './motor-pagos.js';
import { validarJugador } from './validador.js';
import { obtenerIp, minutosBloqueado, registrarFallo } from './limitador.js';
import { anotarIncidencia } from './incidencias.js';
import { JUEGOS_ENTREGA, paqueteDe, entregarPaquete } from './entrega.js';
import { avisar, llavePublicaPush } from './push.js';
import { esDelWorker } from './arena-secretos.js';

const MODOS = new Set(['1v1', '2v2']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SALA = /^[a-z2-9]{10}$/;
const NO_DISPONIBLE = 'El torneo no está disponible en este momento. Intenta más tarde.';
const SCRIPT_DE = { freefire: 'SCRIPT_RECARGAS_URL', bloodstrike: 'SCRIPT_BLOOD', mobilelegends: 'SCRIPT_MLBB' };
const limpiarNombre = (n) => String(n || '').replace(/[^\p{L}\p{N} _.\-]/gu, '').trim().slice(0, 14);
const hora = (iso) => new Date(iso).toLocaleTimeString('es-VE', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Caracas' });
const dia = (iso) => {
  const f = (d) => new Date(d).toLocaleDateString('es-VE', { timeZone: 'America/Caracas' });
  return f(iso) === f(Date.now()) ? 'hoy' : f(iso) === f(Date.now() + 86400000) ? 'mañana' : f(iso);
};

async function configuracion() {
  const filas = await leer('configuracion', { clave: 'arena' }, 'valor');
  const v = (filas && filas[0] && filas[0].valor) || {};
  return { activo: v.activo !== false, paquetes: v.paquetes || {} };
}

// ------------------------------------------------------------------ página
let copiaConfig = null;
export async function config(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!supabaseActivo()) return res.status(503).json({ status: 'error', message: NO_DISPONIBLE });
  try {
    if (!copiaConfig || Date.now() - copiaConfig.momento > 60_000) {
      const c = await configuracion();
      const juegos = [];
      for (const [juego, datos] of Object.entries(JUEGOS_ENTREGA)) {
        const paquete = c.paquetes[juego];
        if (!paquete) continue;
        const p = await paqueteDe(juego, paquete).catch(() => null);
        if (p && p.precio && p.activo) juegos.push({ juego, nombre: datos.nombre, paquete, precio: p.precio, zona: !!datos.zona });
      }
      copiaConfig = { momento: Date.now(), valor: { activo: c.activo && juegos.length > 0, juegos, push: await llavePublicaPush().catch(() => '') } };
    }
    return res.status(200).json({ status: 'success', ...copiaConfig.valor });
  } catch (error) {
    console.error('⚠️ arena/config:', error.message);
    return res.status(503).json({ status: 'error', message: NO_DISPONIBLE });
  }
}

const tokenDe = (req) => String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();

export async function inscribir(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ status: 'error', message: 'Método no permitido' });
  if (!supabaseActivo()) return res.status(503).json({ status: 'error', message: NO_DISPONIBLE });
  const b = req.body || {};
  const modo = String(b.modo || '');
  const juego = String(b.juego || '');
  const id = String(b.id ?? '').trim();
  const zona = String(b.zona ?? '').trim();
  const referencia = String(b.referencia ?? '').trim();
  const idInscripcion = String(b.idInscripcion || '');
  const nombre = limpiarNombre(b.nombre);
  const datosJuego = JUEGOS_ENTREGA[juego];
  if (!MODOS.has(modo) || !datosJuego) return res.status(400).json({ status: 'error', message: 'Elige el modo y el juego del premio.' });
  if (!/^\d{5,15}$/.test(id)) return res.status(400).json({ status: 'error', message: `Escribe tu ID de ${datosJuego.nombre} (solo números).` });
  if (datosJuego.zona && !/^\d{2,6}$/.test(zona)) return res.status(400).json({ status: 'error', message: 'Escribe tu Zona ID (solo números).' });
  if (!/^\d{5}$/.test(referencia)) return res.status(400).json({ status: 'error', message: MENSAJES_PAGO.formato });
  if (!UUID.test(idInscripcion)) return res.status(400).json({ status: 'error', message: 'Recarga la página e intenta de nuevo.' });
  if (!nombre) return res.status(400).json({ status: 'error', message: 'Escribe tu nombre para el juego (letras y números).' });

  const usuario = await usuarioDelToken(tokenDe(req));
  if (!usuario) return res.status(401).json({ status: 'error', sesion: true, message: 'Inicia sesión con Google para inscribirte.' });

  const ip = obtenerIp(req);
  const claves = [`ip:${ip}`, `arena:${usuario}`];
  const minutos = await minutosBloqueado(claves);
  if (minutos > 0) return res.status(429).json({ status: 'error', message: `Demasiados intentos. Espera ${minutos} minutos.` });

  let c;
  let paq;
  try {
    c = await configuracion();
    paq = c.paquetes[juego] ? await paqueteDe(juego, c.paquetes[juego]) : null;
  } catch (error) {
    console.error('⚠️ arena/inscribir: no se pudo leer la configuración:', error.message);
    return res.status(503).json({ status: 'error', message: NO_DISPONIBLE });
  }
  if (!c.activo || !paq || !paq.precio || !paq.activo) return res.status(503).json({ status: 'error', message: NO_DISPONIBLE });
  const paquete = c.paquetes[juego];

  // El ID existe (antes de tocar el pago)
  let nick = '';
  try {
    const v = await validarJugador(juego, id, datosJuego.zona ? zona : '');
    if (v && v.valid === false) return res.status(400).json({ status: 'error', message: `❌ ${v.message || 'Ese ID no existe'}. Revísalo.` });
    nick = (v && v.player_name) || '';
  } catch (error) {
    console.warn('⚠️ arena/inscribir: el validador no respondió:', error.message);
    return res.status(503).json({ status: 'error', message: 'No pudimos comprobar tu ID ahora. Intenta en un minuto (no se tomó tu pago).' });
  }

  // El pago (el id de la inscripción es el pedido: si repite, encuentra el mismo pago)
  let pago;
  try {
    pago = await rpc('pagos_tomar', { p_ultimos5: referencia, p_id_pedido: idInscripcion, p_juego: 'arena' });
  } catch (error) {
    console.error('⚠️ arena/inscribir: Supabase no respondió al tomar el pago:', error.message);
    return res.status(503).json({ status: 'error', message: 'No pudimos revisar tu pago ahora. Intenta en un minuto.' });
  }
  if (!pago || !pago.encontrado) {
    if (pago?.motivo === 'no_existe') await registrarFallo(claves).catch(() => {});
    return res.status(400).json({ status: 'error', message: MENSAJES_PAGO[pago?.motivo] || MENSAJES_PAGO.no_existe });
  }
  const monto = Number(pago.monto) || 0;
  const ref = String(pago.referencia);
  const incidencia = (fase, motivo) => anotarIncidencia(process.env[SCRIPT_DE[juego]], {
    accion: 'registrar_error', idPedido: idInscripcion, idJugador: id, paquete: `Arena ${modo} · ${paquete}`, referencia: ref,
    fase, motivo, estadoPago: 'Usado (no se libera)',
  });
  if (monto + MARGEN_BS < paq.precio) {
    await cambiarPago(ref, 'usado', { idPedido: idInscripcion }).catch(() => {});
    incidencia('ARENA: PAGO INSUFICIENTE', `Pagó ${monto} Bs y la inscripción cuesta ${paq.precio} Bs`);
    return res.status(400).json({ status: 'error', message: `💸 Tu pago fue de ${monto} Bs y la inscripción cuesta ${paq.precio} Bs. Escríbenos por WhatsApp con tu referencia para resolverlo.` });
  }

  let r;
  try {
    r = await rpc('arena_inscribir', {
      p_id: idInscripcion, p_usuario: usuario, p_nombre: nombre, p_modo: modo, p_juego: juego, p_paquete: paquete,
      p_precio: paq.precio, p_id_jugador: id, p_zona: datosJuego.zona ? zona : '', p_nick: nick, p_referencia: ref, p_monto: monto,
    });
  } catch (error) {
    // El pago queda "en proceso" (no se reutiliza): con el mismo idInscripcion, el reintento lo encuentra
    console.error(`❌ arena/inscribir: pago ${ref} tomado pero no se pudo inscribir:`, error.message);
    incidencia('ARENA: NO SE PUDO INSCRIBIR', error.message);
    return res.status(503).json({ status: 'error', reintentar: true, message: 'Tu pago quedó registrado, pero no pudimos terminar la inscripción. Toca "Inscribirme" otra vez en un minuto (no se cobra de nuevo).' });
  }
  if (!(await cambiarPago(ref, 'usado', { idPedido: idInscripcion }).catch(() => false))) {
    console.error(`⚠️ arena/inscribir: no se pudo marcar usado el pago ${ref} (sigue en proceso: no se reutiliza)`);
  }
  console.info(`🏟️ arena: inscripción ${idInscripcion} (${modo}, ${juego}, ${paquete}) en ${r.partida} · ${r.estado}`);
  return res.status(200).json({
    status: 'success', partida: r.partida, estado: r.estado, hora: r.hora || null, faltan: r.faltan ?? 0,
    message: r.estado === 'lista'
      ? `✅ ¡Inscrito! Tu partida es ${dia(r.hora)} a las ${hora(r.hora)}.`
      : '✅ ¡Inscrito! Te avisamos apenas pague tu rival y te damos la hora.',
  });
}

export async function guardarPush(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ status: 'error', message: 'Método no permitido' });
  const usuario = await usuarioDelToken(tokenDe(req));
  if (!usuario) return res.status(401).json({ status: 'error', message: 'Inicia sesión.' });
  const { endpoint, keys } = req.body || {};
  if (typeof endpoint !== 'string' || !/^https:\/\/[^\s]{10,600}$/.test(endpoint) || !keys || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string'
    || !/^[A-Za-z0-9_-]{20,200}$/.test(keys.p256dh) || !/^[A-Za-z0-9_-]{8,100}$/.test(keys.auth)) {
    return res.status(400).json({ status: 'error', message: 'Suscripción no válida.' });
  }
  try {
    await rpc('arena_push_guardar', { p_usuario: usuario, p_endpoint: endpoint, p_p256dh: keys.p256dh, p_auth: keys.auth });
    return res.status(200).json({ status: 'success' });
  } catch (error) {
    console.error('⚠️ arena/push:', error.message);
    return res.status(503).json({ status: 'error', message: 'No se pudieron activar los avisos ahora.' });
  }
}

// ------------------------------------------------------------------ Worker
export async function sala(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!(await esDelWorker(req))) return res.status(403).json({ status: 'error' });
  const id = String(req.query.id || '');
  if (!SALA.test(id)) return res.status(400).json({ status: 'error' });
  try {
    return res.status(200).json({ status: 'success', partida: await rpc('arena_sala', { p_partida: id }) });
  } catch (error) {
    console.error('⚠️ arena/sala:', error.message);
    return res.status(503).json({ status: 'error' });
  }
}

export async function evento(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST' || !(await esDelWorker(req))) return res.status(403).json({ status: 'error' });
  const b = req.body || {};
  try {
    if (b.tipo === 'empezo' && SALA.test(String(b.partida))) {
      return res.status(200).json({ status: 'success', ok: await rpc('arena_empezo', { p_partida: b.partida }) });
    }
    if (b.tipo === 'resultado' && SALA.test(String(b.partida)) && [0, 1, 2].includes(b.ganador)) {
      const ok = await rpc('arena_resultado', { p_partida: b.partida, p_ganador: b.ganador, p_marcador: String(b.marcador || '').slice(0, 10), p_motivo: String(b.motivo || '').slice(0, 200) });
      if (ok) {
        console.info(`🏆 arena: ${b.partida} terminó (ganador ${b.ganador}, ${b.marcador || ''}) ${b.motivo || ''}`);
        await hacerEntregas(Date.now() + 22_000);
      }
      return res.status(200).json({ status: 'success', ok });
    }
    if (b.tipo === 'ranking' && UUID.test(String(b.ganador?.usuario)) && UUID.test(String(b.perdedor?.usuario))) {
      const r = await rpc('arena_ranking_sumar', {
        p_ganador: b.ganador.usuario, p_nombre_g: limpiarNombre(b.ganador.nombre) || 'Jugador',
        p_perdedor: b.perdedor.usuario, p_nombre_p: limpiarNombre(b.perdedor.nombre) || 'Jugador',
      });
      return res.status(200).json({ status: 'success', ...r });
    }
    return res.status(400).json({ status: 'error' });
  } catch (error) {
    console.error(`⚠️ arena/evento ${b.tipo}:`, error.message);
    return res.status(503).json({ status: 'error' });
  }
}

const TEXTO_AVISO = {
  lista: (a) => ({ titulo: '⚔️ ¡Tu rival pagó!', texto: `Tu partida de Duelo de Acero es ${dia(a.hora)} a las ${hora(a.hora)}. Te avisamos 10 minutos antes.` }),
  diez: (a) => ({ titulo: '⏰ Tu partida empieza en 10 minutos', texto: `A las ${hora(a.hora)}. Entra a la Arena y toca "Entrar a la partida".` }),
  ya: () => ({ titulo: '🔥 ¡Es la hora de tu partida!', texto: 'Entra ya: si no entras en 10 minutos, pierdes por ausencia.' }),
  sin_rival: () => ({ titulo: 'Nadie más se inscribió', texto: 'Pasaron 24 horas sin rival: te enviamos tu paquete a tu cuenta del juego.' }),
  nadie: () => ({ titulo: 'Nadie entró a la partida', texto: 'Como no entró nadie, cada uno recibe su paquete de vuelta.' }),
};

export async function tic(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST' || !(await esDelWorker(req))) return res.status(403).json({ status: 'error' });
  const limite = Date.now() + 24_000;
  let avisos = 0;
  try {
    const r = await rpc('arena_tic', {});
    await Promise.all((r?.avisos || []).map((a) => {
      const t = TEXTO_AVISO[a.tipo] && TEXTO_AVISO[a.tipo](a);
      if (!t) return null;
      avisos++;
      return avisar(a.usuarios, { ...t, url: '/arena.html', etiqueta: `arena-${a.partida}-${a.tipo}` });
    }));
  } catch (error) {
    console.error('⚠️ arena/tic:', error.message);
  }
  const entregas = await hacerEntregas(limite);
  return res.status(200).json({ status: 'success', avisos, entregas });
}

// Premios y devoluciones pendientes, mientras quede tiempo. Cada paquete con su idPedido fijo:
// "<inscripción>a" (y "b" para el segundo del premio); tras un reintento del panel, "-r<N>" en la llave.
async function hacerEntregas(limite) {
  let hechas = 0;
  while (Date.now() < limite - 13_000) {
    let lista;
    try {
      lista = await rpc('arena_entregas', { p_limite: 1 });
    } catch (error) {
      console.error('⚠️ arena/entregas: no se pudieron leer:', error.message);
      return hechas;
    }
    if (!Array.isArray(lista) || !lista.length) return hechas;
    for (const e of lista) {
      let partes = Number(e.partes_ok) || 0;
      let final = 'entregado';
      let nota = '';
      while (partes < e.veces) {
        // Sin tiempo para otro paquete (cada uno espera hasta 12 s): lo que falta sigue en el próximo tic
        if (Date.now() > limite - 13_000) { final = 'pendiente'; nota = `${partes} de ${e.veces} entregado(s); sigue en el próximo minuto`; break; }
        const base = `${e.id}${'ab'[partes]}`;
        const r = await entregarPaquete({
          juego: e.juego, paquete: e.paquete, idJugador: e.id_jugador, zona: e.zona || '',
          idPedido: e.intento ? `${base}-r${e.intento}` : base, idFila: base, tiempoMs: 12_000,
          nota: `Arena ${e.partida}: ${e.resultado === 'gano' ? `premio ${partes + 1} de ${e.veces}` : 'devolución de la inscripción'}`,
        });
        if (r.estado === 'entregado' || r.estado === 'en_proceso') { partes++; continue; }
        final = r.estado === 'no_disponible' ? 'pendiente' : 'revisar';
        nota = r.motivo || r.estado;
        break;
      }
      await rpc('arena_entrega_fin', { p_id: e.id, p_estado: final, p_nota: nota || `${partes} de ${e.veces} entregado(s)`, p_partes_ok: partes })
        .catch((error) => console.error(`🚨 arena/entregas: no se pudo anotar la entrega ${e.id}:`, error.message));
      if (final === 'entregado') {
        hechas++;
        const total = e.veces > 1 ? `${e.veces} × ${e.paquete}` : e.paquete;
        avisar([e.usuario], {
          titulo: e.resultado === 'gano' ? '🏆 ¡Tu premio va en camino!' : '📦 Te enviamos tu paquete',
          texto: `${total} a tu ID ${e.id_jugador}${e.nick ? ` (${e.nick})` : ''}.`, etiqueta: `arena-entrega-${e.id}`,
        });
      } else if (final === 'revisar') {
        console.error(`❌ arena/entregas: ${e.id} (${e.juego} ${e.paquete} → ${e.id_jugador}) quedó por revisar: ${nota}`);
      }
    }
  }
  return hechas;
}

