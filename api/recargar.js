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

    // 🛡️ Blindaje anti-vacíos
    if (!id || !paquete || !referencia) {
      return res.status(400).json({ status: "error", message: "Faltan datos obligatorios para procesar la recarga." });
    }

    const URL_GOOGLE_SCRIPT = process.env.SCRIPT_RECARGAS_URL; 
    const RAILWAY_URL = "https://bot-levelup-production.up.railway.app/canjear";
    const RAILWAY_SECRET = process.env.RAILWAY_SECRET || "TuClaveSecretaSuperSegura123"; 

    // ==========================================
    // ORDEN PASO 1: VERIFICAR QUE LA REFERENCIA EXISTA EN EL BANCO
    // ==========================================
    const resVerificacion = await fetch(URL_GOOGLE_SCRIPT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accion: "verificar_pago_simple", referencia: referencia })
    });
    const dataVerificacion = await resVerificacion.json();

    if (!dataVerificacion || !dataVerificacion.encontrado) {
      return res.status(400).json({ status: "error", message: dataVerificacion.message || "Referencia bancaria no encontrada o ya utilizada." });
    }

    const montoPagadoReal = limpiarMontoVES(dataVerificacion.montoPagado);

    // ==========================================
    // ORDEN PASO 2: VERIFICAR PRECIO OFICIAL DEL PAQUETE
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

    const precioRealOficial = limpiarMontoVES(paqueteGsheet.precio);

    // 🛡️ REVISIÓN ESTRICTA: ¿El monto pagado es menor al precio oficial? (Con tolerancia de 0.50 céntimos por redondeos)
    if (montoPagadoReal < (precioRealOficial - 0.50)) {
      // Liberamos el pago de vuelta a verificado para que no quede bloqueado eternamente
      await fetch(URL_GOOGLE_SCRIPT, { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify({ accion: "marcar_verificado", referencia: dataVerificacion.referencia }) 
      });

      const faltante = precioRealOficial - montoPagadoReal;

      return res.status(400).json({ 
        status: "error", 
        insuficiente: true,
        montoPagado: montoPagadoReal,
        precioRequerido: precioRealOficial,
        faltante: faltante,
        message: `Pago insuficiente: Encontramos ${formatearVES(montoPagadoReal)} Bs, pero el paquete cuesta ${formatearVES(precioRealOficial)} Bs. Faltan ${formatearVES(faltante)} Bs.` 
      });
    }

    // ==========================================
    // ORDEN PASO 3: EXTRAER LOS CÓDIGOS DE LA HOJA "codigos"
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
    // ORDEN PASO 4: EJECUTAR RECARGA EN RAILWAY (EN SIMULTÁNEO SI SON 2)
    // ==========================================
    try {
      const promesasCanje = pinesExtraidos.map(pin => {
        return fetch(RAILWAY_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-secret-token": RAILWAY_SECRET },
          body: JSON.stringify({ pin: pin, player_id: id })
        }).then(res => res.json());
      });

      const resultados = await Promise.all(promesasCanje);
      
      const fallo = resultados.find(r => r.status !== "success");
      if (fallo) {
        throw new Error(fallo.detail || fallo.message || "Fallo en el servidor de Railway.");
      }
    } catch (error) {
      return res.status(400).json({ status: "error", message: "Error interno del Bot de Canje: " + error.message });
    }

    // ==========================================
    // ORDEN PASO 5: QUEMAR EL PAGO EN EXCEL ("Usado")
    // ==========================================
    await fetch(URL_GOOGLE_SCRIPT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accion: "marcar_usado", referencia: dataVerificacion.referencia })
    });

    // ==========================================
    // ORDEN PASO 6: GUARDAR EN PESTAÑA FINALIZADOS
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
