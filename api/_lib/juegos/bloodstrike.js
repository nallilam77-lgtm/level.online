// Blood Strike: precios y recarga directa por la API de FazerCards.
// Lo usan api/juego.js (acción precios) y api/recargar.js (recargar).
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { obtenerIp, minutosBloqueado, registrarFallo } from '../limitador.js';
import { pedirJSON, llamarScript, LECTURA_APPS_SCRIPT, conCache, catalogoValido, cabecerasCachePrecios, ErrorExterno } from '../externo.js';
import { PAQUETE_VALIDO, textoParaHoja, faltaConfiguracion } from '../validacion.js';
import { FASES } from '../reporte.js';
import { formatearVES, limpiarMontoVES, crearUtilidadesPedido } from '../recarga-comun.js';
import { crearAccionDescuento, aplicarDescuentoARecarga, registrarUsoDescuento } from '../descuentos.js';
import { crearOrdenFazer } from '../fazer.js';

// Tiempos (maxDuration de api/recargar.js = 180 s en vercel.json). Peor caso con respuesta incierta:
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

// Clave del paquete (ver clavePaquete) -> offer_id de FazerCards (categoría blood_strike).
// Un paquete que no esté aquí NO se envía a la API: queda en "errores" para hacerlo a mano.
const CODIGOS_FAZER = {
  "51": "51_bc",
  "105": "105_bc",
  "320": "320_bc",
  "540": "540_bc",
  "1100": "1100_bc",
  "2260": "2260_bc",
  "5800": "5800_bc",
  "lucky_bag_week": "lucky_bag_week",
  "season_pass": "season_pass",
  "level_up_pass": "level_up_pass",
  "strike_pass_elite": "strike_pass_elite",
  "strike_pass_premium": "strike_pass_premium"
};

// Completar un pago insuficiente: la clave que recibe el cliente (la hoja solo guarda su huella SHA-256)
const CLAVE_COMPLEMENTO = /^[A-Za-z0-9_-]{32,64}$/;
const huella = (texto) => createHash('sha256').update(String(texto)).digest('hex');

// Pases y bolsas por una palabra de su nombre en la pestaña de precios (en español o en inglés,
// con o sin tildes): "Pase de Temporada" y "Season Pass" -> "season_pass". Gana la primera que coincida.
const PALABRAS_PASES = [
  [/elite/, "strike_pass_elite"],
  [/premium/, "strike_pass_premium"],
  [/bolsa|lucky/, "lucky_bag_week"],
  [/temporada|season/, "season_pass"],
  [/nivel|level/, "level_up_pass"],
];

// Clave de un paquete: el oro por su número ("105 Oro 🪙" -> "105"); los pases y bolsas por su
// nombre (ver PALABRAS_PASES; otro nombre queda como texto: "Mi Pase" -> "mi_pase", sin oferta).
function clavePaquete(texto) {
  const t = String(texto ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const nombre = t.replace(/oro|gold|monedas|diamantes|blood strike|\bbc\b/g, ' ').replace(/[^a-z]+/g, ' ').trim();
  if (!nombre) return t.replace(/[^0-9]/g, '');
  const pase = PALABRAS_PASES.find(([palabra]) => palabra.test(nombre));
  return pase ? pase[1] : nombre.replace(/ /g, '_');
}

// =========================================================================
// ACCIONES DE api/juego.js
// =========================================================================

async function precios(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ status: "error", message: "Método no permitido" });
  }

  const URL_GOOGLE_SCRIPT = process.env.SCRIPT_BLOOD;
  if (!URL_GOOGLE_SCRIPT) {
    return faltaConfiguracion(res, ["SCRIPT_BLOOD"], { status: "error", message: "Error interno al conectar con Google Sheets" });
  }

  try {
    // GET con la acción en la URL para evitar redirecciones de POST.
    // Lectura sin efectos secundarios (20 s con 1 reintento). Con copia en caché el cliente no espera.
    const { datos } = await conCache('precios:bs',
      () => pedirJSON(`${URL_GOOGLE_SCRIPT}?accion=obtener_precios`, { metodo: 'GET', ...LECTURA_APPS_SCRIPT }),
      { esValido: catalogoValido });
    cabecerasCachePrecios(res);
    return res.status(200).json(datos);
  } catch (error) {
    console.error("Error al obtener precios de Blood Strike:", error.message);
    return res.status(503).json({ status: "error", message: "Error interno al conectar con Google Sheets" });
  }
}

