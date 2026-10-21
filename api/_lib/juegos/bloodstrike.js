// Blood Strike: precios y recarga directa por la API de Central One.
// Lo usan api/juego.js (acción precios) y api/recargar.js (recargar).
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { obtenerIp, minutosBloqueado, registrarFallo } from '../limitador.js';
import { pedirJSON, llamarScript, LECTURA_APPS_SCRIPT, conCache, catalogoValido, cabecerasCachePrecios, ErrorExterno } from '../externo.js';
import { PAQUETE_VALIDO, textoParaHoja, faltaConfiguracion } from '../validacion.js';
import { FASES } from '../reporte.js';
import { formatearVES, limpiarMontoVES, crearUtilidadesPedido, responderErrorInesperado } from '../recarga-comun.js';
import { crearAccionDescuento, aplicarDescuentoARecarga, registrarUsoDescuento } from '../descuentos.js';
import { datosParaPedido, crearPedidoCentralOne } from '../centralone.js';

// Tiempos (maxDuration de api/recargar.js = 180 s en vercel.json). Peor caso con respuesta incierta:
// precios 12 + verificar 32 + catálogo Central One 8 + pedido 40 + registrar 12 + marcar 12 = 116 s
const TIEMPOS = {
  // Solo si el Apps Script de Blood Strike anuncia "version: 2" (verificar_pago idempotente)
  idempotente: { tiempoMs: 32000, intentoMs: 15000, reintentos: 2, reintentarTrasTimeout: true },
  // Apps Script sin idPedido: un solo intento largo, nunca se repite
  sinIdempotencia: { tiempoMs: 20000 },
  // Pedido en Central One: dos intentos de 20 s con la misma Idempotency-Key (no cobra dos veces)
  centralOne: 40000,
  incidente: 12000,
};

// El product_id de Central One de cada paquete vive en la pestaña de precios (fila 3, la llena el menú
// "🩸 Blood Strike → 🔄 Traer productos de Central One" de bloodstrike.gs): obtener_precios lo manda
// como "producto". Nunca se envía al navegador (ver sinProducto).
const PRODUCTO_VALIDO = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sinProducto = ({ producto, ...paquete }) => paquete;

// Paquete del catálogo que corresponde a lo que pidió el cliente. Si dos columnas dan la misma clave
// (p. ej. dos nombres que se reducen a "105") no se sabe cuál comprar: { repetido: true }.
function buscarPaquete(catalogo, clave) {
  const iguales = clave ? catalogo.filter((p) => clavePaquete(p.diamantes || p.paquete) === clave) : [];
  return { paquete: iguales[0] || null, repetido: iguales.length > 1 };
}
const productoDe = (paquete) => (PRODUCTO_VALIDO.test(String(paquete?.producto || '')) ? String(paquete.producto) : '');

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
// Si cambia, cambiar igual clavePaqueteBlood de apps-script/bloodstrike.gs (quita los repetidos al traer productos).
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
    return res.status(200).json({ ...datos, catalogo: datos.catalogo.map(sinProducto) });
  } catch (error) {
    console.error("Error al obtener precios de Blood Strike:", error.message);
    return res.status(503).json({ status: "error", message: "Error interno al conectar con Google Sheets" });
  }
}

// Verificar el ID: POST { id } -> el Apps Script validador (SCRIPT_VALIDADOR_URL, apps-script/validador.gs)
// pregunta a Central One si la cuenta existe (no compra nada). Respuesta para la página:
//   { valid: true, verificado: true, player_name } existe · { valid: false, verificado: true } no existe ·
//   { valid: true, verificado: false } no se pudo comprobar (la página deja seguir, como antes).
// El validador ya guarda cada ID 10 min; aquí solo se frena a quien prueba IDs al azar.
const MAX_VERIFICACIONES_POR_MINUTO = 10;
const verificacionesPorIp = new Map();

