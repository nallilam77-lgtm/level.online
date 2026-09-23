const PROJECT_ID = "levelupstore-87d4d";

// 🔗 Enlace directo a tu Google Apps Script de Producción
const URL_GOOGLE_SCRIPT = "https://script.google.com/macros/s/AKfycbzvMrCsdpy2vkHgJeUVH00y_6S64AwvOAB3SS9CRt94IpUVAiTEI-6uXmzT0Ifs6tNP/exec";

module.exports = async function handler(req, res) {
  // Solo aceptamos peticiones POST (Seguridad idéntica a Free Fire)
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: "Método no permitido" });
  }

  // Convertidor inteligente para formatear montos en Bolívares
  const formatearVES = (monto) => {
    return Number(monto).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  try {
    const { producto, jugadorId, orderId, referencia, urlImagen } = req.body;

    // Validación estricta de campos obligatorios
    if (!referencia || !producto || !jugadorId || !orderId) {
      return res.status(200).json({ success: false, message: "Faltan datos obligatorios en la petición." });
    }

    // ==========================================
    // 1. EL CATÁLOGO MAESTRO DE ROBUX (Blindado y Normalizado)
    // ==========================================
    const catalogoRobux = {
      "50":   { precio: 928.00 },
      "100":  { precio: 1693.00 },
      "275":  { precio: 2900.00 },
      "365":  { precio: 3937.00 },
      "420":  { precio: 4605.00 },
      "700":  { precio: 7571.00 },
      "1000": { precio: 9923.00 }
    };

    const numeroRobux = String(producto).replace(/[^0-9]/g, '');
    const paqueteSeleccionado = catalogoRobux[numeroRobux];

    // Si intentan inyectar un paquete falso o manipular el HTML
    if (!paqueteSeleccionado) {
      return res.status(200).json({ success: false, message: "Paquete de Roblox inválido o manipulado." });
    }

    // ==========================================
    // 2. VERIFICAR Y BLOQUEAR EL PAGO EN GOOGLE SHEETS
    // ==========================================
    const resVerificacion = await fetch(URL_GOOGLE_SCRIPT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accion: "verificar_pago", referencia: referencia, monto: paqueteSeleccionado.precio })
    });
    
    const dataVerificacion = await resVerificacion.json();

    if (!dataVerificacion || !dataVerificacion.encontrado) {
      return res.status(200).json({ success: false, message: dataVerificacion.message || "No se encontró ningún pago con esa referencia." });
    }

    // 🛡️ EXCEPCIÓN DE SEGURIDAD: Si el pago es insuficiente, devolvemos los datos para el frontend
    if (dataVerificacion.insuficiente) {
      await fetch(URL_GOOGLE_SCRIPT, { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify({ accion: "marcar_verificado", referencia: dataVerificacion.referencia }) 
      });
      
      const montoPagadoNum = Number(dataVerificacion.montoPagado) || 0;
      const diferencia = paqueteSeleccionado.precio - montoPagadoNum;

      return res.status(200).json({ 
        success: false, 
        insuficiente: true,
        montoPagado: formatearVES(montoPagadoNum),
        faltaPorPagar: formatearVES(diferencia > 0 ? diferencia : 0),
        message: `Pago insuficiente: Encontramos ${formatearVES(montoPagadoNum)} Bs, pero este paquete cuesta ${formatearVES(paqueteSeleccionado.precio)} Bs.` 
      });
    }

    // ==========================================
    // 3. OBTENER EL PIN DESDE LA HOJA Y MOVER A "exitosas"
    // ==========================================
    const resStock = await fetch(URL_GOOGLE_SCRIPT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        accion: "obtener_pin_roblox", 
        paquete: numeroRobux,
        jugadorId: jugadorId,
        urlImagen: urlImagen || "Sin comprobante"
      })
    });
    
    const dataStock = await resStock.json();

    if (!dataStock || !dataStock.success || !dataStock.codigo) {
      // Devolver el pago a "Verificado" si ocurre algún error con el stock
      await fetch(URL_GOOGLE_SCRIPT, { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify({ accion: "marcar_verificado", referencia: dataVerificacion.referencia }) 
      });

      return res.status(200).json({ success: false, message: dataStock.message || "Lo sentimos, no hay stock disponible en la hoja de cálculo." });
    }

    const pinCodigo = dataStock.codigo;

    // ==========================================
    // 4. QUEMAR EL PAGO DE INMEDIATO (Se marca como "Usado")
    // ==========================================
    await fetch(URL_GOOGLE_SCRIPT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accion: "marcar_usado", referencia: dataVerificacion.referencia })
    });

    // ==========================================
    // 5. REGISTRAR EL HISTORIAL EN FIRESTORE (Para el panel de tu tienda)
    // ==========================================
    const firestoreBaseUrl = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
    const fechaActual = new Date().toISOString();

    const commitBody = {
      writes: [{
        update: {
          name: `${firestoreBaseUrl}/pedidos/orden_${orderId}`,
          fields: {
            orderId: { stringValue: String(orderId) },
            categoria: { stringValue: "Roblox" },
            oferta: { stringValue: `${numeroRobux} Robux` },
            jugadorId: { stringValue: String(jugadorId) },
            montoUsd: { doubleValue: 0 },
            estado: { stringValue: "completed" },
            creadoEn: { stringValue: fechaActual }
          }
        }
      }]
    };

    await fetch(`${firestoreBaseUrl}:commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(commitBody)
    });

    // ==========================================
    // 6. RETORNAR EL CÓDIGO AL CLIENTE
    // ==========================================
    return res.status(200).json({
      success: true,
      codigo: pinCodigo
    });

  } catch (error) {
    console.error("Error crítico en recargar-roblox.js:", error);
    return res.status(200).json({ success: false, message: "Falla interna del servidor al procesar la recarga." });
  }
};