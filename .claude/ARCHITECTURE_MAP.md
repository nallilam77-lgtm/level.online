# Mapa de arquitectura

Dominio: `https://levelupstore.online` (CORS de `/api/*` restringido a él en `vercel.json`).

---

## Estructura

```
api/                      Funciones serverless de Vercel (un archivo = un endpoint)
├── _lib/                 Código compartido (el "_" evita que Vercel lo publique)
│   ├── juegos/           Lógica de cada tienda (enrutada por api/juego.js y api/recargar.js)
│   │   ├── index.js      Lista cerrada de juegos + carga diferida (cargarJuego)
│   │   ├── freefire.js   acciones { precios, verificar, descuento } + recargar: manual, pines + bot de Railway o API de Central One (product_id en la fila 3 de "precios", `freefire_nuevo`)
│   │   ├── bloodstrike.js  acciones { precios, verificar, descuento } + recargar: API de Central One (product_id en la fila 3 de PreciosBlood)
│   │   ├── mobilelegends.js  igual que bloodstrike.js, pero el jugador es ID + Zona ID (`zona`). Hoja propia (SCRIPT_MLBB, apps-script/mobilelegends.gs), llave `mlbb_nuevo`, Idempotency-Key `ml-<idPedido>`
│   │   └── roblox.js     acciones { precios (+ stock: disponible/pocos/agotado, nunca la cantidad), descuento } + recargar: compra en apps-script/roblox.gs (sin reintentos; manda montoACobrar con código e idPedido; responde solo campos conocidos; pago insuficiente → clave para completar con `tokenComplemento` → `completarCompra`). Sin códigos guardados y con `roblox_nuevo`: roblox.gs responde `status: "comprar"` (pago "En proceso", fila en "pedidos_api") → `comprarEnCentralOne` (pedido + `esperarCodigo` hasta 150 s) → `entregar_api` / `liberar_api` / `nota_api`. Menú de la hoja "🎮 Roblox → 🔄" (solo tarjetas de Robux GLOBAL con stock, `REGIONES_ROBLOX`): reemplaza toda PreciosRoblox; "Codigos" es opcional (fila 2 fórmula con tasa_dolar, fila 3 product_id, 4 costo USD, 5 stock)
│   ├── recarga-comun.js  limpiarMontoVES, formatearVES, crearUtilidadesPedido (Free Fire y Blood Strike)
│   ├── descuentos.js     Códigos de descuento (tabla común en la pestaña "Descuentos" de la hoja de Free Fire)
│   ├── externo.js        pedirJSON/llamarScript: timeouts, reintentos, caché en memoria (conCache)
│   ├── fazer.js          firmaFazerValida (webhook de FazerCards, solo órdenes anteriores a Central One)
│   ├── centralone.js     Central One (Free Fire, Blood Strike, Mobile Legends y códigos de Roblox): catalogo, esperarCodigo/leerCodigos (GET /orders/{id} y /codes), datosParaPedido (catálogo 15 min; target_payload según target_schema, stock; con `zona` exige dos campos de texto y pone la zona en el que se llama zone/server), crearPedidoCentralOne (POST /orders, Idempotency-Key = idPedido, 1 reintento si es incierto) y firmaCentralOneValida (webhook)
│   ├── limitador.js      Límite de intentos fallidos (Firestore o memoria)
│   ├── reporte.js        informeError(), FASES, ESTADO_PINES → pestaña "errores"
│   └── validacion.js     PAQUETE_VALIDO, textoParaHoja(), faltaConfiguracion()
├── juego.js              GET/POST ?juego=<freefire|bloodstrike|roblox|mobilelegends>&accion=<precios|verificar|descuento> (30 s)
├── recargar.js           POST ?juego=<freefire|bloodstrike|roblox|mobilelegends> (maxDuration 180)
├── creadores.js          POST { codigo, pin } -> panel del creador (ventas, comisión, movimientos)
├── subir-imagen.js       Comprobante de pago → Drive (límite 4 MB)
├── consultar-ordenes.js  Consulta de pedidos (página de inicio)
├── ruleta.js             Ruleta de la suerte (apps-script/ruleta.gs; reintenta: el giro es idempotente)
├── fazer-webhook.js      Webhook de FazerCards (firma X-Webhook-Signature) → estado_fazer de recargas.gs Y de bloodstrike.gs (órdenes de Blood Strike anteriores a Central One) → pestaña "fazer_card" de la hoja que tenga la orden
├── centralone-webhook.js Webhook de Central One (firma X-CentralOne-Signature con timestamp ≤ 5 min) → estado_fazer de bloodstrike.gs (reference_code + sequence) → "fazer_card" de Blood Strike · idempotency_key `ff-…` → estado_fazer de recargas.gs (SCRIPT_RECARGAS_URL) → "fazer_card" de Free Fire · idempotency_key `ml-…` → estado_fazer de mobilelegends.gs (SCRIPT_MLBB) → "pedidos" de Mobile Legends · pedidos con idempotency_key `rbx-…` → roblox.gs (GAS_URL): delivered → `entregar_api` (código del aviso o de GET /codes), failed/cancelled → `liberar_api`, refunded → `nota_api`
└── ia-soporte.js         Chat de soporte con Gemini (rota GEMINI_KEYS)
apps-script/bloodstrike.gs Copia del Apps Script de Blood Strike (SCRIPT_BLOOD): precios (PreciosBlood), pagos en la hoja CENTRAL, finalizados (F = orden), errores y "fazer_card". Sin marcar_verificado.
apps-script/mobilelegends.gs Apps Script de Mobile Legends (SCRIPT_MLBB, hoja propia, v3): PreciosML, tasa_dolar, pedidos (estado de Central One), errores, por_completar (con zona) y resumen (fórmulas). Pagos en la hoja CENTRAL; cada recarga exitosa va a "finalizados" de Free Fire (ID_HOJA_FINALIZADOS) con "· Zona N" en el paquete. Menú 💎: 🔄 productos, 💲 dólar y ganancia, 🔑 llave, 🧱 pestañas
>>>>
scripts/productos-centralone.mjs Lista saldo y productos de Central One (diagnóstico; solo lee)
apps-script/validador.gs  Validador de IDs (SCRIPT_VALIDADOR_URL): POST { id, juego } (mobilelegends: también `zona`) → Central One /player/validate con un producto del juego (freefire: LATAM; bloodstrike: GLOBAL; mobilelegends: cualquier región, producto con ID + zona) (valid/invalid/unverified → { valid, verificado, player_name }). Llave en Propiedades del script: CENTRALONE_API_KEY (catalog:read)
apps-script/recargas.gs   Copia del Apps Script de recargas Free Fire (v2, con idPedido). Secciones: configuración, doPost, pagos, pines, ruleta, descuentos/creadores, menús, 7b menú de Central One (🔑, 🔄 Traer productos: Free Fire LATAM sin pines, 220 = "2x" el de 110, sin tocar tus precios), utilidades
public/                   Frontend estático; cada página lleva su CSS/JS en línea
├── index.html            Inicio + consultar órdenes + acceso al Panel de Creadores
├── creadores.html + css/creadores.css   Panel de Creadores (cómo ganas, reglas y consulta con código + PIN)
├── freefire.html / bloodstrike.html / roblox.html / mobilelegends.html   Tiendas por juego (mobilelegends.html: campos ID y Zona; pegar "123 (45)" en el ID los reparte)
├── admin.html            Panel (lee Firestore)
├── js/lector-referencia.js   Lee la referencia del comprobante (Tesseract)
├── js/descuento.js + css/descuento.css   Campo "código de descuento" (Free Fire, Blood Strike y Roblox)
├── js/aviso-codigo.js + css/aviso-codigo.css   Burbuja "Paga 1,5 % menos con un código de creador" (encima del botón de WhatsApp; se oculta mientras se escribe en el campo, hay código aplicado o un modal/chat abierto; la X la cierra 3 días)
├── img/og-*.jpg            Vista previa al compartir en WhatsApp (1200×630). Las etiquetas og: van en el <head> de cada página con URL absoluta y ?v=N: si cambias la imagen, sube el ?v= porque WhatsApp la guarda en caché. Soporte: wa.me/584228887089
└── terminos / privacidad / reembolsos.html + css/   Páginas legales
```

