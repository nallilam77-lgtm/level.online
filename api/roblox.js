// Este archivo vive en /api/roblox.js dentro de tu proyecto en Vercel
import { obtenerIp, minutosBloqueado, registrarFallo } from './_lib/limitador.js';

export default async function handler(req, res) {
  // 1. Configurar los encabezados CORS: solo tu dominio (igual que vercel.json)
  res.setHeader('Access-Control-Allow-Origin', 'https://levelupstore.online');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // 2. Manejar la petición "preflight" (OPTIONS)
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // 3. Bloquear métodos que no sean POST
  if (req.method !== 'POST') {
    return res.status(405).json({ status: 'error', message: 'Método no permitido. Usa POST.' });
  }

  try {
    // 4. Obtener la URL secreta de Google Apps Script desde las variables de entorno de Vercel
    const scriptUrl = process.env.GAS_URL;

    if (!scriptUrl) {
      console.error("Falta la variable de entorno GAS_URL");
      return res.status(500).json({ status: 'error', message: 'Error de configuración del servidor.' });
    }

    // 5. Solo se reenvían las dos operaciones que usa la página y sus campos conocidos
    const { tipo, referencia, user, producto, url_capture } = req.body || {};
    let payload;
    let clavesLimite = null;

    if (tipo === 'obtener_precios') {
      payload = { tipo };
    } else if (tipo === 'compra') {
      const usuario = String(user || '').trim();
      if (!/^\d{5}$/.test(String(referencia)) || !/^[A-Za-z0-9_]{2,30}$/.test(usuario) || !producto || String(producto).length > 60) {
        return res.status(400).json({ status: 'error', message: 'Datos con formato inválido. Revisa tu usuario y los 5 dígitos de la referencia.' });
      }

      // Antes de consultar la hoja de pagos: ¿esta IP o este usuario acumula demasiados fallos?
      clavesLimite = [`ip:${obtenerIp(req)}`, `jugador:roblox:${usuario.toLowerCase()}`];
      const minutosEspera = await minutosBloqueado(clavesLimite);
      if (minutosEspera > 0) {
        return res.status(429).json({ status: 'error', message: `Demasiados intentos fallidos. Espera ${minutosEspera} minutos para volver a intentar.` });
      }

      payload = { tipo, referencia: String(referencia), user: usuario, producto: String(producto), url_capture: String(url_capture || 'Sin comprobante').slice(0, 500) };
    } else {
      return res.status(400).json({ status: 'error', message: 'Operación no permitida.' });
    }

    const googleResponse = await fetch(scriptUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload)
    });

    // 6. Leer la respuesta devuelta por Google Apps Script
    const data = await googleResponse.json();

    // Una compra rechazada (pago no encontrado, ya usado, insuficiente...) cuenta como intento fallido.
    // "Fallo técnico" no cuenta: el pago sí existía y quedó en proceso.
    if (clavesLimite && data?.status !== 'success' && !String(data?.message || '').toLowerCase().includes('fallo técnico')) {
      await registrarFallo(clavesLimite);
    }

    // 7. Entregar la respuesta limpia a tu página web de Roblox
    return res.status(200).json(data);

  } catch (error) {
    console.error('Error en el proxy de Vercel para Roblox:', error);
    return res.status(500).json({ status: 'error', message: 'Error interno de conexión con el servidor.' });
  }
}