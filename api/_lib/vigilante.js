// =========================================================================
// VIGILANTE DE PAGOS Y RECARGAS (desde 2026-11-20; supabase/vigilante.sql)
//
// Cada minuto (tic de _lib/arena.js, llamado por el cron del Worker del juego): vigilante_revisar() anota en
// "alertas" lo raro (pago libre sin usar, pago marcado usado a mano con alguien esperando, pago usado sin recarga,
// compra cortada, posible recarga doble, recarga en revisión o sin confirmar, cliente esperando en "Revisar pagos")
// y devuelve lo nuevo. Aquí se le avisa al administrador por notificación (las que active en admin.html →
// Resumen → Vigilante → "Activar avisos"). Más de 3 a la vez (p. ej. la primera vez): un solo aviso con el total.
// Nunca lanza: si falla, la tienda sigue igual.
// =========================================================================
import { supabaseActivo, rpc } from './supabase.js';
import { avisar } from './push.js';

export async function vigilar() {
  if (!supabaseActivo()) return 0;
  try {
    const r = await rpc('vigilante_revisar', {});
    const nuevas = Array.isArray(r?.nuevas) ? r.nuevas : [];
    const admins = Array.isArray(r?.admins) ? r.admins : [];
    if (!nuevas.length || !admins.length) return nuevas.length;
    if (nuevas.length > 3) {
      await avisar(admins, { titulo: `🔎 Vigilante: ${nuevas.length} cosas por revisar`, texto: nuevas.slice(0, 3).map((a) => a.titulo).join(' · '), url: '/admin.html', etiqueta: 'vigilante-resumen' });
    } else {
      for (const a of nuevas) {
        await avisar(admins, { titulo: `🔎 ${a.titulo}`, texto: String(a.detalle || '').slice(0, 220), url: '/admin.html', etiqueta: `vigilante-${a.id}` });
      }
    }
    console.info(`🔎 vigilante: ${nuevas.length} alerta(s) nueva(s): ${nuevas.map((a) => a.tipo).join(', ')}`);
    return nuevas.length;
  } catch (error) {
    console.error('⚠️ vigilante:', error.message);
    return 0;
  }
}
