# Mapa de arquitectura

Dominio: `https://levelupstore.online` (CORS de `/api/*` restringido a él en `vercel.json`).

---

## Estructura

```
api/                      Funciones serverless de Vercel (un archivo = un endpoint)
├── _lib/                 Código compartido (el "_" evita que Vercel lo publique)
│   ├── juegos/           Lógica de cada tienda (enrutada por api/juego.js y api/recargar.js)
│   │   ├── index.js      Lista cerrada de juegos + carga diferida (cargarJuego)
│   │   ├── freefire.js   acciones { precios, verificar, descuento } + recargar: pines + bot de Railway
│   │   ├── bloodstrike.js  acciones { precios, descuento } + recargar: API de FazerCards
│   │   └── roblox.js     acciones { precios, descuento } + recargar: compra en apps-script/roblox.gs (sin reintentos; manda montoACobrar con código)
│   ├── recarga-comun.js  limpiarMontoVES, formatearVES, crearUtilidadesPedido (Free Fire y Blood Strike)
│   ├── descuentos.js     Códigos de descuento (tabla común en la pestaña "Descuentos" de la hoja de Free Fire)
│   ├── externo.js        pedirJSON/llamarScript: timeouts, reintentos, caché en memoria (conCache)
│   ├── limitador.js      Límite de intentos fallidos (Firestore o memoria)
│   ├── reporte.js        informeError(), FASES, ESTADO_PINES → pestaña "errores"
│   └── validacion.js     PAQUETE_VALIDO, textoParaHoja(), faltaConfiguracion()
├── juego.js              GET/POST ?juego=<freefire|bloodstrike|roblox>&accion=<precios|verificar|descuento> (30 s)
├── recargar.js           POST ?juego=<freefire|bloodstrike|roblox> (maxDuration 180)
├── creadores.js          POST { codigo, pin } -> panel del creador (nivel, ventas, comisión, movimientos)
├── subir-imagen.js       Comprobante de pago → Drive (límite 4 MB)
├── consultar-ordenes.js  Consulta de pedidos (página de inicio)
├── ruleta.js             Ruleta de la suerte (apps-script/ruleta.gs; reintenta: el giro es idempotente)
└── ia-soporte.js         Chat de soporte con Gemini (rota GEMINI_KEYS)
apps-script/recargas.gs   Copia del Apps Script de recargas Free Fire (v2, con idPedido)
public/                   Frontend estático; cada página lleva su CSS/JS en línea
├── index.html            Inicio + consultar órdenes + acceso al Panel de Creadores
├── creadores.html + css/creadores.css   Panel de Creadores (niveles, reglas y consulta con código + PIN)
├── freefire.html / bloodstrike.html / roblox.html   Tiendas por juego
├── admin.html            Panel (lee Firestore)
├── js/lector-referencia.js   Lee la referencia del comprobante (Tesseract)
├── js/descuento.js + css/descuento.css   Campo "código de descuento" (Free Fire y Blood Strike)
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
2. `obtener_precios` (caché) → precio real del paquete (nunca el del cliente).
3. `verificar_pago` (referencia + monto + `idPedido`) — idempotente.
4. `obtener_codigo` → pines del inventario — idempotente.
5. POST al bot de Railway `/canjear` (`x-secret-token`). Resultado: ok / fallo_bot / no_procesado / incierto.
6. Si falla: `devolver_codigos` cuando es seguro, `registrar_error` con informe, y en orden `marcar_usado`/`marcar_verificado`.
7. Éxito: `registrar_finalizado`.

## Servicios externos y variables

| Servicio | Variable(s) | Usado en |
|---|---|---|
| Apps Script recargas | `SCRIPT_RECARGAS_URL`, `SCRIPT_RECARGAS_TOKEN` | juegos/freefire (precios, recarga), subir-imagen |
| Apps Script órdenes | `SCRIPT_RECARGAS_VERIFICACION` | consultar-ordenes |
| Apps Script validador | `SCRIPT_VALIDADOR_URL` | juegos/freefire (verificar) |
| Apps Script ruleta (`apps-script/ruleta.gs`) | `SCRIPT_RULETA_URL` (+ `SCRIPT_RECARGAS_TOKEN` opcional) | ruleta |
| Apps Script Roblox (`apps-script/roblox.gs`) | `GAS_URL` (+ `SCRIPT_RECARGAS_TOKEN` opcional) | juegos/roblox |
| Apps Script + FazerCards | `SCRIPT_BLOOD`, `FAZER_API_KEY` | juegos/bloodstrike |
| Bot Railway | `RAILWAY_SECRET` | juegos/freefire (recarga) |
| Firestore | `FIREBASE_SERVICE_ACCOUNT` | _lib/limitador |
| Gemini | `GEMINI_KEYS` / `GEMINI_API_KEY`, `GEMINI_MODEL` | ia-soporte |

Detalle de cada variable: `.env.example`.

## Códigos de descuento y Panel de Creadores (hoja de Free Fire)

- **Descuentos**: A código · B descuento en % (vacío en creadores = según nivel) · C usos · D dinero movido (Bs) · E creador (vacío = promo normal) · F PIN · G % actual (= descuento del cliente) · H comisión total (USD) · I liquidado (Bs, referencia) · J pendiente (USD) · K niveles bajados por meta semanal incumplida (0 = perdonar) · L comisión por convertir (Bs, ventas sin tasa). **Comisión por venta**: cada venta guarda su comisión (% del nivel y tasa de ese día) en "movimientos_descuentos" y la SUMA a H y J; H y J son saldos, no se recalculan (cambiar de nivel o de tasa no toca lo ganado). Registrar pago (menú ⭐ Creadores) deja J en 0; pagos en "pagos_creadores". Arranque: `iniciarSaldosPorVenta` fija una vez H/J con el cálculo anterior (propiedad `saldos_por_venta`).
- **movimientos_descuentos** (se crea sola): cada venta con código; historial de cada venta (el panel calcula la comisión con el % y la tasa actuales).
- **config!B1**: tasa Bs por 1 USD (actualizarla a mano).
- Niveles (`NIVELES_CREADOR` en `recargas.gs`): Aliado 0-99 usos 0,65 % (meta 5/semana) · Pro 100-249 1 % (15/semana) · Diamante 250+ 1,5 % (30/semana). El descuento del cliente = la comisión del creador. La meta semanal (lunes-domingo, Caracas) se cuenta en "movimientos_descuentos" y el panel la muestra (`semana`). Cada lunes `revisarMetasSemanales` (activador del menú ⭐ Creadores) revisa la semana anterior: no cumplió → K "Niveles bajados" +1; cumplió estando castigado → K −1. Nivel real = nivel por usos − K (mínimo Aliado); resultados en "revisiones_creadores". Solo se revisan semanas desde `INICIO_METAS_SEMANALES` (lunes 12/10/2026). "movimientos_descuentos": D = id del jugador, I = id del pedido (filas viejas: pedido en D). `sumarUsoDescuento` ignora un idPedido ya anotado (un reintento no duplica uso ni comisión); si el uso del código no se pudo anotar, el cierre de Free Fire/Blood Strike lo deja en la pestaña "errores" para hacerlo a mano. Si se cambian, actualizar también el texto de `creadores.html`.