// Catálogo de Blood Strike para la acción "descuento" (misma caché que la acción precios)
async function catalogoBloodStrike() {
  const { datos } = await conCache('precios:bs',
    () => pedirJSON(`${process.env.SCRIPT_BLOOD}?accion=obtener_precios`, { metodo: 'GET', ...LECTURA_APPS_SCRIPT }),
    { esValido: catalogoValido });
  return datos.catalogo;
}

export const acciones = { precios, descuento: crearAccionDescuento('Blood Strike', catalogoBloodStrike) };

// =========================================================================
// RECARGA (api/recargar.js)
// =========================================================================

/**
 * Fases 4-5 con el pago ya verificado (y bloqueado "En proceso"): orden en FazerCards y cierre.
 * La usan recargar (un pago) y completarPago (varios pagos que juntos cubren el precio).
 */
async function entregarRecarga(res, {
  FAZER_API_KEY, idPedido, id, paquete, numeroOro, precioReal, desc, comprobante, referencias,
  utilidades: { marcarReferencia, registrarEnHoja, informe, bloquearPago },
}) {
  // Texto para la hoja y los informes: "ref1" o "ref1 + ref2" (pago completado)
  const referenciaCompleta = referencias.join(' + ');
  // Ante cualquier error: TODOS los pagos de este pedido quedan "Usado" (en orden, nunca en paralelo)
  const bloquear = async (datos) => {
    const [primera, ...resto] = referencias;
    const ok = await bloquearPago(primera, resto.length ? { ...datos, motivo: `${datos.motivo} (pago completado con ${referenciaCompleta})` } : datos);
    for (const ref of resto) await marcarReferencia("marcar_usado", ref);
    return ok;
  };
  const marcarPagos = async () => {
    let todos = true;
    for (const ref of referencias) todos = (await marcarReferencia("marcar_usado", ref)) && todos;
    return todos;
  };

  // ==========================================
  // FASE 4: RECARGA EN LA API DE FAZERCARDS
  // ==========================================
  const offerIdFinal = CODIGOS_FAZER[numeroOro];
  if (!offerIdFinal) {
    await bloquear({
      fase: FASES.apiBloodStrike, noAplica: true,
      motivo: `El paquete "${paquete}" (clave ${numeroOro}) no tiene un offer_id de FazerCards configurado en CODIGOS_FAZER (api/_lib/juegos/bloodstrike.js). No se llamó a la API.`,
      queHacer: 'la recarga NO se hizo; hacerla a mano o devolver el pago',
    });
    return res.status(202).json({ status: "error", message: "Fallo técnico con el proveedor. Tu pago está verificado y la recarga quedó en revisión." });
  }

  const orden = await crearOrdenFazer({
    apiKey: FAZER_API_KEY, categoria: "blood_strike", offerId: offerIdFinal, campos: { "player_id": id },
    idempotencia: idPedido, tiempoMs: TIEMPOS.fazer,
  });

  if (orden.tipo === 'incierto') {
    console.error(`⚠️ [${FASES.apiBloodStrike}] ${orden.motivo} | REF: ${referenciaCompleta}`);
    // Registrar el incidente y LUEGO bloquear el pago (en orden, dentro de bloquearPago)
    await bloquear({
      fase: FASES.apiBloodStrike,
      motivo: `${orden.motivo} Oferta ${offerIdFinal}. ANTES DE REPETIR: buscar en el panel de FazerCards si existe una orden para el jugador ${id}.`,
      queHacer: 'confirmar la orden en FazerCards antes de repetir la recarga',
    });

    // El frontend reconoce "fallo técnico" y muestra el modal de "recarga en proceso"
    return res.status(202).json({
      status: "error",
      message: "Fallo técnico con el proveedor. Tu pago está verificado y la recarga quedó en revisión."
    });
  }

  if (orden.tipo === 'rechazo') {
    console.error(`❌ [${FASES.apiBloodStrike}] ${orden.motivo}`);
    // FazerCards confirmó que NO hizo la recarga (p. ej. ID incorrecto). El pago igual se bloquea:
    // la recarga se rehace a mano con el ID correcto que el cliente envíe por WhatsApp.
    await bloquear({
      fase: FASES.apiBloodStrike, motivo: `${orden.motivo} Oferta ${offerIdFinal}.`,
      queHacer: 'no se cobró nada en FazerCards; hacer la recarga a mano con el ID correcto o devolver el pago',
    });

    return res.status(400).json({
      status: "error",
      message: "El proveedor rechazó la recarga: " + orden.errorCliente + ". Tu pago quedó guardado: escríbenos por WhatsApp con tu referencia y tu ID correcto."
    });
  }

  // ==========================================
  // FASE 5: QUEMAR EL PAGO Y GUARDAR EN FINALIZADOS
  // ==========================================
  // Primero el pago (no compite por el candado con registrar_finalizado); después, en paralelo,
  // finalizados (hoja de Blood Strike) y el uso del código (hoja de Free Fire).
  const pagoMarcado = await marcarPagos();
  const [finalizadoGuardado, usoDescuentoGuardado] = await Promise.all([
    registrarEnHoja({
      accion: "registrar_finalizado",
      idJugador: id,
      paquete: paquete,
      referencia: referenciaCompleta,
      codigosUsados: `API Directa (FazerCards, orden ${orden.orden?.id || 'sin id'})`,
      urlImagen: comprobante,
      idPedido,
      // La hoja de Blood Strike anota la orden en "fazer_card"; el webhook actualiza su estado
      ordenFazer: orden.orden?.id || '', estadoFazer: orden.orden?.status || 'processing',
      ofertaFazer: offerIdFinal, montoCobrado: precioReal,
    }),
    // +1 uso y el monto cobrado del código, en la pestaña "Descuentos" (hoja de Free Fire).
    // Si falla, la recarga ya está hecha: va al informe de "errores" para anotarlo a mano
    // (sin él, el creador pierde la comisión y la recarga no cuenta para su meta semanal).
    desc ? registrarUsoDescuento({ codigo: desc.codigo, montoCobrado: precioReal, idPedido, idJugador: id, juego: 'Blood Strike' }) : true,
  ]);
  if (!pagoMarcado || !finalizadoGuardado || !usoDescuentoGuardado) {
    const pendiente = [
      !pagoMarcado && 'marcar el pago como "Usado"',
      !finalizadoGuardado && 'anotar la recarga en "finalizados"',
      !usoDescuentoGuardado && `anotar el uso del código ${desc.codigo} (${precioReal} Bs, pedido ${idPedido}) en "Descuentos"`,
    ].filter(Boolean).join(' y ');
    await registrarEnHoja(informe({
      fase: FASES.cierre,
      motivo: `La recarga SÍ se entregó (FazerCards confirmó la orden), pero Apps Script no respondió al cierre: falta ${pendiente}`,
      referenciaCompleta,
      estadoPago: pagoMarcado ? 'USADO (correcto)' : `SIN CONFIRMAR: marcar a mano como "Usado" la referencia ${referenciaCompleta}`,
    }));
  }

  return res.status(200).json({ status: "success", message: "Recarga de Blood Strike procesada exitosamente." });

}

