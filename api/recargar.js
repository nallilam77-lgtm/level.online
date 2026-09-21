export default async function handler(req, res) {
  // Solo aceptamos peticiones POST
  if (req.method !== 'POST') return res.status(405).json({ status: "error", message: "Método no permitido" });

  // Convertidor inteligente para mostrar siempre el dinero como "1.520,00 Bs" al usuario
  const formatearVES = (monto) => {
    return Number(monto).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  try {
    const { id, paquete, referencia, urlImagen } = req.body;

    if (!id || !paquete || !referencia) {
      return res.status(400).json({ status: "error", message: "Faltan datos obligatorios para procesar la recarga." });
    }

    // ==========================================
    // 1. EL CATÁLOGO MAESTRO (Blindado y Normalizado)
    // ==========================================
    const catalogo = {
      "110":   { code: "110_diamonds", precio: 760.00 },
      "220":   { code: "110_diamonds", precio: 1520.00, doble: true },
      "341":   { code: "341_diamonds", precio: 2300.00 },
      "572":   { code: "572_diamonds", precio: 3850.00 },
      "1166":  { code: "1166_diamonds", precio: 7120.00 },
      "2278":  { code: "2398_diamonds", precio: 14100.00 },
      "6160":  { code: "6160_diamonds", precio: 36000.00 }
    };

    // Extraemos solo los números del paquete recibido para que los puntos o letras no afecten la búsqueda
    const numeroDiamantes = String(paquete).replace(/[^0-9]/g, '');
    const producto = catalogo[numeroDiamantes];
    
    // Si intentan inyectar un paquete falso o inexistente
    if (!producto) {
      return res.status(400).json({ status: "error", message: "Paquete inválido o manipulado desde el navegador." });
    }

    const API_KEY_FAZER = process.env.FAZER_API_KEY || "fc_cb682478a17afc111710344a";
    const URL_GOOGLE_SCRIPT = process.env.SCRIPT_RECARGAS_URL; 

    // ==========================================
    // 2. VERIFICAR Y BLOQUEAR EL PAGO EN SHEETS
    // ==========================================
    const resVerificacion = await fetch(URL_GOOGLE_SCRIPT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accion: "verificar_pago", referencia: referencia, monto: producto.precio })
    });
    
    const dataVerificacion = await resVerificacion.json();

    if (!dataVerificacion || !dataVerificacion.encontrado) {
      return res.status(400).json({ status: "error", message: dataVerificacion.message || "Pago no encontrado o ya utilizado." });
    }
    
    // 🛡️ RECHAZO CON FORMATO EXACTO VENEZOLANO
    if (dataVerificacion.insuficiente) {
      return res.status(400).json({ 
        status: "error", 
        message: `Pago insuficiente: Encontramos ${formatearVES(dataVerificacion.montoPagado)} Bs, pero este paquete cuesta ${formatearVES(producto.precio)} Bs.` 
      });
    }

    // ==========================================
    // 3. INYECTAR LOS DIAMANTES (FAZERCARDS)
    // ==========================================
    const enviarRecargaFazer = async () => {
      const resp = await fetch("https://api.fzr.cards/api/v2/topups/order", {
        method: "POST",
        headers: { "X-API-Key": API_KEY_FAZER, "Content-Type": "application/json" },
        body: JSON.stringify({ category_id: "free_fire_latam", offer_id: producto.code, fields: { player_id: id } })
      });
      return await resp.json();
    };

    let resultadoCompra = await enviarRecargaFazer();

    if (resultadoCompra.ok !== true) {
      // Si la API falla, el escudo protector le devuelve el pago al cliente
      await fetch(URL_GOOGLE_SCRIPT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accion: "marcar_verificado", referencia: dataVerificacion.referencia }) });
      return res.status(400).json({ status: "error", message: "Fallo en el servidor de recargas: " + (resultadoCompra.error || "Mantenimiento temporal.") });
    }

    // Doble inyección para el paquete de 220
    if (producto.doble) {
      await new Promise(resolve => setTimeout(resolve, 3000));
      let resultadoCompra2 = await enviarRecargaFazer();
      if (resultadoCompra2.ok !== true) {
        console.error("Fallo la 2da inyección de 220 diamantes. Referencia: ", dataVerificacion.referencia);
      }
    }

    // ==========================================
    // 4. QUEMAR EL PAGO Y GUARDAR EL RECIBO
    // ==========================================
    await fetch(URL_GOOGLE_SCRIPT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accion: "marcar_usado", referencia: dataVerificacion.referencia })
    });

    await fetch(URL_GOOGLE_SCRIPT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        accion: "registrar_finalizado", 
        idJugador: id, 
        paquete: paquete, 
        referencias: dataVerificacion.referencia, 
        urlImagen: urlImagen || "Sin comprobante" 
      })
    });

    return res.status(200).json({ status: "success", message: "Recarga procesada exitosamente." });

  } catch (error) {
    console.error("Error crítico en recargar.js:", error);
    return res.status(500).json({ status: "error", message: "Falla interna del servidor." });
  }
}