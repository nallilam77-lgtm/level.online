// Este archivo vive en /api/roblox.js dentro de tu proyecto en Vercel

export default async function handler(req, res) {
  // 1. Configurar los encabezados CORS para permitir que tu dominio haga peticiones
  res.setHeader('Access-Control-Allow-Origin', '*'); // Puedes cambiarlo por tu dominio exacto si prefieres
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // 2. Manejar la petición "preflight" (OPTIONS) que hacen los navegadores por seguridad
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // 3. Bloquear peticiones que no sean POST
  if (req.method !== 'POST') {
    return res.status(405).json({ status: 'error', message: 'Método no permitido. Usa POST.' });
  }

  // Convertidor para mostrar montos al usuario (Ej: 1.520,00 Bs)
  const formatearVES = (monto) => Number(monto).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // TRADUCTOR BANCARIO: Convierte formatos de texto a número plano (Ej: "3.850,00" -> 3850.00)
  const limpiarMontoVES = (valor) => {
    if (!valor) return 0;
    if (typeof valor === 'number') return valor;
    let m = String(valor).trim().replace(/[^0-9.,-]/g, '');
    if (!m) return 0;

    let lastComma = m.lastIndexOf(',');
    let lastDot = m.lastIndexOf('.');

    if (lastComma > lastDot) {
      m = m.replace(/\./g, '').replace(',', '.'); // Ej: 1.520,00 -> 1520.00
    } else if (lastComma !== -1 && lastDot === -1) {
      m = m.replace(',', '.'); // Ej: 760,00 -> 760.00
    } else if (lastDot !== -1 && lastComma === -1) {
      let parts = m.split('.');
      if (parts.length > 2 || (parts.length === 2 && parts[1].length === 3)) {
        m = m.replace(/\./g, ''); // Ej: 3.850 -> 3850
      }
    }
    return parseFloat(m) || 0;
  };

  try {
    const { tipo, user, producto, referencia, url_capture } = req.body;

    const URL_GOOGLE_SCRIPT = process.env.GAS_URL; 
    const API_KEY_FAZER = process.env.FAZER_API_KEY || "fc_cb682478a17afc111710344a";

    if (!URL_GOOGLE_SCRIPT) {
      console.error("Falta la variable de entorno GAS_URL");
      return res.status(500).json({ status: 'error', message: 'Error de configuración del servidor.' });
    }

    // ==========================================
    // CASO A: SI EL CLIENTE SOLO PIDE EL CATÁLOGO DE PRECIOS
    // ==========================================
    if (tipo === "obtener_precios") {
      const resPrecios = await fetch(URL_GOOGLE_SCRIPT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accion: "obtener_precios_roblox" }) // Asegúrate de manejar esta acción en tu Apps Script o usar la general
      });
      const dataPrecios = await resPrecios.json();
      return res.status(200).json(dataPrecios);
    }

    // ==========================================
    // CASO B: PROCESAMIENTO DE COMPRA Y PAGO (Antifraude y FazerCards/Pines)
    // ==========================================
    if (tipo === "compra") {
      if (!user || !producto || !referencia) {
        return res.status(400).json({ status: "error", message: "Faltan datos obligatorios para procesar la recarga de Roblox." });
      }

      // PASO 1: OBTENER EL PRECIO REAL DESDE LA BASE DE DATOS (Antifraude)
      const resPrecios = await fetch(URL_GOOGLE_SCRIPT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accion: "obtener_precios" })
      });
      const dataPrecios = await resPrecios.json();

      if (!dataPrecios || dataPrecios.status !== "success" || !dataPrecios.catalogo) {
        return res.status(500).json({ status: "error", message: "Error al leer la base de datos de precios." });
      }

      // Buscamos el paquete de Roblox en el catálogo del Google Sheet
      const paqueteGsheet = dataPrecios.catalogo.find(p => String(p.diamantes).trim().toLowerCase() === String(producto).trim().toLowerCase() || String(p.producto).trim().toLowerCase() === String(producto).trim().toLowerCase());
      
      if (!paqueteGsheet) {
        return res.status(400).json({ status: "error", message: "Paquete de Roblox inválido o manipulado." });
      }

      const precioReal = limpiarMontoVES(paqueteGsheet.precio);

      // PASO 2: BUSCAR EL PAGO EN EL EXCEL Y VERIFICAR EL MONTO EXACTO
      const resVerificacion = await fetch(URL_GOOGLE_SCRIPT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accion: "verificar_pago", referencia: referencia, monto: precioReal })
      });
      
      const dataVerificacion = await resVerificacion.json();

      if (!dataVerificacion || !dataVerificacion.encontrado) {
        return res.status(400).json({ status: "error", message: dataVerificacion.message || "Pago no encontrado o ya utilizado." });
      }
      
      // 🛡️ REVISIÓN ESTRICTA: ¿Faltó dinero? (Pago Insuficiente)
      if (dataVerificacion.insuficiente) {
        // Liberamos el pago para que el usuario pueda completarlo luego
        await fetch(URL_GOOGLE_SCRIPT, { 
          method: 'POST', 
          headers: { 'Content-Type': 'application/json' }, 
          body: JSON.stringify({ accion: "marcar_verificado", referencia: dataVerificacion.referencia }) 
        });
        
        const pagado = Number(dataVerificacion.montoPagado) || 0;
        const faltante = precioReal - pagado;

        return res.status(400).json({ 
          status: "error", 
          insuficiente: true,
          montoPagado: pagado,
          precioOficial: precioReal,
          faltante: faltante,
          message: `Pago insuficiente: Encontramos ${formatearVES(pagado)} Bs, pero el paquete de Roblox cuesta ${formatearVES(precioReal)} Bs. Faltan ${formatearVES(faltante)} Bs.` 
        });
      }

      // PASO 3: TODO COINCIDE -> QUEMAR EL PAGO PARA QUE NO SE REPITA
      await fetch(URL_GOOGLE_SCRIPT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accion: "marcar_usado", referencia: dataVerificacion.referencia })
      });

      // PASO 4: OBTENER CÓDIGO DE ROBLOX (Ya sea vía API de FazerCards o consultando tu bóveda/API externa)
      // Nota: Si usas FazerCards para tarjetas de Roblox, puedes hacer la petición correspondiente aquí, 
      // o dejar que Google Apps Script devuelva el PIN de tu inventario interno.
      
      let codigoRobloxFinal = "ROBLOX-PIN-AUTOMATICO";

      // Petición opcional a FazerCards si manejas Roblox por API de Fazer:
      /*
      const respFazer = await fetch("https://api.fzr.cards/api/v2/...", { ... });
      const dataFazer = await respFazer.json();
      codigoRobloxFinal = dataFazer.code;
      */

      // O solicitar el PIN directamente al Apps Script (bóveda interna):
      const resPin = await fetch(URL_GOOGLE_SCRIPT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accion: "entregar_pin_roblox", producto: producto })
      });
      const dataPin = await resPin.json();

      if (dataPin && dataPin.code) {
        codigoRobloxFinal = dataPin.code;
      }

      // PASO 5: REGISTRAR EL PEDIDO FINALIZADO EN EL EXCEL
      const comprobanteSeguro = url_capture && url_capture.trim() !== "" ? url_capture : "Sin comprobante";

      await fetch(URL_GOOGLE_SCRIPT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          accion: "registrar_finalizado", 
          idJugador: user, 
          paquete: `${producto} Robux`, 
          referencias: dataVerificacion.referencia, 
          urlImagen: comprobanteSeguro 
        })
      });

      return res.status(200).json({ 
        status: "success", 
        code: codigoRobloxFinal,
        message: "¡Código de Roblox obtenido exitosamente!" 
      });
    }

    return res.status(400).json({ status: 'error', message: 'Tipo de petición no válido.' });

  } catch (error) {
    console.error('Error crítico en el proxy de Roblox:', error);
    return res.status(500).json({ status: 'error', message: 'Error interno de conexión con el servidor.' });
  }
}