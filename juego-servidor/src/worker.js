// =========================================================================
// Duelo de Acero · puerta de entrada (Cloudflare Worker).
//
// El juego es privado. Solo CREA salas quien trae un código de acceso válido (?c=…), que se hace en
// admin.html → Minijuego y se revisa en Supabase con juego_entrar() (supabase/juego-enlaces.sql).
// Cada sala tiene su propio enlace (?s=<sala>) que el creador comparte; con ese enlace se entra sin código
// mientras la sala exista (sala.js la borra si se queda vacía).
//   GET /acceso?c=…        → { ok } para que la página diga "enlace no válido" antes de conectarse
//   GET /ws?c=…&crear=1    → sala nueva (Durable Object con nombre al azar); quien la abre es el anfitrión
//   GET /ws?s=<sala>       → entrar a una sala que ya existe (también las del duelo rápido, que arma la cola)
//   GET /ws?a=<partida>    → sala de una partida del torneo pagado (Arena; con sesión de Google, ver ARENA.md)
//   GET /cola              → cola del duelo rápido (cola.js)
// Cada minuto (cron de wrangler.toml) avisa a la tienda: /api/juego?accion=arena_tic (vencimientos, avisos, premios).
// En local (localhost) no pide código. Lo demás: los archivos de public/juego (solo para probar en local;
// en la tienda la página la sirve Vercel en /juego/).
//
// Variables (wrangler secret put): SUPABASE_URL y SUPABASE_KEY (la clave pública "anon" de Supabase) y
// ARENA_SECRETO (el mismo "arena_secreto" de Supabase Vault). ARENA_API (wrangler.toml): la API de la tienda.
// =========================================================================

export { Sala } from './sala.js';
export { Cola } from './cola.js';

const ORIGENES = ['https://www.levelupstore.online', 'https://levelupstore.online'];
const ES_LOCAL = /^(localhost|127\.0\.0\.1)$/;
const SALA_VALIDA = /^[a-z2-9]{10}$/;
const LETRAS_SALA = 'abcdefghjkmnpqrstuvwxyz23456789';
const VALIDOS_MS = 60 * 1000;        // un código bueno se recuerda 1 minuto (menos consultas a Supabase)
const validos = new Map();           // código → hasta cuándo

function origenPermitido(origen, url) {
  if (!origen) return true;                        // apps sin navegador: igual necesitan código
  if (ORIGENES.includes(origen) || origen === url.origin) return true;
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origen);
}

function cabecerasCors(origen) {
  return ORIGENES.includes(origen) ? { 'Access-Control-Allow-Origin': origen, Vary: 'Origin' } : {};
}

// true = sirve · false = no sirve · null = no se pudo preguntar
async function codigoValido(codigo, env) {
  if (!/^[a-f0-9]{32}$/.test(codigo || '')) return false;
  const hasta = validos.get(codigo);
  if (hasta && hasta > Date.now()) return true;
  if (!env.SUPABASE_URL || !env.SUPABASE_KEY) return null;
  try {
    const r = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/juego_entrar`, {
      method: 'POST',
      headers: { apikey: env.SUPABASE_KEY, Authorization: `Bearer ${env.SUPABASE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_codigo: codigo }),
    });
    if (!r.ok) return null;
    const ok = (await r.json()) === true;
    if (ok) validos.set(codigo, Date.now() + VALIDOS_MS);
    else validos.delete(codigo);
    if (validos.size > 500) validos.clear();
    return ok;
  } catch (e) {
    return null;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origen = request.headers.get('Origin') || '';
    // En local: wrangler dev pone el dominio de routes en la URL, por eso además la variable LOCAL (npm run dev)
    const local = ES_LOCAL.test(url.hostname) || env.LOCAL === '1';
    const codigo = url.searchParams.get('c') || '';

    if (url.pathname === '/acceso') {
      const ok = local ? true : await codigoValido(codigo, env);
      return new Response(JSON.stringify({ ok: ok === true, error: ok === null }), {
        status: ok === null ? 503 : 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cabecerasCors(origen) },
      });
    }

    if (url.pathname === '/cola') {
      if (!origenPermitido(origen, url)) return new Response('Origen no permitido', { status: 403 });
      return env.COLA.get(env.COLA.idFromName('cola')).fetch(request);
    }

    if (url.pathname === '/ws') {
      if (!origenPermitido(origen, url)) return new Response('Origen no permitido', { status: 403 });
      const r = new Request(request);
      r.headers.delete('X-Crear');
      r.headers.delete('X-Arena-Sala');
      let nombre;
      const partida = url.searchParams.get('a');
      if (partida) {
        if (!SALA_VALIDA.test(partida)) return new Response('Partida no válida', { status: 400 });
        r.headers.set('X-Arena-Sala', partida);
        return env.SALA.get(env.SALA.idFromName('arena-' + partida)).fetch(r);
      }
      if (url.searchParams.get('crear') === '1') {
        if (!local) {
          const ok = await codigoValido(codigo, env);
          if (ok === null) return new Response('No se pudo revisar el enlace', { status: 503 });
          if (!ok) return new Response('Enlace no válido', { status: 403 });
        }
        const azar = crypto.getRandomValues(new Uint8Array(10));
        nombre = [...azar].map((b) => LETRAS_SALA[b % LETRAS_SALA.length]).join('');
        r.headers.set('X-Crear', '1');
        r.headers.set('X-Sala', nombre);
      } else {
        nombre = url.searchParams.get('s') || '';
        if (!SALA_VALIDA.test(nombre)) return new Response('Sala no válida', { status: 400 });
      }
      return env.SALA.get(env.SALA.idFromName('sala-' + nombre)).fetch(r);
    }
    return new Response('No encontrado', { status: 404 });
  },

  // Cada minuto: la tienda vence partidas, manda avisos y entrega premios (api/_lib/arena.js → tic)
  async scheduled(evento, env, ctx) {
    if (!env.ARENA_API || !env.ARENA_SECRETO) return;
    ctx.waitUntil(fetch(`${env.ARENA_API}?accion=arena_tic`, { method: 'POST', headers: { 'X-Arena': env.ARENA_SECRETO } })
      .then((r) => { if (!r.ok) console.error('arena_tic: HTTP ' + r.status); })
      .catch((e) => console.error('arena_tic:', e.message)));
  },
};
