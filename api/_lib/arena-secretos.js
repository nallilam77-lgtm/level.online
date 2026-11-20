// Secretos de la Arena guardados en Supabase Vault (supabase/arena.sql → arena_secretos()):
//   arena_secreto   lo comparten el Worker del juego (ARENA_SECRETO en Cloudflare) y Vercel
//   vapid_publica / vapid_privada   llaves de las notificaciones
// Se leen una vez cada 10 minutos por instancia (no en cada llamada).
import { timingSafeEqual } from 'node:crypto';
import { rpc } from './supabase.js';

const DURA_MS = 10 * 60_000;
let copia = null;

export async function secretosArena() {
  if (copia && Date.now() - copia.momento < DURA_MS) return copia.valor;
  const valor = (await rpc('arena_secretos', {})) || {};
  copia = { valor, momento: Date.now() };
  return valor;
}

/** ¿La petición viene del Worker del juego? (cabecera X-Arena con el secreto) */
export async function esDelWorker(req) {
  const dado = Buffer.from(String(req.headers['x-arena'] || ''));
  if (dado.length < 32) return false;
  const s = await secretosArena().catch(() => ({}));
  const real = Buffer.from(String(s.arena_secreto || ''));
  return real.length >= 32 && real.length === dado.length && timingSafeEqual(real, dado);
}
