import { obtenerIp, minutosBloqueado, registrarFallo } from './_lib/limitador.js';
import { llamarScript, LECTURA_APPS_SCRIPT } from './_lib/externo.js';
import { faltaConfiguracion } from './_lib/validacion.js';
import { CODIGO_DESCUENTO_VALIDO, normalizarCodigoDescuento } from './_lib/descuentos.js';

// Panel de creadores: POST { codigo, pin } -> nivel, ventas, comisión y últimos movimientos.
// Los datos viven en la hoja de Free Fire (pestañas "Descuentos" y "movimientos_descuentos",
// acción consultar_creador de recargas.gs). El PIN protege las ganancias de cada creador:
// los intentos fallidos se limitan por IP y por código (frena que se adivine el PIN).
const PIN_VALIDO = /^\d{4,8}$/;
const NO_ENCONTRADO = "Código o PIN incorrecto. Si eres creador y no tienes tu PIN, pídelo por WhatsApp.";

const numero = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

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

    // Solo los campos que muestra la página, nunca la respuesta cruda de Apps Script
    const movimientos = Array.isArray(datos.movimientos) ? datos.movimientos.slice(0, 10) : [];
    return res.status(200).json({
      status: "success",
      encontrado: true,
      codigo: String(datos.codigo),
      nivel: { nombre: String(datos.nivel?.nombre || ''), descuento: numero(datos.nivel?.descuento) },
      siguienteNivel: datos.siguienteNivel
        ? { nombre: String(datos.siguienteNivel.nombre), descuento: numero(datos.siguienteNivel.descuento), faltanUsos: numero(datos.siguienteNivel.faltanUsos) }
        : null,
      descuentoSeguidores: numero(datos.descuentoSeguidores),
      usos: numero(datos.usos),
      ventasBs: numero(datos.ventasBs),
      comisionPorcentaje: numero(datos.comisionPorcentaje),
      comisionTotalUsd: numero(datos.comisionTotalUsd),
      pagadoUsd: numero(datos.pagadoUsd),
      saldoUsd: numero(datos.saldoUsd),
      retiroMinimoUsd: numero(datos.retiroMinimoUsd),
      faltaParaRetiroUsd: numero(datos.faltaParaRetiroUsd),
      tasa: datos.tasa ? numero(datos.tasa) : null,
      movimientos: movimientos.map((m) => ({
        fecha: String(m.fecha || '').slice(0, 20),
        juego: String(m.juego || '').slice(0, 20),
        ventaBs: numero(m.ventaBs),
        comisionUsd: numero(m.comisionUsd),
      })),
    });
  } catch (error) {
    console.error("Error en el panel de creadores:", error.message);
    return res.status(503).json({ status: "error", message: "No pudimos consultar tu panel ahora. Intenta de nuevo en unos segundos." });
  }
}
