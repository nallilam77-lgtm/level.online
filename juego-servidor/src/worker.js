// =========================================================================
// Último en Pie · puerta de entrada (Cloudflare Worker).
//
// El juego es privado: solo entra quien trae un código de enlace válido (?c=…), que se crea en
// admin.html → Minijuego y se revisa en Supabase con juego_entrar() (supabase/juego-enlaces.sql).
//   GET /acceso?c=…   → { ok } para que la página diga "enlace no válido" antes de conectarse
//   GET /ws?c=…       → la sala del juego (Durable Object)
// En local (localhost) no pide código. Lo demás: los archivos de public/juego (solo para probar en local;
// en la tienda la página la sirve Vercel en /juego/).
//
// Variables (wrangler secret put): SUPABASE_URL y SUPABASE_KEY (la clave pública "anon" de Supabase).
// =========================================================================

export { Sala } from './sala.js';

const ORIGENES = ['https://www.levelupstore.online', 'https://levelupstore.online'];
const ES_LOCAL = /^(localhost|127\.0\.0\.1)$/;
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
    const local = ES_LOCAL.test(url.hostname);
    const codigo = url.searchParams.get('c') || '';

    if (url.pathname === '/acceso') {
      const ok = local ? true : await codigoValido(codigo, env);
      return new Response(JSON.stringify({ ok: ok === true, error: ok === null }), {
        status: ok === null ? 503 : 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cabecerasCors(origen) },
      });
    }

    if (url.pathname === '/ws') {
      if (!origenPermitido(origen, url)) return new Response('Origen no permitido', { status: 403 });
      if (!local) {
        const ok = await codigoValido(codigo, env);
        if (ok === null) return new Response('No se pudo revisar el enlace', { status: 503 });
        if (!ok) return new Response('Enlace no válido', { status: 403 });
      }
      const sala = env.SALA.get(env.SALA.idFromName('sala-principal'));
      // Solo en tu computadora: /ws?espera=3 acorta la espera antes de cada partida (para probar rápido)
      const espera = Number(url.searchParams.get('espera'));
      if (local && espera > 0 && espera <= 60) {
        const r = new Request(request);
        r.headers.set('X-Espera-Prueba', String(espera));
        return sala.fetch(r);
      }
      return sala.fetch(request);
    }
    return new Response('No encontrado', { status: 404 });
  },
};