export async function recargar(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ status: "error", message: "Método no permitido" });
  // Segunda (o tercera...) referencia de un pago que no alcanzó
  if (req.body?.tokenComplemento !== undefined) return completarPago(req, res);

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

    const { marcarReferencia, registrarEnHoja, informe, bloquearPago } = crearUtilidadesPedido({
      urlScript: URL_GOOGLE_SCRIPT, idPedido, tiempoIncidenteMs: TIEMPOS.incidente,
      datosInforme: { idPedido, idJugador: id, paquete, referenciaCliente: referencia, comprobante, noAplica: true },
    });

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

    const numeroOro = clavePaquete(paquete);
    const paqueteGsheet = numeroOro && dataPrecios.catalogo.find(p => clavePaquete(p.diamantes || p.paquete) === numeroOro);
    if (!paqueteGsheet) {
      await registrarFallo(clavesLimite);
      return res.status(400).json({ status: "error", message: "Paquete inválido o manipulado." });
    }
    const precioLista = limpiarMontoVES(paqueteGsheet.precio);

    // Descuento opcional (tabla común en la hoja de Free Fire): se vuelve a consultar el código
    // (pudo desactivarse) antes de tocar el pago
    const descuento = await aplicarDescuentoARecarga(req.body?.codigoDescuento, precioLista);
    if (descuento.error) return res.status(descuento.error.codigo).json(descuento.error.cuerpo);
    const { desc, precio: precioReal } = descuento;

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
        // "En proceso" ya impide reutilizarlo: NUNCA se devuelve a "Verificado"
        estadoPago: `SIN CONFIRMAR: si la fila del pago (referencia terminada en ${referencia}) quedó "En proceso", márcala "Usado" y haz la recarga a mano`,
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
      const pagado = Number(dataVerificacion.montoPagado) || 0;
      const faltante = precioReal - pagado;

      // El pago queda "Por completar" (nadie más puede usarlo) y el cliente recibe una clave para pagar
      // la diferencia. El jugador, el paquete y el precio quedan en la hoja: al completar se usan esos,
      // nunca los que mande el navegador. Se puede repetir: bloodstrike.gs reconoce el idPedido.
      const clave = randomBytes(24).toString('base64url');
      const porCompletar = await llamarScript(URL_GOOGLE_SCRIPT, {
        accion: "pago_por_completar", idPedido, referencia: referenciaCompleta, idJugador: String(id),
        paquete: textoParaHoja(String(paquete)), precio: precioReal, pagado, comprobante,
        codigoDescuento: desc?.codigo || "", claveHash: huella(clave),
      }, { reintentos: 2, tiempoMs: TIEMPOS.incidente, reintentarTrasTimeout: true }).catch((e) => ({ status: 'error', message: e.message }));
      if (porCompletar?.status === 'success') {
        return res.status(400).json({
          status: "error",
          insuficiente: true,
          montoPagado: pagado,
          precioRequerido: precioReal,
          faltante: faltante,
          tokenComplemento: clave,
          horasParaCompletar: Number(porCompletar.horas) || 48,
          message: `Pago insuficiente: Encontramos ${formatearVES(pagado)} Bs, pero el paquete cuesta ${formatearVES(precioReal)} Bs. Faltan ${formatearVES(faltante)} Bs: paga la diferencia y escribe la nueva referencia para completar tu recarga.`
        });
      }
      console.error(`⚠️ pago_por_completar falló para REF ${referenciaCompleta}: ${porCompletar?.message}. Se bloquea el pago como antes.`);

      // Sin "completar" (Apps Script anterior o sin respuesta): el pago queda "Usado" y se resuelve por WhatsApp
      await bloquearPago(referenciaCompleta, {
        fase: FASES.verificacion, noAplica: true,
        motivo: `Pago insuficiente: pagó ${formatearVES(pagado)} Bs y el paquete cuesta ${formatearVES(precioReal)} Bs (faltan ${formatearVES(faltante)} Bs)`,
        queHacer: 'NO se recargó; el cliente completa la diferencia o pide la devolución por WhatsApp',
      });

      return res.status(400).json({
        status: "error",
        insuficiente: true,
        montoPagado: pagado,
        precioRequerido: precioReal,
        faltante: faltante,
        message: `Pago insuficiente: Encontramos ${formatearVES(pagado)} Bs, pero el paquete cuesta ${formatearVES(precioReal)} Bs. Faltan ${formatearVES(faltante)} Bs.`
      });
    }

    return await entregarRecarga(res, {
      FAZER_API_KEY, idPedido, id, paquete, numeroOro, precioReal, desc, comprobante,
      referencias: [referenciaCompleta], utilidades: { marcarReferencia, registrarEnHoja, informe, bloquearPago },
    });
  } catch (error) {
    console.error("Error crítico en la recarga de Blood Strike:", error.message);
    if (error instanceof ErrorExterno) {
      return res.status(503).json({ status: "error", message: "No pudimos confirmar tu pago a tiempo. Espera un minuto e intenta de nuevo; si te dice que ya fue utilizado, escríbenos por WhatsApp." });
    }
    return res.status(500).json({ status: "error", message: "Falla interna del servidor." });
  }
}

