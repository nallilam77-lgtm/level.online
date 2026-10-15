// Free Fire: precios, verificación de ID y recarga. Cómo se entrega lo decide el modo del menú
// "🖐️ Recargas Free Fire" de la hoja (recargas.gs): manual ("sin_codigo"), pines + bot de Railway,
// o API de FazerCards (pestaña "fazer_card", con el estado en tiempo real vía api/fazer-webhook.js).
// Lo usan api/juego.js (acciones precios y verificar) y api/recargar.js (recargar).
import { randomUUID } from 'node:crypto';
import { obtenerIp, minutosBloqueado, registrarFallo } from '../limitador.js';
import { llamarScript, LECTURA_APPS_SCRIPT, conCache, catalogoValido, cabecerasCachePrecios, ErrorExterno } from '../externo.js';
import { PAQUETE_VALIDO, textoParaHoja, faltaConfiguracion } from '../validacion.js';
import { FASES, ESTADO_PINES } from '../reporte.js';
import { formatearVES, limpiarMontoVES, crearUtilidadesPedido } from '../recarga-comun.js';
import { crearAccionDescuento, aplicarDescuentoARecarga } from '../descuentos.js';
import { crearOrdenFazer } from '../fazer.js';

// Tiempos (maxDuration de api/recargar.js = 180 s en vercel.json). Peor caso con fallo del bot:
// precios 8 + verificar 32 + códigos 32 + bot 45 + devolver pines 15 + registrar 12 + marcar 12 = 156 s
// Peor caso con éxito: precios 12 + verificar 32 + códigos 32 + bot 45 + marcar 12 + finalizado 12 + aviso 12 = 157 s
// Peor caso por FazerCards: precios 12 + verificar 32 + códigos 32 + fazer 40 + marcar 12 + finalizado 12 + aviso 12 = 152 s
const TIEMPOS = {
  // verificar_pago y obtener_codigo: hasta 3 intentos de 15 s dentro de 32 s
  idempotente: { tiempoMs: 32000, intentoMs: 15000, reintentos: 2, reintentarTrasTimeout: true },
  // Apps Script anterior (sin idPedido): un solo intento largo, nunca se repite
  sinIdempotencia: { tiempoMs: 20000 },
  bot: 45000,
  // La orden de FazerCards NUNCA se reintenta: repetirla podría recargar dos veces
  fazer: 40000,
  devolver: { tiempoMs: 15000, intentoMs: 10000, reintentos: 1, reintentarTrasTimeout: true },
  incidente: 12000,
};
const RAILWAY_URL = "https://bot-levelup-production.up.railway.app/canjear";

// Modo API (FazerCards): categoría y offer_id de cada paquete (clave del paquete -> offer_id).
// Un paquete sin offer_id aquí NO se envía a la API: va a "sin_codigo" para hacerlo a mano.
// Para ver los valores reales: node scripts/ofertas-fazer.mjs (con FAZER_API_KEY).
const CATEGORIA_FAZER = "free_fire_latam";
const OFERTAS_FAZER = {
  "110": "110_diamonds",
  "341": "341_diamonds",
  "572": "572_diamonds",
  "1166": "1166_diamonds",
  "2398": "2398_diamonds",
  "6160": "6160_diamonds",
  "semanal_lite": "weekly_lite",
  "semanal": "weekly_membership",
  "mensual": "monthly_membership",
};

