# Errores comunes

Errores que ya ocurrieron (o casi) en Level Up. Revisar antes de tocar `api/` o `apps-script/`.

---

## 1. Reintentar operaciones que crean algo

**Síntoma**: pines entregados dos veces, compras de Roblox/Blood Strike duplicadas, filas repetidas en la hoja.
**Regla**: solo se reintenta lo idempotente (leer precios, validar ID, `marcar_usado`, y `verificar_pago`/`obtener_codigo` porque llevan `idPedido`; la ruleta, porque `apps-script/ruleta.gs` devuelve el premio ya anotado si la misma referencia y el mismo jugador repiten). Nunca se reintenta tras un timeout: compras (`api/_lib/juegos/roblox.js`, FazerCards en `freefire.js`), `registrar_*`, `subir_imagen`. Única compra que sí se reintenta (una vez): Central One en `_lib/centralone.js`, porque repite la MISMA `Idempotency-Key` (idPedido) y Central One devuelve el mismo pedido sin cobrar dos veces; nunca generar una llave nueva para reintentar.
**Dónde**: comentario de cabecera de `api/_lib/externo.js` (`reintentarTrasTimeout`).
**Cierre de una recarga ya entregada** (desde 2026-10-16): al cliente se le responde éxito en cuanto FazerCards/el bot confirma; `marcar_usado`, `registrar_finalizado` y `registrar_uso_descuento` corren DESPUÉS de responder con `cerrarEnSegundoPlano` (`_lib/recarga-comun.js`, con `waitUntil`), EN ORDEN, y lo que no se confirme se repite tras 10, 20 y 40 s dentro de los 180 s de la función; solo si sigue fallando se anota el aviso "CIERRE" en "errores". Por eso la ruleta puede encontrar el pago aún "En proceso": ruleta.gs responde `enCierre` y api/ruleta.js lo repite una vez tras 5 s; no volver a tratar "En proceso" como "sin recarga completada". `registrar_finalizado` solo se repite con el script v3 (`VERSION_SCRIPT = 3` en recargas.gs y bloodstrike.gs: ignora un `idPedido` ya anotado, marca `fin_<idPedido>` 6 h en CacheService); con v2 no, porque duplicaría la fila. Al subir un `.gs`, no bajar `VERSION_SCRIPT`.

## 1b. `registrar_finalizado` que falla en todas las recargas

**Síntoma** (2026-10-17): en "errores", "FazerCards aceptó la orden …, pero Apps Script no respondió al cierre (ni tras 3 reintento(s)…): falta anotar la recarga en \"finalizados\"", en cada recarga.
**Regla**: en recargas.gs, `registrarFinalizado` anota la fila, hace `flush` y marca `fin_<idPedido>` ANTES de los pasos secundarios (asignaciones, fazer_card, por_completar, descuentos); cada uno va en su try/catch y lo que falle se anota en "errores" sin tumbar el cierre. La pestaña "finalizados" se crea si falta. `conCandado` devuelve `detalle` (mensaje de la excepción) y Vercel lo copia al aviso del cierre ("Motivo: …"); nunca se reenvía al cliente.

## 2. Ejecutar en paralelo `registrar_error` y `marcar_usado`

**Síntoma**: tras un fallo del bot, el pago queda en "Verificado" y la referencia se puede reutilizar.
**Regla**: las llamadas que cambian el estado del pago van **en orden** (`await` una tras otra), nunca con `Promise.all`.

## 2b. Tomar `{status:"error"}` de Apps Script como éxito

**Síntoma**: recargas en "finalizados" cuyo pago sigue "En proceso"/"Verificado" y sin aviso en "errores".
**Causa**: `marcar_usado` y `registrar_finalizado` iban en paralelo y compiten por el candado de recargas.gs (8 s); el perdedor recibía `{status:"error", ocupado:true}` con HTTP 200 y `marcarReferencia` lo daba por bueno.
**Regla**: `marcarReferencia`/`registrarEnHoja` (`_lib/recarga-comun.js`) solo cuentan como éxito lo que no trae `status:"error"` y repiten si viene `ocupado`. Las llamadas a recargas.gs del cierre van en orden. Reparar los ya afectados: menú "🖐️ Recargas Free Fire" → 🧰 Mantenimiento → ✅ Marcar como Usado los pagos ya finalizados.

## 2c. Devolver un pago a "Verificado"

