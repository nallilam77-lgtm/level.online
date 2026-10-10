# Comandos rápidos

No hay `scripts` en `package.json`, ni tests ni build: los endpoints se despliegan tal cual en Vercel.

---

## Comprobar

```bash
# Sintaxis de todos los endpoints (Node 24, ESM)
for f in api/*.js api/_lib/*.js; do node --check "$f" || echo "FALLA $f"; done
```

## Local

```bash
npm install          # única dependencia: firebase-admin
npx vercel dev       # sirve public/ y api/ en local (necesita .env con las variables de .env.example)
```

## Desplegar

- **Vercel**: `git push` a `main` en `origin` (GitHub) si el repo está conectado a Vercel; si no, `npx vercel --prod`.
- **Variables de entorno**: panel de Vercel → Project Settings → Environment Variables (redesplegar tras cambiarlas).
- **Apps Script** (`apps-script/recargas.gs`): pegar en el editor y publicar como **nueva versión de la implementación existente** (ver `COMMON_MISTAKES.md` #7).

## Diagnóstico

- Logs de las funciones: panel de Vercel → Logs (los `console.error` llevan la fase entre corchetes, p. ej. `[2. VERIFICACIÓN DEL PAGO (Google Sheets)]`; ver `FASES` en `api/_lib/reporte.js`).
- Fallos de recarga: pestaña **"errores"** de Google Sheets; pines entregados: pestaña **"asignaciones_pines"**.