async function verificar(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ valid: false, message: "Método no permitido" });

  const id = String(req.body?.id ?? '');
  // Mismo formato de ID que exige la recarga
  if (!/^\d{5,15}$/.test(id)) {
    return res.status(400).json({ valid: false, message: "ID con formato inválido. Debe tener entre 5 y 15 números." });
  }

  const URL_VALIDADOR = process.env.SCRIPT_VALIDADOR_URL;
  if (!URL_VALIDADOR) {
    return faltaConfiguracion(res, ["SCRIPT_VALIDADOR_URL"], { valid: true, verificado: false });
  }

  // Central One permite 30 validaciones por minuto para toda la cuenta: por IP, como mucho 10
  const ip = obtenerIp(req);
  const ahora = Date.now();
  const recientes = (verificacionesPorIp.get(ip) || []).filter((t) => ahora - t < 60_000);
  if (recientes.length >= MAX_VERIFICACIONES_POR_MINUTO) {
    return res.status(429).json({ valid: false, message: "Demasiadas verificaciones. Espera un minuto e intenta de nuevo." });
  }
  verificacionesPorIp.set(ip, [...recientes, ahora]);
  if (verificacionesPorIp.size > 5000) verificacionesPorIp.delete(verificacionesPorIp.keys().next().value);

  try {
    const data = await llamarScript(URL_VALIDADOR, { id, juego: 'bloodstrike' }, LECTURA_APPS_SCRIPT);
    const verificado = data?.verificado === true;
    // Solo un "no existe" confirmado bloquea; cualquier otra cosa deja seguir sin nombre
    if (verificado && data.valid === false) {
      return res.status(200).json({ valid: false, verificado: true, message: "Ese ID no existe en Blood Strike. Revísalo." });
    }
    return res.status(200).json({
      valid: true, verificado,
      player_name: verificado && data.player_name ? String(data.player_name).slice(0, 60) : undefined,
    });
  } catch (error) {
    console.error("Error al verificar ID de Blood Strike:", error.message);
    return res.status(200).json({ valid: true, verificado: false });
  }
}

// Catálogo de Blood Strike para la acción "descuento" (misma caché que la acción precios)
async function catalogoBloodStrike() {
  const { datos } = await conCache('precios:bs',
    () => pedirJSON(`${process.env.SCRIPT_BLOOD}?accion=obtener_precios`, { metodo: 'GET', ...LECTURA_APPS_SCRIPT }),
    { esValido: catalogoValido });
  return datos.catalogo.map(sinProducto);
}

export const acciones = { precios, verificar, descuento: crearAccionDescuento('Blood Strike', catalogoBloodStrike) };

// =========================================================================
// RECARGA (api/recargar.js)
// =========================================================================

/**
 * Fases 4-5 con el pago ya verificado (y bloqueado "En proceso"): pedido en Central One y cierre.
 * La usan recargar (un pago) y completarPago (varios pagos que juntos cubren el precio).
 */