**Regla** (desde 2026-10-13): ningún error lo libera, ni pago insuficiente ni rechazo del proveedor. Siempre `bloquearPago` (anota en "errores" y marca "Usado"); el cliente sigue por WhatsApp.
**Errores no previstos** (desde 2026-10-15): en Free Fire y Blood Strike, desde que se pide `verificar_pago`/`usar_complemento` el pedido queda en la variable `pedido`; cualquier excepción llega al `catch` general y `responderErrorInesperado` (`_lib/recarga-comun.js`) lo bloquea con `bloquearPorError` (fase "ERROR INESPERADO"). Un `{status:"error"}` de Apps Script (salvo `ocupado`, que no ejecutó nada) se trata como falta de respuesta: `bloquear_pedido` + fila en "errores". Al añadir un paso nuevo, no atrapar la excepción en silencio: si no hay un `bloquear(...)` propio, déjala subir al `catch`. No volver a añadir `marcar_verificado`/`liberar_pedido`. Excepción controlada: en Free Fire el pago insuficiente queda "Por completar" (tampoco es reutilizable) hasta que el cliente complete la diferencia o venza el plazo; nunca pasa a "Verificado".

## 2d. Pagos de MacroDroid que no llegan a "pagos"

**Síntoma**: MacroDroid recibe HTTP 200 pero la fila no aparece.
**Causas vistas**: (1) la URL de MacroDroid era de otro Apps Script; la respuesta ahora trae `libro`, `hoja` y `fila`, y si no los trae, es otro script. (2) El candado: con 8 s de espera, si había una recarga en curso respondía `ocupado` (también HTTP 200) sin guardar; MacroDroid ahora espera `ESPERA_CANDADO_MACRODROID_MS` (20 s). (3) `SocketTimeoutException` hacia `script.googleusercontent.com`: red del teléfono. En MacroDroid hay que reintentar si `respuesta` no contiene `success`; es seguro porque el script detecta la referencia repetida.

## 3. 401 del bot de Railway

**Síntoma**: `El bot rechazó la autenticación (HTTP 401)`.
**Causa**: `RAILWAY_SECRET` (Vercel) ≠ `WEBHOOK_SECRET` (Railway), o se añadieron cabeceras extra.
**Regla**: el bot lee solo la cabecera `x-secret-token`. No añadir `Authorization` ni otras variantes.

## 4. Tiempos que no caben en `maxDuration`

**Síntoma**: Vercel corta la función a mitad de una recarga (estado incierto de pines y pago).
**Regla**: Apps Script tarda 5-15 s en arrancar en frío. Si cambias un tiempo en `TIEMPOS` o en `externo.js`, recalcula el "peor caso" del comentario del endpoint y que siga por debajo de su `maxDuration` en `vercel.json`.

## 5. Responder 500 o filtrar errores internos

**Regla**: falta de variable de entorno → `faltaConfiguracion()` (503). Servicio externo caído → 503 con mensaje para el cliente. El detalle técnico va a `console.error` y a la pestaña "errores" (`informeError()` de `_lib/reporte.js`), nunca al cliente.

## 6. Texto del cliente sin sanear

**Regla**: todo lo que va a Google Sheets pasa por `textoParaHoja()` (evita fórmulas `=IMPORTXML`...). Nombres de paquete → `PAQUETE_VALIDO`. En el frontend, datos dinámicos en HTML siempre escapados (ver `escaparHtml` en `public/admin.html`).

## 7. Desplegar Apps Script con una implementación nueva

**Síntoma**: la tienda deja de funcionar porque la URL `/exec` cambió.
**Regla**: Implementar → Gestionar implementaciones → editar la existente → "Nueva versión". Y para el token: primero `SCRIPT_RECARGAS_TOKEN` en Vercel (y redesplegar), **después** la propiedad `TOKEN_VERCEL` en Apps Script.
**Token obligatorio** (desde 2026-11-08): los 6 scripts (recargas, bloodstrike, mobilelegends, roblox, ruleta, validador) rechazan TODO lo que llegue por POST sin `TOKEN_VERCEL` correcto (los pagos de MacroDroid no: siguen con `MACRODROID_CLAVE` opcional). Si la tienda responde "No autorizado" en todo, falta la propiedad en ese script o no coincide con `SCRIPT_RECARGAS_TOKEN`. `llamarScript` (`_lib/externo.js`) manda el token a cualquier Apps Script: no volver a añadirlo a mano ni limitarlo a unas URLs (antes solo iba a Free Fire y Blood Strike, y Mobile Legends y el validador quedaban sin él).

