// Versión del despliegue actual (GET /api/version → { version }). La usa public/js/version-nueva.js
// para que una pestaña abierta hace horas o días se actualice sola al volver a ella.
// Sin imports a propósito: arranca en frío lo más rápido posible.
// VERCEL_GIT_COMMIT_SHA / VERCEL_DEPLOYMENT_ID las pone Vercel solo (variables de sistema):
// sin ellas responde "" y la página no hace nada.
const VERSION = process.env.VERCEL_GIT_COMMIT_SHA || process.env.VERCEL_DEPLOYMENT_ID || '';

export default function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ status: 'error', message: 'Método no permitido' });
  // 30 s en la CDN de Vercel (se vacía en cada despliegue): muchas pestañas no despiertan la función
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=30');
  return res.status(200).json({ version: VERSION });
}
