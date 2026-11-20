// Sesión de Google del cliente (Supabase Auth) y avisos a la tienda (Vercel). Ver ARENA.md.
//
// usuarioDe(env, jwt) → { usuario, nombre } o null. Pregunta a Supabase (/auth/v1/user) y recuerda el
// resultado 5 minutos por token. En local (LOCAL=1) también acepta "prueba:<uuid>:<nombre>" para las pruebas.
// avisarTienda(env, cuerpo) manda un evento a /api/juego?accion=arena_evento con el secreto y reintenta
// (2, 5, 15, 30, 60 s) hasta que Vercel responda; sin ARENA_API / ARENA_SECRETO solo lo escribe en el log.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const copias = new Map();
const DURA_MS = 5 * 60_000;
const nombreDe = (u) => {
  const m = u.user_metadata || {};
  return String(m.full_name || m.name || (u.email || '').split('@')[0] || 'Jugador').split(' ')[0].replace(/[^\p{L}\p{N} _.\-]/gu, '').slice(0, 14) || 'Jugador';
};

export async function usuarioDe(env, jwt) {
  const t = String(jwt || '');
  if (env.LOCAL === '1') {
    const p = t.match(/^prueba:([0-9a-f-]{36}):(.{1,14})$/i);
    if (p && UUID.test(p[1])) return { usuario: p[1].toLowerCase(), nombre: p[2] };
  }
  if (!/^[A-Za-z0-9._-]{20,4000}$/.test(t) || !env.SUPABASE_URL || !env.SUPABASE_KEY) return null;
  const c = copias.get(t);
  if (c && Date.now() - c.momento < DURA_MS) return c.valor;
  try {
    const r = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, { headers: { apikey: env.SUPABASE_KEY, Authorization: `Bearer ${t}` } });
    if (!r.ok) return null;
    const u = await r.json();
    if (!UUID.test(String(u && u.id))) return null;
    const valor = { usuario: u.id, nombre: nombreDe(u) };
    copias.set(t, { valor, momento: Date.now() });
    if (copias.size > 300) copias.delete(copias.keys().next().value);
    return valor;
  } catch (e) {
    return null;
  }
}

const ESPERAS = [2000, 5000, 15000, 30000, 60000];
export function avisarTienda(env, cuerpo, intento = 0) {
  if (!env.ARENA_API || !env.ARENA_SECRETO) { console.log('arena (sin tienda):', JSON.stringify(cuerpo)); return; }
  fetch(`${env.ARENA_API}?accion=arena_evento`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Arena': env.ARENA_SECRETO }, body: JSON.stringify(cuerpo),
  }).then((r) => {
    if (!r.ok && r.status !== 400 && r.status !== 403) throw new Error('HTTP ' + r.status);
    if (!r.ok) console.error(`arena: la tienda rechazó ${cuerpo.tipo} (HTTP ${r.status})`);
  }).catch((e) => {
    if (intento >= ESPERAS.length) { console.error(`arena: no se pudo avisar ${cuerpo.tipo} de ${cuerpo.partida || ''}: ${e.message}`); return; }
    setTimeout(() => avisarTienda(env, cuerpo, intento + 1), ESPERAS[intento]);
  });
}

/** La partida del torneo y sus jugadores (Vercel → Supabase). null si no se pudo preguntar. */
export async function partidaDe(env, id) {
  if (!env.ARENA_API || !env.ARENA_SECRETO) return null;
  try {
    const r = await fetch(`${env.ARENA_API}?accion=arena_sala&id=${id}`, { headers: { 'X-Arena': env.ARENA_SECRETO } });
    if (!r.ok) return null;
    const d = await r.json();
    return d && d.partida ? d.partida : (d && d.status === 'success' ? false : null);
  } catch (e) {
    return null;
  }
}