## 7c. IP del cliente detrás de Cloudflare

**Regla** (2026-11-08): `obtenerIp` (`_lib/limitador.js`) usa `cf-connecting-ip` SOLO si la conexión viene de un rango de Cloudflare (`RANGOS_CLOUDFLARE`); si no, cualquiera inventaría esa cabecera para saltarse los límites. Sin esto, todos los clientes de un mismo nodo de Cloudflare compartían el contador.

## 7b. Mudarse a una hoja nueva

**Regla**: la hoja nueva es otro proyecto de Apps Script: URL `/exec` nueva y propiedades vacías. `ID_HOJA_PAGOS` de bloodstrike.gs, roblox.gs y ruleta.gs apunta a la pestaña "pagos" de la hoja de Free Fire: cambiarlo en los tres EL MISMO DÍA, con la tienda cerrada, junto con `SCRIPT_RECARGAS_URL` (Vercel) y la URL de MacroDroid; si no, un pago puede gastarse en las dos hojas. La herramienta de copia (menú 🚚, `copiarDesdeHojaVieja`) se quitó el 2026-11-02 porque la mudanza ya se hizo: si hace falta otra vez, recuperarla del historial de git (commit 2929afb) y recordar que fija `saldos_por_venta` y `retroactivo_<%>` para que los saldos de los creadores no se recalculen, crear TOKEN_VERCEL/MACRODROID_CLAVE y copiar `appsscript.json` (permisos de Firestore).

## 8. Otros

- Log `⚠️ precios:…: Apps Script falló (Apps Script lento)`: ya no sale cuando Apps Script solo tarda más de 1,5 s (`conCache` responde con la copia y renueva en segundo plano). Si aparece "falló" o "no se pudo renovar", Apps Script sí respondió con error.
- Precios que no se actualizan tras cambiar la hoja: la renovación en segundo plano de `conCache` necesita `waitUntil` (@vercel/functions); sin él Vercel congela la función al responder y la copia vieja dura hasta 6 h. No quitarlo.
- Precios viejos con `x-vercel-cache: STALE`: no volver a poner `stale-while-revalidate` en `cabecerasCachePrecios`; la CDN servía la copia vieja varios minutos tras cambiar la hoja.
- Aviso `DEP0169 url.parse()` en Vercel: no es nuestro código; se oculta con `NODE_OPTIONS=--disable-warning=DEP0169`.
- Contador del inicio en 0 los días 1 a 12 (2026-11-01): `appendRow` con "01/11/2026 …" hace que la hoja (configuración regional de EE. UU.) lo guarde como fecha del 11 de enero; del 13 al 31 queda como texto. `contarFinalizadosHoy` acepta los dos órdenes. Cualquier código nuevo que lea la fecha de una pestaña debe contar con que puede venir como `Date` con el día y el mes al revés.
- Archivo nuevo de `public/` con 404 aunque ya está desplegado (2026-10-30, `whatsapp-cliente.js?v=1`): Cloudflare guardó el 404 de una consulta hecha ANTES de que Vercel terminara. No pedir la URL nueva hasta ver la página ya publicada; si pasó, subir el `?v=` en las páginas.
- Ruleta que "no gira" en el celular (2026-10-30): `css/ligero.css` quita TODAS las transiciones y la rueda gira con una de 4 s; saltaba al resultado (1440° = 4 vueltas, mismo lugar). `#ruletaGiraAuto` tiene su excepción en ligero.css: lo que deba moverse para funcionar (no de adorno) necesita la suya.
- JS/CSS de `public/` que cambian y el cliente no ve: Vercel los sirve con caché de 4 h (el HTML no). Al cambiar un archivo compartido, subir el `?v=` con el que lo incluye cada página (p. ej. `aviso-codigo.js?v=3`).
- Modelos `gemini-1.5-*` retirados (404). Por defecto `gemini-2.5-flash` vía `GEMINI_MODEL`.
- `firebase-admin` se importa de forma perezosa en `_lib/limitador.js` para no alargar el cold start: no moverlo a un `import` estático.
- Variable nueva → documentarla en `.env.example`. Nunca leer ni editar `.env`.

## 8a. `obtener_codigo` lento en modo API

