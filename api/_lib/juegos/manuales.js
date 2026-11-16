// Recargas MANUALES: FC Mobile, COD Mobile y Clash Royale. Los tres juegos comparten este módulo
// (api/_lib/juegos/index.js carga este archivo para los tres y el juego sale de ?juego=).
//
// El cliente elige el paquete, paga por Pago Móvil y deja sus datos de inicio de sesión y su WhatsApp. El
// equipo hace la recarga a mano. Aquí no se compra nada en ningún proveedor.
//
// TODO EN SUPABASE desde 2026-11-16 (supabase/manuales.sql; antes la hoja de apps-script/manuales.gs):
//   - Precios: tabla "precios" (admin.html → Precios → el juego → "Paquete sin Central One"). Mientras un
//     juego no tenga ningún paquete en Supabase, se usan los de la hoja (SCRIPT_MANUALES) como respaldo.
//   - Pedidos: tabla "pedidos_manuales" (admin.html → Manuales: ver la contraseña, cambiar el estado).
//   - Pago: _lib/motor-pagos.js (como las demás tiendas).
//
// SEGURIDAD: el cuerpo trae la CONTRASEÑA del cliente. Nunca se escribe en los logs (ni req.body ni la fila):
// se guarda cifrada (_lib/cifrado.js) y solo la descifra Vercel para un administrador (acción "clave").
// Se borra sola al marcar el pedido "completado" o a los 7 días.
import { randomUUID } from 'node:crypto';
import { motorPagos, tomarPago, cambiarPago, MARGEN_BS } from '../motor-pagos.js';
import { obtenerIp, minutosBloqueado, registrarFallo, permitirUso } from '../limitador.js';
import { anotarRecarga, conDestacados } from '../fidelidad.js';
import { llamarScript, LECTURA_APPS_SCRIPT, conCache, cabecerasCachePrecios } from '../externo.js';
import { PAQUETE_VALIDO, textoParaHoja, telefonoCliente } from '../validacion.js';
import { crearAccionDescuento, aplicarDescuentoARecarga } from '../descuentos.js';
import { limpiarMontoVES, formatearVES } from '../recarga-comun.js';
import { supabaseActivo, rpc, leer, guardar, esAdminToken } from '../supabase.js';
import { tokenDe } from '../historial.js';
import { cifrar, descifrar } from '../cifrado.js';

// Formas de iniciar sesión (igual que METODOS de manuales.gs). clave: pide contraseña · telefono: acepta
// número de teléfono en vez de correo. Supercell ID entra con un código que llega al correo del cliente.
const METODOS = {
  ea: { nombre: 'Cuenta EA', clave: true, telefono: false },
  facebook: { nombre: 'Facebook', clave: true, telefono: true },
  activision: { nombre: 'Activision', clave: true, telefono: false },
  google: { nombre: 'Google', clave: true, telefono: false },
  supercell: { nombre: 'Supercell ID (correo con código)', clave: false, telefono: false },
};
const JUEGOS = {
  fcmobile: { nombre: 'FC Mobile', metodos: ['ea', 'facebook'] },
  codmobile: { nombre: 'COD Mobile', metodos: ['activision', 'facebook', 'google'] },
  clashroyale: { nombre: 'Clash Royale', metodos: ['supercell'] },
};

const MENSAJE_SIN_CONFIGURAR = 'Esta tienda no está disponible en este momento. Intenta más tarde.';
const METODO_VALIDO = /^[a-z]{2,20}$/;
const MAX_USUARIO = 100;
const MAX_CLAVE = 100;
const ESTADOS_PEDIDO = ['pendiente', 'en_proceso', 'completado', 'incompleto', 'problema'];
const ID_PEDIDO_MANUAL = /^man-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CORREO = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;
const redondear2 = (n) => Math.round(n * 100) / 100;

