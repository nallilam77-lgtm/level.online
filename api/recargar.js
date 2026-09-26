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

    const URL_GOOGLE_SCRIPT = process.env.SCRIPT_RECARGAS_URL; 
    const RAILWAY_URL = "https://bot-levelup-production.up.railway.app/canjear";
    const RAILWAY_SECRET = process.env.RAILWAY_SECRET || "TuClaveSecretaSuperSegura123"; 

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

    const numeroDiamantes = String(paquete).replace(/[^0-9]/g, '');
    
    const paqueteGsheet = dataPrecios.catalogo.find(p => String(p.diamantes).replace(/[^0-9]/g, '') === numeroDiamantes);
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
    // PASO 3: EXTRAER LOS CÓDIGOS DE LA HOJA
    // ==========================================
    const resCodigos = await fetch(URL_GOOGLE_SCRIPT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accion: "obtener_codigo", diamantes: numeroDiamantes })
    });
    
    const dataCodigos = await resCodigos.json();
    
    if (!dataCodigos || dataCodigos.status !== "success") {
      await fetch(URL_GOOGLE_SCRIPT, { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify({ accion: "marcar_verificado", referencia: dataVerificacion.referencia }) 
      });
      return res.status(400).json({ status: "error", message: dataCodigos.message });
    }

    const pinesExtraidos = dataCodigos.pines; 

    // ==========================================
    // PASO 4: ATACAR RAILWAY (Envío en bloque)
    // ==========================================
    let resultadoBot = {};
    try {
      const respuestaRailway = await fetch(RAILWAY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-secret-token": RAILWAY_SECRET },
        body: JSON.stringify({ pins: pinesExtraidos, player_id: id }) 
      });

      resultadoBot = await respuestaRailway.json();
      
      // Si Python responde que falló, lanzamos el JSON como error para desglosarlo en el catch
      if (resultadoBot.status !== "success") {
        throw new Error(JSON.stringify(resultadoBot));
      }
    } catch (error) {
      let pinesPendientes = pinesExtraidos;
      let pinesExitosos = [];
      let errorMsg = error.message;

      // 🔍 Intentamos desglosar el JSON que envió tu bot de Python
      try {
        const botData = JSON.parse(error.message);
        pinesPendientes = botData.pines_pendientes || pinesExtraidos;
        pinesExitosos = botData.pines_exitosos || [];
        errorMsg = botData.detail || botData.error || "Fallo interno en el bot.";
      } catch(e) {
        // Si no es JSON, fue una caída de red o timeout
      }

      console.error("❌ Error en Railway:", errorMsg);

      const stringPendientes = pinesPendientes.length > 0 ? pinesPendientes.join(" | ") : "Ninguno";
      const stringExitosos = pinesExitosos.length > 0 ? pinesExitosos.join(" | ") : "Ninguno";

      // 📝 ANOTAR EL INCIDENTE Y SALVAR LOS PINES INTACTOS
      await fetch(URL_GOOGLE_SCRIPT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          accion: "registrar_error", 
          idJugador: id, 
          paquete: paquete, 
          referencia: dataVerificacion.referencia, 
          codigosUsados: stringPendientes, // 🔥 Se salvan en la hoja "errores" SÓLO los que no se gastaron
          urlImagen: `⚠️ MOTIVO: ${errorMsg} | ✅ SE USARON: ${stringExitosos} | 🔗 CAPTURE: ${urlImagen || "Sin comprobante"}` 
        })
      });

      // 🤫 Se devuelve un error genérico para que tu página web muestre "En proceso de 1 a 5 minutos"
      return res.status(400).json({ 
        status: "error", 
        message: "Fallo técnico del bot. Pines respaldados correctamente en hoja de errores." 
      });
    }

    // ==========================================
    // PASO 5: QUEMAR EL PAGO EN EXCEL
    // ==========================================
    await fetch(URL_GOOGLE_SCRIPT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accion: "marcar_usado", referencia: dataVerificacion.referencia })
    });

    // ==========================================
    // PASO 6: GUARDAR EN PESTAÑA FINALIZADOS
    // ==========================================
    const comprobanteSeguro = urlImagen && urlImagen.trim() !== "" ? urlImagen : "Sin comprobante";
    const codigosUnidos = pinesExtraidos.join(" | ");

    await fetch(URL_GOOGLE_SCRIPT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        accion: "registrar_finalizado", 
        idJugador: id, 
        paquete: paquete, 
        referencias: dataVerificacion.referencia, 
        codigosUsados: codigosUnidos, 
        urlImagen: comprobanteSeguro 
      })
    });

    return res.status(200).json({ status: "success", message: "Recarga procesada exitosamente con Level Up Bot." });

  } catch (error) {
    console.error("Error crítico en recargar.js:", error);
    return res.status(500).json({ status: "error", message: "Falla interna del servidor." });
  }
}
