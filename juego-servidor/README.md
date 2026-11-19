# Duelo de Acero (2 vs 2 por turnos, cuerpo a cuerpo)

- `src/combate.js`: las reglas (clases, habilidades, filas, efectos, turnos y la jugada de los bots). Sin red.
- `src/sala.js`: una sala (Cloudflare Durable Object, una por enlace): conexiones WebSocket, puestos, quién es
  el anfitrión, el reloj de cada turno (20 s) y el ciclo sala → combate → fin → sala.
- `src/worker.js`: la entrada `/ws` (crear sala o entrar a una) y `/acceso`; en local también sirve la página.
- `../public/juego/`: la página (sala de espera + combate en pixel art dibujado en código). En la tienda queda
  en `/juego/` (Vercel) y se conecta a `wss://juego.levelupstore.online/ws`.

## Cómo se juega

1. El administrador toca **Crear partida** en el panel (Minijuego). Se abre el juego con su sala y queda como anfitrión.
2. La página le da el enlace de la sala (`/juego/?s=<sala>`) con botones para copiarlo o mandarlo por WhatsApp.
   Quien lo abre entra a esa sala (no necesita código). Hay 4 puestos: Rojo y Azul, adelante y atrás.
3. Cada uno elige puesto y clase. El anfitrión toca **Empezar** cuando quiera: los puestos vacíos los juegan bots.
4. Por turnos (orden por velocidad), 20 s para decidir; si no, ataque básico automático. Si alguien se desconecta,
   su luchador juega solo hasta que vuelva (al recargar recupera su puesto).
5. Al terminar, el anfitrión toca **Otra partida** y vuelven todos a la sala con los mismos puestos.

Cuerpo a cuerpo: solo se le pega al enemigo de adelante (el de atrás, cuando el de adelante cae o con habilidades
que lo permiten). Cualquiera puede gastar su turno en cambiar de fila con su compañero. Las habilidades tienen
enfriamiento.

| Clase | Vida / Vel. | Habilidades |
|---|---|---|
| Guerrero (espada y escudo) | 140 / 3 | Golpe de escudo (aturde), Provocar, Muro |
| Bárbaro (hacha) | 120 / 2 | Tajo giratorio (a los dos), Furia, Ejecutar |
| Lancero (lanza, su básico llega atrás) | 112 / 4 | Estocada (atraviesa), Empujón (cambia las filas rivales), Guardia |
| Pícaro (dagas, 25 % de crítico) | 100 / 5 | Veneno, Sombra (ignora filas), Evasión |

Para cambiar números o habilidades: `src/combate.js` (la página toma los textos de ahí). Después correr
`node prueba/combate.mjs`: simula 5000 partidas de bots y muestra el % de victorias de cada clase (hoy 47-52 %).

Una sala se borra si se queda 2 minutos sin nadie conectado; su enlace deja de servir y hay que crear otra.

Sonidos: Kenney (CC0, `public/juego/sonidos/LICENCIA-kenney.txt`).

## Probar en tu computadora

```
cd juego-servidor
npm install        # solo la primera vez
npm run dev        # abre http://localhost:8787 (en local no pide código)
npm run prueba     # (con npm run dev corriendo) simula partidas y prueba una sala con dos jugadores
```

Para jugar entre varios en local: crea la sala en una pestaña y abre el enlace de la sala en otras.

## Acceso privado

Solo el administrador crea partidas: admin.html → Minijuego → **Crear partida** abre `/juego/?c=<su código>&nueva=1`
(supabase/juego-enlaces.sql; el código no vence y el panel lo crea la primera vez) y la sala se crea sola. El Worker
revisa el código con `juego_entrar()` (solo acepta el del dueño) en `/acceso` y al crear la sala. Los demás entran
únicamente con el enlace de una sala (`?s=<sala>`).

## Publicar (Cloudflare, plan gratis)

1. `npx wrangler login` (abre tu cuenta de Cloudflare).
2. Las dos variables (una sola vez): `npx wrangler secret put SUPABASE_URL` y `npx wrangler secret put SUPABASE_KEY`
   (la URL del proyecto y la clave pública "anon"/publishable de Supabase).
3. `npm run deploy` (también crea `juego.levelupstore.online`, por `routes` en wrangler.toml).

Plan gratis: los mensajes cuentan como peticiones (20 mensajes = 1 petición, tope de 100.000 por día). Al ser por
turnos se mandan muy pocos (una acción por turno y un ping cada 25 s), así que alcanza de sobra.
