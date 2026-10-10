// Códigos de descuento, compartidos por todas las tiendas.
// La tabla vive en la pestaña "Descuentos" de la hoja de recargas de Free Fire (SCRIPT_RECARGAS_URL):
// A: código | B: descuento ("10%" o "50") | C: usos | D: dinero total movido.
// El descuento SIEMPRE se calcula aquí, en el servidor: el navegador solo envía el código.
// (Los archivos con "_" dentro de /api no se publican como endpoints en Vercel.)
import { llamarScript, LECTURA_APPS_SCRIPT, conCache } from './externo.js';
import { obtenerIp, minutosBloqueado, registrarFallo } from './limitador.js';
import { faltaConfiguracion } from './validacion.js';
import { formatearVES, limpiarMontoVES } from './recarga-comun.js';

// Letras, números, "_" y "-"; se comparan sin distinguir mayúsculas
export const CODIGO_DESCUENTO_VALIDO = /^[A-Z0-9_-]{2,30}$/;
export const normalizarCodigoDescuento = (codigo) => String(codigo ?? '').trim().toUpperCase();

const urlTablaDescuentos = () => process.env.SCRIPT_RECARGAS_URL;

// descuento = { tipo: 'porcentaje' | 'monto', valor }. Redondea a céntimos. Si el descuento
// dejaría el paquete en 0 o menos (monto fijo mayor que el precio), no se aplica a ese paquete.
export function precioConDescuento(precio, descuento) {
  if (!descuento) return precio;
  const final = descuento.tipo === 'porcentaje' ? precio * (1 - descuento.valor / 100) : precio - descuento.valor;
  const redondeado = Math.round(final * 100) / 100;
  return redondeado > 0 ? redondeado : precio;
}

export const describirDescuento = (descuento) => descuento.tipo === 'porcentaje'
  ? `${formatearVES(descuento.valor).replace(/,00$/, '')}% de descuento`
  : `${formatearVES(descuento.valor)} Bs de descuento`;

// Consulta un código (acción validar_descuento de recargas.gs).
// Devuelve { codigo, tipo, valor } o null si no existe o su descuento no es válido.
// Copia de 60 s por código; sin respaldo viejo, porque decide lo que se cobra.
export async function obtenerDescuento(codigo) {
  const { datos } = await conCache(`descuento:${codigo}`,
    () => llamarScript(urlTablaDescuentos(), { accion: "validar_descuento", codigo }, LECTURA_APPS_SCRIPT),
    { respaldoMs: 0, esValido: (d) => d?.status === 'success' });
  const valor = Number(datos.valor);
  const tipoValido = (datos.tipo === 'porcentaje' && valor > 0 && valor < 100) || (datos.tipo === 'monto' && valor > 0);
  return datos.valido === true && tipoValido ? { codigo: String(datos.codigo || codigo), tipo: datos.tipo, valor } : null;
}

// Anota +1 uso y el monto cobrado de un código (acción registrar_uso_descuento de recargas.gs).
// Para los juegos cuya recarga se registra en OTRA hoja (Blood Strike); Free Fire lo hace dentro
// de registrar_finalizado. Es una escritura: sin reintento tras timeout para no contar dos veces.
export function registrarUsoDescuento({ codigo, montoCobrado, idPedido, juego }) {
  return llamarScript(urlTablaDescuentos(), { accion: "registrar_uso_descuento", codigo, montoCobrado, idPedido, juego }, { tiempoMs: 12000, reintentos: 1 })
    .then((r) => r?.status === 'success')
    .catch((e) => { console.error(`❌ registrar_uso_descuento falló (${juego}, código ${codigo}, pedido ${idPedido}):`, e.message); return false; });
}

/**
 * Acción "descuento" de api/juego.js para una tienda: POST { codigo } -> su catálogo con los
 * precios ya descontados (el mismo cálculo que hará la recarga: lo que se ve es lo que se cobra).
 * obtenerCatalogo() devuelve la lista de paquetes del juego, cada uno con su "precio".
 * Los códigos inválidos cuentan como intento fallido de la IP (frena que se adivinen).
 */
export function crearAccionDescuento(nombreJuego, obtenerCatalogo) {
  return async function descuento(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ status: "error", message: "Método no permitido" });

    const codigo = normalizarCodigoDescuento(req.body?.codigo);
    if (!CODIGO_DESCUENTO_VALIDO.test(codigo)) {
      return res.status(400).json({ status: "error", valido: false, message: "Escribe un código válido (letras y números)." });
    }

    if (!urlTablaDescuentos()) {
      return faltaConfiguracion(res, ["SCRIPT_RECARGAS_URL"], { status: "error", valido: false, message: "Los códigos de descuento no están disponibles en este momento." });
    }

    const clavesLimite = [`descuento:${obtenerIp(req)}`];
    const minutosEspera = await minutosBloqueado(clavesLimite);
    if (minutosEspera > 0) {
      return res.status(429).json({ status: "error", valido: false, message: `Demasiados códigos incorrectos. Espera ${minutosEspera} minutos para volver a intentar.` });
    }

    try {
      const desc = await obtenerDescuento(codigo);
      if (!desc) {
        await registrarFallo(clavesLimite);
        return res.status(200).json({ status: "success", valido: false, message: "Ese código no existe o ya no está activo." });
      }

      const catalogo = (await obtenerCatalogo()).map((p) => {
        const original = limpiarMontoVES(p.precio);
        const final = precioConDescuento(original, desc);
        return final < original ? { ...p, precio: formatearVES(final), precioOriginal: p.precio } : { ...p };
      });
      return res.status(200).json({ status: "success", valido: true, codigo: desc.codigo, descripcion: describirDescuento(desc), catalogo });
    } catch (error) {
      console.error(`Error al validar código de descuento (${nombreJuego}):`, error.message);
      return res.status(503).json({ status: "error", valido: false, message: "No pudimos validar el código. Intenta de nuevo en unos segundos." });
    }
  };
}

/**
 * Para la recarga: lee el código opcional del cuerpo y calcula el precio a cobrar.
 * Devuelve { error: { codigo, cuerpo } } si hay que cortar, o { desc, precio }.
 * Se consulta de nuevo la tabla (el código pudo desactivarse) ANTES de tocar el pago.
 */
export async function aplicarDescuentoARecarga(codigoRecibido, precioLista) {
  const codigo = normalizarCodigoDescuento(codigoRecibido);
  if (!codigo) return { desc: null, precio: precioLista };
  if (!CODIGO_DESCUENTO_VALIDO.test(codigo)) {
    return { error: { codigo: 400, cuerpo: { status: "error", message: "Código de descuento con formato inválido. Quítalo o revísalo." } } };
  }
  let desc;
  try {
    desc = await obtenerDescuento(codigo);
  } catch (error) {
    console.error(`❌ validar_descuento: ${error.message}`);
    return { error: { codigo: 503, cuerpo: { status: "error", message: "No pudimos validar tu código de descuento. Intenta de nuevo en un momento." } } };
  }
  if (!desc) {
    return { error: { codigo: 400, cuerpo: { status: "error", message: "Tu código de descuento ya no está activo. Quítalo e intenta de nuevo, o escríbenos por WhatsApp si ya pagaste." } } };
  }
  return { desc, precio: precioConDescuento(precioLista, desc) };
}
