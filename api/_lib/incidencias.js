// INCIDENCIAS EN SUPABASE (supabase/revision.sql, desde 2026-11-14).
// Cada vez que una recarga anota un problema en la pestaña "errores" de su hoja (registrar_error, desde
// crearUtilidadesPedido de _lib/recarga-comun.js), se guarda también en la tabla "incidencias" para verlo y
// resolverlo en admin.html → Revisión. Después de responder (waitUntil) y sin frenar nada: si Supabase
// falla, la hoja ya lo tiene.
import { waitUntil } from '@vercel/functions';
import { supabaseActivo, guardar } from './supabase.js';

const corto = (t, max) => (t === undefined || t === null || t === '' ? null : String(t).slice(0, max));

// El juego sale del Apps Script al que se le anota el error (cada juego tiene el suyo)
function juegoDelScript(url) {
  const u = String(url || '').trim();
  if (!u) return null;
  if (u === String(process.env.SCRIPT_RECARGAS_URL || '').trim()) return 'freefire';
  if (u === String(process.env.SCRIPT_BLOOD || '').trim()) return 'bloodstrike';
  if (u === String(process.env.SCRIPT_MLBB || '').trim()) return 'mobilelegends';
  return null;
}

/** cuerpo: lo que se manda a Apps Script (informeError de _lib/reporte.js, accion "registrar_error"). */
export function anotarIncidencia(urlScript, cuerpo) {
  if (!supabaseActivo() || cuerpo?.accion !== 'registrar_error') return;
  const fila = {
    id_pedido: corto(cuerpo.idPedido, 80),
    juego: juegoDelScript(urlScript),
    fase: corto(cuerpo.fase, 120),
    motivo: corto(cuerpo.motivo, 600),
    estado_pago: corto(cuerpo.estadoPago, 400),
    id_jugador: corto(cuerpo.idJugador, 60),
    paquete: corto(cuerpo.paquete, 80),
    referencia: corto(cuerpo.referencia, 40),
    telefono: corto(cuerpo.telefono, 20),
    comprobante: /^https:\/\//.test(String(cuerpo.comprobante || '')) ? corto(cuerpo.comprobante, 500) : null,
  };
  waitUntil(guardar('incidencias', fila)
    .catch((error) => console.error('⚠️ incidencias: no se pudo guardar en Supabase (sí quedó en la hoja):', error.message)));
}