## Enrutamiento por juego

- El juego (y en `juego.js` la acción) va **siempre en la URL**; el cuerpo solo lleva datos.
- `cargarJuego()` solo acepta claves propias de la lista (`Object.hasOwn`): cualquier otro valor → 400.
- `juego.js` llama a `modulo.acciones[accion](req, res)`; si el juego no tiene esa acción → 400.
- `recargar.js` llama a `modulo.recargar(req, res)`. Cada módulo valida sus campos, mantiene sus tiempos y responde igual que los endpoints anteriores.
- Juego nuevo: crear `api/_lib/juegos/<juego>.js` con `acciones` y `recargar`, y añadirlo a `index.js`.
- **Compatibilidad temporal** (quitar tras ~2 semanas): `rewrites` de `vercel.json` para las rutas antiguas (`/api/precios`, `/api/precios-bloodstrike`, `/api/verificar`, `/api/recargar-bloodstrike`, `/api/roblox`), `freefire` por defecto en `recargar.js` y `tipo: "obtener_precios"` en `roblox.js`.

## Flujo de una recarga Free Fire (`api/_lib/juegos/freefire.js` → `recargar`)

1. Valida entrada y límite de fallos (`limitador.js`).
2. `obtener_precios` (caché) → precio real del paquete (nunca el del cliente) y su product_id de Central One (`producto`, fila 3; nunca llega al navegador). Columnas sin precio > 0 no se venden; en modo API tampoco las que dicen "SIN STOCK" en la fila 5. Cada paquete se reconoce por `clavePaquete` (igual en freefire.js y recargas.gs): los números ("110 💎" → "110"), las tarjetas por el nombre de su columna en "precios"/"codigos" ("Tarjeta semanal" → "semanal", "Semanal Lite" → "semanal_lite", "Tarjeta mensual" → "mensual") y los demás productos con nombre por sus palabras ("Pase de Subida de Nivel" → "pase_de_subida_de_nivel"). freefire.html los muestra al final del catálogo como "Membresía" (tarjetas) o "Pase".
3. `verificar_pago` (referencia + monto + `idPedido`) — idempotente.
4. `obtener_codigo` → pines del inventario — idempotente. Si no hay pines del paquete (o no existe su columna), con `manualSiNoHay` recargas.gs anota el pedido en la pestaña **"sin_codigo"** (recarga manual, casilla "¿hecha?") y responde `{manual:true}`: Vercel salta el bot, marca el pago "Usado", lo anota en finalizados y al cliente le responde éxito. Si Vercel no recibe esa respuesta, la fila se queda en "sin_codigo" y el pago se bloquea ("Usado"). Interruptor en el menú de la hoja "🖐️ Recargas Free Fire" (propiedad `MODO_RECARGA_FF`): "manual" (o sin elegir) manda TODOS los pedidos a "sin_codigo" aunque haya pines; "automatico" (bot) usa los pines; "api" anota el pedido en la pestaña **"fazer_card"** ("📤 POR ENVIAR") y responde `{api:true}` si Vercel mandó `ofertaFazer` (el product_id que `prepararCentralOne` comprobó: llave `freefire_nuevo`, en el catálogo, con stock y solo pide el ID); si no, va a "sin_codigo" con `motivoSinApi`.
5. POST al bot de Railway `/canjear` (`x-secret-token`). Resultado: ok / fallo_bot / no_procesado / incierto.
   Modo API (`{api:true}`): en vez del bot, `crearPedidoCentralOne` (1 reintento con la misma Idempotency-Key si es incierto). 220 = dos pedidos de 110 (fila 3 = "2x<product_id>"; Idempotency-Key `ff-<idPedido>-1`/`-2`, uno solo `ff-<idPedido>`; cada pedido en su fila de "fazer_card", columna J = reference_code). ok → el cliente ve éxito aunque siga "confirmed"; rechazo/incierto → `bloquearPago` (fase `apiFreeFire`) y la fila de "fazer_card" queda "❌ ERROR". Después, `api/centralone-webhook.js` actualiza la columna K (estado) en tiempo real; failed/cancelled/partially_completed/refunded anota UNA fila en "errores" para hacerla a mano (y un "completed" después de un fallo, otra de ATENCIÓN). Si el aviso llega antes que `registrar_finalizado`, recargas.gs lo guarda 6 h en CacheService y lo aplica al anotar el pedido. `api/fazer-webhook.js` sigue para las órdenes anteriores de FazerCards.
