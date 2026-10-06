import { obtenerIp, minutosBloqueado, registrarFallo } from './_lib/limitador.js';
import { llamarScript, conCache, catalogoValido, ErrorExterno } from './_lib/externo.js';

// Tiempos (maxDuration de Vercel = 60 s): precios 8 + verificar 10 + códigos 10 + bot 20 + registros 8 = 56 s
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

  try {
    const { id, paquete, referencia, urlImagen } = req.body || {};

    if (!id || !paquete || !referencia) {
      return res.status(400).json({ status: "error", message: "Faltan datos obligatorios para procesar la recarga." });
    }

    // Formato estricto: ID numérico y exactamente 5 dígitos de referencia
    if (!/^\d{5,15}$/.test(String(id)) || !/^\d{5}$/.test(String(referencia)) || String(paquete).length > 40) {
      return res.status(400).json({ status: "error", message: "Datos con formato inválido. Revisa tu ID y los 5 dígitos de la referencia." });
    }

    const URL_GOOGLE_SCRIPT = process.env.SCRIPT_RECARGAS_URL;
    const RAILWAY_URL = "https://bot-levelup-production.up.railway.app/canjear";
    const RAILWAY_SECRET = process.env.RAILWAY_SECRET;

    // Sin secreto no se puede autenticar con el bot: se aborta antes de tocar pagos o códigos
    if (!URL_GOOGLE_SCRIPT || !RAILWAY_SECRET) {
      console.error("❌ Faltan variables de entorno: SCRIPT_RECARGAS_URL y/o RAILWAY_SECRET");
      return res.status(500).json({ status: "error", message: "Falla interna del servidor." });
    }

    // Marcar una referencia se puede repetir sin efectos secundarios: 1 reintento rápido.
    // Los fallos solo quedan en los logs para no interrumpir la respuesta al cliente.
    const marcarReferencia = (accion, ref) =>
      llamarScript(URL_GOOGLE_SCRIPT, { accion, referencia: ref }, { reintentos: 1 })
        .catch((e) => console.error(`❌ ${accion} falló para REF ${ref}:`, e.message));
    // Los registros agregan filas: sin reintento para no duplicarlas
    const registrarEnHoja = (cuerpo) =>
      llamarScript(URL_GOOGLE_SCRIPT, cuerpo)
        .catch((e) => console.error(`❌ ${cuerpo.accion} falló para REF ${cuerpo.referencia || cuerpo.referencias}:`, e.message));

    // Antes de consultar la hoja de pagos: ¿esta IP o este jugador acumula demasiados fallos?
    const clavesLimite = [`ip:${obtenerIp(req)}`, `jugador:ff:${id}`];
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
      ({ datos: dataPrecios } = await conCache('precios:ff',
        () => llamarScript(URL_GOOGLE_SCRIPT, { accion: "obtener_precios" }, { reintentos: 1 }),
        { esValido: catalogoValido, respaldoMs: 0 }));
    } catch (error) {
      console.error("❌ No se pudieron leer los precios:", error.message);
      return res.status(503).json({ status: "error", message: "Error al leer la base de datos de precios. Intenta de nuevo en un momento." });
    }

    const numeroDiamantes = String(paquete).replace(/[^0-9]/g, '');

    const paqueteGsheet = dataPrecios.catalogo.find(p => String(p.diamantes).replace(/[^0-9]/g, '') === numeroDiamantes);
    if (!paqueteGsheet) {
      await registrarFallo(clavesLimite);
      return res.status(400).json({ status: "error", message: "Paquete inválido o manipulado." });
    }

    const precioReal = limpiarMontoVES(paqueteGsheet.precio);

    // ==========================================
    // PASO 2: BUSCAR PAGO Y VERIFICAR
    // ==========================================
    // Sin reintento: si Apps Script ya registró la verificación, repetirla daría "ya utilizado"
    const dataVerificacion = await llamarScript(URL_GOOGLE_SCRIPT,
      { accion: "verificar_pago", referencia: referencia, monto: precioReal },
      { tiempoMs: TIEMPO_ESCRITURA_CRITICA_MS });

    if (!dataVerificacion || !dataVerificacion.encontrado) {
      await registrarFallo(clavesLimite);
      return res.status(400).json({ status: "error", message: dataVerificacion?.message || "Pago no encontrado o ya utilizado." });
    }

    if (dataVerificacion.insuficiente) {
      await registrarFallo(clavesLimite);
      await marcarReferencia("marcar_verificado", dataVerificacion.referencia);

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
    // Sin reintento: cada llamada saca pines de la hoja
    let dataCodigos;
    try {
      dataCodigos = await llamarScript(URL_GOOGLE_SCRIPT,
        { accion: "obtener_codigo", diamantes: numeroDiamantes },
        { tiempoMs: TIEMPO_ESCRITURA_CRITICA_MS });
    } catch (error) {
      // No se sabe si Apps Script alcanzó a sacar pines: se bloquea el pago y pasa a revisión manual
      console.error("⚠️ obtener_codigo sin respuesta:", error.message, "| REF:", dataVerificacion.referencia);
      await Promise.allSettled([
        registrarEnHoja({
          accion: "registrar_error", idJugador: id, paquete: paquete, referencia: dataVerificacion.referencia,
          codigosUsados: "DESCONOCIDO",
          urlImagen: `⚠️ obtener_codigo no respondió (${error.message}). REVISAR SI SE SACARON PINES DE LA HOJA | 🧾 REF: ${dataVerificacion.referencia} | 🔗 CAPTURE: ${urlImagen || "Sin comprobante"}`
        }),
        marcarReferencia("marcar_usado", dataVerificacion.referencia)
      ]);
      return res.status(202).json({ status: "error", message: "Fallo técnico momentáneo. Tu pago está verificado y la recarga quedó en revisión." });
    }

    if (!dataCodigos || dataCodigos.status !== "success") {
      await marcarReferencia("marcar_verificado", dataVerificacion.referencia);
      return res.status(400).json({ status: "error", message: dataCodigos?.message || "No hay códigos disponibles para este paquete." });
    }

    const pinesExtraidos = dataCodigos.pines;

    // ==========================================
    // PASO 4: ATACAR RAILWAY (Envío en bloque)
    // ==========================================
    // Tiempo límite para el bot: debe cortar ANTES que Vercel (maxDuration 60 s) para que
    // siempre se alcance a respaldar los pines y quemar el pago en el catch.
    let resultadoBot = {};
    const controlador = new AbortController();
    const tiempoLimite = setTimeout(() => controlador.abort(), 20000);
    try {
      const respuestaRailway = await fetch(RAILWAY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-secret-token": RAILWAY_SECRET },
        body: JSON.stringify({ pins: pinesExtraidos, player_id: id }),
        signal: controlador.signal
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

      if (error.name === 'AbortError') {
        // El bot pudo haber canjeado algunos pines antes del corte: revisar antes de reusarlos
        errorMsg = "TIEMPO AGOTADO (20 s). REVISAR EN EL JUEGO SI LOS PINES YA SE CANJEARON ANTES DE REUSARLOS";
      } else {
        // 🔍 Intentamos desglosar el JSON que envió tu bot de Python
        try {
          const botData = JSON.parse(error.message);
          pinesPendientes = botData.pines_pendientes || pinesExtraidos;
          pinesExitosos = botData.pines_exitosos || [];
          errorMsg = botData.detail || botData.error || "Fallo interno en el bot.";
        } catch(e) {
          // Si no es JSON, fue una caída de red
        }
      }

      console.error("❌ Error en Railway:", errorMsg);

      const stringPendientes = pinesPendientes.length > 0 ? pinesPendientes.join(" | ") : "Ninguno";
      const stringExitosos = pinesExitosos.length > 0 ? pinesExitosos.join(" | ") : "Ninguno";

      // 📝 ANOTAR EL INCIDENTE (SALVANDO LOS PINES) Y 🔥 QUEMAR EL PAGO, en paralelo para ganar tiempo
      await Promise.allSettled([
        registrarEnHoja({
          accion: "registrar_error",
          idJugador: id,
          paquete: paquete,
          referencia: dataVerificacion.referencia,
          codigosUsados: stringPendientes,
          // Agregada la Referencia aquí para que la veas claramente en la hoja de errores
          urlImagen: `⚠️ MOTIVO: ${errorMsg} | 🧾 REF: ${dataVerificacion.referencia} | ✅ SE USARON: ${stringExitosos} | 🔗 CAPTURE: ${urlImagen || "Sin comprobante"}`
        }),
        marcarReferencia("marcar_usado", dataVerificacion.referencia)
      ]);

      // 🤫 Se devuelve un error genérico para que tu página web muestre "En proceso de 1 a 5 minutos"
      return res.status(400).json({
        status: "error",
        message: "Fallo técnico del bot. Pines respaldados correctamente en hoja de errores."
      });
    } finally {
      clearTimeout(tiempoLimite);
    }

    // ==========================================
    // PASO 5 Y 6: QUEMAR EL PAGO Y GUARDAR EN FINALIZADOS (en paralelo)
    // ==========================================
    // La recarga YA se hizo: aunque Apps Script falle aquí, al cliente se le responde éxito.
    const comprobanteSeguro = urlImagen && urlImagen.trim() !== "" ? urlImagen : "Sin comprobante";
    const codigosUnidos = pinesExtraidos.join(" | ");

    await Promise.allSettled([
      marcarReferencia("marcar_usado", dataVerificacion.referencia),
      registrarEnHoja({
        accion: "registrar_finalizado",
        idJugador: id,
        paquete: paquete,
        referencias: dataVerificacion.referencia,
        codigosUsados: codigosUnidos,
        urlImagen: comprobanteSeguro
      })
    ]);

    return res.status(200).json({ status: "success", message: "Recarga procesada exitosamente con Level Up Bot." });

  } catch (error) {
    console.error("Error crítico en recargar.js:", error.message);
    if (error instanceof ErrorExterno) {
      return res.status(503).json({ status: "error", message: "No pudimos confirmar tu pago a tiempo. Espera un minuto e intenta de nuevo; si te dice que ya fue utilizado, escríbenos por WhatsApp." });
    }
    return res.status(500).json({ status: "error", message: "Falla interna del servidor." });
  }
}