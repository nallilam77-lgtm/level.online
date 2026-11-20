# Arena de Level Up (Duelo de Acero para clientes)

Sección pública de la tienda (`/arena.html`) para clientes con sesión de Google. Tres partes:

1. **Duelo rápido** (gratis): "Buscar rival" empareja 1 vs 1 con otro cliente conectado; si en 20 s no hay
   nadie, juega contra un bot (sin puntos).
2. **Ranking semanal** (gratis): ganarle a una persona en el duelo rápido da +25 puntos y perder resta 10
   (nunca baja de 0). Contra bots no hay puntos. Se reinicia cada lunes (hora de Venezuela). Sin premios por ahora.
3. **Torneo pagado**: el cliente elige modo (1 vs 1 o 2 vs 2) y juego del premio (Free Fire, Blood Strike o
   Mobile Legends), escribe su ID y paga por Pago Móvil el paquete de inscripción del juego (p. ej. 110
   Diamantes de Free Fire = 780 Bs). Se juega al **mejor de 3 combates**; el ganador (en 2 vs 2, cada
   jugador del equipo ganador) recibe **el doble del paquete** (220 Diamantes) en su ID, por Central One.

## Torneo pagado: reglas (decididas por el dueño, 2026-11-19)

- Se empareja con quien eligió el **mismo modo, juego y paquete** (así todos pagaron lo mismo).
- Al pagar el primero: "Inscrito, esperando rival". Cuando paga el último que falta, la partida queda
  **lista** y el sistema le asigna una **hora** (la siguiente media hora con al menos 30 min de margen,
  entre 9:00 y 22:00 de Venezuela; si no cabe, al día siguiente a las 9:00). Se avisa a todos (notificación).
- **Sin rival en 24 h**: la inscripción se cierra y cada uno recibe **su paquete** (sus 110 Diamantes):
  no pierde nada y la tienda tampoco.
- La sala abre 10 min antes de la hora. Empieza cuando están todos (desde 5 min antes) o a la hora + 10 min
  con los que haya. **Ausente**: si falta un equipo entero, gana el otro (se lleva el premio); en 2 vs 2, si
  falta uno, un bot juega su puesto. Si no entra **nadie**, cada uno recibe su paquete.
- Empate en un combate (40 rondas sin ganador y misma vida): ese combate se repite.
- Avisos (notificaciones del navegador, si las activa): partida lista con su hora, 10 min antes y a la hora.

## Piezas

| Dónde | Qué |
|---|---|
| `supabase/arena.sql` | Tablas `arena_partidas`, `arena_inscripciones`, `arena_ranking`, `arena_push`; funciones `arena_*` (solo service_role, salvo `arena_mias`/`arena_ranking_semana` para el cliente y `admin_arena*`). Secretos en Supabase Vault: `arena_secreto` (Worker ↔ Vercel) y `vapid_privada`. |
| `api/arena.js` + `api/_lib/arena.js` | `config` (GET), `inscribir` (POST con sesión: valida ID, toma el pago con `pagos_tomar`, inscribe), `mias` (GET con sesión), `push` (POST con sesión: guarda la suscripción), y para el Worker (cabecera `X-Arena` = secreto): `sala`, `evento` (empezó / resultado / ranking) y `tic` (cada minuto). |
| `api/_lib/entrega.js` | Entrega de un paquete por Central One a un ID (Free Fire, Blood Strike, Mobile Legends) y su fila en `recargas` (Panel → Pedidos/Revisión). Idempotency-Key fija por premio: repetir no cobra dos veces. |
| `api/_lib/push.js` | Notificaciones Web Push (VAPID, librería `web-push`). |
| `juego-servidor/` | Salas de torneo (`?a=<partida>`, mejor de 3, solo los inscritos se sientan, con su sesión), cola del duelo rápido (`/cola`), salas con puntos, flecha medida en el servidor y un cron cada minuto que llama a `tic`. |
| `public/arena.html` | La sección para clientes. |
| `public/sw.js` | Muestra las notificaciones y abre la Arena al tocarlas. |
| `admin.html → Arena` | Encender/apagar el torneo, paquete por juego y lista de partidas con sus entregas. |

## Seguridad

- La sesión se comprueba en el servidor (Vercel con `usuarioDelToken`; el Worker con `/auth/v1/user`).
- La flecha: el servidor mide el tiempo (la página solo dice cuánto tardó y se acepta dentro del margen de
  su ping). Un programa hecho para eso podría seguir acertando: es el límite de cualquier juego de reflejos.
- Pagos: mismas reglas que la tienda (un pago tomado nunca vuelve a "verificado"; si no alcanza, queda usado
  y el cliente sigue por WhatsApp).
