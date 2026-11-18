import { supabaseActivo, rpc, usuarioDelToken } from './_lib/supabase.js';
import { tokenDe } from './_lib/historial.js';

// Panel de creadores (creadores.html), SOLO con "Entrar con Google" desde 2026-11-13:
// POST { cuenta: true } + Authorization: Bearer <token de la sesión> -> los códigos cuyo correo puso el
// administrador en admin.html (función creador_por_usuario de supabase/codigos.sql). El usuario sale del
// token (Supabase lo comprueba), nunca de lo que mande la página. El creador no puede darse acceso solo.
// El código + PIN ya no abre el panel (el PIN queda guardado en "codigos" solo como dato del creador).
// Con { cuenta: true, accion: "perfil", datos } guarda sus datos de pago (creador_guardar_perfil): cómo
// quiere cobrar (bolívares o diamantes), edad, WhatsApp y Pago Móvil. Solo quien ya tiene código.
// INSCRIPCIÓN (desde 2026-11-17, supabase/creadores-inscripcion.sql):
//   { accion: "inscripcion" } (sin sesión) → { abierta, quedan, minimo }
//   { cuenta: true, accion: "inscribir", codigo, whatsapp, enlace } → crea su código si quedan cupos
//   (creador_inscribir: un código por cuenta y por WhatsApp; los cupos los abre el administrador).
const RETIRO_MINIMO_USD = 3;

// Bancos de Pago Móvil (código SUDEBAN). Igual que la lista de creadores.html.
export const BANCOS = {
  '0102': 'Banco de Venezuela', '0104': 'Venezolano de Crédito', '0105': 'Mercantil', '0108': 'Provincial',
  '0114': 'Bancaribe', '0115': 'Exterior', '0128': 'Caroní', '0134': 'Banesco', '0137': 'Sofitasa', '0138': 'Plaza',
  '0146': 'Bangente', '0151': 'BFC Fondo Común', '0156': '100% Banco', '0157': 'DelSur', '0163': 'Banco del Tesoro',
  '0166': 'Agrícola de Venezuela', '0168': 'Bancrecer', '0169': 'R4', '0171': 'Activo', '0172': 'Bancamiga',
  '0173': 'Internacional de Desarrollo', '0174': 'Banplus', '0175': 'Digital de los Trabajadores', '0177': 'Banfanb',
  '0178': 'N58 Banco Digital', '0191': 'BNC Nacional de Crédito',
};
const CELULAR = /^4(12|14|16|22|24|26)\d{7}$/;

// "0414-123.45.67" / "+58 414…" -> "+584141234567" (o '' si no es un celular venezolano)
function celular(texto) {
  let d = String(texto ?? '').replace(/\D/g, '');
  if (d.startsWith('58')) d = d.slice(2);
  if (d.startsWith('0')) d = d.slice(1);
  return CELULAR.test(d) ? '+58' + d : '';
}

// WhatsApp de CUALQUIER país → "+<código de país><número>" (o ''). Un celular venezolano escrito sin
// código ("0414-1234567") se toma como +58; cualquier otro tiene que traer su código de país.
export function whatsappInternacional(texto) {
  const crudo = String(texto ?? '').trim();
  let d = crudo.replace(/\D/g, '');
  if (crudo.startsWith('00')) d = d.slice(2);
  else if (!crudo.startsWith('+') && CELULAR.test(d.replace(/^0/, ''))) d = '58' + d.replace(/^0/, '');
  return /^[1-9]\d{7,14}$/.test(d) ? '+' + d : '';
}

