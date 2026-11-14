import { obtenerIp, minutosBloqueado, registrarFallo } from './_lib/limitador.js';
import { llamarScript, LECTURA_APPS_SCRIPT } from './_lib/externo.js';
import { faltaConfiguracion } from './_lib/validacion.js';
import { CODIGO_DESCUENTO_VALIDO, normalizarCodigoDescuento } from './_lib/descuentos.js';
import { supabaseActivo, rpc } from './_lib/supabase.js';

// Panel de creadores: POST { codigo, pin } -> ventas, comisión y últimos movimientos.
// Desde 2026-11-13 los datos viven en Supabase (función creador_panel de supabase/codigos.sql: compara
// el PIN cifrado). Si Supabase no responde, se usa la hoja de Free Fire (acción consultar_creador de
// recargas.gs, datos viejos de respaldo). El PIN protege las ganancias de cada creador:
// los intentos fallidos se limitan por IP y por código (frena que se adivine el PIN).
const RETIRO_MINIMO_USD = 3;
const PIN_VALIDO = /^\d{4,8}$/;
const NO_ENCONTRADO = "Código o PIN incorrecto. Si eres creador y no tienes tu PIN, pídelo por WhatsApp.";

const numero = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
// Sin tasa del dólar en la hoja, los montos en USD llegan como null (no se inventan)
const numeroONulo = (v) => (v === null || v === undefined || v === '' ? null : numero(v));

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ status: "error", message: "Método no permitido" });

  const codigo = normalizarCodigoDescuento(req.body?.codigo);
  const pin = String(req.body?.pin ?? '').trim();
  if (!CODIGO_DESCUENTO_VALIDO.test(codigo) || !PIN_VALIDO.test(pin)) {
    return res.status(400).json({ status: "error", message: "Escribe tu código y tu PIN (de 4 a 8 números)." });
  }

  const URL_GOOGLE_SCRIPT = process.env.SCRIPT_RECARGAS_URL;
  if (!URL_GOOGLE_SCRIPT) {
    return faltaConfiguracion(res, ["SCRIPT_RECARGAS_URL"], { status: "error", message: "El panel de creadores no está disponible en este momento." });
  }

  const clavesLimite = [`panel:${obtenerIp(req)}`, `panelcodigo:${codigo}`];
  const minutosEspera = await minutosBloqueado(clavesLimite);
  if (minutosEspera > 0) {
    return res.status(429).json({ status: "error", message: `Demasiados intentos incorrectos. Espera ${minutosEspera} minutos para volver a intentar.` });
  }

  if (supabaseActivo()) {
    try {
      const d = await rpc('creador_panel', { p_codigo: codigo, p_pin: pin });
      if (!d?.encontrado) {
        if (d?.sinPin) return res.status(200).json({ status: "success", encontrado: false, message: "Tu código todavía no tiene PIN de acceso. Pídelo por WhatsApp para ver tu panel." });
        await registrarFallo(clavesLimite);
        return res.status(200).json({ status: "success", encontrado: false, message: NO_ENCONTRADO });
      }
      const pendienteUsd = numeroONulo(d.pendienteUsd);
      return res.status(200).json(respuestaPanel({
        ...d,
        descuentoSeguidores: d.porcentaje, comisionPorcentaje: d.porcentaje, retiroMinimoUsd: RETIRO_MINIMO_USD,
        // Sin tasa en el panel admin, las ventas nuevas esperan en Bs y se suman al guardar la tasa
        faltaParaRetiroUsd: pendienteUsd !== null ? Math.max(0, Math.round((RETIRO_MINIMO_USD - pendienteUsd) * 100) / 100) : null,
      }));
    } catch (error) {
      console.error("⚠️ panel de creadores: Supabase no respondió, se usa la hoja:", error.message);
    }
  }

  try {
    // Solo lectura: se puede reintentar sin riesgo
    const datos = await llamarScript(URL_GOOGLE_SCRIPT, { accion: "consultar_creador", codigo, pin }, LECTURA_APPS_SCRIPT);
    if (datos?.status !== 'success') throw new Error(datos?.message || 'respuesta inválida de Apps Script');

    if (!datos.encontrado) {
      if (datos.sinPin) {
        return res.status(200).json({ status: "success", encontrado: false, message: "Tu código todavía no tiene PIN de acceso. Pídelo por WhatsApp para ver tu panel." });
      }
      await registrarFallo(clavesLimite);
      return res.status(200).json({ status: "success", encontrado: false, message: NO_ENCONTRADO });
    }

    return res.status(200).json(respuestaPanel(datos));
  } catch (error) {
    console.error("Error en el panel de creadores:", error.message);
    return res.status(503).json({ status: "error", message: "No pudimos consultar tu panel ahora. Intenta de nuevo en unos segundos." });
  }
}

// Solo los campos que muestra la página, nunca la respuesta cruda de Supabase o de Apps Script
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
    movimientos: movimientos.map((m) => ({
      fecha: String(m.fecha || '').slice(0, 20),
      juego: String(NOMBRES_JUEGO[m.juego] || m.juego || '').slice(0, 20),
      ventaBs: numero(m.ventaBs),
      comisionUsd: numeroONulo(m.comisionUsd),
    })),
  };
}