// Clave de un paquete, igual que clavePaquete() de recargas.gs: "110 Diamantes" -> "110";
// las tarjetas se reconocen por el nombre de su columna en "precios" ("Tarjeta semanal",
// "Semanal Lite", "Tarjeta mensual"; también en inglés) -> "semanal", "semanal_lite", "mensual".
function clavePaquete(texto) {
  const t = String(texto ?? '').toLowerCase();
  if (/semanal|weekly/.test(t)) return /lite/.test(t) ? 'semanal_lite' : 'semanal';
  if (/mensual|monthly/.test(t)) return 'mensual';
  return t.replace(/[^0-9]/g, '');
}
// Clave del ID del jugador en "fields" (la que muestra el script de ofertas para Free Fire)
const CAMPO_JUGADOR_FAZER = "player_id";
// Errores de conexión en los que la petición NUNCA llegó al bot: es seguro reintentar
const CONEXION_NO_ESTABLECIDA = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']);
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// IDs ya validados (por instancia de Vercel): el mismo jugador suele verificar su ID varias veces
// mientras compra, y así solo la primera consulta espera a Apps Script. Solo se guardan los válidos.
const VALIDOS_MS = 10 * 60 * 1000;
const MAX_VALIDOS = 5000;
const validados = new Map();

// =========================================================================
// ACCIONES DE api/juego.js
// =========================================================================

async function precios(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ status: "error", message: "Método no permitido" });

  const URL_GOOGLE_SCRIPT = process.env.SCRIPT_RECARGAS_URL;
  if (!URL_GOOGLE_SCRIPT) {
    return faltaConfiguracion(res, ["SCRIPT_RECARGAS_URL"], { status: "error", message: "Error al conectar con la hoja de precios." });
  }

  try {
    // Lectura sin efectos secundarios (20 s con 1 reintento). Con copia en caché el cliente no espera.
    const { datos } = await conCache('precios:ff',
      () => llamarScript(URL_GOOGLE_SCRIPT, { accion: "obtener_precios" }, LECTURA_APPS_SCRIPT),
      { esValido: catalogoValido });
    cabecerasCachePrecios(res);
    return res.status(200).json(datos);
  } catch (error) {
    console.error("Error al obtener precios de Free Fire:", error.message);
    return res.status(503).json({ status: "error", message: "Error al conectar con la hoja de precios." });
  }
}

async function verificar(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const { id } = req.body || {};

  // Mismo formato de ID que exige la recarga
  if (!/^\d{5,15}$/.test(String(id ?? ''))) {
    return res.status(400).json({ valid: false, message: "ID con formato inválido. Debe tener entre 5 y 15 números." });
  }

  const URL_VALIDADOR = process.env.SCRIPT_VALIDADOR_URL;
  if (!URL_VALIDADOR) {
    return faltaConfiguracion(res, ["SCRIPT_VALIDADOR_URL"], { valid: false, message: "El validador de IDs no está disponible. Intenta de nuevo en unos minutos." });
  }

  const guardado = validados.get(String(id));
  if (guardado && Date.now() - guardado.momento < VALIDOS_MS) {
    return res.status(200).json({ valid: true, player_name: guardado.player_name });
  }

  try {
    const data = await llamarScript(URL_VALIDADOR, { id: String(id) }, LECTURA_APPS_SCRIPT);
    if (data?.valid === true) {
      validados.delete(String(id));
      validados.set(String(id), { player_name: data.player_name ? String(data.player_name).slice(0, 60) : undefined, momento: Date.now() });
      if (validados.size > MAX_VALIDOS) validados.delete(validados.keys().next().value);
    }

    // Solo se devuelven los campos que usa la página, nunca la respuesta cruda de Apps Script
    return res.status(200).json({
      valid: data?.valid === true,
      player_name: data?.valid === true && data.player_name ? String(data.player_name).slice(0, 60) : undefined
    });
  } catch (error) {
    console.error("Error al verificar ID de Free Fire:", error.message);
    if (error.name === 'ErrorExterno') {
      return res.status(503).json({ valid: false, message: "El validador de IDs está lento. Intenta de nuevo en unos segundos." });
    }
    return res.status(500).json({ valid: false, message: "Error en el servidor" });
  }
}

// Catálogo de Free Fire para la acción "descuento" (misma caché que la acción precios)
async function catalogoFreeFire() {
  const { datos } = await conCache('precios:ff',
    () => llamarScript(process.env.SCRIPT_RECARGAS_URL, { accion: "obtener_precios" }, LECTURA_APPS_SCRIPT),
    { esValido: catalogoValido });
  return datos.catalogo;
}

