# Mapa de arquitectura

Dominio: `https://levelupstore.online` (CORS de `/api/*` restringido a él en `vercel.json`).

---

## Estructura

```
api/                      Funciones serverless de Vercel (un archivo = un endpoint)
├── _lib/                 Código compartido (el "_" evita que Vercel lo publique)
│   ├── juegos/           Lógica de cada tienda (enrutada por api/juego.js y api/recargar.js)
│   │   ├── index.js      Lista cerrada de juegos + carga diferida (cargarJuego)
│   │   ├── freefire.js   acciones { precios, verificar } + recargar: pines + bot de Railway
│   │   ├── bloodstrike.js  acciones { precios } + recargar: API de FazerCards
│   │   └── roblox.js     acciones { precios } + recargar: compra en su Apps Script (sin reintentos)
│   ├── recarga-comun.js  limpiarMontoVES, formatearVES, crearUtilidadesPedido (Free Fire y Blood Strike)
│   ├── externo.js        pedirJSON/llamarScript: timeouts, reintentos, caché en memoria (conCache)
│   ├── limitador.js      Límite de intentos fallidos (Firestore o memoria)
│   ├── reporte.js        informeError(), FASES, ESTADO_PINES → pestaña "errores"
│   └── validacion.js     PAQUETE_VALIDO, textoParaHoja(), faltaConfiguracion()
├── juego.js              GET/POST ?juego=<freefire|bloodstrike|roblox>&accion=<precios|verificar> (30 s)
├── recargar.js           POST ?juego=<freefire|bloodstrike|roblox> (maxDuration 180)
├── subir-imagen.js       Comprobante de pago → Drive (límite 4 MB)
├── consultar-ordenes.js  Consulta de pedidos (página de inicio)
├── ruleta.js             Ruleta de la suerte (opcional: 503 si no hay script)
└── ia-soporte.js         Chat de soporte con Gemini (rota GEMINI_KEYS)
apps-script/recargas.gs   Copia del Apps Script de recargas Free Fire (v2, con idPedido)
public/                   Frontend estático; cada página lleva su CSS/JS en línea
├── index.html            Inicio + consultar órdenes
├── freefire.html / bloodstrike.html / roblox.html   Tiendas por juego
├── admin.html            Panel (lee Firestore)
├── js/lector-referencia.js   Lee la referencia del comprobante (Tesseract)
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
| Apps Script ruleta | `SCRIPT_RULETA_URL` | ruleta |
| Apps Script Roblox | `GAS_URL` | juegos/roblox |
| Apps Script + FazerCards | `SCRIPT_BLOOD`, `FAZER_API_KEY` | juegos/bloodstrike |
| Bot Railway | `RAILWAY_SECRET` | juegos/freefire (recarga) |
| Firestore | `FIREBASE_SERVICE_ACCOUNT` | _lib/limitador |
| Gemini | `GEMINI_KEYS` / `GEMINI_API_KEY`, `GEMINI_MODEL` | ia-soporte |

Detalle de cada variable: `.env.example`.