**Síntoma**: `[3. OBTENCIÓN DE CÓDIGOS] Tiempo agotado (15 s)` aunque el modo sea API (FazerCards). No es un choque: en modo API `obtener_codigo` no toca los pines, pero es quien lee el modo y anota la fila de "fazer_card", así que Vercel no puede saltárselo.
**Causa**: `buscarAsignacion` leía toda la pestaña "asignaciones_pines" dentro del candado. **Regla**: las búsquedas por id dentro del candado van con TextFinder sobre una columna (`buscarAsignacion`, `filaDePago`, `buscarFilaFazer`), nunca con `getDataRange()` de una pestaña que crece.

## 8b. Orden de la compra de Roblox (`apps-script/roblox.gs`)

**Regla**: buscar pago y código sin tocar nada → marcar pago "Usado" → marcar el código `USADO-…` → anotar en "Exitosas" y compactar. Lo que va después de gastar el pago (registro, compactar) va en try/catch y nunca impide devolver el código al cliente. El stock que ve el cliente es solo disponible/pocos/agotado. Pago insuficiente: con la huella de la clave (`claveHash`) el pago queda "Por completar" y la compra en "por_completar"; `tipo: "completar"` (`completarCompra`) busca el código ANTES de gastar el pago nuevo y al entregar marca TODOS los pagos "Usado". Tampoco se reintenta.
**Central One (sin códigos guardados)**: primero siempre los de "Codigos". Solo con `api: true` (Vercel con `roblox_nuevo`) y product_id en la fila 3 roblox.gs reserva: pago "En proceso" ANTES de comprar, nunca "Usado" (si no se compra, `liberar_api` lo devuelve a "Verificado"). `entregar_api`/`liberar_api`/`nota_api` solo cambian una fila de "pedidos_api" que empieza por ⏳: Vercel y el webhook pueden llamarlas a la vez o repetirlas. Si el código tarda más de 150 s, el cliente ve "en proceso" y el webhook lo anota como "📲 ENVIAR POR WHATSAPP". El 🔄 reemplaza toda PreciosRoblox con las tarjetas de Robux GLOBAL y de EE. UU. con stock (`REGIONES_ROBLOX`). Un paquete se identifica por `claveDePaquete` (número de Robux + "-EEUU" si el nombre dice "EE. UU."), en PreciosRoblox y en "Codigos": nunca volver a comparar solo los números, porque "800 Robux" y "800 Robux EE. UU." son paquetes distintos; una columna de "Codigos" con códigos de EE. UU. debe llamarse "800 Robux EE. UU."; "Codigos" es opcional (si existe, su columna se busca por el número de la fila 1). Un paquete "agotado" en la tienda sin códigos guardados = falta `roblox_nuevo`, falta publicar roblox.gs o Central One no tiene stock (el log de Vercel dice cuál). El código nunca va a los logs de Vercel.

## 9. Recalcular la comisión de los creadores desde D

**Síntoma**: al cambiar el % de comisión o la tasa, el pendiente de un creador cambia sobre ventas ya hechas.
**Regla**: H (total) y J (pendiente) de "Descuentos" son saldos: solo los suma `sumarComisionCreador` en cada venta y los baja Registrar pago. Nunca volver a calcularlos como D × % ÷ tasa. Si se cambia el % y hay que aplicarlo a ventas pasadas, usar `pasarVentasAnterioresAlPorcentaje` (venta por venta, cada una con su tasa).

## 9b. Webhook de FazerCards (`api/fazer-webhook.js`)

**Regla**: FazerCards espera un 200 en menos de 10 s; con otra respuesta reintenta (1, 5 y 30 min) y tras 50 fallos seguidos **desactiva el webhook** (reactivarlo en su panel). Por eso solo se responde 401 (firma mala) o 503 (la hoja no respondió); lo demás, incluidas las órdenes de Blood Strike (misma cuenta), es 200. La firma se calcula sobre el cuerpo **crudo**: no leer `req.body` antes de `leerCuerpoCrudo`. Si el log muestra siempre "firma inválida", `FAZER_WEBHOOK_SECRET` no coincide con el del panel. `estado_fazer` espera el candado solo 4 s (`ESPERA_CANDADO_WEBHOOK_MS`).
Desde 2026-10-21 Free Fire ya no pide a FazerCards (compra en Central One, ver 9d): este webhook solo actualiza las órdenes anteriores.

## 9c. Central One (Blood Strike)

