export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ status: "error", message: "Método no permitido" });

  const formatearVES = (monto) => Number(monto).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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
    const { id, paquete, referencia, urlImagen } = req.body;

    if (!id || !paquete || !referencia) {
      return res.status(400).json({ status: "error", message: "Faltan datos obligatorios para procesar la recarga." });
    }

    // Usando tu variable exacta de Vercel para el Apps Script de Blood Strike
    const URL_GOOGLE_SCRIPT = process.env.SCRIPT_BLOOD; 
    const FAZER_API_KEY = process.env.FAZER_API_KEY;

    if (!URL_GOOGLE_SCRIPT || !FAZER_API_KEY) {
      return res.status(500).json({ status: "error", message: "Error interno: Variables de entorno no configuradas." });
    }

    // ==========================================
    // PASO 1: OBTENER EL PRECIO REAL
    // ==========================================
    const resPrecios = await fetch(URL_GOOGLE_SCRIPT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accion: "obtener_precios" })
    });
    const dataPrecios = await resPrecios.json();

    if (!dataPrecios || dataPrecios.status !== "success" || !dataPrecios.catalogo) {
      return res.status(500).json({ status: "error", message: "Error al leer la base de datos de precios." });
    }

    const numeroOro = String(paquete).replace(/[^0-9]/g, '');
    
    // Busca el paquete en Google Sheets ignorando letras (ej. "51 oro" coincide con "51")
    const paqueteGsheet = dataPrecios.catalogo.find(p => String(p.diamantes || p.paquete).replace(/[^0-9]/g, '') === numeroOro);
    if (!paqueteGsheet) {
      return res.status(400).json({ status: "error", message: "Paquete inválido o manipulado." });
    }

    const precioReal = limpiarMontoVES(paqueteGsheet.precio);

    // ==========================================
    // PASO 2: BUSCAR PAGO Y VERIFICAR
    // ==========================================
    const resVerificacion = await fetch(URL_GOOGLE_SCRIPT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accion: "verificar_pago", referencia: referencia, monto: precioReal })
    });
    const dataVerificacion = await resVerificacion.json();

    if (!dataVerificacion || !dataVerificacion.encontrado) {
      return res.status(400).json({ status: "error", message: dataVerificacion.message || "Pago no encontrado o ya utilizado." });
    }
    
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
        precioRequerido: precioReal,
        faltante: faltante,
        message: `Pago insuficiente: Encontramos ${formatearVES(pagado)} Bs, pero el paquete cuesta ${formatearVES(precioReal)} Bs. Faltan ${formatearVES(faltante)} Bs.` 
      });
    }

    // ==========================================
    // PASO 3: ATACAR API DE FAZERCARDS
    // ==========================================
    const codigosFazer = {
      "51": "51_bc",
      "105": "105_bc",
      "320": "320_bc",
      "540": "540_bc",
      "1100": "1100_bc",
      "2260": "2260_bc",
      "5800": "5800_bc"
    };

    const offerIdFinal = codigosFazer[numeroOro];
    if (!offerIdFinal) {
      await fetch(URL_GOOGLE_SCRIPT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accion: "marcar_verificado", referencia: dataVerificacion.referencia }) });
      return res.status(400).json({ status: "error", message: "El paquete solicitado no existe en el catálogo del proveedor." });
    }

    let resultadoCompra = {};
    try {
      const respuestaFazer = await fetch("https://api.fzr.cards/api/v2/topups/order", {
        method: "POST",
        headers: { "X-API-Key": FAZER_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ 
          "category_id": "blood_strike", 
          "offer_id": offerIdFinal, 
          "fields": { "player_id": id } 
        })
      });

      resultadoCompra = await respuestaFazer.json();

      if (resultadoCompra.ok !== true) {
        throw new Error(resultadoCompra.error || "ID de jugador incorrecto o mantenimiento.");
      }
    } catch (error) {
      const errorMsg = error.message || "Falla de red con el proveedor.";
      console.error("❌ Error en FazerCards:", errorMsg);

      // 📝 ANOTAR EL ERROR EN LA HOJA
      await fetch(URL_GOOGLE_SCRIPT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          accion: "registrar_error", 
          idJugador: id, 
          paquete: paquete, 
          referencia: dataVerificacion.referencia, 
          codigosUsados: "API FAZERCARDS", 
          urlImagen: `⚠️ FALLO PROVEEDOR: ${errorMsg} | 🧾 REF: ${dataVerificacion.referencia}` 
        })
      });

      // 🔓 DEVOLVER A VERIFICADO: Como la recarga por ID falló, no perdimos dinero. El cliente conserva su saldo.
      await fetch(URL_GOOGLE_SCRIPT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accion: "marcar_verificado", referencia: dataVerificacion.referencia })
      });

      return res.status(400).json({ 
        status: "error", 
        message: "El proveedor rechazó la recarga: " + errorMsg + ". Tu pago no se descontó, verifica tu ID." 
      });
    }

    // ==========================================
    // PASO 4: QUEMAR EL PAGO EN EXCEL (Todo fue exitoso)
    // ==========================================
    await fetch(URL_GOOGLE_SCRIPT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accion: "marcar_usado", referencia: dataVerificacion.referencia })
    });

    // ==========================================
    // PASO 5: GUARDAR EN PESTAÑA FINALIZADOS
    // ==========================================
    const comprobanteSeguro = urlImagen && urlImagen.trim() !== "" ? urlImagen : "Sin comprobante";

    await fetch(URL_GOOGLE_SCRIPT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        accion: "registrar_finalizado", 
        idJugador: id, 
        paquete: paquete, 
        referencia: dataVerificacion.referencia, 
        codigosUsados: "API Directa (FazerCards)", 
        urlImagen: comprobanteSeguro 
      })
    });

    return res.status(200).json({ status: "success", message: "Recarga de Blood Strike procesada exitosamente." });

  } catch (error) {
    console.error("Error crítico en recargar-bloodstrike.js:", error);
    return res.status(500).json({ status: "error", message: "Falla interna del servidor." });
  }
}