export const acciones = { precios, verificar, descuento: crearAccionDescuento('Free Fire', catalogoFreeFire) };

// =========================================================================
// RECARGA (api/recargar.js)
// =========================================================================

/**
 * Envía los pines al bot de Railway y clasifica el resultado:
 *  - ok:          el bot canjeó todo.
 *  - fallo_bot:   el bot respondió que falló e indica qué pines canjeó y cuáles no.
 *  - no_procesado: la petición nunca llegó a procesarse (conexión rechazada, servicio caído,
 *                 clave rechazada, datos rechazados): ningún pin se canjeó.
 *  - incierto:    el bot no respondió a tiempo o la conexión se cortó a mitad: pudo canjear.
 * Solo se reintenta cuando es seguro (no_procesado por conexión o 503), dentro de 45 s.
 */
async function canjearEnBot({ pines, idJugador, secreto }) {
  const limite = Date.now() + TIEMPOS.bot;
  let intentos = 0;
  while (true) {
    intentos++;
    const restante = limite - Date.now();
    const controlador = new AbortController();
    const temporizador = setTimeout(() => controlador.abort(), restante);
    let resultado;
    try {
      const respuesta = await fetch(RAILWAY_URL, {
        method: "POST",
        // El bot (bot-levelup/main.py, POST /canjear) lee SOLO la cabecera "x-secret-token"
        // y la compara con su variable WEBHOOK_SECRET en Railway. Deben ser idénticas.
        headers: { "Content-Type": "application/json", "x-secret-token": secreto },
        body: JSON.stringify({ pins: pines, player_id: idJugador }),
        signal: controlador.signal
      });
      const texto = await respuesta.text();
      let datos = null;
      try { datos = JSON.parse(texto); } catch (e) { /* respuesta no JSON */ }

      if (respuesta.status === 401 || respuesta.status === 403) {
        return { tipo: 'no_procesado', intentos, motivo: `El bot rechazó la autenticación (HTTP ${respuesta.status}): RAILWAY_SECRET en Vercel no coincide con WEBHOOK_SECRET del bot en Railway. El bot no intentó canjear ningún pin.` };
      }
      if (datos && datos.status === 'success') {
        return { tipo: 'ok', intentos, usados: datos.pines_exitosos?.length ? datos.pines_exitosos : pines };
      }
      if (datos && datos.status === 'error') {
        const usados = Array.isArray(datos.pines_exitosos) ? datos.pines_exitosos : [];
        const pendientes = Array.isArray(datos.pines_pendientes) ? datos.pines_pendientes : pines.filter((p) => !usados.includes(p));
        return { tipo: 'fallo_bot', intentos, usados, pendientes, motivo: `El bot respondió con error: ${datos.detail || datos.error || 'sin detalle'}` };
      }
      if (respuesta.status === 503) {
        resultado = { tipo: 'no_procesado', reintentable: true, motivo: `Railway respondió HTTP 503 (servicio del bot no disponible o reiniciándose). El bot no procesó la petición.` };
      } else if (respuesta.status >= 400 && respuesta.status < 500) {
        return { tipo: 'no_procesado', intentos, motivo: `El bot rechazó la petición (HTTP ${respuesta.status}) antes de canjear: ${texto.slice(0, 200)}` };
      } else {
        return { tipo: 'incierto', intentos, motivo: `Respuesta inesperada del bot (HTTP ${respuesta.status}): ${texto.slice(0, 200) || 'vacía'}. No se puede confirmar si canjeó los pines.` };
      }
    } catch (error) {
      // Con varias direcciones (IPv4/IPv6) Node agrupa los errores en cause.errors
      const codigo = error.cause?.code || error.cause?.errors?.[0]?.code || error.code;
      if (error.name === 'AbortError') {
        return { tipo: 'incierto', intentos, motivo: `El bot no respondió en ${Math.round(TIEMPOS.bot / 1000)} s (tiempo agotado tras ${intentos} intento(s)). Pudo haber canjeado los pines antes del corte.` };
      }
      if (CONEXION_NO_ESTABLECIDA.has(codigo)) {
        resultado = { tipo: 'no_procesado', reintentable: true, motivo: `No se pudo conectar con el bot de Railway (${codigo}). La petición nunca llegó al bot.` };
      } else {
        return { tipo: 'incierto', intentos, motivo: `Se cortó la conexión con el bot a mitad de la petición (${codigo || error.message}). No se puede confirmar si canjeó los pines.` };
      }
    } finally {
      clearTimeout(temporizador);
    }
    // Reintento seguro: espera creciente (1 s, 2 s) si todavía queda tiempo
    const espera = intentos * 1000;
    if (!resultado.reintentable || intentos >= 3 || limite - Date.now() < espera + 5000) {
      return { ...resultado, intentos, motivo: `${resultado.motivo} (tras ${intentos} intento(s))` };
    }
    await esperar(espera);
  }
}

