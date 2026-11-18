// =========================================================================
// Serpientes Neón · puerta de entrada (Cloudflare Worker).
// /ws → la sala del juego (Durable Object). Lo demás: los archivos de public/juego (solo para probar en local;
// en la tienda la página la sirve Vercel en /juego/).
// =========================================================================

export { Sala } from './sala.js';

const ORIGENES = ['https://www.levelupstore.online', 'https://levelupstore.online'];

function origenPermitido(origen, url) {
  if (!origen) return true;                        // apps sin navegador: igual las frena el límite de la sala
  if (ORIGENES.includes(origen) || origen === url.origin) return true;
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origen);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/ws') {
      if (!origenPermitido(request.headers.get('Origin'), url)) return new Response('Origen no permitido', { status: 403 });
      const sala = env.SALA.get(env.SALA.idFromName('sala-principal'));
      return sala.fetch(request);
    }
    return new Response('No encontrado', { status: 404 });
  },
};
