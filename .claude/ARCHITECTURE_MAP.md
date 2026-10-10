# Mapa de arquitectura

Dominio: `https://levelupstore.online` (CORS de `/api/*` restringido a él en `vercel.json`).

---

## Estructura

```
api/                      Funciones serverless de Vercel (un archivo = un endpoint)
├── _lib/                 Código compartido (el "_" evita que Vercel lo publique)
│   ├── externo.js        pedirJSON/llamarScript: timeouts, reintentos, caché en memoria (conCache)
│   ├── limitador.js      Límite de intentos fallidos (Firestore o memoria)
│   ├── reporte.js        informeError(), FASES, ESTADO_PINES → pestaña "errores"
│   └── validacion.js     PAQUETE_VALIDO, textoParaHoja(), faltaConfiguracion()
├── precios.js            Precios Free Fire (caché)
├── verificar.js          Valida ID de jugador Free Fire (caché de IDs válidos)
├── recargar.js           Recarga Free Fire: pago → pines → bot de Railway (maxDuration 180)
├── precios-bloodstrike.js / recargar-bloodstrike.js   Blood Strike vía FazerCards (120)
├── roblox.js             Compra Roblox vía su Apps Script (60, sin reintentos)
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

## Flujo de una recarga Free Fire (`api/recargar.js`)

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
| Apps Script recargas | `SCRIPT_RECARGAS_URL`, `SCRIPT_RECARGAS_TOKEN` | precios, recargar, subir-imagen |
| Apps Script órdenes | `SCRIPT_RECARGAS_VERIFICACION` | consultar-ordenes |
| Apps Script validador | `SCRIPT_VALIDADOR_URL` | verificar |
| Apps Script ruleta | `SCRIPT_RULETA_URL` | ruleta |
| Apps Script Roblox | `GAS_URL` | roblox |
| Apps Script + FazerCards | `SCRIPT_BLOOD`, `FAZER_API_KEY` | *-bloodstrike |
| Bot Railway | `RAILWAY_SECRET` | recargar |
| Firestore | `FIREBASE_SERVICE_ACCOUNT` | _lib/limitador |
| Gemini | `GEMINI_KEYS` / `GEMINI_API_KEY`, `GEMINI_MODEL` | ia-soporte |

Detalle de cada variable: `.env.example`.
