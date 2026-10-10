// Free Fire: precios, verificación de ID y recarga (pines del inventario + bot de Railway).
// Lo usan api/juego.js (acciones precios y verificar) y api/recargar.js (recargar).
import { randomUUID } from 'node:crypto';
import { obtenerIp, minutosBloqueado, registrarFallo } from '../limitador.js';
import { llamarScript, LECTURA_APPS_SCRIPT, conCache, catalogoValido, cabecerasCachePrecios, ErrorExterno } from '../externo.js';
import { PAQUETE_VALIDO, textoParaHoja, faltaConfiguracion } from '../validacion.js';
import { FASES, ESTADO_PINES } from '../reporte.js';
import { formatearVES, limpiarMontoVES, crearUtilidadesPedido } from '../recarga-comun.js';
import { crearAccionDescuento, aplicarDescuentoARecarga } from '../descuentos.js';

// Tiempos (maxDuration de api/recargar.js = 180 s en vercel.json). Peor caso con fallo del bot:
// precios 8 + verificar 32 + códigos 32 + bot 45 + devolver pines 15 + registrar 12 + marcar 12 = 156 s
const TIEMPOS = {
  // verificar_pago y obtener_codigo: hasta 3 intentos de 15 s dentro de 32 s
  idempotente: { tiempoMs: 32000, intentoMs: 15000, reintentos: 2, reintentarTrasTimeout: true },
  // Apps Script anterior (sin idPedido): un solo intento largo, nunca se repite
  sinIdempotencia: { tiempoMs: 20000 },
  bot: 45000,
  devolver: { tiempoMs: 15000, intentoMs: 10000, reintentos: 1, reintentarTrasTimeout: true },
  incidente: 12000,
};
const RAILWAY_URL = "https://bot-levelup-production.up.railway.app/canjear";
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

    const { marcarReferencia, registrarEnHoja, informe } = crearUtilidadesPedido({
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

    const numeroDiamantes = String(paquete).replace(/[^0-9]/g, '');
    const paqueteGsheet = dataPrecios.catalogo.find(p => String(p.diamantes).replace(/[^0-9]/g, '') === numeroDiamantes);
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
      // El pago pudo quedar "En proceso" en la hoja: con v2 se libera solo este pedido
      const liberacion = scriptV2
        ? await llamarScript(URL_GOOGLE_SCRIPT, { accion: "liberar_pedido", idPedido }, { reintentos: 2, tiempoMs: TIEMPOS.incidente, reintentarTrasTimeout: true }).catch(() => null)
        : null;
      let estadoPago = `SIN CONFIRMAR: si la fila del pago (referencia terminada en ${referencia}) quedó "En proceso", cámbiala a "Verificado" o ejecuta liberarPagosAtascados`;
      if (liberacion?.status === 'success') {
        estadoPago = liberacion.liberado
          ? `LIBERADO (vuelve a "Verificado", referencia ${liberacion.referencia}): el cliente puede reintentar con la misma referencia`
          : 'SIN CAMBIOS: este pedido no llegó a bloquear ningún pago; el cliente puede reintentar';
      }
      console.error(`❌ [${FASES.verificacion}] ${error.message}`);
      await registrarEnHoja(informe({ fase: FASES.verificacion, motivo: `Apps Script no respondió a verificar_pago: ${error.message}`, sinPines: true, estadoPago }));
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
    // FASE 3: EXTRAER LOS CÓDIGOS DE LA HOJA
    // ==========================================
    let dataCodigos;
    try {
      dataCodigos = await llamarScript(URL_GOOGLE_SCRIPT,
        { accion: "obtener_codigo", diamantes: numeroDiamantes, idPedido, referencia: referenciaCompleta }, opcionesCriticas);
    } catch (error) {
      console.error(`⚠️ [${FASES.codigos}] ${error.message} | REF: ${referenciaCompleta}`);
      // Con v2 sabemos exactamente qué pines se asignaron a este pedido: como el bot nunca los
      // recibió, se devuelven al inventario. Sin v2 no hay forma de saberlo.
      let detallePines;
      let devolucionConfirmada = false;
      if (scriptV2) {
        const devolucion = await llamarScript(URL_GOOGLE_SCRIPT,
          { accion: "devolver_codigos", idPedido, motivo: `obtener_codigo sin respuesta: ${error.message}` }, TIEMPOS.devolver)
          .catch((e) => ({ status: 'error', message: e.message }));
        if (devolucion?.status === 'success') {
          devolucionConfirmada = true;
          detallePines = devolucion.pines?.length
            ? { pinesNoUsados: devolucion.pines, estadoNoUsados: ESTADO_PINES.devueltos }
            : { sinPines: true };
        } else {
          detallePines = { pinesNoUsados: [`consultar la pestaña "asignaciones_pines", pedido ${idPedido}`], estadoNoUsados: `${ESTADO_PINES.noDevueltos} (Apps Script tampoco respondió a la devolución: ${devolucion?.message})` };
        }
      } else {
        detallePines = { pinesNoUsados: ['desconocidos'], estadoNoUsados: 'NO SE PUEDE SABER: el Apps Script instalado no registra asignaciones de pines; actualiza a recargas.gs v2' };
      }

      if (devolucionConfirmada) {
        // Nada se entregó y ningún pin quedó fuera del inventario: el cliente puede reintentar
        const liberado = await marcarReferencia("marcar_verificado", referenciaCompleta);
        await registrarEnHoja(informe({
          fase: FASES.codigos, motivo: `Apps Script no respondió a obtener_codigo: ${error.message}`, referenciaCompleta, ...detallePines,
          estadoPago: liberado ? 'LIBERADO (vuelve a "Verificado"): el cliente puede reintentar con la misma referencia' : `SIN CONFIRMAR: no se pudo devolver a "Verificado"; la referencia ${referenciaCompleta} puede seguir "En proceso"`,
        }));
        return res.status(503).json({ status: "error", message: "No pudimos completar tu recarga en este momento. Tu pago NO se usó: intenta de nuevo en unos minutos." });
      }

      // No se sabe si salieron pines: se bloquea el pago y pasa a revisión manual.
      // EN ORDEN: registrar_error primero (los Apps Script anteriores devuelven el pago a
      // "Verificado" al registrar) y marcar_usado al final para que el pago quede bloqueado.
      await registrarEnHoja(informe({
        fase: FASES.codigos, motivo: `Apps Script no respondió a obtener_codigo: ${error.message}`, referenciaCompleta, ...detallePines,
        estadoPago: 'BLOQUEADO (se marca "Usado" justo después de este registro): la recarga NO se entregó; completarla manualmente',
      }));
      await marcarReferencia("marcar_usado", referenciaCompleta);
      return res.status(202).json({ status: "error", message: "Fallo técnico momentáneo. Tu pago está verificado y la recarga quedó en revisión." });
    }

    if (!dataCodigos || dataCodigos.status !== "success" || !Array.isArray(dataCodigos.pines) || !dataCodigos.pines.length) {
      // Sin stock o columna sin configurar: no salió ningún pin, el pago se libera
      const motivo = `Apps Script no entregó códigos: ${dataCodigos?.message || 'respuesta sin pines'}`;
      const liberado = await marcarReferencia("marcar_verificado", referenciaCompleta);
      await registrarEnHoja(informe({
        fase: FASES.codigos, motivo, referenciaCompleta, sinPines: true,
        estadoPago: liberado ? 'LIBERADO (vuelve a "Verificado"): el cliente puede reintentar cuando haya stock' : `SIN CONFIRMAR: no se pudo devolver a "Verificado"; la referencia ${referenciaCompleta} puede seguir "En proceso"`,
      }));
      return res.status(400).json({ status: "error", message: dataCodigos?.message || "No hay códigos disponibles para este paquete." });
    }

    const pinesExtraidos = dataCodigos.pines;

    // ==========================================
    // FASE 4: CANJE EN EL BOT DE RAILWAY
    // ==========================================
    const bot = await canjearEnBot({ pines: pinesExtraidos, idJugador: id, secreto: RAILWAY_SECRET });

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

      // 📝 ANOTAR EL INCIDENTE Y LUEGO 🔥 QUEMAR EL PAGO.
      // EN ORDEN, no en paralelo: los Apps Script anteriores devuelven el pago a "Verificado" al
      // registrar el error; marcar_usado debe ser SIEMPRE la última escritura.
      await registrarEnHoja(informe({
        fase: FASES.botFreeFire, motivo: bot.motivo, referenciaCompleta, ...detallePines,
        estadoPago: 'BLOQUEADO (se marca "Usado" justo después de este registro): la recarga NO se completó; entregarla manualmente al jugador',
      }));
      await marcarReferencia("marcar_usado", referenciaCompleta);

      // El mensaje contiene "fallo técnico": la página muestra el modal de "recarga en proceso"
      return res.status(400).json({
        status: "error",
        message: "Fallo técnico del bot. Pines respaldados correctamente en hoja de errores."
      });
    }

    // ==========================================
    // FASE 5: QUEMAR EL PAGO Y GUARDAR EN FINALIZADOS (en paralelo)
    // ==========================================
    // La recarga YA se hizo: aunque Apps Script falle aquí, al cliente se le responde éxito.
    const [pagoMarcado, finalizadoGuardado] = await Promise.all([
      marcarReferencia("marcar_usado", referenciaCompleta),
      registrarEnHoja({
        accion: "registrar_finalizado",
        idJugador: id,
        paquete: paquete,
        referencias: referenciaCompleta,
        codigosUsados: pinesExtraidos.join(" | "),
        urlImagen: comprobante,
        idPedido,
        // recargas.gs suma +1 uso y el monto cobrado al código en la pestaña "Descuentos"
        ...(desc && { codigoDescuento: desc.codigo, montoCobrado: precioReal })
      })
    ]);
    if (!pagoMarcado || !finalizadoGuardado) {
      const pendiente = [!pagoMarcado && 'marcar el pago como "Usado"', !finalizadoGuardado && 'anotar la recarga en "finalizados"'].filter(Boolean).join(' y ');
      await registrarEnHoja(informe({
        fase: FASES.cierre,
        motivo: `La recarga SÍ se entregó, pero Apps Script no respondió al cierre: falta ${pendiente}`,
        referenciaCompleta, pinesUsados: bot.usados,
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
