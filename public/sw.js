// Service worker de Level Up (lo registra js/instalar-app.js). Solo hace dos cosas:
//   1. Permite instalar la tienda como app (Android pide un service worker).
//   2. Si el cliente abre una página SIN internet, muestra un aviso en vez del dinosaurio.
// NO guarda páginas, precios ni nada en caché: todo sale siempre de internet (los precios y pagos
// tienen que ser los de ese momento). Las peticiones que no son de navegación ni se tocan.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (evento) => evento.waitUntil(self.clients.claim()));

const SIN_CONEXION = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#0f172a"><title>Sin conexión · Level Up</title>
<style>:root{--bg:#0f172a;--texto:#f1f5f9;--tenue:#94a3b8;--acento:#22d3ee}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--texto);font-family:Montserrat,system-ui,sans-serif;text-align:center;padding:16px}h1{font-size:22px;margin:0 0 8px}p{color:var(--tenue);font-size:14px;margin:0 0 20px}button{min-height:44px;padding:0 22px;border:0;border-radius:12px;background:var(--acento);color:var(--bg);font-weight:800;font-size:14px;cursor:pointer}</style></head>
<body><main><h1>Sin conexión a internet</h1><p>Revisa tus datos o tu Wi-Fi y vuelve a intentar.</p><button onclick="location.reload()">Reintentar</button></main></body></html>`;

self.addEventListener('fetch', (evento) => {
  if (evento.request.mode !== 'navigate') return;
  evento.respondWith(fetch(evento.request).catch(() => new Response(SIN_CONEXION, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })));
});