// Enlace del perfil o de un video: siempre https, con dominio y sin usuario/contraseña. '' si no sirve.
export function enlaceLimpio(texto) {
  let t = String(texto ?? '').trim();
  if (!t || t.length > 300) return '';
  if (!/^https?:\/\//i.test(t)) t = 'https://' + t;
  try {
    const url = new URL(t);
    if (url.username || url.password || !/\.[a-z]{2,}$/i.test(url.hostname)) return '';
    url.protocol = 'https:';
    const limpio = url.href;
    return limpio.length <= 300 && !/[\s<>"]/.test(limpio) ? limpio : '';
  } catch {
    return '';
  }
}

/** Valida la inscripción. Devuelve { datos } o { error } para mostrarle al creador. */
export function limpiarInscripcion(entrada) {
  const e = entrada && typeof entrada === 'object' ? entrada : {};
  const codigo = String(e.codigo ?? '').toUpperCase().replace(/\s/g, '');
  const whatsapp = whatsappInternacional(e.whatsapp);
  const enlace = enlaceLimpio(e.enlace);
  if (!/^[A-Z0-9]{4,15}$/.test(codigo)) return { error: 'Tu código debe tener de 4 a 15 letras o números, sin espacios ni símbolos (ej: JOSEFF).' };
  if (!whatsapp) return { error: 'Escribe tu WhatsApp con el código de tu país (ej: +58 414 1234567 o +57 300 1234567).' };
  if (!enlace) return { error: 'Pega el enlace de tu perfil o de un video tuyo (TikTok, YouTube, Instagram…).' };
  if (e.acepto !== true) return { error: 'Marca que aceptas las reglas del programa.' };
  return { datos: { codigo, whatsapp, enlace } };
}

/** Valida los datos de pago del creador. Devuelve { datos } limpios o { error } para mostrarle. */
export function limpiarPerfil(entrada) {
  const e = entrada && typeof entrada === 'object' ? entrada : {};
  const preferencia = e.preferencia === 'diamantes' ? 'diamantes' : e.preferencia === 'bolivares' ? 'bolivares' : '';
  const idJugador = String(e.id_jugador ?? '').replace(/\D/g, '');
  const edad = Number(e.edad);
  // WhatsApp de cualquier país (desde 2026-11-17: hay creadores fuera de Venezuela)
  const telefono = whatsappInternacional(e.telefono);
  const cedula = String(e.pm_cedula ?? '').toUpperCase().replace(/[^VE0-9]/g, '');
  const pmCedula = /^[VE]\d{6,9}$/.test(cedula) ? cedula : /^\d{6,9}$/.test(cedula) ? 'V' + cedula : '';
  const pmTelefono = celular(e.pm_telefono);
  const pmBanco = String(e.pm_banco ?? '');
  // Pago Móvil: obligatorio en bolívares; en diamantes es opcional (si lo deja, completo)
  const conPm = preferencia === 'bolivares' || !!(cedula || String(e.pm_telefono ?? '').trim() || pmBanco);
  if (!preferencia) return { error: 'Elige cómo quieres cobrar: bolívares o diamantes.' };
  if (preferencia === 'diamantes' && !/^\d{5,15}$/.test(idJugador)) return { error: 'Para cobrar en diamantes escribe tu ID de Free Fire.' };
  if (!Number.isInteger(edad) || edad < 8 || edad > 99) return { error: 'Escribe tu edad.' };
  if (!telefono) return { error: 'Escribe tu WhatsApp con el código de tu país (ej: +58 414 1234567).' };
  if (conPm && !pmCedula) return { error: 'Escribe la cédula de tu Pago Móvil (ej: V12345678).' };
  if (conPm && !pmTelefono) return { error: 'Escribe el teléfono de tu Pago Móvil (ej: 0414-1234567).' };
  if (conPm && !BANCOS[pmBanco]) return { error: 'Elige el banco de tu Pago Móvil.' };
  return { datos: { preferencia, id_jugador: idJugador || null, edad, telefono,
    pm_cedula: conPm ? pmCedula : null, pm_telefono: conPm ? pmTelefono : null, pm_banco: conPm ? pmBanco : null } };
}

// Lo que ve el creador de sus datos (sin nada que no haga falta)
const perfilVisible = (f) => (f && typeof f === 'object' ? {
  preferencia: f.preferencia === 'diamantes' ? 'diamantes' : 'bolivares', id_jugador: f.id_jugador || '', edad: Number(f.edad) || null,
  telefono: String(f.telefono || ''), pm_cedula: String(f.pm_cedula || ''), pm_telefono: String(f.pm_telefono || ''),
  // (sin Pago Móvil, los tres pm_* llegan vacíos: cobra en diamantes)
  pm_banco: String(f.pm_banco || ''), banco: BANCOS[f.pm_banco] || '', actualizado: f.actualizado || null,
} : null);

const numero = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
// Sin tasa del dólar en la hoja, los montos en USD llegan como null (no se inventan)
const numeroONulo = (v) => (v === null || v === undefined || v === '' ? null : numero(v));

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ status: "error", message: "Método no permitido" });
  // ¿Hay inscripciones abiertas? (sin sesión: solo el estado y los cupos que quedan, sin datos de nadie)
  if (req.body?.accion === 'inscripcion') return estadoInscripcion(res);
  // Desde 2026-11-13 el panel es SOLO con Google: el código + PIN ya no abre nada
  if (req.body?.cuenta !== true) {
    return res.status(410).json({ status: "error", encontrado: false, message: "Ahora entras a tu panel con tu cuenta de Google. Pídenos tu acceso por WhatsApp." });
  }
  return panelPorCuenta(req, res);
}

