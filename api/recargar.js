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

    // 🛡️ RESPALDO DE EMERGENCIA EN LOGS DE VERCEL ANTES DE ENVIAR
    console.log(`[LEVEL-UP SEGURIDAD] Pines extraídos para ID ${id} (${paquete}):`, JSON.stringify(pinesExtraidos));

    // ==========================================
    // PASO 4: ATACAR RAILWAY DE FORMA SECUENCIAL
    // ==========================================
    let resultadoBot;
    try {
      const respuestaRailway = await fetch(RAILWAY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-secret-token": RAILWAY_SECRET },
        body: JSON.stringify({ pins: pinesExtraidos, player_id: id })
      });

      resultadoBot = await respuestaRailway.json();
      
      if (resultadoBot.status !== "success") {
        throw new Error(resultadoBot.detail || resultadoBot.message || "Fallo en el servidor de Railway.");
      }
    } catch (error) {
      // 🚨 ZONA DE ALERTA: Si Railway falló o dio timeout, recuperamos qué pines sí se usaron y cuáles no
      const pinesExitosos = resultadoBot?.pines_exitosos || [];
      const pinesPendientes = resultadoBot?.pines_pendientes || pinesExtraidos;
      const errorMsg = error.message;

      console.error("❌ Error crítico en Railway durante el canje:", errorMsg);
      console.log("✅ Pines que SÍ se alcanzaron a canjear:", pinesExitosos);
      console.log("⚠️ Pines que NO se canjearon (pendientes):", pinesPendientes);

      // 📝 ANOTAR EL INCIDENTE Y EL ESTADO DE LOS PINES EN GOOGLE SHEETS
      await fetch(URL_GOOGLE_SCRIPT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          accion: "registrar_incidente", 
          idJugador: id, 
          paquete: paquete, 
          referencia: dataVerificacion.referencia, 
          pinesCanjeados: pinesExitosos.join(" | ") || "Ninguno",
          pinesNoCanjeados: pinesPendientes.join(" | ") || "Ninguno",
          error: errorMsg,
          urlImagen: urlImagen || "Sin comprobante"
        })
      });

      // Liberar el pago o dejarlo marcado para revisión manual
      await fetch(URL_GOOGLE_SCRIPT, { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify({ accion: "marcar_verificado", referencia: dataVerificacion.referencia }) 
      });

      return res.status(400).json({ 
        status: "error", 
        message: `Error en el bot de canje: ${errorMsg}. Incidente registrado y pines respaldados para revisión.` 
      });
    }

    // ==========================================
    // PASO 5: QUEMAR EL PAGO EN EXCEL (ÉXITO TOTAL)
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
