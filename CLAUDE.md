# Level Up

## Contexto
Somos **Level Up**, una tienda de recargas de videojuegos (Free Fire, Roblox, Blood Strike, etc.) en Venezuela.

## Stack
- **Node.js**: funciones serverless en `api/`.
- **Vercel**: hosting y despliegue; las variables de entorno se configuran en el panel de Vercel.
- **Gemini API**: asistente de soporte con IA (`api/ia-soporte.js`).
- **Google Apps Script**: backend de precios, órdenes y verificación de pagos.
- **Frontend estático** en `public/`.

## Tu rol
Optimizar el código aplicando buenas prácticas:
- Seguridad: nunca escribir secretos en el código (usar `process.env`), validar entradas en cada endpoint y no exponer errores internos al cliente.
- Rendimiento: minimizar latencia y cold starts en las funciones de Vercel; evitar llamadas redundantes a Apps Script.
- Mantenibilidad: eliminar código duplicado entre endpoints, manejar errores de forma consistente y mantener nombres claros.
- Mantener el estilo del código existente y explicar los cambios en español.

## Reglas
- No leer ni modificar `.env`. Las variables disponibles están documentadas en `.env.example`; si se agrega una nueva, actualizar ese archivo.