/**
 * Completar un pago insuficiente: POST { tokenComplemento, referencia (últimos 5 del nuevo pago) }.
 * La clave solo sirve para el pedido que la generó: el jugador, el paquete y el precio salen de la
 * pestaña "por_completar" de la hoja de Blood Strike (el navegador no puede cambiarlos).
 * usar_complemento corre con el candado de bloodstrike.gs: si dos dispositivos lo intentan a la vez,
 * solo uno avanza; el pago nuevo queda "En proceso" o "Por completar" y nunca vuelve a "Verificado".
 */
async function completarPago(req, res) {
  try {
    const clave = String(req.body?.tokenComplemento ?? '');
    const referencia = String(req.body?.referencia ?? '');
    if (!CLAVE_COMPLEMENTO.test(clave) || !/^\d{5}$/.test(referencia)) {
      return res.status(400).json({ status: "error", message: "Escribe los últimos 5 dígitos de la referencia del pago que hiciste para completar." });
    }

    const URL_GOOGLE_SCRIPT = process.env.SCRIPT_BLOOD;
    const FAZER_API_KEY = process.env.FAZER_API_KEY;
    if (!URL_GOOGLE_SCRIPT || !FAZER_API_KEY) {
      return faltaConfiguracion(res, ["SCRIPT_BLOOD", "FAZER_API_KEY"].filter((v) => !process.env[v]),
        { status: "error", message: "No podemos completar tu pago en este momento. Escríbenos por WhatsApp con tus referencias." });
    }

    const claveHash = huella(clave);
    // Intentos fallidos por IP y por clave (frena probar referencias al azar)
    const clavesLimite = [`ip:${obtenerIp(req)}`, `completar:bs:${claveHash.slice(0, 24)}`];
    const minutosEspera = await minutosBloqueado(clavesLimite);
    if (minutosEspera > 0) {
      return res.status(429).json({ status: "error", message: `Demasiados intentos fallidos. Espera ${minutosEspera} minutos para volver a intentar.` });
    }

    const idPedido = randomUUID();
    let datos;
    try {
      // Se puede repetir: bloodstrike.gs guarda la respuesta de este idPedido
      datos = await llamarScript(URL_GOOGLE_SCRIPT, { accion: "usar_complemento", claveHash, referencia, idPedido }, TIEMPOS.idempotente);
    } catch (error) {
      // El pago nuevo pudo quedar "En proceso": se bloquea (solo el que tomó ESTE pedido) y va a revisión
      const bloqueo = await llamarScript(URL_GOOGLE_SCRIPT, { accion: "bloquear_pedido", idPedido }, { reintentos: 2, tiempoMs: TIEMPOS.incidente, reintentarTrasTimeout: true }).catch(() => null);
      console.error(`❌ [${FASES.verificacion}] usar_complemento de Blood Strike sin respuesta: ${error.message}`);
      const { registrarEnHoja, informe } = crearUtilidadesPedido({
        urlScript: URL_GOOGLE_SCRIPT, idPedido, tiempoIncidenteMs: TIEMPOS.incidente,
        datosInforme: { idPedido, idJugador: 'ver pestaña "por_completar"', paquete: 'pago por completar', referenciaCliente: referencia, comprobante: 'Sin comprobante', noAplica: true },
      });
      await registrarEnHoja(informe({
        fase: FASES.verificacion,
        motivo: `Apps Script de Blood Strike no respondió al completar un pago (usar_complemento): ${error.message}. Revisar la pestaña "por_completar" (clave ${claveHash.slice(0, 12)}…)`,
        estadoPago: bloqueo?.referencia ? `BLOQUEADO ("Usado", referencia ${bloqueo.referencia}): completar la recarga a mano` : 'SIN CONFIRMAR: revisar la pestaña "por_completar"',
      }));
      return res.status(202).json({ status: "error", message: "Fallo técnico momentáneo. Tu pago quedó registrado y la recarga está en revisión: escríbenos por WhatsApp con tus referencias." });
    }

    if (datos?.status !== 'success' || !datos.valido) {
      await registrarFallo(clavesLimite);
      return res.status(400).json({ status: "error", complementoInvalido: true, message: datos?.message || "No pudimos completar este pago. Escríbenos por WhatsApp con tus referencias." });
    }
    if (!datos.encontrado) {
      await registrarFallo(clavesLimite);
      return res.status(400).json({ status: "error", message: datos.message || "Pago no encontrado o ya utilizado." });
    }
    if (!datos.completo) {
      const falta = Number(datos.falta) || 0;
      return res.status(400).json({
        status: "error", insuficiente: true, tokenComplemento: clave,
        montoPagado: Number(datos.pagadoTotal) || 0, precioRequerido: Number(datos.precio) || 0, faltante: falta,
        message: `Pago insuficiente: con este pago llevas ${formatearVES(Number(datos.pagadoTotal) || 0)} Bs y faltan ${formatearVES(falta)} Bs. Paga la diferencia y escribe la nueva referencia.`,
      });
    }

    // Pago completo: los datos del pedido salen de la hoja (se validan igual que en recargar)
    const id = String(datos.idJugador || '');
    const paquete = String(datos.paquete || '');
    const referencias = Array.isArray(datos.referencias) ? datos.referencias.map(String).filter((r) => /^\d{5,30}$/.test(r)) : [];
    const precioReal = limpiarMontoVES(datos.precio);
    const numeroOro = clavePaquete(paquete);
    if (!/^\d{5,15}$/.test(id) || !PAQUETE_VALIDO.test(paquete) || !numeroOro || !referencias.length || !(precioReal > 0)) {
      console.error(`❌ usar_complemento de Blood Strike devolvió datos inválidos para el pedido ${idPedido}: ${JSON.stringify(datos).slice(0, 300)}`);
      return res.status(202).json({ status: "error", message: "Fallo técnico momentáneo. Tu pago quedó registrado y la recarga está en revisión: escríbenos por WhatsApp con tus referencias." });
    }
    const comprobante = textoParaHoja(datos.comprobante || "Sin comprobante");
    const utilidades = crearUtilidadesPedido({
      urlScript: URL_GOOGLE_SCRIPT, idPedido, tiempoIncidenteMs: TIEMPOS.incidente,
      datosInforme: { idPedido, idJugador: id, paquete, referenciaCliente: referencia, comprobante, noAplica: true },
    });
    console.info(`🧩 Pago de Blood Strike completado (${referencias.join(' + ')}) para el pedido ${datos.idPedidoOriginal} -> ${idPedido} (ID ${id})`);

    return await entregarRecarga(res, {
      FAZER_API_KEY, idPedido, id, paquete, numeroOro, precioReal,
      desc: datos.codigoDescuento ? { codigo: String(datos.codigoDescuento) } : null,
      comprobante, referencias, utilidades,
    });
  } catch (error) {
    console.error("Error crítico al completar un pago de Blood Strike:", error.message);
    if (error instanceof ErrorExterno) {
      return res.status(503).json({ status: "error", message: "No pudimos confirmar tu pago a tiempo. Espera un minuto e intenta de nuevo; si persiste, escríbenos por WhatsApp." });
    }
    return res.status(500).json({ status: "error", message: "Falla interna del servidor." });
  }
}
