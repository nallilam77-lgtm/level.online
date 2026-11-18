# Serpientes Neón (juego en línea, hasta 15 jugadores)

- `src/partida.js`: la partida (movimiento, comida, choques, bots). El servidor decide todo.
- `src/sala.js`: la sala (Cloudflare Durable Object): conexiones WebSocket, 20 pasos por segundo.
- `src/worker.js`: la entrada `/ws`; en local también sirve la página.
- `../public/juego/`: la página del juego (Canvas). En la tienda queda en `/juego/` (Vercel) y se conecta a
  `wss://juego.levelupstore.online/ws`.

## Probar en tu computadora

```
cd juego-servidor
npm install        # solo la primera vez
npm run dev        # abre http://localhost:8787
```

Abre esa dirección en varias pestañas o en otro teléfono de tu misma red Wi-Fi para jugar entre varios.
`npm run prueba` conecta 15 jugadores de prueba a la vez (con `npm run dev` corriendo).

## Publicar (Cloudflare, plan gratis)

1. `npx wrangler login` (abre tu cuenta de Cloudflare).
2. `npm run deploy`.
3. En Cloudflare → Workers → levelup-juego → Settings → Domains: agregar `juego.levelupstore.online`.

Plan gratis: los mensajes de los jugadores cuentan como peticiones (20 mensajes = 1 petición, tope de
100.000 por día). Por eso el navegador solo manda la dirección cuando cambia, máximo 10 veces por segundo.