async function entregarRecarga(res, {
  CENTRALONE_API_KEY, idPedido, id, paquete, numeroOro, productId, precioReal, desc, comprobante, referencias, cierreIdempotente,
  utilidades: { marcarReferencia, registrarEnHoja, informe, bloquearPago, cerrarEnSegundoPlano },
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
  // FASE 4: RECARGA EN LA API DE CENTRAL ONE
  // ==========================================
  // Datos del jugador según el producto (y si sigue en el catálogo y con stock), antes de gastar saldo
  const datosJugador = productId
    ? await datosParaPedido({ apiKey: CENTRALONE_API_KEY, productId, idJugador: String(id) })
    : { error: `El paquete "${paquete}" (clave ${numeroOro}) no tiene un product_id de Central One válido (y único) en la fila 3 de la pestaña de precios de Blood Strike.` };
  if (datosJugador.error) {
    console.error(`❌ [${FASES.apiBloodStrike}] ${datosJugador.error}`);
    await bloquear({
      fase: FASES.apiBloodStrike, noAplica: true,
      motivo: `${datosJugador.error} No se creó el pedido en Central One (no se cobró nada).`,
      queHacer: 'la recarga NO se hizo; hacerla a mano o devolver el pago',
    });
    return res.status(202).json({ status: "error", message: "Fallo técnico con el proveedor. Tu pago está verificado y la recarga quedó en revisión." });
  }

  const orden = await crearPedidoCentralOne({
    apiKey: CENTRALONE_API_KEY, productId, payload: datosJugador.payload,
    idempotencia: idPedido, nota: `Level Up ${idPedido}`, tiempoMs: TIEMPOS.centralOne,
  });

  if (orden.tipo === 'incierto') {
    console.error(`⚠️ [${FASES.apiBloodStrike}] ${orden.motivo} | REF: ${referenciaCompleta}`);
    // Registrar el incidente y LUEGO bloquear el pago (en orden, dentro de bloquearPago)
    await bloquear({
      fase: FASES.apiBloodStrike,
      motivo: `${orden.motivo} Producto ${productId}. ANTES DE REPETIR: buscar en el portal de Central One un pedido con la nota "Level Up ${idPedido}" para el jugador ${id}.`,
      queHacer: 'confirmar el pedido en Central One antes de repetir la recarga',
    });

    // El frontend reconoce "fallo técnico" y muestra el modal de "recarga en proceso"
    return res.status(202).json({
      status: "error",
      message: "Fallo técnico con el proveedor. Tu pago está verificado y la recarga quedó en revisión."
    });
  }

  if (orden.tipo === 'rechazo') {
    console.error(`❌ [${FASES.apiBloodStrike}] ${orden.motivo}`);
    // Central One no creó el pedido (p. ej. datos inválidos o sin saldo). El pago igual se bloquea:
    // la recarga se rehace a mano con el ID correcto que el cliente envíe por WhatsApp.
    await bloquear({
      fase: FASES.apiBloodStrike, motivo: `${orden.motivo} Producto ${productId}.`,
      queHacer: orden.codigo === 'insufficient_balance'
        ? 'RECARGAR SALDO en Central One; no se cobró nada. Hacer la recarga a mano o devolver el pago'
        : 'no se cobró nada en Central One; hacer la recarga a mano con el ID correcto o devolver el pago',
    });

    return res.status(400).json({
      status: "error",
      message: "El proveedor rechazó la recarga: " + orden.errorCliente + ". Tu pago quedó guardado: escríbenos por WhatsApp con tu referencia y tu ID correcto."
    });
  }

  // ==========================================
  // FASE 5: QUEMAR EL PAGO Y GUARDAR EN FINALIZADOS
  // ==========================================
  console.info(`✅ Central One aceptó el pedido ${orden.orden.referencia} (${orden.orden.status}, ${orden.orden.total}) para el jugador ${id}`);
  // Central One aceptó el pedido: al cliente se le responde éxito sin esperar a Apps Script y el cierre sigue
  // después de responder (cerrarEnSegundoPlano), en orden: el pago, finalizados (hoja de Blood Strike) y
  // el uso del código (hoja de Free Fire; sin él, el creador pierde la comisión). Lo que no se confirme se
  // repite (registrar_finalizado solo con bloodstrike.gs v3; recargas.gs ignora un uso ya anotado).
  const guardarFinalizado = () => registrarEnHoja({
    accion: "registrar_finalizado",
    idJugador: id,
    paquete: paquete,
    referencia: referenciaCompleta,
    codigosUsados: `API Directa (Central One, pedido ${orden.orden.referencia})`,
    urlImagen: comprobante,
    idPedido,
    // La hoja de Blood Strike anota el pedido en "fazer_card" (columna I = reference_code, que es lo que
    // trae el webhook); api/centralone-webhook.js actualiza su estado
    ordenFazer: orden.orden.referencia, estadoFazer: orden.orden.status,
    ofertaFazer: `Central One ${productId} (${orden.orden.total})`, montoCobrado: precioReal,
  });
  cerrarEnSegundoPlano([
    { nombre: 'marcar el pago como "Usado"', repetible: true, ejecutar: marcarPagos },
    { nombre: 'anotar la recarga en "finalizados" (y el pedido en "fazer_card")', repetible: cierreIdempotente, ejecutar: guardarFinalizado },
    desc && {
      nombre: `anotar el uso del código ${desc.codigo} (${precioReal} Bs, pedido ${idPedido}) en "Descuentos"`, repetible: true,
      ejecutar: () => registrarUsoDescuento({ codigo: desc.codigo, montoCobrado: precioReal, idPedido, idJugador: id, juego: 'Blood Strike' }),
    },
  ].filter(Boolean), (faltan, rondas, motivoFallo) => registrarEnHoja(informe({
    fase: FASES.cierre,
    motivo: `La recarga SÍ se pidió (Central One aceptó el pedido ${orden.orden.referencia}), pero Apps Script no respondió al cierre${rondas ? ` (ni tras ${rondas} reintento(s) en segundo plano)` : ''}: falta ${faltan.join(' y ')}${motivoFallo ? `. Motivo: ${motivoFallo}` : ''}`,
    referenciaCompleta,
    estadoPago: faltan.includes('marcar el pago como "Usado"')
      ? `SIN CONFIRMAR: marcar a mano como "Usado" la referencia ${referenciaCompleta}` : 'USADO (correcto)',
  })));

  return res.status(200).json({ status: "success", message: "Recarga de Blood Strike procesada exitosamente." });

}

export async function recargar(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ status: "error", message: "Método no permitido" });
  // Segunda (o tercera...) referencia de un pago que no alcanzó
  if (req.body?.tokenComplemento !== undefined) return completarPago(req, res);

  // Desde verificar_pago: con quién bloquear el pago si algo falla sin estar previsto (ver el catch)
  let pedido = null;
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
    const CENTRALONE_API_KEY = (process.env.blood_nuevo || "").trim();

    if (!URL_GOOGLE_SCRIPT || !CENTRALONE_API_KEY) {
      return faltaConfiguracion(res, ["SCRIPT_BLOOD", "blood_nuevo"].filter((v) => !(process.env[v] || "").trim()),
        { status: "error", message: "Las recargas automáticas no están disponibles en este momento. No realices el pago todavía; escríbenos por WhatsApp." });
    }

    const idPedido = randomUUID();
    const comprobante = urlImagen && urlImagen.trim() !== "" ? urlImagen : "Sin comprobante";

    const { marcarReferencia, registrarEnHoja, informe, bloquearPago, bloquearPorError, cerrarEnSegundoPlano } = crearUtilidadesPedido({
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
    // v3: registrar_finalizado ignora un idPedido ya anotado (se puede repetir el cierre en segundo plano)
    const cierreIdempotente = Number(dataPrecios.version) >= 3;

    const numeroOro = clavePaquete(paquete);
    const { paquete: paqueteGsheet, repetido } = buscarPaquete(dataPrecios.catalogo, numeroOro);
    const precioLista = limpiarMontoVES(paqueteGsheet?.precio);
    if (!paqueteGsheet || !(precioLista > 0)) {
      await registrarFallo(clavesLimite);
      return res.status(400).json({ status: "error", message: "Paquete inválido o manipulado." });
    }
    // Sin producto de Central One (o con dos columnas para el mismo paquete) no se sabe qué comprar:
    // se avisa ANTES de tocar el pago (sigue libre)
    const productId = repetido ? '' : productoDe(paqueteGsheet);
    if (!productId) {
      console.error(`❌ [${FASES.apiBloodStrike}] El paquete "${paquete}" (clave ${numeroOro}) ${repetido ? 'aparece en más de una columna' : 'no tiene product_id en la fila 3'} de la pestaña de precios. No se usó el pago.`);
      return res.status(503).json({ status: "error", message: "Este paquete no está disponible por ahora. Tu pago no se usó: escríbenos por WhatsApp con tu referencia." });
    }

    // Descuento opcional (tabla común en la hoja de Free Fire): se vuelve a consultar el código
    // (pudo desactivarse) antes de tocar el pago
    const descuento = await aplicarDescuentoARecarga(req.body?.codigoDescuento, precioLista);
    if (descuento.error) return res.status(descuento.error.codigo).json(descuento.error.cuerpo);
    const { desc, precio: precioReal } = descuento;

    // ==========================================
    // FASE 2: BUSCAR PAGO Y VERIFICAR
    // ==========================================
    pedido = { utilidades: { registrarEnHoja, informe, bloquearPorError }, referencias: [] };
    let dataVerificacion;
    try {
      dataVerificacion = await llamarScript(URL_GOOGLE_SCRIPT,
        { accion: "verificar_pago", referencia: referencia, monto: precioReal, idPedido },
        scriptV2 ? TIEMPOS.idempotente : TIEMPOS.sinIdempotencia);
      // Un error de Apps Script (salvo "ocupado", que no ejecutó nada) pudo dejar el pago "En proceso":
      // se trata igual que si no hubiera respondido
      if (dataVerificacion?.status === 'error' && !dataVerificacion.ocupado) {
        throw new Error(`Apps Script respondió con error: ${dataVerificacion.message || 'sin detalle'}`);
      }
    } catch (error) {
      // El pago pudo quedar "En proceso": NUNCA se libera, se marca "Usado" (bloquear_pedido solo toca
      // el pago que bloqueó ESTE pedido) y la recarga pasa a revisión manual
      console.error(`❌ [${FASES.verificacion}] ${error.message}`);
      const motivo = `Apps Script de Blood Strike falló en verificar_pago: ${error.message}`;
      let pagoTomado = true;
      if (scriptV2) {
        ({ pagoTomado } = await bloquearPorError({ fase: FASES.verificacion, motivo }));
      } else {
        await registrarEnHoja(informe({ fase: FASES.verificacion, motivo,
          estadoPago: `SIN CONFIRMAR: si la fila del pago (referencia terminada en ${referencia}) quedó "En proceso", márcala "Usado" y haz la recarga a mano` }));
      }
      if (!pagoTomado) {
        return res.status(503).json({ status: "error", message: "No pudimos confirmar tu pago a tiempo. Espera un minuto e intenta de nuevo." });
      }
      return res.status(202).json({ status: "error", message: "Fallo técnico momentáneo. Si tu pago es válido, quedó registrado y la recarga está en revisión: escríbenos por WhatsApp con tu referencia." });
    }

    // Ocupado: Apps Script no tocó ningún pago; no cuenta como intento fallido del cliente
    if (dataVerificacion?.ocupado) {
      return res.status(503).json({ status: "error", message: dataVerificacion.message || "Sistema ocupado. Intenta de nuevo en unos segundos." });
    }
    if (!dataVerificacion || !dataVerificacion.encontrado) {
      await registrarFallo(clavesLimite);
      return res.status(400).json({ status: "error", message: dataVerificacion?.message || "Pago no encontrado o ya utilizado." });
    }
    const referenciaCompleta = dataVerificacion.referencia;
    pedido.referencias = [referenciaCompleta];

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
      CENTRALONE_API_KEY, idPedido, id, paquete, numeroOro, productId, precioReal, desc, comprobante,
      referencias: [referenciaCompleta], cierreIdempotente,
      utilidades: { marcarReferencia, registrarEnHoja, informe, bloquearPago, cerrarEnSegundoPlano },
    });
  } catch (error) {
    console.error("Error crítico en la recarga de Blood Strike:", error.message);
    // Con el pago ya pedido: se bloquea y va a "errores"
    const respuesta = await responderErrorInesperado(res, pedido, error);
    if (respuesta) return respuesta;
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
  // Desde usar_complemento: con quién bloquear los pagos si algo falla sin estar previsto (ver el catch)
  let pedido = null;
  // Límite del cierre en segundo plano (las utilidades del pedido se crean más tarde)
  const inicio = Date.now();
  try {
    const clave = String(req.body?.tokenComplemento ?? '');
    const referencia = String(req.body?.referencia ?? '');
    if (!CLAVE_COMPLEMENTO.test(clave) || !/^\d{5}$/.test(referencia)) {
      return res.status(400).json({ status: "error", message: "Escribe los últimos 5 dígitos de la referencia del pago que hiciste para completar." });
    }

    const URL_GOOGLE_SCRIPT = process.env.SCRIPT_BLOOD;
    const CENTRALONE_API_KEY = (process.env.blood_nuevo || "").trim();
    if (!URL_GOOGLE_SCRIPT || !CENTRALONE_API_KEY) {
      return faltaConfiguracion(res, ["SCRIPT_BLOOD", "blood_nuevo"].filter((v) => !(process.env[v] || "").trim()),
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
    // Hasta conocer el pedido (sale de la hoja), los informes de "errores" remiten a "por_completar"
    pedido = {
      utilidades: crearUtilidadesPedido({
        urlScript: URL_GOOGLE_SCRIPT, idPedido, tiempoIncidenteMs: TIEMPOS.incidente, inicio,
        datosInforme: { idPedido, idJugador: 'ver pestaña "por_completar"', paquete: 'pago por completar', referenciaCliente: referencia, comprobante: 'Sin comprobante', noAplica: true },
      }),
      referencias: [],
    };
    const revisarPorCompletar = `Revisar la pestaña "por_completar" (clave ${claveHash.slice(0, 12)}…)`;
    let datos;
    try {
      // Se puede repetir: bloodstrike.gs guarda la respuesta de este idPedido
      datos = await llamarScript(URL_GOOGLE_SCRIPT, { accion: "usar_complemento", claveHash, referencia, idPedido }, TIEMPOS.idempotente);
      // Un error de Apps Script (salvo "ocupado") pudo dejar el pago nuevo "En proceso"
      if (datos?.status === 'error' && !datos.ocupado) throw new Error(`Apps Script respondió con error: ${datos.message || 'sin detalle'}`);
    } catch (error) {
      // El pago nuevo pudo quedar "En proceso": se bloquea (solo el que tomó ESTE pedido) y va a revisión
      console.error(`❌ [${FASES.verificacion}] usar_complemento de Blood Strike falló: ${error.message}`);
      await pedido.utilidades.bloquearPorError({
        fase: FASES.verificacion,
        motivo: `Apps Script de Blood Strike falló al completar un pago (usar_complemento): ${error.message}. ${revisarPorCompletar}`,
      });
      return res.status(202).json({ status: "error", message: "Fallo técnico momentáneo. Tu pago quedó registrado y la recarga está en revisión: escríbenos por WhatsApp con tus referencias." });
    }

    // Ocupado: Apps Script no tocó ningún pago; la clave sigue sirviendo
    if (datos?.ocupado) {
      return res.status(503).json({ status: "error", message: datos.message || "Sistema ocupado. Intenta de nuevo en unos segundos." });
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
      // Los pagos de este pedido quedan "Usado" (si no se pueden leer las referencias, el que tomó este pedido)
      await pedido.utilidades.bloquearPorError({
        fase: FASES.inesperado, referencias,
        motivo: `usar_complemento devolvió datos inválidos (jugador "${id}", paquete "${paquete}", precio ${datos.precio}, referencias ${JSON.stringify(datos.referencias)}). ${revisarPorCompletar}`,
      });
      return res.status(202).json({ status: "error", message: "Fallo técnico momentáneo. Tu pago quedó registrado y la recarga está en revisión: escríbenos por WhatsApp con tus referencias." });
    }
    const comprobante = textoParaHoja(datos.comprobante || "Sin comprobante");
    const utilidades = crearUtilidadesPedido({
      urlScript: URL_GOOGLE_SCRIPT, idPedido, tiempoIncidenteMs: TIEMPOS.incidente, inicio,
      datosInforme: { idPedido, idJugador: id, paquete, referenciaCliente: referencia, comprobante, noAplica: true },
    });
    pedido = { utilidades, referencias };
    console.info(`🧩 Pago de Blood Strike completado (${referencias.join(' + ')}) para el pedido ${datos.idPedidoOriginal} -> ${idPedido} (ID ${id})`);

    // Producto de Central One del paquete (pestaña de precios). Si no se puede leer o ya no está,
    // entregarRecarga bloquea los pagos y lo deja en "errores" sin crear el pedido.
    let productId = '';
    try {
      const { datos: dataPrecios } = await conCache('precios:bs',
        () => llamarScript(URL_GOOGLE_SCRIPT, { accion: "obtener_precios" }, { reintentos: 2, intentoMs: 8000, tiempoMs: 12000, reintentarTrasTimeout: true }),
        { esValido: catalogoValido });
      const { paquete: paqueteGsheet, repetido } = buscarPaquete(dataPrecios.catalogo, numeroOro);
      productId = repetido ? '' : productoDe(paqueteGsheet);
    } catch (error) {
      console.error(`❌ [${FASES.precios}] No se pudo leer el producto del paquete "${paquete}": ${error.message}`);
    }

    return await entregarRecarga(res, {
      CENTRALONE_API_KEY, idPedido, id, paquete, numeroOro, productId, precioReal,
      desc: datos.codigoDescuento ? { codigo: String(datos.codigoDescuento) } : null,
      comprobante, referencias, utilidades,
      // usar_complemento de bloodstrike.gs v3 anuncia su versión
      cierreIdempotente: Number(datos.version) >= 3,
    });
  } catch (error) {
    console.error("Error crítico al completar un pago de Blood Strike:", error.message);
    const respuesta = await responderErrorInesperado(res, pedido, error);
    if (respuesta) return respuesta;
    if (error instanceof ErrorExterno) {
      return res.status(503).json({ status: "error", message: "No pudimos confirmar tu pago a tiempo. Espera un minuto e intenta de nuevo; si persiste, escríbenos por WhatsApp." });
    }
    return res.status(500).json({ status: "error", message: "Falla interna del servidor." });
  }
}