function cabecerasCors(res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://levelupstore.online');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// =========================================================================
// PRECIOS: Supabase; si el juego todavía no tiene paquetes ahí, la hoja (respaldo de la mudanza)
// =========================================================================

// [{ paquete, precio: número en Bs }] de Supabase (activos y con precio). 30 s en memoria.
async function paquetesSupabase(juego) {
  const { datos } = await conCache(`precios:manual:${juego}`, async () => {
    const filas = await rpc('precios_de', { p_juego: juego });
    return (Array.isArray(filas) ? filas : [])
      .filter((f) => f.activo && Number(f.precio) > 0 && PAQUETE_VALIDO.test(String(f.paquete || '')))
      .map((f) => ({ paquete: String(f.paquete), precio: redondear2(Number(f.precio)) }));
  }, { frescoMs: 30_000, respaldoMs: 10 * 60_000, esValido: Array.isArray });
  return datos;
}

// Respaldo: los paquetes de la hoja de manuales.gs (precio en Bs como texto)
async function paquetesHoja(juego) {
  const url = String(process.env.SCRIPT_MANUALES || '').trim();
  if (!url) return [];
  const { datos } = await conCache('precios:manuales',
    () => llamarScript(url, { accion: 'obtener_precios' }, LECTURA_APPS_SCRIPT),
    { esValido: (d) => d?.status === 'success' && d.juegos && typeof d.juegos === 'object' });
  const lista = Array.isArray(datos.juegos?.[juego]?.catalogo) ? datos.juegos[juego].catalogo : [];
  return lista.filter((p) => PAQUETE_VALIDO.test(String(p?.paquete || '')) && limpiarMontoVES(p.precio) > 0)
    .map((p) => ({ paquete: String(p.paquete), precio: redondear2(limpiarMontoVES(p.precio)) }));
}

const avisoHoja = {};
async function paquetesDe(juego) {
  if (supabaseActivo()) {
    const deSupabase = await paquetesSupabase(juego);
    if (deSupabase.length) return deSupabase;
  }
  if (!avisoHoja[juego]) {
    console.warn(`⚠️ Manuales: ${juego} no tiene paquetes en Supabase (admin.html → Precios): se usan los de la hoja`);
    avisoHoja[juego] = true;
  }
  return paquetesHoja(juego);
}

// Lo que ve la página: precio como texto "1.234,56"
const catalogoParaCliente = async (juego) => (await paquetesDe(juego)).map((p) => ({ paquete: p.paquete, precio: formatearVES(p.precio) }));

function metodosDe(juego) {
  return JUEGOS[juego].metodos.map((id) => ({ id, nombre: METODOS[id].nombre, clave: METODOS[id].clave, telefono: METODOS[id].telefono }));
}

// =========================================================================
// ACCIONES DE api/juego.js
// =========================================================================

async function precios(req, res) {
  cabecerasCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ status: 'error', message: 'Método no permitido' });
  const juego = String(req.query.juego);
  try {
    const catalogo = await catalogoParaCliente(juego);
    if (!catalogo.length) {
      console.error(`Manuales: ${juego} no tiene paquetes a la venta (ni en Supabase ni en la hoja)`);
      return res.status(503).json({ status: 'error', message: MENSAJE_SIN_CONFIGURAR });
    }
    cabecerasCachePrecios(res);
    // "⭐ Más vendido" / "💰 Mejor precio" (_lib/fidelidad.js)
    return res.status(200).json({ status: 'success', nombre: JUEGOS[juego].nombre, metodos: metodosDe(juego), catalogo: await conDestacados(juego, catalogo) });
  } catch (error) {
    console.error(`Error al obtener precios de ${juego}:`, error.message);
    return res.status(503).json({ status: 'error', message: 'Error interno de conexión con el servidor.' });
  }
}

// POST { codigo } -> catálogo del juego con los precios ya descontados (js/descuento.js)
async function descuento(req, res) {
  cabecerasCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const juego = String(req.query.juego);
  return crearAccionDescuento(JUEGOS[juego].nombre, async () => conDestacados(juego, await catalogoParaCliente(juego)))(req, res);
}