6. Si falla (cualquier error con el pago ya encontrado, también pago insuficiente): `devolver_codigos` cuando es seguro, y `bloquearPago` (`_lib/recarga-comun.js`): `registrar_error` y después `marcar_usado`. **Un pago nunca vuelve a "Verificado"** (recargas.gs ya no tiene `liberar_pedido` ni `marcar_verificado`; si `verificar_pago` no responde o responde `status:"error"` sin `ocupado` se usa `bloquear_pedido`). Cualquier excepción no prevista con el pago ya pedido → `responderErrorInesperado` (todas las referencias del pedido "Usado" + fila "ERROR INESPERADO" en "errores"). recargas.gs y bloodstrike.gs anotan `proc_`/`pedido_` ANTES de poner "En proceso", para que `bloquear_pedido` siempre encuentre el pago. Un pedido de "sin_codigo" no se borra: se hace a mano.
6b. **Pago insuficiente** (Free Fire): `pago_por_completar` pasa el pago a "Por completar" (ningún otro pedido lo toma) y anota el pedido en la pestaña **"por_completar"** (jugador, paquete, precio, huella SHA-256 de la clave; vence en 48 h, máx. 4 pagos). El cliente recibe la clave (`tokenComplemento`) y paga la diferencia: `recargar` con `{ tokenComplemento, referencia }` → `completarPago` → `usar_complemento` (con candado, idempotente por idPedido; ID, paquete y precio salen de la hoja) → `entregarRecarga` (las mismas fases 3-5) y TODOS los pagos quedan "Usado". Con un recargas.gs sin esa acción, se vuelve al bloqueo de siempre.
7. Éxito: `registrar_finalizado` (en modo API también lleva `ordenFazer` y `estadoFazer`, que se anotan en "fazer_card"). El cierre (marcar "Usado" + `registrar_finalizado`) corre después de responder éxito al cliente, con `cerrarEnSegundoPlano`, que repite lo que no se confirme (ver COMMON_MISTAKES #1).

## Servicios externos y variables

| Servicio | Variable(s) | Usado en |
|---|---|---|
| Apps Script recargas | `SCRIPT_RECARGAS_URL`, `SCRIPT_RECARGAS_TOKEN` | juegos/freefire (precios, recarga), subir-imagen |
| Apps Script órdenes | `SCRIPT_RECARGAS_VERIFICACION` | consultar-ordenes |
| Apps Script validador (`apps-script/validador.gs`) | `SCRIPT_VALIDADOR_URL` | juegos/freefire y juegos/bloodstrike (verificar) |
| Apps Script ruleta (`apps-script/ruleta.gs`) | `SCRIPT_RULETA_URL` (+ `SCRIPT_RECARGAS_TOKEN` opcional) | ruleta |
| Apps Script Roblox (`apps-script/roblox.gs`) | `GAS_URL` (+ `SCRIPT_RECARGAS_TOKEN` opcional) | juegos/roblox |
| Apps Script Blood Strike + Central One | `SCRIPT_BLOOD` (+ `SCRIPT_RECARGAS_TOKEN`, que llamarScript también le envía), `blood_nuevo` | juegos/bloodstrike |
| Apps Script Mobile Legends + Central One | `SCRIPT_MLBB` (+ `SCRIPT_RECARGAS_TOKEN`), `mlbb_nuevo` | juegos/mobilelegends, centralone-webhook |
| Webhook Central One | `CENTRALONE_WEBHOOK_SECRET` (+ `SCRIPT_BLOOD`, `SCRIPT_RECARGAS_URL`, `GAS_URL`, `roblox_nuevo`) | centralone-webhook |
| Central One para Free Fire | `freefire_nuevo` (catalog:read, orders:read, orders:write) | juegos/freefire (modo API) |
| Central One para Roblox | `roblox_nuevo` (catalog:read, orders:read, orders:write, codes:read) | juegos/roblox |
| Webhook FazerCards (solo órdenes anteriores) | `FAZER_WEBHOOK_SECRET` (+ `SCRIPT_RECARGAS_URL`) | fazer-webhook |
| Bot Railway | `RAILWAY_SECRET` | juegos/freefire (recarga) |
| Firestore | `FIREBASE_SERVICE_ACCOUNT` | _lib/limitador |
| Gemini | `GEMINI_KEYS` / `GEMINI_API_KEY`, `GEMINI_MODEL` | ia-soporte |

Detalle de cada variable: `.env.example`.

## Blood Strike

- Paquetes por `clavePaquete` de bloodstrike.js: el oro por su número; los pases y bolsas por una palabra de su nombre en PreciosBlood, en español o inglés (`PALABRAS_PASES`: élite, premium, bolsa/lucky, temporada/season, nivel/level), p. ej. "Pase de Temporada" → `season_pass`. En bloodstrike.html, una columna sin números es un "Pase" y va al final.
- Pago insuficiente: igual que Free Fire (`pago_por_completar` / `usar_complemento` en bloodstrike.gs, pestaña "por_completar" de la hoja de Blood Strike; `completarPago` → `entregarRecarga` en bloodstrike.js). bloodstrike.gs también tiene `bloquear_pedido` (usado si `usar_complemento` no responde). El estado "Por completar" vive en la hoja CENTRAL de pagos: ningún juego lo toma.
- Proveedor (desde 2026-10-20): **Central One** (antes FazerCards). Pestaña PreciosBlood: fila 1 paquete · fila 2 precio Bs (fórmula ROUND(costo × tasa_dolar!B1 × (1 + tasa_dolar!B2 / 100), 2); B2 = 4 % por defecto) · fila 3 product_id · fila 4 costo USD · fila 5 stock. obtener_precios manda los precios numéricos como "1.144,40". La llena el menú de la hoja "🩸 Blood Strike → 🔄 Traer productos de Central One" (llave en la propiedad del script CENTRALONE_API_KEY, menú 🔑; conserva el precio de los product_id que ya estaban). obtener_precios omite columnas sin precio > 0 y manda `producto`; Vercel lo quita antes de responder al navegador (`sinProducto`). Sin product_id válido o con dos columnas de la misma clave → 503 ANTES de verificar el pago (queda libre). Con el pago tomado: `datosParaPedido` (fuera de catálogo / sin stock / pide un dato que no preguntamos → bloquear, sin pedido) → `crearPedidoCentralOne` (ok → éxito al cliente aunque siga "confirmed"; rechazo 4xx o incierto → `bloquear`).
- Éxito: `registrar_finalizado` lleva `ordenFazer` (= reference_code `CO-ORD-…`), `estadoFazer`, `ofertaFazer` (product_id y total en USD) y `montoCobrado`; bloodstrike.gs anota la fila en "fazer_card" (columna J = estado). El webhook de Central One la actualiza; failed/cancelled/partially_completed/refunded → UNA fila en "errores"; un "completed" después de "failed" anota otra fila de ATENCIÓN (no recargar a mano).

## Mobile Legends (desde 2026-10-22)

- Igual que Blood Strike (Central One, pago insuficiente con `por_completar`, cierre en segundo plano), con estas diferencias: el jugador es **ID + Zona ID** (`zona`, 1-6 números) en la página, la verificación, la recarga, `por_completar` y `usar_complemento`; el pedido se crea con Idempotency-Key `ml-<idPedido>` y el webhook lo manda solo a SCRIPT_MLBB.
- Hoja propia (`apps-script/mobilelegends.gs`, `VERSION_SCRIPT = 3`; Vercel no vende con otra versión). PreciosML con las mismas 5 filas que PreciosBlood; el 🔄 solo trae diamantes normales GLOBAL con stock (sin pases, doble diamante, eventos ni Adventure: `PRODUCTO_ESPECIAL`), los `MAX_PRODUCTOS` = 10 más baratos. `clavePaquete` (mobilelegends.js) = `clavePaqueteML` (mobilelegends.gs): diamantes por su número; pases por palabra (semanal/weekly → `weekly_pass`, crepúsculo/twilight → `twilight_pass`, estelar plus → `starlight_plus`, estelar → `starlight`) más su número si lo tienen ("Pase Semanal x2" → `weekly_pass_2`).
- `registrar_finalizado`: primero la fila de "pedidos" (no repite un pedido de Central One ya anotado), después "finalizados" de Free Fire (B = ID, C = paquete · Zona) y la marca `fin_<idPedido>`. El uso del código de descuento lo anota Vercel con `registrar_uso_descuento` (juego "Mobile Legends"), no la hoja.

## Códigos de descuento y Panel de Creadores (hoja de Free Fire)

- **Descuentos**: A código · B descuento en % (solo promos; los de creador dan siempre `PORCENTAJE_CREADOR`) · C usos · D dinero movido (Bs) · E creador (vacío = promo normal) · F PIN · G % actual (= descuento del cliente) · H comisión total (USD) · I liquidado (Bs, referencia) · J pendiente (USD) · K sin uso (eran los niveles bajados) · L comisión por convertir (Bs, ventas sin tasa). **Comisión por venta**: cada venta guarda su comisión (% y tasa de ese día) en "movimientos_descuentos" y la SUMA a H y J; H y J son saldos, no se recalculan (cambiar el % o la tasa no toca lo ganado). Registrar pago (menú ⭐ Creadores) deja J en 0; pagos en "pagos_creadores". Arranque: `iniciarSaldosPorVenta` fija una vez H/J con el cálculo anterior (propiedad `saldos_por_venta`).
- **movimientos_descuentos** (se crea sola): cada venta con código; historial de cada venta (el panel calcula la comisión con el % y la tasa actuales).
- **config!B1**: tasa Bs por 1 USD (actualizarla a mano).
- Creadores (desde 2026-10-13): sin niveles, sin metas semanales y sin límite de creadores. `PORCENTAJE_CREADOR` = 1,5 % (descuento del cliente = comisión del creador) y `RETIRO_MINIMO_USD` = 3 en `recargas.gs`. `revisarMetasSemanales` quedó solo para borrar el activador viejo de los lunes. Menú ⭐ Creadores → ♻️ `pasarVentasAnterioresAlPorcentaje`: una vez por % (propiedad `retroactivo_<%>`), recalcula cada venta de "movimientos_descuentos" al % actual con la tasa de esa venta, H = suma, J = H − pagado ("pagos_creadores"). "movimientos_descuentos": D = id del jugador, I = id del pedido (filas viejas: pedido en D). `sumarUsoDescuento` ignora un idPedido ya anotado (un reintento no duplica uso ni comisión); si el uso del código no se pudo anotar, el cierre de Free Fire/Blood Strike lo deja en la pestaña "errores" para hacerlo a mano. Si se cambian, actualizar también el texto de `creadores.html`.
