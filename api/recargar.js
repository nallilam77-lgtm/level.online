export default async function handler(req, res) {
  // Solo aceptamos peticiones POST
  if (req.method !== 'POST') return res.status(405).json({ status: "error", message: "Método no permitido" });

  // Convertidor para mostrar montos al usuario (Ej: 1.520,00 Bs)
  const formatearVES = (monto) => Number(monto).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // TRADUCTOR BANCARIO: Convierte "100.000.000,00" o "3.850,00" a formato computadora (3850.00)
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
    const { id, paquete, referencia, urlImagen } = req.body;

    if (!id || !paquete || !referencia) {
      return res.status(400).json({ status: "error", message: "Faltan datos obligatorios para procesar la recarga." });
    }

    const API_KEY_FAZER = process.env.FAZER_API_KEY || "fc_cb682478a17afc111710344a";
    const URL_GOOGLE_SCRIPT = process.env.SCRIPT_RECARGAS_URL; 

    // ==========================================
    // PASO 1: OBTENER EL PRECIO REAL DESDE TU EXCEL (Antifraude)
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

    // Extraemos solo el número de diamantes (Ej: "110")
    const numeroDiamantes = String(paquete).replace(/[^0-9]/g, '');
    
    // Buscamos cuánto cuesta realmente en tu Excel
    const paqueteGsheet = dataPrecios.catalogo.find(p => String(p.diamantes).replace(/[^0-9]/g, '') === numeroDiamantes);
    if (!paqueteGsheet) {
      return res.status(400).json({ status: "error", message: "Paquete inválido o manipulado." });
    }

    // Traducimos el precio de Excel a matemática pura (Ej: "760,00" -> 760)
    const precioReal = limpiarMontoVES(paqueteGsheet.precio);

    const mapasFazer = {
      "110":   { code: "110_diamonds", doble: false },
      "220":   { code: "110_diamonds", doble: true },
      "341":   { code: "341_diamonds", doble: false },
      "572":   { code: "572_diamonds", doble: false },
      "1166":  { code: "1166_diamonds", doble: false },
      "2278":  { code: "2398_diamonds", doble: false },
      "6160":  { code: "6160_diamonds", doble: false }
    };
    
    const productoFazer = mapasFazer[numeroDiamantes];
    if (!productoFazer) {
      return res.status(400).json({ status: "error", message: "Código de FazerCards no configurado." });
    }

    // ==========================================
    // PASO 2: BUSCAR EL PAGO EN EL EXCEL Y VERIFICAR EL MONTO EXACTO
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
    
    // 🛡️ REVISIÓN ESTRICTA: ¿Faltó dinero?
    if (dataVerificacion.insuficiente) {
      // Liberamos el pago para que pueda completarlo
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
    // PASO 3: TODO COINCIDE -> QUEMAMOS EL PAGO PARA QUE NO SE REPITA
    // ==========================================
    await fetch(URL_GOOGLE_SCRIPT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accion: "marcar_usado", referencia: dataVerificacion.referencia })
    });

    // ==========================================
    // PASO 4: INYECTAR LOS DIAMANTES (FAZERCARDS)
    // ==========================================
    const enviarRecargaFazer = async () => {
      const resp = await fetch("https://api.fzr.cards/api/v2/topups/order", {
        method: "POST",
        headers: { "X-API-Key": API_KEY_FAZER, "Content-Type": "application/json" },
        body: JSON.stringify({ category_id: "free_fire_latam", offer_id: productoFazer.code, fields: { player_id: id } })
      });
      return await resp.json();
    };

    let resultadoCompra = await enviarRecargaFazer();

    if (resultadoCompra.ok !== true) {
      return res.status(400).json({ 
        status: "error", 
        message: "Fallo en el servidor de recargas: " + (resultadoCompra.error || "Mantenimiento temporal. Contacta a soporte.") 
      });
    }

    if (productoFazer.doble) {
      await new Promise(resolve => setTimeout(resolve, 3000));
      await enviarRecargaFazer();
    }

    // ==========================================
    // PASO 5: GUARDAR EN FINALIZADOS (IMAGEN OPCIONAL)
    // ==========================================
    // Si la imagen falla en subir desde la página, aquí llega como null o vacío, y se guarda como "Sin comprobante" sin detener la recarga.
    const comprobanteSeguro = urlImagen && urlImagen.trim() !== "" ? urlImagen : "Sin comprobante";

    await fetch(URL_GOOGLE_SCRIPT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        accion: "registrar_finalizado", 
        idJugador: id, 
        paquete: paquete, 
        referencias: dataVerificacion.referencia, 
        urlImagen: comprobanteSeguro 
      })
    });

    return res.status(200).json({ status: "success", message: "Recarga procesada exitosamente." });

  } catch (error) {
    console.error("Error crítico en recargar.js:", error);
    return res.status(500).json({ status: "error", message: "Falla interna del servidor." });
  }
}