**Reglas**: la llave (`blood_nuevo`) da acceso a todo el saldo: solo en Vercel; la API no acepta navegador ni `?api_key=`. El precio NO se manda (el servidor lo calcula; un campo desconocido en la línea da 400). `target_payload` se arma con el `target_schema` del catálogo, no fijo; un `select` solo acepta el `value` de sus opciones. El catálogo se lee como mucho cada 15 min (límite 60 lecturas/min por llave). Un pedido aceptado queda "confirmed": el resultado real llega por `api/centralone-webhook.js` (si el webhook no está registrado en el portal, un fallo de entrega NO llega a "errores"). `order.failed` no es definitivo: puede llegar `order.delivered` después (bloodstrike.gs avisa en "errores"). Los avisos pueden repetirse y llegar desordenados: bloodstrike.gs ignora un `sequence` menor que el último del pedido (CacheService 6 h). No hay sandbox: cualquier pedido gasta saldo real.
**Despliegue**: 1) bloodstrike.gs con el menú 🩸, llave (🔑) y 🔄 Traer productos; escribir los precios en la fila 2 (sin precio no se vende: antes se habría cobrado 0); 2) `blood_nuevo` y `CENTRALONE_WEBHOOK_SECRET` en Vercel; 3) bloodstrike.gs (estados de Central One); 4) desplegar Vercel; 5) registrar el webhook en el portal. Con un product_id vacío el paquete responde "no disponible" sin tocar el pago. No borrar ni mover la fila 3 de PreciosBlood a mano: es con lo que se compra.
**Qué trae el 🔄** (desde 2026-10-26): solo oro, pases (incluida la Bolsa de la Suerte) y membresías, según el nombre ya traducido (`esProductoTiendaBlood`); cofres, cupones, preventas, Cornucopia y ofertas ("0.99 DEAL") se dejan fuera. Un producto nuevo con otro nombre en Central One no aparece hasta agregarlo a `TRADUCCIONES_BLOOD` o al filtro.

## 9d. Central One (Free Fire, desde 2026-10-21)

**Reglas**: llave `freefire_nuevo` (catalog:read, orders:read, orders:write) solo en Vercel. El product_id sale de la fila 3 de "precios" (`obtener_precios` lo manda como `producto`; freefire.js lo quita antes de responder al navegador). 220 = "2x<product_id de 110>": dos pedidos seguidos con Idempotency-Key `ff-<idPedido>-1` / `-2` (uno solo: `ff-<idPedido>`); el webhook reconoce Free Fire por ese `ff-` y lo manda a recargas.gs (`estado_fazer`, con `sequence`). Antes de `obtener_codigo`, `prepararCentralOne` comprueba catálogo, stock y `target_schema`: si no se puede pedir, en modo API el pedido va a "sin_codigo" con el motivo (sin gastar saldo) en vez de bloquear el pago. Rechazo o incierto con el pedido ya enviado → `bloquear` (si el primero de dos sí entró, el motivo lo dice). Los precios los escribe el dueño en la fila 2: el 🔄 conserva el de cada product_id (o, la primera vez, el de la misma `clavePaquete`) y deja vacíos los nuevos (no se venden). En modo API, una columna con "SIN STOCK" en la fila 5 no se muestra. `clavePaquete` (freefire.js y recargas.gs) y `esTarjeta` (freefire.html) deben coincidir: un nombre con letras además de "Diamantes" es un producto con nombre ("Pase de Subida de Nivel" → `pase_de_subida_de_nivel`).
**Despliegue**: 1) Vercel con `freefire_nuevo` (y `CENTRALONE_WEBHOOK_SECRET`, que ya está); 2) recargas.gs como Nueva versión; 3) 🔑 y 🔄 en el menú "🖐️ Recargas Free Fire", poner los precios; 4) validador.gs como Nueva versión (Free Fire valida el ID en Central One); 5) elegir "🛒 API de Central One". Con un Vercel anterior, el modo API mandaría todo a "sin_codigo" (sin product_id): no se pierde nada, pero es manual.

## 9e. Mobile Legends (Central One, desde 2026-10-22)

