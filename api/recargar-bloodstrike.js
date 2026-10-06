import { randomUUID } from 'node:crypto';
import { obtenerIp, minutosBloqueado, registrarFallo } from './_lib/limitador.js';
import { llamarScript, conCache, catalogoValido, ErrorExterno } from './_lib/externo.js';
import { PAQUETE_VALIDO, textoParaHoja, faltaConfiguracion } from './_lib/validacion.js';
import { FASES, informeError } from './_lib/reporte.js';

// Tiempos (maxDuration de Vercel = 120 s en vercel.json). Peor caso con respuesta incierta:
// precios 12 + verificar 32 + FazerCards 40 + registrar 12 + marcar 12 = 108 s
const TIEMPOS = {
  // Solo si el Apps Script de Blood Strike anuncia "version: 2" (verificar_pago idempotente)
  idempotente: { tiempoMs: 32000, intentoMs: 15000, reintentos: 2, reintentarTrasTimeout: true },
  // Apps Script sin idPedido: un solo intento largo, nunca se repite
  sinIdempotencia: { tiempoMs: 20000 },
  // La orden de FazerCards NUNCA se reintenta: repetirla podría recargar dos veces
  fazer: 40000,
  incidente: 12000,
};

const CODIGOS_FAZER = {
  "51": "51_bc",
  "105": "105_bc",
  "320": "320_bc",
  "540": "540_bc",
  "1100": "1100_bc",
  "2260": "2260_bc",
  "5800": "5800_bc"
};

const formatearVES = (monto) => Number(monto).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function limpiarMontoVES(valor) {
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
}

/**
 * Crea la orden en FazerCards y clasifica el resultado:
 *  - ok:       FazerCards confirmó la recarga.
 *  - rechazo:  FazerCards respondió claramente que NO hizo la recarga.
 *  - incierto: red caída, tiempo agotado, error 5xx o respuesta ilegible: la orden PUDO crearse.
 */
