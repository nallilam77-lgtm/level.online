// Versión del despliegue actual (GET /api/version → { version }). La usa public/js/version-nueva.js
// para que una pestaña abierta hace horas o días se actualice sola al volver a ella.
// Sin imports a propósito: arranca en frío lo más rápido posible.
// VERCEL_GIT_COMMIT_SHA / VERCEL_DEPLOYMENT_ID las pone Vercel solo (variables de sistema):
// sin ellas responde "" y la página no hace nada.
// GET /api/version?config=1 → { supabaseUrl, supabaseKey }: lo PÚBLICO que necesita public/js/sesion.js
// para iniciar sesión con Google (la llave publicable, nunca la secreta). Sin esas variables → {}.
const VERSION = process.env.VERCEL_GIT_COMMIT_SHA || process.env.VERCEL_DEPLOYMENT_ID || '';
const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const SUPABASE_PUBLICA = (process.env.SUPABASE_PUBLISHABLE_KEY || '').trim();

export default function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ status: 'error', message: 'Método no permitido' });
  // 30 s en la CDN de Vercel (se vacía en cada despliegue): muchas pestañas no despiertan la función
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=30');
  if (req.query?.config) {
    return res.status(200).json(SUPABASE_URL && SUPABASE_PUBLICA ? { supabaseUrl: SUPABASE_URL, supabaseKey: SUPABASE_PUBLICA } : {});
  }
  return res.status(200).json({ version: VERSION });
}
