// MEJORES CLIENTES DEL DÍA Y DE LA SEMANA (GET /api/ranking → { status, dia: [...], semana: [...] }).
// Sale de la función SQL ranking_clientes (supabase/levelup.sql): recargas COMPLETADAS de clientes con
// sesión. Cada fila: { puesto, nombre ("Jesús D."), foto, recargas, total } — nunca correo ni ID del juego.
// Hora de Venezuela (UTC-4 todo el año): el día empieza a las 00:00 y la semana el lunes a las 00:00.
// 5 min en la CDN de Vercel: muchas visitas al inicio = una sola llamada a Supabase cada 5 min.
import { supabaseActivo, rpc } from './_lib/supabase.js';
import { iniciosVE } from './_lib/semana.js';

const PUESTOS = 10;

const limpiar = (filas) => (Array.isArray(filas) ? filas : []).map((f) => ({
  puesto: Number(f.puesto) || 0,
  nombre: String(f.nombre || 'Cliente').slice(0, 40),
  // Solo fotos https (las de Google): nada de otros esquemas en un <img> público
  foto: /^https:\/\/[^\s"'<>]{1,500}$/.test(String(f.foto || '')) ? f.foto : null,
  recargas: Number(f.recargas) || 0,
  total: Number(f.total) || 0,
}));

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ status: 'error', message: 'Método no permitido' });
  if (!supabaseActivo()) {
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=300');
    return res.status(200).json({ status: 'success', activo: false, dia: [], semana: [] });
  }
  try {
    const desde = iniciosVE();
    const [dia, semana] = await Promise.all([
      rpc('ranking_clientes', { p_desde: desde.dia, p_limite: PUESTOS }),
      rpc('ranking_clientes', { p_desde: desde.semana, p_limite: PUESTOS }),
    ]);
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600');
    return res.status(200).json({ status: 'success', activo: true, dia: limpiar(dia), semana: limpiar(semana) });
  } catch (error) {
    console.error('⚠️ ranking: no se pudo leer de Supabase:', error.message);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(503).json({ status: 'error', message: 'El ranking no está disponible ahora.' });
  }
}
