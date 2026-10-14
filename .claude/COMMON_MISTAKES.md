# Errores comunes

Errores que ya ocurrieron (o casi) en Level Up. Revisar antes de tocar `api/` o `apps-script/`.

---

## 1. Reintentar operaciones que crean algo

**Síntoma**: pines entregados dos veces, compras de Roblox/Blood Strike duplicadas, filas repetidas en la hoja.
**Regla**: solo se reintenta lo idempotente (leer precios, validar ID, `marcar_usado`, y `verificar_pago`/`obtener_codigo` porque llevan `idPedido`; la ruleta, porque `apps-script/ruleta.gs` devuelve el premio ya anotado si la misma referencia y el mismo jugador repiten). Nunca se reintenta tras un timeout: compras (`api/_lib/juegos/roblox.js`, FazerCards en `api/_lib/juegos/bloodstrike.js`), `registrar_*`, `subir_imagen`.
**Dónde**: comentario de cabecera de `api/_lib/externo.js` (`reintentarTrasTimeout`).

## 2. Ejecutar en paralelo `registrar_error` y `marcar_usado`

**Síntoma**: tras un fallo del bot, el pago queda en "Verificado" y la referencia se puede reutilizar.
**Regla**: las llamadas que cambian el estado del pago van **en orden** (`await` una tras otra), nunca con `Promise.all`.

## 2b. Tomar `{status:"error"}` de Apps Script como éxito

**Síntoma**: recargas en "finalizados" cuyo pago sigue "En proceso"/"Verificado" y sin aviso en "errores".
**Causa**: `marcar_usado` y `registrar_finalizado` iban en paralelo y compiten por el candado de recargas.gs (8 s); el perdedor recibía `{status:"error", ocupado:true}` con HTTP 200 y `marcarReferencia` lo daba por bueno.
**Regla**: `marcarReferencia`/`registrarEnHoja` (`_lib/recarga-comun.js`) solo cuentan como éxito lo que no trae `status:"error"` y repiten si viene `ocupado`. Las llamadas a recargas.gs del cierre van en orden. Reparar los ya afectados: menú "🖐️ Recargas Free Fire" → 🧹 Marcar como Usado los pagos ya finalizados.

## 2c. Devolver un pago a "Verificado"

**Regla** (desde 2026-10-13): ningún error lo libera, ni pago insuficiente ni rechazo del proveedor. Siempre `bloquearPago` (anota en "errores" y marca "Usado"); el cliente sigue por WhatsApp. No volver a añadir `marcar_verificado`/`liberar_pedido`.

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

## 8. Otros

- Log `⚠️ precios:…: Apps Script falló (Apps Script lento)`: ya no sale cuando Apps Script solo tarda más de 1,5 s (`conCache` responde con la copia y renueva en segundo plano). Si aparece "falló" o "no se pudo renovar", Apps Script sí respondió con error.
- Precios que no se actualizan tras cambiar la hoja: la renovación en segundo plano de `conCache` necesita `waitUntil` (@vercel/functions); sin él Vercel congela la función al responder y la copia vieja dura hasta 6 h. No quitarlo.
- Precios viejos con `x-vercel-cache: STALE`: no volver a poner `stale-while-revalidate` en `cabecerasCachePrecios`; la CDN servía la copia vieja varios minutos tras cambiar la hoja.
- Aviso `DEP0169 url.parse()` en Vercel: no es nuestro código; se oculta con `NODE_OPTIONS=--disable-warning=DEP0169`.
- JS/CSS de `public/` que cambian y el cliente no ve: Vercel los sirve con caché de 4 h (el HTML no). Al cambiar un archivo compartido, subir el `?v=` con el que lo incluye cada página (p. ej. `aviso-codigo.js?v=3`).
- Modelos `gemini-1.5-*` retirados (404). Por defecto `gemini-2.5-flash` vía `GEMINI_MODEL`.
- `firebase-admin` se importa de forma perezosa en `_lib/limitador.js` para no alargar el cold start: no moverlo a un `import` estático.
- Variable nueva → documentarla en `.env.example`. Nunca leer ni editar `.env`.

## 8b. Orden de la compra de Roblox (`apps-script/roblox.gs`)

**Regla**: buscar pago y código sin tocar nada → marcar pago "Usado" → marcar el código `USADO-…` → anotar en "Exitosas" y compactar. Lo que va después de gastar el pago (registro, compactar) va en try/catch y nunca impide devolver el código al cliente. El stock que ve el cliente es solo disponible/pocos/agotado.

## 9. Recalcular la comisión de los creadores desde D

**Síntoma**: al cambiar el % de comisión o la tasa, el pendiente de un creador cambia sobre ventas ya hechas.
**Regla**: H (total) y J (pendiente) de "Descuentos" son saldos: solo los suma `sumarComisionCreador` en cada venta y los baja Registrar pago. Nunca volver a calcularlos como D × % ÷ tasa. Si se cambia el % y hay que aplicarlo a ventas pasadas, usar `pasarVentasAnterioresAlPorcentaje` (venta por venta, cada una con su tasa).

## 10. Bot de Railway: `BlockingIOError: [Errno 11] Resource temporarily unavailable`

**Síntoma**: todas las recargas de Free Fire caen en "errores"; el log del bot muestra ese error al abrir Playwright (`async_playwright()`).
**Causa**: el contenedor se quedaba sin procesos: Chromium y su Playwright se abrían en cada canje, sin init que recogiera los procesos terminados (zombis) y con canjes en paralelo.
**Regla** (repo `bot-levelup`): `tini` como ENTRYPOINT en el Dockerfile, un solo Chromium reutilizado (contexto nuevo por canje, cerrado en `finally`), un canje a la vez (`asyncio.Semaphore(1)`) y 503 si el navegador no abre (Vercel lo trata como "no procesado" y devuelve los pines). Mientras el bot falle, usar el modo manual de recargas.gs (menú "🖐️ Recargas Free Fire").