/**
 * Seguimiento del pedido (js/mis-recargas.js lo consulta cada 30 s mientras la página está abierta):
 * POST { idPedido } -> { status, estado } con estado = pendiente | en_proceso | completado | incompleto |
 * problema | desconocido. El idPedido (UUID que solo recibió el cliente) hace de llave: no expone nada más.
 * Pedidos de antes del 2026-11-16 (en la hoja): "desconocido".
 */
async function estado(req, res) {
  cabecerasCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ status: 'error', message: 'Método no permitido' });
  const juego = String(req.query.juego);
  const idPedido = String(req.body?.idPedido ?? '');
  if (!ID_PEDIDO_MANUAL.test(idPedido)) return res.status(400).json({ status: 'error', message: 'Pedido inválido.' });
  if (!supabaseActivo()) return res.status(200).json({ status: 'success', estado: 'desconocido' });

  const minutos = await permitirUso(`estado:${obtenerIp(req)}`);
  if (minutos > 0) return res.status(429).json({ status: 'error', message: `Espera ${minutos} minutos.` });

  try {
    // Copia de 20 s por pedido: dos pestañas abiertas no duplican la consulta
    const { datos } = await conCache(`estado:${idPedido}`,
      async () => (await leer('pedidos_manuales', { id_pedido: idPedido, juego }, 'estado'))?.[0] || {},
      { frescoMs: 20000, respaldoMs: 0 });
    const valor = String(datos.estado || '');
    return res.status(200).json({ status: 'success', estado: ESTADOS_PEDIDO.includes(valor) ? valor : 'desconocido' });
  } catch (error) {
    console.error(`Manuales: no se pudo leer el estado del pedido (${juego}):`, error.message);
    return res.status(503).json({ status: 'error', message: 'No pudimos consultar tu pedido ahora.' });
  }
}

/**
 * Panel → Manuales → "Ver contraseña" (solo administrador): POST { idPedido } con Authorization.
 * -> { status, usuario, clave } (clave vacía si el método no usa contraseña o ya se borró).
 */
async function clave(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ status: 'error', message: 'Método no permitido' });
  if (!(await esAdminToken(tokenDe(req)))) return res.status(403).json({ status: 'error', message: 'Solo el administrador.' });
  const idPedido = String(req.body?.idPedido ?? '');
  if (!ID_PEDIDO_MANUAL.test(idPedido)) return res.status(400).json({ status: 'error', message: 'Pedido inválido.' });
  try {
    const [fila] = await leer('pedidos_manuales', { id_pedido: idPedido }, 'usuario,clave_cifrada');
    if (!fila) return res.status(404).json({ status: 'error', message: 'No existe ese pedido.' });
    let texto = '';
    if (fila.clave_cifrada) {
      try {
        texto = descifrar(fila.clave_cifrada);
      } catch (error) {
        console.error(`🚨 Manuales: no se pudo descifrar la contraseña del pedido ${idPedido} (¿cambió CLAVE_MANUALES?): ${error.message}`);
        return res.status(500).json({ status: 'error', message: 'No se pudo descifrar la contraseña (cambió la llave en Vercel). Pídesela al cliente por WhatsApp.' });
      }
    }
    return res.status(200).json({ status: 'success', usuario: String(fila.usuario || ''), clave: texto });
  } catch (error) {
    console.error('Manuales: no se pudo leer la contraseña:', error.message);
    return res.status(503).json({ status: 'error', message: 'Supabase no respondió. Intenta de nuevo.' });
  }
}

export const acciones = { precios, descuento, estado, clave };

// =========================================================================
// PEDIDO (api/recargar.js)
// POST { paquete, referencia, metodo, usuario, clave, telefono, url_capture }
// → { status: 'success', insuficiente, precio, pagado, falta, idPedido } o { status: 'error', message }
// =========================================================================