**Reglas**: el producto pide DOS datos (ID y Zona ID): `datosParaPedido` recibe `zona` y solo arma el pedido si el `target_schema` tiene exactamente dos campos de texto y uno se llama zone/zona/server/servidor (`CAMPO_ZONA`, igual en validador.gs); si no, bloquea sin crear pedido. Nunca mandar la zona pegada al ID. La Idempotency-Key lleva el prefijo `ml-`: sin él, el webhook mandaría el aviso a Free Fire/Blood Strike y "pedidos" nunca se actualizaría. Los finalizados se escriben en la hoja de Free Fire con `openById`: la cuenta que publica mobilelegends.gs debe poder editar esa hoja. Si el 🔄 dice que no hay productos de la región, agregar la región en `REGIONES_CENTRALONE`. Central One tiene también la familia "Mobile Legends Especial" con productos de nombres iguales a los normales: filtrar por palabras no basta, se filtra por familia exacta (`esFamiliaNormalML` en mobilelegends.gs, `esFamiliaExacta` en validador.gs, desde 2026-11-11); si Central One renombra la familia normal, el 🔄 avisa con las familias que hay y no cambia nada.
**Despliegue**: 1) hoja nueva + mobilelegends.gs (🧱, 🔑, 💲, 🔄) y publicarlo como aplicación web (autorizar Sheets de la hoja central); 2) `SCRIPT_MLBB` en Vercel (la llave es `blood_nuevo`, la misma de Blood Strike); 3) validador.gs como Nueva versión; 4) desplegar Vercel; 5) TOKEN_VERCEL en mobilelegends.gs si Vercel tiene SCRIPT_RECARGAS_TOKEN. El webhook de Central One no se toca en el portal (es la misma URL).

## 10. Bot de Railway: `BlockingIOError: [Errno 11] Resource temporarily unavailable`

**Síntoma**: todas las recargas de Free Fire caen en "errores"; el log del bot muestra ese error al abrir Playwright (`async_playwright()`).
**Causa**: el contenedor se quedaba sin procesos: Chromium y su Playwright se abrían en cada canje, sin init que recogiera los procesos terminados (zombis) y con canjes en paralelo.
**Regla** (repo `bot-levelup`): `tini` como ENTRYPOINT en el Dockerfile, un solo Chromium reutilizado (contexto nuevo por canje, cerrado en `finally`), un canje a la vez (`asyncio.Semaphore(1)`) y 503 si el navegador no abre (Vercel lo trata como "no procesado" y devuelve los pines). Mientras el bot falle, usar el modo manual de recargas.gs (menú "🖐️ Recargas Free Fire").

## 11. Tienda con el pie legal al lado de la tarjeta (2026-10-22)

**Síntoma**: en Free Fire, Blood Strike y Roblox la tarjeta salía angosta, con los precios cortados, y el pie legal a su derecha sin estilo.
**Causa**: al insertar el bloque "TEMA …" antes de `</style>` se reemplazó también la línea `<link rel="stylesheet" href="css/pie-legal.css">` (es la que pone `flex-wrap` en `body.pagina-juego`).
**Regla**: al tocar el final del `<style>` de una tienda, comprobar que siguen los tres `<link>` (pie-legal, descuento, aviso-codigo). Revisar a 360 y 390 px con capturas reales, no solo la sintaxis: Edge sin interfaz no baja de ~500 px de ventana, así que la página se mete en un iframe del ancho del celular.

## 12. Tiendas lentas en celulares sencillos (2026-10-23)

**Síntoma**: en teléfonos baratos o con datos lentos la tienda tardaba en mostrar los precios y se trababa al bajar.
**Causa**: el `<script type="module">` de cada tienda importaba el SDK de Firebase (~300 KB) solo para leer los datos de Pago Móvil, y TODO el módulo (catálogo, chat, verificación) esperaba esa descarga; además, muchas capas con `backdrop-filter` (una dentro de otra) y animaciones sin fin.
**Regla**: no volver a importar Firebase en las tiendas: usar `DatosPago.leer()` (`js/datos-pago.js`). En celulares (todos, desde 2026-10-23: con solo detectar los baratos seguía trabándose) `css/ligero.css` apaga desenfoque, animaciones, transiciones, filtros y sombras grandes; al cambiarlo, subir el `?v=` de su `href` en el script del `<head>` de TODAS las páginas (Cloudflare); si una clase nueva arranca con `opacity: 0` y aparece con una animación, agregarla ahí con `opacity: 1` (en modo ligero las animaciones duran 0,01 ms). Los indicadores de "cargando" se reactivan en ese mismo archivo. Caché (`vercel.json`): imágenes 1 día; `css/` y `js/` piden 5 min, pero **Cloudflare está delante del dominio** y les pone 4 h (`max-age=14400`, `cf-cache-status: HIT`). Al cambiar un `.js`/`.css` compartido, subir el `?v=N` de su `<script>`/`<link>` en las páginas (como `aviso-codigo.js?v=3`); al cambiar una imagen, cambiarle el nombre.
**Cloudflare también guarda los 404** (1 día, 2026-10-26): pedir la URL de un archivo nuevo antes de que Vercel termine de desplegar deja el 404 en caché aunque el archivo ya exista. No probar URLs nuevas hasta que el despliegue esté listo (o probar con `?x=1`); si ya pasó, cambiar el `?v=` con que se pide (las imágenes de `img/productos/` van con `?v=N`).

