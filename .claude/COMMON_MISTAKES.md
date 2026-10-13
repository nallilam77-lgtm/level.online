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

## 9. Recalcular la comisión de los creadores desde D

**Síntoma**: al cambiar el % de comisión o la tasa, el pendiente de un creador cambia sobre ventas ya hechas.
**Regla**: H (total) y J (pendiente) de "Descuentos" son saldos: solo los suma `sumarComisionCreador` en cada venta y los baja Registrar pago. Nunca volver a calcularlos como D × % ÷ tasa. Si se cambia el % y hay que aplicarlo a ventas pasadas, usar `pasarVentasAnterioresAlPorcentaje` (venta por venta, cada una con su tasa).