export async function recargar(req, res) {
  cabecerasCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ status: 'error', message: 'Método no permitido. Usa POST.' });
  const juego = String(req.query.juego);
  const datosJuego = JUEGOS[juego];

  try {
    if (!supabaseActivo()) return res.status(503).json({ status: 'error', message: MENSAJE_SIN_CONFIGURAR });

    // Solo se usan los campos conocidos. La contraseña NO se recorta (los espacios cuentan).
    const { paquete, referencia, metodo, url_capture } = req.body || {};
    let usuario = String(req.body?.usuario ?? '').trim();
    const claveCliente = typeof req.body?.clave === 'string' ? req.body.clave : '';
    const telefono = telefonoCliente(req.body?.telefono);
    if (!/^\d{5}$/.test(String(referencia)) || !PAQUETE_VALIDO.test(String(paquete || '')) || !METODO_VALIDO.test(String(metodo || ''))) {
      return res.status(400).json({ status: 'error', message: 'Datos con formato inválido. Revisa el paquete y los 5 dígitos de la referencia.' });
    }
    if (!datosJuego.metodos.includes(String(metodo))) {
      return res.status(400).json({ status: 'error', message: `Elige cómo inicias sesión en ${datosJuego.nombre}.` });
    }
    const m = METODOS[metodo];
    if (usuario.length < 3 || usuario.length > MAX_USUARIO || claveCliente.length > MAX_CLAVE || /[\u0000-\u001f\u007f]/.test(usuario + claveCliente)) {
      return res.status(400).json({ status: 'error', message: 'Revisa el correo (o usuario) y la contraseña de tu cuenta.' });
    }
    const esCorreo = CORREO.test(usuario);
    const esTelefono = m.telefono && /^\+?\d{7,15}$/.test(usuario.replace(/[\s-]/g, ''));
    if (!esCorreo && !esTelefono) {
      return res.status(400).json({ status: 'error', message: m.telefono ? `Escribe el correo o el teléfono de tu cuenta de ${m.nombre}.` : `Escribe un correo válido de tu cuenta de ${m.nombre}.` });
    }
    if (esTelefono && !esCorreo) usuario = usuario.replace(/[\s-]/g, '');
    if (m.clave && !claveCliente) return res.status(400).json({ status: 'error', message: `Escribe la contraseña de tu cuenta de ${m.nombre}.` });
    if (!telefono) {
      return res.status(400).json({ status: 'error', message: 'Escribe un número de WhatsApp venezolano válido: por ahí te escribimos si hace falta.' });
    }

    // ¿Esta IP o esta cuenta acumula demasiados fallos?
    const clavesLimite = [`ip:${obtenerIp(req)}`, `manual:${juego}:${usuario.toLowerCase()}`];
    const minutosEspera = await minutosBloqueado(clavesLimite);
    if (minutosEspera > 0) {
      return res.status(429).json({ status: 'error', message: `Demasiados intentos fallidos. Espera ${minutosEspera} minutos para volver a intentar.` });
    }

    // Precio: del servidor, nunca del cliente
    let lista;
    try {
      lista = await paquetesDe(juego);
    } catch (error) {
      console.error(`Manuales: no se pudieron leer los precios de ${juego}:`, error.message);
      return res.status(503).json({ status: 'error', message: 'No pudimos leer los precios ahora. Tu pago no se usó: intenta de nuevo en un momento.' });
    }
    const item = lista.find((p) => p.paquete.toLowerCase() === String(paquete).trim().toLowerCase());
    if (!item) return res.status(400).json({ status: 'error', message: 'Ese paquete ya no está disponible. Recarga la página y elige de nuevo.' });

    // Código de descuento (opcional): se vuelve a consultar ANTES de tocar el pago
    let precio = item.precio;
    let desc = null;
    if (req.body?.codigoDescuento) {
      const resultado = await aplicarDescuentoARecarga(req.body.codigoDescuento, item.precio);
      if (resultado.error) return res.status(resultado.error.codigo).json(resultado.error.cuerpo);
      // Un monto fijo mayor que el precio no se aplica a ese paquete: se cobra completo y no cuenta como uso
      if (resultado.desc && resultado.precio > 0 && resultado.precio < item.precio) ({ desc, precio } = resultado);
    }

    // La contraseña se cifra ANTES de tocar el pago (sin llave en Vercel no se acepta el pedido)
    let claveCifrada = null;
    if (m.clave) {
      try {
        claveCifrada = cifrar(claveCliente);
      } catch (error) {
        console.error(`🚨 Manuales: ${error.message}`);
        return res.status(503).json({ status: 'error', message: MENSAJE_SIN_CONFIGURAR });
      }
    }

    await motorPagos();
    const idPedido = req.idPedidoForzado || `man-${randomUUID()}`;   // forzado: recarga repetida al aprobar un pago a mano
    const pago = await tomarPago(String(referencia), idPedido, juego, precio);
    if (!pago.encontrado) {
      await registrarFallo(clavesLimite);
      return res.status(200).json({ status: 'error', message: pago.message });
    }

    const insuficiente = pago.monto < precio - MARGEN_BS;
    const falta = insuficiente ? redondear2(precio - pago.monto) : 0;
    const notas = [];
    if (desc) notas.push(`Código ${desc.codigo} (precio sin descuento: ${formatearVES(item.precio)} Bs)`);
    if (insuficiente) notas.push(`Faltan ${formatearVES(falta)} Bs: escribir al cliente`);
    if (!m.clave) notas.push('Pedir por WhatsApp el código que llega al correo');
    const fila = {
      id_pedido: idPedido, juego, paquete: item.paquete, precio, pagado: redondear2(pago.monto), referencia: pago.referencia,
      metodo: m.nombre, usuario, clave_cifrada: claveCifrada, telefono, estado: insuficiente ? 'incompleto' : 'pendiente',
      nota: notas.join(' · ').slice(0, 500) || null, comprobante: textoParaHoja(url_capture || 'Sin comprobante'),
      codigo_descuento: desc?.codigo || null,
    };

    // Guardar el pedido (repetir es seguro: misma id_pedido). Sin confirmación, el pago NO vuelve a quedar
    // libre (pudo guardarse): queda usado y se revisa a mano.
    let guardado = false;
    for (let intento = 0; intento < 2 && !guardado; intento++) {
      try {
        await guardar('pedidos_manuales', fila, 'id_pedido');
        guardado = true;
      } catch (error) {
        console.error(`❌ Manuales: no se pudo guardar el pedido ${idPedido} (intento ${intento + 1}): ${error.message}`);
      }
    }
    await cambiarPago(pago.referencia, 'usado', { idPedido }).catch((error) =>
      console.error(`🚨 Manuales: el pago …${String(pago.referencia).slice(-5)} del pedido ${idPedido} no se pudo marcar usado: ${error.message}`));
    if (!guardado) {
      console.error(`🚨 Manuales: pedido ${idPedido} SIN GUARDAR | ${juego} · ${item.paquete} · REF ${pago.referencia} · WhatsApp ${telefono} · usuario ${usuario}. Escribir al cliente.`);
      return res.status(202).json({ status: 'error', message: 'Fallo técnico momentáneo: tu pedido quedó en revisión. Si en 10 minutos no te escribimos, escríbenos por WhatsApp con tu referencia.' });
    }

    // +1 venta del paquete ("Más vendido") y la fila del historial (con el estado de la respuesta).
    // El uso del código de descuento lo cuenta Supabase al marcar el pedido "completado" en el panel.
    anotarRecarga({ juego, cuenta: null, paquete: item.paquete, idPedido, precio });
    return res.status(200).json({
      status: 'success', insuficiente,
      precio: formatearVES(precio), pagado: formatearVES(pago.monto), falta: formatearVES(falta),
      // Para seguir el estado del pedido desde la página (js/mis-recargas.js)
      idPedido,
    });
  } catch (error) {
    console.error(`Error en el pedido manual de ${juego}:`, error.message);
    return res.status(error.name === 'ErrorExterno' ? 503 : 500).json({ status: 'error', message: 'Error interno de conexión con el servidor.' });
  }
}
