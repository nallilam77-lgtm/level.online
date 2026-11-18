# Último en Pie (battle royale en línea, hasta 15 jugadores)

- `src/partida.js`: la partida (movimiento, disparos, botín, zona, bots y quién gana). El servidor decide todo.
- `src/sala.js`: la sala (Cloudflare Durable Object): conexiones WebSocket, 20 pasos por segundo, ciclo
  espera → partida → fin. Si no queda nadie conectado, se apaga y vuelve a empezar limpia.
- `src/worker.js`: la entrada `/ws`; en local también sirve la página.
- `../public/juego/`: la página del juego (Canvas). En la tienda queda en `/juego/` (Vercel) y se conecta a
  `wss://juego.levelupstore.online/ws`.

Reglas: todos caen con pistola; en el piso hay subfusil, escopeta, rifle, francotirador, botiquines (+35 de
vida) y chalecos (+50 de escudo). Con pistola el arma se agarra sola; con otra, se cambia con E o el botón.
Cada arma tiene cargador y recarga (R o el botón). La zona se cierra en 4 fases y quema más en cada una. Si hay
menos de 10 personas, entran bots.

Arte y sonidos: Kenney "Desert Shooter Pack" (CC0, `public/juego/img/LICENCIA-kenney.txt`). Solo se usan
las hojas copiadas a `public/juego/img/` y 14 sonidos de `public/juego/sonidos/`; los paquetes completos
quedan en `recursos-juego/` (no se suben).

## Probar en tu computadora

```
cd juego-servidor
npm install        # solo la primera vez
npm run dev        # abre http://localhost:8787  (o http://localhost:8787/?espera=5 para no esperar 20 s)
```

Abre esa dirección en varias pestañas para jugar entre varios.
`npm run prueba` conecta 15 jugadores de prueba a la vez (con `npm run dev` corriendo).

## Acceso privado

Solo se juega con un enlace `https://www.levelupstore.online/juego/?c=<código>`. Los códigos se crean en
admin.html → Minijuego → "Último en Pie" (supabase/juego-enlaces.sql): **Jugar ahora** usa el tuyo (no vence) y
**Crear enlace** hace uno para otra persona (vence en 1, 7, 30 días o nunca; se puede anular). El Worker revisa
el código con `juego_entrar()` en `/acceso` y al abrir `/ws`. En local (localhost) no pide código.

## Publicar (Cloudflare, plan gratis)

1. `npx wrangler login` (abre tu cuenta de Cloudflare).
2. Las dos variables (una sola vez): `npx wrangler secret put SUPABASE_URL` y `npx wrangler secret put SUPABASE_KEY`
   (la URL del proyecto y la clave pública "anon"/publishable de Supabase).
3. `npm run deploy` (también crea `juego.levelupstore.online`, por `routes` en wrangler.toml).

Plan gratis: los mensajes de los jugadores cuentan como peticiones (20 mensajes = 1 petición, tope de
100.000 por día). Por eso el navegador solo manda los controles cuando cambian, máximo 10 veces por segundo
(~7 por segundo por jugador en la prueba: con 15 jugadores a la vez alcanza para unas 4 horas al día).