async function crearOrdenFazer({ apiKey, offerId, idJugador }) {
  const controlador = new AbortController();
  const temporizador = setTimeout(() => controlador.abort(), TIEMPOS.fazer);
  try {
    const respuesta = await fetch("https://api.fzr.cards/api/v2/topups/order", {
      method: "POST",
      headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        "category_id": "blood_strike",
        "offer_id": offerId,
        "fields": { "player_id": idJugador }
      }),
      signal: controlador.signal
    });
    const texto = await respuesta.text();
    if (respuesta.status >= 500) {
      return { tipo: 'incierto', motivo: `FazerCards respondió HTTP ${respuesta.status}: ${texto.slice(0, 200) || 'sin cuerpo'}. La orden pudo haberse creado.` };
    }
    let datos;
    try { datos = JSON.parse(texto); } catch (e) {
      return { tipo: 'incierto', motivo: `FazerCards devolvió una respuesta ilegible (HTTP ${respuesta.status}): ${texto.slice(0, 200) || 'vacía'}. La orden pudo haberse creado.` };
    }
    if (datos && datos.ok === true) return { tipo: 'ok', datos };
    return { tipo: 'rechazo', motivo: `FazerCards rechazó la recarga (HTTP ${respuesta.status}): ${String(datos?.error || 'ID de jugador incorrecto o mantenimiento.')}`, errorCliente: String(datos?.error || "ID de jugador incorrecto o mantenimiento.") };
  } catch (error) {
    const motivo = error.name === 'AbortError'
      ? `FazerCards no respondió en ${Math.round(TIEMPOS.fazer / 1000)} s (tiempo agotado). La orden pudo haberse creado.`
      : `Error de red con FazerCards (${error.cause?.code || error.message}). La orden pudo haberse creado.`;
    return { tipo: 'incierto', motivo };
  } finally {
    clearTimeout(temporizador);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ status: "error", message: "Método no permitido" });

  try {
    const { id, paquete, referencia } = req.body || {};
    // El comprobante viaja a la hoja de cálculo: se limpia para que no pueda inyectar fórmulas
    const urlImagen = textoParaHoja(req.body?.urlImagen || "");

    if (!id || !paquete || !referencia) {
      return res.status(400).json({ status: "error", message: "Faltan datos obligatorios para procesar la recarga." });
    }

    // Formato estricto: ID numérico y exactamente 5 dígitos de referencia
    if (!/^\d{5,15}$/.test(String(id)) || !/^\d{5}$/.test(String(referencia)) || !PAQUETE_VALIDO.test(String(paquete))) {
      return res.status(400).json({ status: "error", message: "Datos con formato inválido. Revisa tu ID y los 5 dígitos de la referencia." });
    }

    const URL_GOOGLE_SCRIPT = process.env.SCRIPT_BLOOD;
    const FAZER_API_KEY = process.env.FAZER_API_KEY;

    if (!URL_GOOGLE_SCRIPT || !FAZER_API_KEY) {
      return faltaConfiguracion(res, ["SCRIPT_BLOOD", "FAZER_API_KEY"].filter((v) => !process.env[v]),
        { status: "error", message: "Las recargas automáticas no están disponibles en este momento. No realices el pago todavía; escríbenos por WhatsApp." });
    }

    const idPedido = randomUUID();
    const comprobante = urlImagen && urlImagen.trim() !== "" ? urlImagen : "Sin comprobante";

    // Marcar una referencia se puede repetir sin efectos secundarios: reintentos rápidos
    const marcarReferencia = (accion, ref) =>
      llamarScript(URL_GOOGLE_SCRIPT, { accion, referencia: ref, idPedido }, { reintentos: 2, tiempoMs: TIEMPOS.incidente, reintentarTrasTimeout: true })
        .then(() => true)
        .catch((e) => { console.error(`❌ ${accion} falló para REF ${ref}:`, e.message); return false; });
    // Los registros agregan filas: sin reintento tras timeout para no duplicarlas
    const registrarEnHoja = (cuerpo) =>
      llamarScript(URL_GOOGLE_SCRIPT, cuerpo, { tiempoMs: TIEMPOS.incidente, reintentos: 1 })
        .then(() => true)
        .catch((e) => { console.error(`❌ ${cuerpo.accion} falló para el pedido ${idPedido}:`, e.message, '| Informe:', cuerpo.urlImagen); return false; });
    const informe = (datos) => informeError({ idPedido, idJugador: id, paquete, referenciaCliente: referencia, comprobante, noAplica: true, ...datos });

    // Antes de consultar la hoja de pagos: ¿esta IP o este jugador acumula demasiados fallos?
    const clavesLimite = [`ip:${obtenerIp(req)}`, `jugador:bs:${id}`];
    const minutosEspera = await minutosBloqueado(clavesLimite);
    if (minutosEspera > 0) {
      return res.status(429).json({ status: "error", message: `Demasiados intentos fallidos. Espera ${minutosEspera} minutos para volver a intentar.` });
    }

    // ==========================================
    // FASE 1: OBTENER EL PRECIO REAL
    // ==========================================
    // Copia de hasta 60 s para no repetir la consulta en cada compra; sin respaldo viejo,
    // porque este precio es el que se cobra.
    let dataPrecios;
    try {
      ({ datos: dataPrecios } = await conCache('precios:bs',
        () => llamarScript(URL_GOOGLE_SCRIPT, { accion: "obtener_precios" }, { reintentos: 2, intentoMs: 8000, tiempoMs: 12000, reintentarTrasTimeout: true }),
        { esValido: catalogoValido, respaldoMs: 0 }));
    } catch (error) {
      console.error(`❌ [${FASES.precios}] ${error.message}`);
      return res.status(503).json({ status: "error", message: "Error al leer la base de datos de precios. Intenta de nuevo en un momento." });
    }
    const scriptV2 = Number(dataPrecios.version) >= 2;

    const numeroOro = String(paquete).replace(/[^0-9]/g, '');
    const paqueteGsheet = dataPrecios.catalogo.find(p => String(p.diamantes || p.paquete).replace(/[^0-9]/g, '') === numeroOro);
    if (!paqueteGsheet) {
      await registrarFallo(clavesLimite);
      return res.status(400).json({ status: "error", message: "Paquete inválido o manipulado." });
    }
    const precioReal = limpiarMontoVES(paqueteGsheet.precio);

    // ==========================================
    // FASE 2: BUSCAR PAGO Y VERIFICAR
    // ==========================================
    let dataVerificacion;
    try {
      dataVerificacion = await llamarScript(URL_GOOGLE_SCRIPT,
        { accion: "verificar_pago", referencia: referencia, monto: precioReal, idPedido },
        scriptV2 ? TIEMPOS.idempotente : TIEMPOS.sinIdempotencia);
    } catch (error) {
      console.error(`❌ [${FASES.verificacion}] ${error.message}`);
      await registrarEnHoja(informe({
        fase: FASES.verificacion, motivo: `Apps Script de Blood Strike no respondió a verificar_pago: ${error.message}`,
        estadoPago: `SIN CONFIRMAR: si la fila del pago (referencia terminada en ${referencia}) quedó "En proceso", cámbiala a "Verificado"`,
      }));
      if (error instanceof ErrorExterno) {
        return res.status(503).json({ status: "error", message: "No pudimos confirmar tu pago a tiempo. Espera un minuto e intenta de nuevo; si te dice que ya fue utilizado, escríbenos por WhatsApp." });
      }
      throw error;
    }

    if (!dataVerificacion || !dataVerificacion.encontrado) {
      await registrarFallo(clavesLimite);
      return res.status(400).json({ status: "error", message: dataVerificacion?.message || "Pago no encontrado o ya utilizado." });
    }
    const referenciaCompleta = dataVerificacion.referencia;

    if (dataVerificacion.insuficiente) {
      await registrarFallo(clavesLimite);
      await marcarReferencia("marcar_verificado", referenciaCompleta);

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
    // FASE 4: RECARGA EN LA API DE FAZERCARDS
    // ==========================================
    const offerIdFinal = CODIGOS_FAZER[numeroOro];
    if (!offerIdFinal) {
      const liberado = await marcarReferencia("marcar_verificado", referenciaCompleta);
      await registrarEnHoja(informe({
        fase: FASES.apiBloodStrike, motivo: `El paquete "${paquete}" (${numeroOro} de oro) no tiene un offer_id de FazerCards configurado en recargar-bloodstrike.js. No se llamó a la API.`,
        referenciaCompleta,
        estadoPago: liberado ? 'LIBERADO (vuelve a "Verificado"): el cliente puede reintentar o elegir otro paquete' : `SIN CONFIRMAR: la referencia ${referenciaCompleta} puede seguir "En proceso"`,
      }));
      return res.status(400).json({ status: "error", message: "El paquete solicitado no existe en el catálogo del proveedor." });
    }

    const orden = await crearOrdenFazer({ apiKey: FAZER_API_KEY, offerId: offerIdFinal, idJugador: id });

    if (orden.tipo === 'incierto') {
      console.error(`⚠️ [${FASES.apiBloodStrike}] ${orden.motivo} | REF: ${referenciaCompleta}`);
      // Registrar el incidente y LUEGO bloquear el pago (nadie puede reutilizarlo mientras se revisa).
      // EN ORDEN, no en paralelo: el Apps Script puede devolver el pago a "Verificado" al registrar
      // el error; marcar_usado debe ser SIEMPRE la última escritura.
      await registrarEnHoja(informe({
        fase: FASES.apiBloodStrike,
        motivo: `${orden.motivo} Oferta ${offerIdFinal}. ANTES DE REPETIR: buscar en el panel de FazerCards si existe una orden para el jugador ${id}.`,
        referenciaCompleta,
        estadoPago: 'BLOQUEADO (se marca "Usado" justo después de este registro) mientras se confirma la orden en FazerCards',
      }));
      await marcarReferencia("marcar_usado", referenciaCompleta);

      // El frontend reconoce "fallo técnico" y muestra el modal de "recarga en proceso"
      return res.status(202).json({
        status: "error",
        message: "Fallo técnico con el proveedor. Tu pago está verificado y la recarga quedó en revisión."
      });
    }

    if (orden.tipo === 'rechazo') {
      console.error(`❌ [${FASES.apiBloodStrike}] ${orden.motivo}`);
      // FazerCards confirmó que NO hizo la recarga: el pago se libera para que el cliente corrija su ID
      await registrarEnHoja(informe({
        fase: FASES.apiBloodStrike, motivo: `${orden.motivo} Oferta ${offerIdFinal}.`, referenciaCompleta,
        estadoPago: 'LIBERADO (se devuelve a "Verificado" justo después de este registro): no se cobró nada en FazerCards',
      }));
      await marcarReferencia("marcar_verificado", referenciaCompleta);

      return res.status(400).json({
        status: "error",
        message: "El proveedor rechazó la recarga: " + orden.errorCliente + ". Tu pago no se descontó, verifica tu ID."
      });
    }

    // ==========================================
    // FASE 5: QUEMAR EL PAGO Y GUARDAR EN FINALIZADOS (en paralelo)
    // ==========================================
    const [pagoMarcado, finalizadoGuardado] = await Promise.all([
      marcarReferencia("marcar_usado", referenciaCompleta),
      registrarEnHoja({
        accion: "registrar_finalizado",
        idJugador: id,
        paquete: paquete,
        referencia: referenciaCompleta,
        codigosUsados: "API Directa (FazerCards)",
        urlImagen: comprobante,
        idPedido
      })
    ]);
    if (!pagoMarcado || !finalizadoGuardado) {
      const pendiente = [!pagoMarcado && 'marcar el pago como "Usado"', !finalizadoGuardado && 'anotar la recarga en "finalizados"'].filter(Boolean).join(' y ');
      await registrarEnHoja(informe({
        fase: FASES.cierre,
        motivo: `La recarga SÍ se entregó (FazerCards confirmó la orden), pero Apps Script no respondió al cierre: falta ${pendiente}`,
        referenciaCompleta,
        estadoPago: pagoMarcado ? 'USADO (correcto)' : `SIN CONFIRMAR: marcar a mano como "Usado" la referencia ${referenciaCompleta}`,
      }));
    }

    return res.status(200).json({ status: "success", message: "Recarga de Blood Strike procesada exitosamente." });

  } catch (error) {
    console.error("Error crítico en recargar-bloodstrike.js:", error.message);
    if (error instanceof ErrorExterno) {
      return res.status(503).json({ status: "error", message: "No pudimos confirmar tu pago a tiempo. Espera un minuto e intenta de nuevo; si te dice que ya fue utilizado, escríbenos por WhatsApp." });
    }
    return res.status(500).json({ status: "error", message: "Falla interna del servidor." });
  }
}