// "Entrar con Google": el usuario sale del token (Supabase lo comprueba), nunca de lo que mande la página
async function panelPorCuenta(req, res) {
  if (!supabaseActivo()) return res.status(503).json({ status: "error", message: "El panel no está disponible ahora. Intenta de nuevo en unos minutos." });
  const usuario = await usuarioDelToken(tokenDe(req));
  if (!usuario) return res.status(401).json({ status: "error", sesion: false, message: "Tu sesión venció. Vuelve a entrar con Google." });
  if (req.body?.accion === 'inscribir') return inscribir(req, res, usuario);
  if (req.body?.accion === 'perfil') {
    const { datos, error } = limpiarPerfil(req.body?.datos);
    if (error) return res.status(400).json({ status: "error", message: error });
    try {
      const guardado = await rpc('creador_guardar_perfil', { p_usuario: usuario, p_datos: datos });
      return res.status(200).json({ status: "success", perfil: perfilVisible(guardado) });
    } catch (e) {
      console.error("Error al guardar los datos del creador:", e.message);
      const sinCodigo = /42501/.test(e.message);
      return res.status(sinCodigo ? 403 : 503).json({ status: "error", message: sinCodigo
        ? "Tu cuenta no tiene código de creador. Pide tu acceso por WhatsApp."
        : "No pudimos guardar tus datos. Revisa que estén bien e intenta de nuevo." });
    }
  }
  try {
    const d = await rpc('creador_por_usuario', { p_usuario: usuario });
    const codigos = (Array.isArray(d?.codigos) ? d.codigos : []).filter(Boolean).map((c) => {
      const pendienteUsd = numeroONulo(c.pendienteUsd);
      return {
        ...respuestaPanel({
          ...c, descuentoSeguidores: c.porcentaje, comisionPorcentaje: c.porcentaje, retiroMinimoUsd: RETIRO_MINIMO_USD,
          faltaParaRetiroUsd: pendienteUsd !== null ? Math.max(0, Math.round((RETIRO_MINIMO_USD - pendienteUsd) * 100) / 100) : null,
        }),
        activo: c.activo !== false,
      };
    });
    return res.status(200).json({ status: "success", correo: String(d?.correo || ''), perfil: perfilVisible(d?.perfil), codigos });
  } catch (error) {
    console.error("Error en el panel de creadores (Google):", error.message);
    return res.status(503).json({ status: "error", message: "No pudimos abrir tu panel ahora. Intenta de nuevo en unos segundos." });
  }
}

