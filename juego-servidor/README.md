# Duelo de Acero (2 vs 2 o 1 vs 1 por turnos, cuerpo a cuerpo)

- `src/combate.js`: las reglas (clases, habilidades, filas, efectos, turnos y la jugada de los bots). Sin red.
- `src/sala.js`: una sala (Cloudflare Durable Object, una por enlace): conexiones WebSocket, puestos, quién es
  el anfitrión, el modo (2 vs 2 o 1 vs 1), el reloj de cada turno (25 s) y el ciclo sala → combate → fin → sala.
- `src/worker.js`: la entrada `/ws` (crear sala o entrar a una) y `/acceso`; en local también sirve la página.
- `../public/juego/`: la página (sala de espera + combate en pixel art dibujado en código). En la tienda queda
  en `/juego/` (Vercel) y se conecta a `wss://juego.levelupstore.online/ws`.

## Cómo se juega

1. El administrador toca **Crear partida** en el panel (Minijuego). Se abre el juego con su sala y queda como anfitrión.
2. La página le da el enlace de la sala (`/juego/?s=<sala>`) con botones para copiarlo o mandarlo por WhatsApp.
   Quien lo abre entra a esa sala (no necesita código). El anfitrión elige el modo: **2 vs 2** (4 puestos: Rojo y
   Azul, adelante y atrás) o **1 vs 1** (un puesto por lado; al cambiar, los de atrás pasan adelante o quedan mirando).
3. Cada uno elige puesto y clase. El anfitrión toca **Empezar** cuando quiera: los puestos vacíos los juegan bots.
4. Por turnos (orden por velocidad), 25 s para decidir; si no, ataque rápido automático (flecha floja). Si alguien se desconecta,
   su luchador juega solo hasta que vuelva (al recargar recupera su puesto).
5. Al terminar, el anfitrión toca **Otra partida** y vuelven todos a la sala con los mismos puestos.

Cuerpo a cuerpo: solo se le pega al enemigo de adelante (el de atrás, cuando el de adelante cae o con habilidades
que lo permiten). En 2 vs 2 cualquiera puede gastar su turno en cambiar de fila con su compañero. Las habilidades
tienen enfriamiento.

Todas las clases tienen dos ataques:
- **Ataque rápido**: poco daño, nadie lo puede esquivar (ni con Evasión).
- **Golpe fuerte**: mucho daño, pero se puede esquivar: 25 % + esquiva del rival − precisión del que ataca (entre 5 y 80 %).
  Las habilidades de daño se esquivan con la mitad de esa probabilidad (sin el 25 % base).

**Flecha de precisión**: en todo ataque sale una barra con una flecha que va y viene (más rápida en el golpe fuerte).
Mientras más cerca del centro la detengas, más daño: de ×0,4 en el borde a ×1,35; justo en el centro, ×1,5
("¡Perfecto!"). Los bots la detienen al azar. La precisión la manda la página (p de 0 a 1); el servidor la limita a ese rango.

**Atributos fijos** (no se pueden cambiar): fuerza multiplica el ataque rápido y el golpe fuerte; defensa resta daño;
esquiva y precisión deciden los golpes esquivados.

| Clase | Vida / Vel. | Fuerza / Defensa / Esquiva / Precisión | Habilidades |
|---|---|---|---|
| Guerrero (espada y escudo) | 135 / 3 | 100 % / 15 % / 8 % / 0 | Golpe de escudo (aturde), Provocar, Muro |
| Bárbaro (hacha) | 135 / 2 | 140 % / 8 % / 3 % / −5 | Tajo giratorio (a todos), Furia, Ejecutar |
| Lancero (lanza, sus ataques llegan atrás) | 115 / 4 | 108 % / 10 % / 12 % / +15 | Estocada (atraviesa), Empujón (cambia las filas rivales), Guardia |
| Asesino (dagas, 20 % de crítico) | 90 / 5 | 70 % / 0 % / 35 % / +30 | Veneno, Sombra (ignora filas), Evasión |
| Clérigo (maza y libro) | 112 / 3 | 85 % / 12 % / 10 % / +5 | Curar (34 a ti o a tu compañero), Plegaria (cura 18 a los dos y quita veneno/aturdido), Juicio (ignora filas) |

Para cambiar números o habilidades: `src/combate.js` (la página toma los textos de ahí). Después correr
`node prueba/combate.mjs`: simula 5000 partidas de bots en 2 vs 2 y otras 5000 en 1 vs 1 y muestra el % de
victorias de cada clase (hoy entre 41 y 55 %).

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
