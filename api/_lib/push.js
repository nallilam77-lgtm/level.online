// =========================================================================
// NOTIFICACIONES WEB PUSH de la Arena (juego-servidor/ARENA.md). Las llaves VAPID están en Supabase Vault
// (vapid_publica / vapid_privada, por arena_secretos()); las suscripciones, en arena_push.
// avisar(usuarios, { titulo, texto, url, etiqueta }) manda a todos los equipos de esos usuarios; los que ya
// no existen (404/410) se borran. Nunca lanza: una notificación que no sale no frena nada.
// =========================================================================
import webpush from 'web-push';
import { rpc } from './supabase.js';
import { secretosArena } from './arena-secretos.js';

const ASUNTO = 'https://www.levelupstore.online';

export async function llavePublicaPush() {
  const s = await secretosArena();
  return s.vapid_publica || '';
}

export async function avisar(usuarios, { titulo, texto, url = '/arena.html', etiqueta }) {
  const lista = [...new Set((usuarios || []).filter((u) => /^[0-9a-f-]{36}$/i.test(String(u))))];
  if (!lista.length) return 0;
  let enviadas = 0;
  try {
    const s = await secretosArena();
    if (!s.vapid_publica || !s.vapid_privada) return 0;
    const suscripciones = await rpc('arena_push_de', { p_usuarios: lista });
    const cuerpo = JSON.stringify({ titulo, texto, url, etiqueta });
    await Promise.all((suscripciones || []).map(async (x) => {
      try {
        await webpush.sendNotification({ endpoint: x.endpoint, keys: { p256dh: x.p256dh, auth: x.auth } }, cuerpo, {
          vapidDetails: { subject: ASUNTO, publicKey: s.vapid_publica, privateKey: s.vapid_privada },
          TTL: 60 * 30, urgency: 'high', timeout: 5000,
        });
        enviadas++;
      } catch (error) {
        if (error.statusCode === 404 || error.statusCode === 410) await rpc('arena_push_borrar', { p_endpoint: x.endpoint }).catch(() => {});
        else console.warn(`⚠️ push: no salió una notificación (${error.statusCode || error.message})`);
      }
    }));
  } catch (error) {
    console.warn('⚠️ push: no se pudieron mandar avisos:', error.message);
  }
  return enviadas;
}
