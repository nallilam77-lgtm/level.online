// Este archivo vive en /api/roblox.js dentro de tu proyecto en Vercel

export default async function handler(req, res) {
  // 1. Configurar los encabezados CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ status: 'error', message: 'Método no permitido. Usa POST.' });
  }

  // Convertidor para mostrar montos al usuario (Ej: 920,00 Bs)
  const formatearVES = (monto) => Number(monto).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // TRADUCTOR BANCARIO: Convierte formatos de texto a número plano
  const limpiarMontoVES = (valor) => {
    if (!valor) return 0;
    if (typeof valor === 'number') return valor;
    let m = String(valor).trim().replace(/[^0-9.,-]/g, '');
    if (!m) return 0;

    let lastComma = m.lastIndexOf(',');
    let lastDot = m.lastIndexOf('.');

    if (lastComma > lastDot) {
      m = m.replace(/\./g, '').replace(',', '.'); 
    } else if (lastComma !== -1 && lastDot === -1) {
      m = m.replace(',', '.'); 
    } else if (lastDot !== -1 && lastComma === -1) {
      let parts = m.split('.');
      if (parts.length > 2 || (parts.length === 2 && parts[1].length === 3)) {
        m = m.replace(/\./g, ''); 
      }
    }
    return parseFloat(m) || 0;
  };

  try {
    const { tipo, user, producto, referencia, url_capture } = req.body;
    const URL_GOOGLE_SCRIPT = process.env.GAS_URL; 

    if (!URL_GOOGLE_SCRIPT) {
      console.error("Falta la variable de entorno GAS_URL");
      return res.status(500).json({ status: 'error', message: 'Error de configuración del servidor.' });
    }

    // ==========================================
    // CASO A: OBTENER PRECIOS DE LA PESTAÑA "PreciosRoblox"
    // ==========================================
    if (tipo === "obtener_precios") {
      const resPrecios = await fetch(URL_GOOGLE_SCRIPT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accion: "obtener_precios_roblox" }) // <--- Apunta a la hoja independiente
      });
      const dataPrecios = await resPrecios.json();
      return res.status(200).json(dataPrecios);
    }

    // ==========================================
    // CASO B: PROCESAMIENTO DE COMPRA Y PAGO (Roblox)
    // ==========================================
    if (tipo === "compra") {
      if (!user || !producto || !referencia) {
        return res.status(400).json({ status: "error", message: "Faltan datos obligatorios para procesar la recarga de Roblox." });
      }

      // 1. Obtener los precios reales desde la pestaña independiente "PreciosRoblox"
      const resPrecios = await fetch(URL_GOOGLE_SCRIPT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accion: "obtener_precios_roblox" })
      });
      const dataPrecios = await resPrecios.json();

      if (!dataPrecios || dataPrecios.status !== "success" || !dataPrecios.precios) {
        return res.status(500).json({ status: "error", message: "Error al leer los precios de la hoja PreciosRoblox." });
      }

      const preciosMap = dataPrecios.precios; // Estructura esperada: { "50 robux": "920,00", "100 robux": "1.690,00", ... }
      const precioTexto = preciosMap[producto];

      if (!precioTexto) {
        return res.status(400).json({ status: "error", message: "Paquete de Roblox inválido o no encontrado en el catálogo." });
      }

      const precioReal = limpiarMontoVES(precioTexto);

      // 2. Buscar el pago en el Excel y verificar el monto exacto
      const resVerificacion = await fetch(URL_GOOGLE_SCRIPT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accion: "verificar_pago", referencia: referencia, monto: precioReal })
      });
      
      const dataVerificacion = await resVerificacion.json();

      if (!dataVerificacion || !dataVerificacion.encontrado) {
        return res.status(400).json({ status: "error", message: dataVerificacion.message || "Pago no encontrado o ya utilizado." });
      }
      
      // 🛡️ REVISIÓN ESTRICTA: ¿Faltó dinero?
      if (dataVerificacion.insuficiente) {
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

      // 3. Quemar el pago para que no se pueda reutilizar
      await fetch(URL_GOOGLE_SCRIPT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accion: "marcar_usado", referencia: dataVerificacion.referencia })
      });

      // 4. Obtener el PIN o código de Roblox correspondiente desde tu Apps Script (bóveda interna)
      const resPin = await fetch(URL_GOOGLE_SCRIPT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accion: "entregar_pin_roblox", producto: producto })
      });
      const dataPin = await resPin.json();
      
      const codigoRobloxFinal = (dataPin && dataPin.code) ? dataPin.code : "ROBLOX-PIN-AUTOMATICO";

      // 5. Registrar el pedido finalizado en el Google Sheet
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