## 11. Columnas nuevas en pestañas que ya existen

**Regla** (desde 2026-10-30, columna "WhatsApp"): una columna nueva va SIEMPRE al final, nunca en medio (las filas viejas se correrían). Si una función usa `COLUMNAS_X.length` como "la última columna" (la casilla de "sin_codigo", la nota de "pedidos_api"), cambiarla por una constante con su número antes de agregar la columna. Antes de leer o escribir esa columna, `asegurarTituloWhatsapp` (o similar) amplía la pestaña: "✂️ Quitar filas y columnas vacías" puede haberla recortado y `getRange` fuera del límite lanza error.

## 13. Borrar pestañas de la hoja de Free Fire (2026-11-02)

**Regla**: solo con el menú "🖐️ Recargas Free Fire" → 🧰 Mantenimiento → 🧹 Ordenar pestañas (`ordenarPestanas`): nunca borra las de `GRUPOS_DE_PESTANAS` (pagos, finalizados, errores, precios, descuentos, config, codigos, sin_codigo, fazer_card, por_completar, ruleta, asignaciones_pines, movimientos_descuentos, pagos_creadores), guarda antes una copia completa en Drive y deja las que una fórmula de otra pestaña usa. Si una función nueva de recargas.gs (o de otro script que abre esta hoja con `openById`, como mobilelegends.gs con "finalizados") empieza a usar una pestaña nueva, agregarla a `GRUPOS_DE_PESTANAS` ANTES de volver a usar el botón; si no, la borra. También quita los activadores cuya función no está en `ACTIVADORES_VALIDOS`: un activador nuevo va en esa lista.

---

## Códigos de descuento en las tiendas manuales (desde 2026-11-12)

**Reglas**: el precio con descuento lo calcula `api/_lib/juegos/manuales.js` sobre el precio de la caché de precios y lo manda como `montoACobrar`; `manuales.gs` (v2) lo acepta solo si es menor que su precio y no menor que la mitad. El uso (+1 y la comisión del creador) se anota en la hoja de Free Fire SOLO si el pago alcanzó: con pago incompleto la nota del pedido dice "El uso del código NO se anotó…" y hay que anotarlo a mano al completar (o no, si se devuelve el dinero). En "movimientos_descuentos" el jugador va como `WhatsApp +58…`: nunca mandar el correo de la cuenta (va junto a la contraseña).
**Despliegue**: con manuales.gs v1 publicado, Vercel responde "Los códigos de descuento aún no están disponibles" y no toca el pago; al publicar la v2 (Nueva versión) se activan solos en ~1 minuto (caché de precios).
**Caché**: un código desactivado en "Descuentos" sigue valiendo hasta 60 s (conCache de `obtenerDescuento`, igual en todas las tiendas).

---

## Imagen pedida antes de subirla: Cloudflare guarda el 404 un día

**Síntoma** (2026-11-12): las tarjetas de FC Mobile, COD Mobile y Clash Royale del inicio salían "a veces" sin foto.
**Causa**: el inicio pedía `fcmobile.jpg` desde un despliegue en el que la imagen aún no existía. `vercel.json` pone `max-age=86400` a TODO `.jpg/.png/.webp/...` (también a la respuesta 404) y Cloudflare guardó ese 404 un día; según el servidor de Cloudflare que respondiera, salía o no la foto (`onerror="this.remove()"` la quita).
**Regla**: nunca enlazar una imagen que todavía no está en el repositorio; subirla en el mismo commit que la usa. Si ya pasó, cambiar la URL (`?v=N`), porque el 404 guardado no se borra desde aquí. Comprobar con `curl -sI https://www.levelupstore.online/<imagen>` (`HTTP 404` + `cf-cache-status: HIT` = 404 guardado).