export async function recargar(req, res) {
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

    const URL_GOOGLE_SCRIPT = process.env.SCRIPT_RECARGAS_URL;
    // trim(): al pegar el valor en Vercel es fácil que se cuele un espacio o salto de línea,
    // y el bot lo rechaza con 401 aunque la clave "se vea" igual
    const RAILWAY_SECRET = (process.env.RAILWAY_SECRET || "").trim();
    // Opcional: sin ella, en modo API los pedidos van a "sin_codigo" (recarga manual)
    const FAZER_API_KEY = (process.env.FAZER_API_KEY || "").trim();

    // Sin secreto no se puede autenticar con el bot: se aborta antes de tocar pagos o códigos
    if (!URL_GOOGLE_SCRIPT || !RAILWAY_SECRET) {
      return faltaConfiguracion(res, ["SCRIPT_RECARGAS_URL", "RAILWAY_SECRET"].filter((v) => !(process.env[v] || "").trim()),
        { status: "error", message: "Las recargas automáticas no están disponibles en este momento. No realices el pago todavía; escríbenos por WhatsApp." });
    }

    // Identificador único del pedido: con recargas.gs v2 hace idempotentes verificar_pago y
    // obtener_codigo (repetir la petición devuelve el mismo pago y los MISMOS pines) y enlaza
    // el pedido con la pestaña "asignaciones_pines".
    const idPedido = randomUUID();
    const comprobante = urlImagen && urlImagen.trim() !== "" ? urlImagen : "Sin comprobante";

    const { marcarReferencia, registrarEnHoja, informe, bloquearPago } = crearUtilidadesPedido({
      urlScript: URL_GOOGLE_SCRIPT, idPedido, tiempoIncidenteMs: TIEMPOS.incidente,
      datosInforme: { idPedido, idJugador: id, paquete, referenciaCliente: referencia, comprobante },
    });

    // Antes de consultar la hoja de pagos: ¿esta IP o este jugador acumula demasiados fallos?
    const clavesLimite = [`ip:${obtenerIp(req)}`, `jugador:ff:${id}`];
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
      ({ datos: dataPrecios } = await conCache('precios:ff',
        () => llamarScript(URL_GOOGLE_SCRIPT, { accion: "obtener_precios" }, { reintentos: 2, intentoMs: 8000, tiempoMs: 12000, reintentarTrasTimeout: true }),
        { esValido: catalogoValido, respaldoMs: 0 }));
    } catch (error) {
      console.error(`❌ [${FASES.precios}] ${error.message}`);
      return res.status(503).json({ status: "error", message: "Error al leer la base de datos de precios. Intenta de nuevo en un momento." });
    }

    // recargas.gs v2 anuncia "version: 2" en los precios: solo entonces es seguro reintentar
    // verificar_pago y obtener_codigo después de un timeout
    const scriptV2 = Number(dataPrecios.version) >= 2;
    const opcionesCriticas = scriptV2 ? TIEMPOS.idempotente : TIEMPOS.sinIdempotencia;

    const numeroDiamantes = clavePaquete(paquete);
    const paqueteGsheet = numeroDiamantes && dataPrecios.catalogo.find(p => clavePaquete(p.diamantes) === numeroDiamantes);
    if (!paqueteGsheet) {
      await registrarFallo(clavesLimite);
      return res.status(400).json({ status: "error", message: "Paquete inválido o manipulado." });
    }
    const precioLista = limpiarMontoVES(paqueteGsheet.precio);

    // Descuento opcional: se vuelve a consultar el código (pudo desactivarse) antes de tocar el pago
    const descuento = await aplicarDescuentoARecarga(req.body?.codigoDescuento, precioLista);
    if (descuento.error) return res.status(descuento.error.codigo).json(descuento.error.cuerpo);
    const { desc, precio: precioReal } = descuento;

    // ==========================================
    // FASE 2: BUSCAR PAGO Y VERIFICAR
    // ==========================================
    let dataVerificacion;
    try {
      dataVerificacion = await llamarScript(URL_GOOGLE_SCRIPT,
        { accion: "verificar_pago", referencia: referencia, monto: precioReal, idPedido }, opcionesCriticas);
    } catch (error) {
      // El pago pudo quedar "En proceso" en la hoja: NUNCA se libera, se marca "Usado" (bloquear_pedido
      // solo toca el pago que bloqueó ESTE pedido) y la recarga pasa a revisión manual.
      const bloqueo = scriptV2
        ? await llamarScript(URL_GOOGLE_SCRIPT, { accion: "bloquear_pedido", idPedido }, { reintentos: 2, tiempoMs: TIEMPOS.incidente, reintentarTrasTimeout: true }).catch(() => null)
        : null;
      const sinBloquearNada = bloqueo?.status === 'success' && !bloqueo.referencia;
      let estadoPago = `SIN CONFIRMAR: si la fila del pago (referencia terminada en ${referencia}) quedó "En proceso", márcala "Usado" y haz la recarga a mano`;
      if (bloqueo?.status === 'success') {
        estadoPago = sinBloquearNada
          ? 'SIN CAMBIOS: este pedido no llegó a tomar ningún pago; el cliente puede reintentar'
          : `BLOQUEADO ("Usado", referencia ${bloqueo.referencia}): la recarga NO se entregó; hacerla a mano`;
      }
      console.error(`❌ [${FASES.verificacion}] ${error.message}`);
      await registrarEnHoja(informe({ fase: FASES.verificacion, motivo: `Apps Script no respondió a verificar_pago: ${error.message}`, sinPines: true, estadoPago }));
      if (sinBloquearNada) {
        return res.status(503).json({ status: "error", message: "No pudimos confirmar tu pago a tiempo. Espera un minuto e intenta de nuevo." });
      }
      // "fallo técnico": la página muestra el modal de "recarga en revisión"
      return res.status(202).json({ status: "error", message: "Fallo técnico momentáneo. Si tu pago es válido, quedó registrado y la recarga está en revisión: escríbenos por WhatsApp con tu referencia." });
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
      // El pago queda "Usado": el cliente completa la diferencia o pide la devolución por WhatsApp
      await bloquearPago(referenciaCompleta, {
        fase: FASES.verificacion, sinPines: true,
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

    // ==========================================
    // FASE 3: EXTRAER LOS CÓDIGOS DE LA HOJA
    // ==========================================
    let dataCodigos;
    try {
      // manualSiNoHay: si no hay pines del paquete, recargas.gs anota el pedido en la pestaña
      // "sin_codigo" para hacerlo a mano y responde { manual: true } (al cliente: recarga exitosa)
      dataCodigos = await llamarScript(URL_GOOGLE_SCRIPT, {
        accion: "obtener_codigo", diamantes: numeroDiamantes, idPedido, referencia: referenciaCompleta,
        manualSiNoHay: true, idJugador: String(id), paquete: textoParaHoja(String(paquete)), montoCobrado: precioReal, comprobante,
        // Modo API: con qué oferta se pediría a FazerCards (vacía = no se puede, va a "sin_codigo")
        ofertaFazer: FAZER_API_KEY ? (OFERTAS_FAZER[numeroDiamantes] || "") : "",
        ...(desc && { codigoDescuento: desc.codigo }),
      }, opcionesCriticas);
    } catch (error) {
      console.error(`⚠️ [${FASES.codigos}] ${error.message} | REF: ${referenciaCompleta}`);
      // Con v2 sabemos exactamente qué pines se asignaron a este pedido: como el bot nunca los
      // recibió, se devuelven al inventario. Sin v2 no hay forma de saberlo.
      let detallePines;
      let queHacer = 'la recarga NO se entregó; hacerla a mano';
      if (scriptV2) {
        const devolucion = await llamarScript(URL_GOOGLE_SCRIPT,
          { accion: "devolver_codigos", idPedido, motivo: `obtener_codigo sin respuesta: ${error.message}` }, TIEMPOS.devolver)
          .catch((e) => ({ status: 'error', message: e.message }));
        if (devolucion?.status === 'success') {
          detallePines = devolucion.pines?.length
            ? { pinesNoUsados: devolucion.pines, estadoNoUsados: ESTADO_PINES.devueltos }
            : { sinPines: true };
          // El pedido se quedó en "sin_codigo": hacerlo desde ahí
          if (devolucion.manual) queHacer = 'el pedido está en la pestaña "sin_codigo": hacer la recarga a mano desde ahí';
          // Modo API: la orden NO se envió a FazerCards (quedó "NO ENVIADO" en "fazer_card")
          if (devolucion.api) queHacer = 'la orden NO se envió a FazerCards (pestaña "fazer_card"): hacer la recarga a mano';
        } else {
          detallePines = { pinesNoUsados: [`consultar la pestaña "asignaciones_pines", pedido ${idPedido}`], estadoNoUsados: `${ESTADO_PINES.noDevueltos} (Apps Script tampoco respondió a la devolución: ${devolucion?.message})` };
        }
      } else {
        detallePines = { pinesNoUsados: ['desconocidos'], estadoNoUsados: 'NO SE PUEDE SABER: el Apps Script instalado no registra asignaciones de pines; actualiza a recargas.gs v2' };
      }

      // El pago NUNCA se libera: se bloquea y la recarga pasa a revisión manual
      await bloquearPago(referenciaCompleta, { fase: FASES.codigos, motivo: `Apps Script no respondió a obtener_codigo: ${error.message}`, ...detallePines, queHacer });
      return res.status(202).json({ status: "error", message: "Fallo técnico momentáneo. Tu pago está verificado y la recarga quedó en revisión." });
    }

    // Sin pines: el pedido quedó en "sin_codigo" para hacerlo a mano; se cierra igual que una recarga
    const manual = dataCodigos?.status === "success" && dataCodigos.manual === true;
    if (manual) console.info(`📝 Sin pines de ${numeroDiamantes}: pedido ${idPedido} (ID ${id}) anotado en "sin_codigo" para recarga manual`);
    // Modo API: el pedido quedó en "fazer_card" y la recarga la hace FazerCards
    const porApi = dataCodigos?.status === "success" && dataCodigos.api === true;

    if (!manual && !porApi && (!dataCodigos || dataCodigos.status !== "success" || !Array.isArray(dataCodigos.pines) || !dataCodigos.pines.length)) {
      // Apps Script anterior (sin "sin_codigo") o error: no salió ningún pin; el pago se bloquea igual
      await bloquearPago(referenciaCompleta, {
        fase: FASES.codigos, sinPines: true,
        motivo: `Apps Script no entregó códigos: ${dataCodigos?.message || 'respuesta sin pines'}`,
        queHacer: 'la recarga NO se entregó; hacerla a mano',
      });
      return res.status(202).json({ status: "error", message: "Fallo técnico momentáneo. Tu pago está verificado y la recarga quedó en revisión." });
    }

    const pinesExtraidos = manual || porApi ? [] : dataCodigos.pines;

    // ==========================================
    // FASE 4 (modo API): ORDEN EN FAZERCARDS
    // ==========================================
    let ordenFazer = null;
    if (porApi) {
      const offerId = OFERTAS_FAZER[numeroDiamantes];
      const orden = offerId && FAZER_API_KEY
        ? await crearOrdenFazer({
          apiKey: FAZER_API_KEY, categoria: CATEGORIA_FAZER, offerId, campos: { [CAMPO_JUGADOR_FAZER]: String(id) },
          idempotencia: idPedido, tiempoMs: TIEMPOS.fazer,
        })
        // No debería pasar (sin oferta recargas.gs lo manda a "sin_codigo"); por si acaso, no se llama a la API
        : { tipo: 'rechazo', motivo: `El paquete ${numeroDiamantes} no tiene offer_id en OFERTAS_FAZER o falta FAZER_API_KEY. No se llamó a la API.` };

      if (orden.tipo !== 'ok') {
        console.error(`❌ [${FASES.apiFreeFire}] ${orden.motivo} | REF: ${referenciaCompleta}`);
        // Registrar el incidente y LUEGO bloquear el pago (en orden, dentro de bloquearPago)
        await bloquearPago(referenciaCompleta, {
          fase: FASES.apiFreeFire, noAplica: true,
          motivo: orden.tipo === 'incierto'
            ? `${orden.motivo} Oferta ${offerId}. ANTES DE REPETIR: buscar en el panel de FazerCards si existe una orden para el jugador ${id}.`
            : `${orden.motivo} Oferta ${offerId}.`,
          queHacer: orden.tipo === 'incierto'
            ? 'confirmar la orden en FazerCards antes de repetir la recarga'
            : 'no se cobró nada en FazerCards; hacer la recarga a mano con el ID correcto o devolver el pago',
        });
        // "fallo técnico": la página muestra el modal de "recarga en revisión"
        return res.status(202).json({ status: "error", message: "Fallo técnico con el proveedor. Tu pago está verificado y la recarga quedó en revisión." });
      }
      ordenFazer = orden.orden;
      console.info(`🛒 FazerCards: orden ${ordenFazer.id} (${ordenFazer.status}) para el pedido ${idPedido} (ID ${id})`);
    }

    // ==========================================
    // FASE 4: CANJE EN EL BOT DE RAILWAY (no aplica a una recarga manual)
    // ==========================================
    const bot = manual || porApi
      ? { tipo: 'ok', usados: [] }
      : await canjearEnBot({ pines: pinesExtraidos, idJugador: id, secreto: RAILWAY_SECRET });

    if (bot.tipo !== 'ok') {
      console.error(`❌ [${FASES.botFreeFire}] ${bot.motivo} | REF: ${referenciaCompleta}`);
      let detallePines;
      if (bot.tipo === 'no_procesado') {
        // El bot no tocó ningún pin: se devuelven al inventario (v2) para no perderlos
        const devolucion = scriptV2
          ? await llamarScript(URL_GOOGLE_SCRIPT, { accion: "devolver_codigos", idPedido, motivo: bot.motivo }, TIEMPOS.devolver)
              .catch((e) => ({ status: 'error', message: e.message }))
          : { status: 'error', message: 'el Apps Script instalado no tiene la acción devolver_codigos (actualiza a recargas.gs v2)' };
        detallePines = devolucion?.status === 'success'
          ? { pinesNoUsados: pinesExtraidos, estadoNoUsados: ESTADO_PINES.devueltos }
          : { pinesNoUsados: pinesExtraidos, estadoNoUsados: `${ESTADO_PINES.noDevueltos} (${devolucion?.message})` };
      } else if (bot.tipo === 'fallo_bot') {
        detallePines = { pinesUsados: bot.usados, pinesNoUsados: bot.pendientes, estadoNoUsados: ESTADO_PINES.retenidos };
      } else {
        detallePines = { pinesNoUsados: pinesExtraidos, estadoNoUsados: ESTADO_PINES.inciertos };
      }

      // 📝 ANOTAR EL INCIDENTE Y LUEGO 🔥 QUEMAR EL PAGO (en orden, dentro de bloquearPago)
      await bloquearPago(referenciaCompleta, {
        fase: FASES.botFreeFire, motivo: bot.motivo, ...detallePines,
        queHacer: 'la recarga NO se completó; entregarla manualmente al jugador',
      });

      // El mensaje contiene "fallo técnico": la página muestra el modal de "recarga en proceso"
      return res.status(400).json({
        status: "error",
        message: "Fallo técnico del bot. Pines respaldados correctamente en hoja de errores."
      });
    }

    // ==========================================
    // FASE 5: QUEMAR EL PAGO Y GUARDAR EN FINALIZADOS (en orden)
    // ==========================================
    // La recarga YA se hizo: aunque Apps Script falle aquí, al cliente se le responde éxito.
    // Una tras otra, NO en paralelo: las dos esperan el mismo candado de recargas.gs y, cuando
    // registrar_finalizado (con código de descuento) lo retenía, marcar_usado se quedaba "ocupado"
    // y el pago no pasaba a "Usado" aunque la recarga quedara en finalizados.
    const pagoMarcado = await marcarReferencia("marcar_usado", referenciaCompleta);
    const finalizadoGuardado = await registrarEnHoja({
      accion: "registrar_finalizado",
      idJugador: id,
      paquete: paquete,
      referencias: referenciaCompleta,
      codigosUsados: manual ? 'SIN CÓDIGO: recarga manual pendiente (pestaña "sin_codigo")'
        : porApi ? `API FazerCards (orden ${ordenFazer.id || 'sin id'})` : pinesExtraidos.join(" | "),
      // recargas.gs guarda la orden y su estado en la pestaña "fazer_card"
      ...(porApi && { ordenFazer: ordenFazer.id, estadoFazer: ordenFazer.status }),
      urlImagen: comprobante,
      idPedido,
      // recargas.gs suma +1 uso y el monto cobrado al código en la pestaña "Descuentos"
      ...(desc && { codigoDescuento: desc.codigo, montoCobrado: precioReal })
    });
    if (!pagoMarcado || !finalizadoGuardado) {
      const pendiente = [
        !pagoMarcado && 'marcar el pago como "Usado"',
        !finalizadoGuardado && 'anotar la recarga en "finalizados"',
        // registrar_finalizado es quien suma el uso del código: sin él, el creador pierde esa comisión
        !finalizadoGuardado && desc && `anotar el uso del código ${desc.codigo} (${precioReal} Bs, pedido ${idPedido}) en "Descuentos"`,
      ].filter(Boolean).join(' y ');
      await registrarEnHoja(informe({
        fase: FASES.cierre,
        motivo: manual
          ? `Recarga MANUAL (anotada en "sin_codigo"), pero Apps Script no respondió al cierre: falta ${pendiente}`
          : porApi
            ? `FazerCards aceptó la orden ${ordenFazer.id}, pero Apps Script no respondió al cierre: falta ${pendiente} (y anotar la orden en "fazer_card")`
            : `La recarga SÍ se entregó, pero Apps Script no respondió al cierre: falta ${pendiente}`,
        referenciaCompleta, pinesUsados: bot.usados, noAplica: porApi,
        estadoPago: pagoMarcado ? 'USADO (correcto)' : `SIN CONFIRMAR: marcar a mano como "Usado" la referencia ${referenciaCompleta}`,
      }));
    }

    return res.status(200).json({ status: "success", message: "Recarga procesada exitosamente con Level Up Bot." });

  } catch (error) {
    console.error("Error crítico en la recarga de Free Fire:", error.message);
    if (error instanceof ErrorExterno) {
      return res.status(503).json({ status: "error", message: "No pudimos confirmar tu pago a tiempo. Espera un minuto e intenta de nuevo; si te dice que ya fue utilizado, escríbenos por WhatsApp." });
    }
    return res.status(500).json({ status: "error", message: "Falla interna del servidor." });
  }
}