async function estadoInscripcion(res) {
  if (!supabaseActivo()) return res.status(200).json({ status: "success", abierta: false, quedan: 0, minimo: 10 });
  try {
    const e = (await rpc('creadores_inscripcion_estado', {})) || {};
    return res.status(200).json({ status: "success", abierta: e.abierta === true, quedan: numero(e.quedan), minimo: numero(e.minimo) || 10 });
  } catch (error) {
    console.error("Error al leer las inscripciones de creadores:", error.message);
    return res.status(503).json({ status: "error", message: "No pudimos revisar las inscripciones. Intenta de nuevo en unos segundos." });
  }
}

// El usuario sale del token (ya comprobado); la base revisa cupos, código repetido, cuenta y WhatsApp
async function inscribir(req, res, usuario) {
  const { datos, error } = limpiarInscripcion(req.body);
  if (error) return res.status(400).json({ status: "error", message: error });
  try {
    const r = await rpc('creador_inscribir', { p_usuario: usuario, p_codigo: datos.codigo, p_whatsapp: datos.whatsapp, p_enlace: datos.enlace });
    if (r?.ok !== true) {
      return res.status(r?.cerrada ? 409 : 400).json({ status: "error", cerrada: r?.cerrada === true, message: String(r?.error || 'No pudimos inscribirte. Revisa tus datos.').slice(0, 200) });
    }
    console.info(`⭐ Creador inscrito: ${r.codigo} (quedan ${r.quedan} cupos)`);
    return res.status(200).json({ status: "success", codigo: String(r.codigo), quedan: numero(r.quedan) });
  } catch (e) {
    console.error("Error al inscribir un creador:", e.message);
    return res.status(503).json({ status: "error", message: "No pudimos inscribirte ahora. Intenta de nuevo en unos segundos." });
  }
}

const NOMBRES_JUEGO = {
  freefire: 'Free Fire', bloodstrike: 'Blood Strike', mobilelegends: 'Mobile Legends', roblox: 'Roblox',
  fcmobile: 'FC Mobile', codmobile: 'COD Mobile', clashroyale: 'Clash Royale',
};

function respuestaPanel(datos) {
  const movimientos = Array.isArray(datos.movimientos) ? datos.movimientos.slice(0, 10) : [];
  return {
    status: "success",
    encontrado: true,
    codigo: String(datos.codigo),
    descuentoSeguidores: numero(datos.descuentoSeguidores),
    usos: numero(datos.usos),
    ventasBs: numero(datos.ventasBs),
    comisionPorcentaje: numero(datos.comisionPorcentaje),
    comisionTotalUsd: numeroONulo(datos.comisionTotalUsd),
    pendienteUsd: numeroONulo(datos.pendienteUsd),
    retiroMinimoUsd: numero(datos.retiroMinimoUsd),
    faltaParaRetiroUsd: numeroONulo(datos.faltaParaRetiroUsd),
    tasa: datos.tasa ? numero(datos.tasa) : null,
    // Inscritos: ventas de esta semana contra el mínimo (cierra = lunes 00:00 de Venezuela)
    inscrito: datos.inscrito === true,
    baja: datos.baja === 'ventas_semana' || datos.baja === 'admin' ? datos.baja : null,
    semana: datos.semana && typeof datos.semana === 'object' ? {
      ventas: numero(datos.semana.ventas), minimo: numero(datos.semana.minimo) || 10,
      cierra: String(datos.semana.cierra || '').slice(0, 40), primera: datos.semana.primera === true,
    } : null,
    movimientos: movimientos.map((m) => ({
      fecha: String(m.fecha || '').slice(0, 20),
      juego: String(NOMBRES_JUEGO[m.juego] || m.juego || '').slice(0, 20),
      ventaBs: numero(m.ventaBs),
      comisionUsd: numeroONulo(m.comisionUsd),
    })),
  };
}
