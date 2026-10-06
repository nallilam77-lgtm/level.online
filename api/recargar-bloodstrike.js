import { obtenerIp, minutosBloqueado, registrarFallo } from './_lib/limitador.js';
import { llamarScript, conCache, catalogoValido, ErrorExterno } from './_lib/externo.js';

// Tiempos (maxDuration de Vercel = 60 s): precios 8 + verificar 10 + FazerCards 20 + registros 8 = 46 s
const TIEMPO_ESCRITURA_CRITICA_MS = 10000;

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

  // 🛡️ Apps Script con tiempo límite (8 s por defecto); si devuelve HTML queda en los logs de Vercel.
  // Solo marcar una referencia se reintenta: repetirlo no tiene efectos secundarios.
  const callGoogleScript = (url, payload, opciones = {}) => llamarScript(url, payload, opciones);
  const marcarReferencia = (url, accion, ref) =>
    llamarScript(url, { accion, referencia: ref }, { reintentos: 1 })
      .catch((e) => console.error(`❌ ${accion} falló para REF ${ref}:`, e.message));

  try {
    const { id, paquete, referencia, urlImagen } = req.body || {};

    if (!id || !paquete || !referencia) {
      return res.status(400).json({ status: "error", message: "Faltan datos obligatorios para procesar la recarga." });
    }

    // Formato estricto: ID numérico y exactamente 5 dígitos de referencia
    if (!/^\d{5,15}$/.test(String(id)) || !/^\d{5}$/.test(String(referencia)) || String(paquete).length > 40) {
      return res.status(400).json({ status: "error", message: "Datos con formato inválido. Revisa tu ID y los 5 dígitos de la referencia." });
    }

    const URL_GOOGLE_SCRIPT = process.env.SCRIPT_BLOOD;
    const FAZER_API_KEY = process.env.FAZER_API_KEY;

    if (!URL_GOOGLE_SCRIPT || !FAZER_API_KEY) {
      console.error("❌ Faltan variables de entorno: SCRIPT_BLOOD y/o FAZER_API_KEY");
      return res.status(500).json({ status: "error", message: "Falla interna del servidor." });
    }

    // Antes de consultar la hoja de pagos: ¿esta IP o este jugador acumula demasiados fallos?
    const clavesLimite = [`ip:${obtenerIp(req)}`, `jugador:bs:${id}`];
    const minutosEspera = await minutosBloqueado(clavesLimite);
    if (minutosEspera > 0) {
      return res.status(429).json({ status: "error", message: `Demasiados intentos fallidos. Espera ${minutosEspera} minutos para volver a intentar.` });
    }

    // ==========================================
    // PASO 1: OBTENER EL PRECIO REAL
    // ==========================================
    // Copia de hasta 60 s para no repetir la consulta en cada compra; sin respaldo viejo,
    // porque este precio es el que se cobra.
    let dataPrecios;
    try {
      ({ datos: dataPrecios } = await conCache('precios:bs',
        () => callGoogleScript(URL_GOOGLE_SCRIPT, { accion: "obtener_precios" }, { reintentos: 1 }),
        { esValido: catalogoValido, respaldoMs: 0 }));
    } catch (error) {
      console.error("❌ No se pudieron leer los precios:", error.message);
      return res.status(503).json({ status: "error", message: "Error al leer la base de datos de precios. Intenta de nuevo en un momento." });
    }

    const numeroOro = String(paquete).replace(/[^0-9]/g, '');
    
    const paqueteGsheet = dataPrecios.catalogo.find(p => String(p.diamantes || p.paquete).replace(/[^0-9]/g, '') === numeroOro);
    if (!paqueteGsheet) {
      await registrarFallo(clavesLimite);
      return res.status(400).json({ status: "error", message: "Paquete inválido o manipulado." });
    }

    const precioReal = limpiarMontoVES(paqueteGsheet.precio);

    // ==========================================
    // PASO 2: BUSCAR PAGO Y VERIFICAR
    // ==========================================
    // Sin reintento: si Apps Script ya registró la verificación, repetirla daría "ya utilizado"
    const dataVerificacion = await callGoogleScript(URL_GOOGLE_SCRIPT, {
      accion: "verificar_pago",
      referencia: referencia,
      monto: precioReal
    }, { tiempoMs: TIEMPO_ESCRITURA_CRITICA_MS });

    if (!dataVerificacion || !dataVerificacion.encontrado) {
      await registrarFallo(clavesLimite);
      return res.status(400).json({ status: "error", message: dataVerificacion?.message || "Pago no encontrado o ya utilizado." });
    }

    if (dataVerificacion.insuficiente) {
      await registrarFallo(clavesLimite);
      await marcarReferencia(URL_GOOGLE_SCRIPT, "marcar_verificado", dataVerificacion.referencia);

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
      await marcarReferencia(URL_GOOGLE_SCRIPT, "marcar_verificado", dataVerificacion.referencia);
      return res.status(400).json({ status: "error", message: "El paquete solicitado no existe en el catálogo del proveedor." });
    }

    // Hay que distinguir dos tipos de fallo del proveedor:
    // - RECHAZO: FazerCards respondió claramente que no hizo la recarga → el pago queda libre para reintentar.
    // - INCIERTO: red caída, tiempo agotado, error 5xx o respuesta ilegible → la orden PUDO crearse.
    //   En ese caso el pago se bloquea y pasa a revisión manual, para que un reintento no recargue dos veces.
    let resultadoCompra = null;
    let respuestaIncierta = false;
    let detalleIncierto = "";

    const controlador = new AbortController();
    const tiempoLimite = setTimeout(() => controlador.abort(), 20000);
    try {
      const respuestaFazer = await fetch("https://api.fzr.cards/api/v2/topups/order", {
        method: "POST",
        headers: { "X-API-Key": FAZER_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          "category_id": "blood_strike",
          "offer_id": offerIdFinal,
          "fields": { "player_id": id }
        }),
        signal: controlador.signal
      });

      const textoFazer = await respuestaFazer.text();
      if (respuestaFazer.status >= 500) {
        respuestaIncierta = true;
        detalleIncierto = `HTTP ${respuestaFazer.status}`;
      } else {
        try {
          resultadoCompra = JSON.parse(textoFazer);
        } catch (e) {
          respuestaIncierta = true;
          detalleIncierto = `respuesta ilegible (HTTP ${respuestaFazer.status})`;
        }
      }
    } catch (error) {
      respuestaIncierta = true;
      detalleIncierto = error.name === 'AbortError' ? "tiempo agotado (20 s)" : `red: ${error.message}`;
    } finally {
      clearTimeout(tiempoLimite);
    }

    if (respuestaIncierta) {
      console.error("⚠️ Respuesta incierta de FazerCards:", detalleIncierto, "| REF:", dataVerificacion.referencia);

      // Registrar el incidente y bloquear el pago (nadie puede reutilizarlo mientras se revisa), en paralelo
      await Promise.allSettled([
        callGoogleScript(URL_GOOGLE_SCRIPT, {
          accion: "registrar_error",
          idJugador: id,
          paquete: paquete,
          referencia: dataVerificacion.referencia,
          codigosUsados: "API FAZERCARDS (INCIERTO)",
          urlImagen: `⚠️ REVISAR EN FAZERCARDS SI LA ORDEN EXISTE ANTES DE REPETIR | Motivo: ${detalleIncierto} | 🧾 REF: ${dataVerificacion.referencia} | 🔗 CAPTURE: ${urlImagen || "Sin comprobante"}`
        }).catch((e) => console.error("❌ registrar_error falló:", e.message)),
        marcarReferencia(URL_GOOGLE_SCRIPT, "marcar_usado", dataVerificacion.referencia)
      ]);

      // El frontend reconoce "fallo técnico" y muestra el modal de "recarga en proceso"
      return res.status(202).json({
        status: "error",
        message: "Fallo técnico con el proveedor. Tu pago está verificado y la recarga quedó en revisión."
      });
    }

    if (!resultadoCompra || resultadoCompra.ok !== true) {
      const errorMsg = String(resultadoCompra?.error || "ID de jugador incorrecto o mantenimiento.");
      console.error("❌ FazerCards rechazó la recarga:", errorMsg);

      await Promise.allSettled([
        callGoogleScript(URL_GOOGLE_SCRIPT, {
          accion: "registrar_error",
          idJugador: id,
          paquete: paquete,
          referencia: dataVerificacion.referencia,
          codigosUsados: "API FAZERCARDS",
          urlImagen: `⚠️ FALLO PROVEEDOR: ${errorMsg} | 🧾 REF: ${dataVerificacion.referencia}`
        }).catch((e) => console.error("❌ registrar_error falló:", e.message)),
        marcarReferencia(URL_GOOGLE_SCRIPT, "marcar_verificado", dataVerificacion.referencia)
      ]);

      return res.status(400).json({ 
        status: "error", 
        message: "El proveedor rechazó la recarga: " + errorMsg + ". Tu pago no se descontó, verifica tu ID." 
      });
    }

    // ==========================================
    // PASO 4 Y 5: QUEMAR EL PAGO Y GUARDAR EN FINALIZADOS (en paralelo)
    // ==========================================
    const comprobanteSeguro = urlImagen && urlImagen.trim() !== "" ? urlImagen : "Sin comprobante";

    await Promise.allSettled([
      marcarReferencia(URL_GOOGLE_SCRIPT, "marcar_usado", dataVerificacion.referencia),
      callGoogleScript(URL_GOOGLE_SCRIPT, {
        accion: "registrar_finalizado",
        idJugador: id,
        paquete: paquete,
        referencia: dataVerificacion.referencia,
        codigosUsados: "API Directa (FazerCards)",
        urlImagen: comprobanteSeguro
      }).catch((e) => console.error("❌ registrar_finalizado falló:", e.message))
    ]);

    return res.status(200).json({ status: "success", message: "Recarga de Blood Strike procesada exitosamente." });

  } catch (error) {
    console.error("Error crítico en recargar-bloodstrike.js:", error.message);
    if (error instanceof ErrorExterno) {
      return res.status(503).json({ status: "error", message: "No pudimos confirmar tu pago a tiempo. Espera un minuto e intenta de nuevo; si te dice que ya fue utilizado, escríbenos por WhatsApp." });
    }
    return res.status(500).json({ status: "error", message: "Falla interna del servidor." });
  }
}