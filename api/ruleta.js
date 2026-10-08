import { randomInt } from 'node:crypto';
import { llamarScript } from './_lib/externo.js';
import { obtenerDb, conTiempoLimite } from './_lib/firestore.js';
import { obtenerIp, minutosBloqueado, registrarFallo } from './_lib/limitador.js';
import { faltaConfiguracion } from './_lib/validacion.js';

// RULETA DE LA SUERTE (página de inicio)
// - El premio lo sortea SOLO este servidor (crypto.randomInt); el navegador solo anima la rueda.
// - Un giro por pago: Apps Script confirma que la referencia es un pago "Usado" (recarga completada)
//   y Firestore guarda el resultado en GirosRuleta/{referencia completa} con create(), que falla
//   si el documento ya existe. Dos peticiones simultáneas con la misma referencia: solo una gana.
// - Las referencias que no existen cuentan como intento fallido (limitador por IP) para frenar
//   a quien pruebe combinaciones de 5 dígitos.

const COLECCION_GIROS = 'GirosRuleta';
const TIEMPO_FIRESTORE_MS = 4000;
const MENSAJE_NO_DISPONIBLE = "La ruleta no está disponible en este momento. Intenta de nuevo en unos minutos.";

// Premios y su probabilidad (peso / suma de pesos). Para cambiar premios o probabilidades,
// edita SOLO esta tabla y las casillas de abajo.
const PREMIOS = {
  // Se entrega en el juego de la recarga (lo que prometía cada página antes de unificar la ruleta)
  premioMayor: { texto: 'Premio mayor 🎁 (100 💎 Free Fire · 50 Robux · 100 🪙 Blood Strike)', ganador: true, peso: 2 },
  vacio: { texto: 'Sin premio esta vez', ganador: false, peso: 98 },
};

// Casillas que dibuja la rueda, en orden horario desde arriba. Son solo visuales:
// la probabilidad la fija el peso del premio, no cuántas casillas tenga.
const CASILLAS = [
  { premio: 'premioMayor', etiqueta: '🎁 PREMIO' },
  { premio: 'vacio', etiqueta: 'Vacío' },
  { premio: 'vacio', etiqueta: 'Suerte' },
  { premio: 'vacio', etiqueta: 'Vacío' },
  { premio: 'premioMayor', etiqueta: '🎁 PREMIO' },
  { premio: 'vacio', etiqueta: 'Vacío' },
  { premio: 'vacio', etiqueta: 'Suerte' },
  { premio: 'vacio', etiqueta: 'Vacío' },
];
const ETIQUETAS_CASILLAS = CASILLAS.map((c) => c.etiqueta);

function sortearPremio() {
  const claves = Object.keys(PREMIOS);
  const total = claves.reduce((suma, clave) => suma + PREMIOS[clave].peso, 0);
  let numero = randomInt(total);
  const clave = claves.find((c) => (numero -= PREMIOS[c].peso) < 0);
  // Casilla donde se detiene la rueda: una al azar entre las que muestran ese premio
  const casillas = CASILLAS.map((c, i) => (c.premio === clave ? i : -1)).filter((i) => i >= 0);
  return { clave, casilla: casillas[randomInt(casillas.length)] };
}

// Respuesta para una referencia que ya giró (no incluye la referencia completa)
function respuestaYaJugado(res, giro) {
  return res.status(200).json({
    status: "success",
    jugado: true,
    premio: giro.premio,
    ganador: Boolean(giro.ganador),
    fecha: giro.creadoEn?.toDate ? giro.creadoEn.toDate().toISOString() : null,
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ status: "error", message: "Método no permitido." });
  }

  try {
    const referencia = String(req.body?.referencia ?? '').replace(/\s+/g, '');
    // Últimos 5 dígitos (como en las recargas) o la referencia completa
    if (!/^\d{5,20}$/.test(referencia)) {
      return res.status(400).json({ status: "error", message: "Escribe los últimos 5 dígitos de la referencia de tu pago (solo números)." });
    }

    const URL_GOOGLE_SCRIPT = (process.env.SCRIPT_RECARGAS_URL || '').trim();
    if (!URL_GOOGLE_SCRIPT) {
      return faltaConfiguracion(res, ['SCRIPT_RECARGAS_URL'], { status: "error", message: MENSAJE_NO_DISPONIBLE });
    }
    // Sin Firestore no se puede garantizar un solo giro por pago: la ruleta se apaga
    const db = await obtenerDb();
    if (!db) {
      return faltaConfiguracion(res, ['FIREBASE_SERVICE_ACCOUNT'], { status: "error", message: MENSAJE_NO_DISPONIBLE });
    }

    const clavesLimite = [`ip:${obtenerIp(req)}`];
    const minutosEspera = await minutosBloqueado(clavesLimite);
    if (minutosEspera > 0) {
      return res.status(429).json({ status: "error", message: `Demasiados intentos con referencias no válidas. Intenta de nuevo en ${minutosEspera} minutos.` });
    }

    // 1. ¿Es un pago con recarga completada? (solo lectura: se puede reintentar sin riesgo)
    const consulta = await llamarScript(URL_GOOGLE_SCRIPT, { accion: "consultar_ruleta", referencia },
      { reintentos: 2, tiempoMs: 12000, reintentarTrasTimeout: true });
    if (consulta?.status !== 'success' || !Array.isArray(consulta.candidatos)) {
      console.error("❌ ruleta: el Apps Script de recargas no reconoce consultar_ruleta (¿falta pegar la versión nueva de recargas.gs?):", consulta?.message);
      return res.status(503).json({ status: "error", message: MENSAJE_NO_DISPONIBLE });
    }
    const candidatos = consulta.candidatos.filter((c) => /^\d{5,20}$/.test(String(c?.referencia || '')));
    if (!candidatos.length) {
      await registrarFallo(clavesLimite);
      return res.status(404).json({ status: "error", message: "No encontramos una recarga completada con esa referencia. Revisa los dígitos; la ruleta se activa cuando tu recarga ya fue entregada." });
    }

    // 2. ¿Alguno de esos pagos todavía no ha girado? (varios pagos pueden terminar en los mismos 5 dígitos)
    const coleccion = db.collection(COLECCION_GIROS);
    const documentos = await conTiempoLimite(db.getAll(...candidatos.map((c) => coleccion.doc(String(c.referencia)))), TIEMPO_FIRESTORE_MS);
    const libre = candidatos.find((c, i) => !documentos[i].exists && !c.ruletaAnterior);
    if (!libre) {
      const masReciente = documentos[0];
      return respuestaYaJugado(res, masReciente.exists
        ? masReciente.data()
        : { premio: "Registrado en la ruleta anterior (consulta tu premio por WhatsApp)", ganador: false });
    }

    // 3. Sortear y QUEMAR el intento. create() es atómico: si otra petición se adelantó, falla.
    const { clave, casilla } = sortearPremio();
    const premio = PREMIOS[clave];
    const giro = {
      referencia: String(libre.referencia),
      premio: premio.texto,
      clavePremio: clave,
      ganador: premio.ganador,
      casilla,
      idJugador: String(libre.idJugador || ''),
      paquete: String(libre.paquete || ''),
      entregado: false,
      creadoEn: new Date(),
    };
    const documento = coleccion.doc(giro.referencia);
    try {
      await conTiempoLimite(documento.create(giro), TIEMPO_FIRESTORE_MS);
    } catch (error) {
      if (error.code === 6) { // ALREADY_EXISTS: la otra petición ganó; se muestra su resultado
        const existente = await conTiempoLimite(documento.get(), TIEMPO_FIRESTORE_MS);
        return respuestaYaJugado(res, existente.data());
      }
      throw error;
    }

    // 4. Ganadores: se anotan en la pestaña "ruleta" para entregar el premio.
    // Firestore ya guardó el giro, así que un fallo aquí solo queda en los logs.
    if (premio.ganador) {
      try {
        await llamarScript(URL_GOOGLE_SCRIPT, {
          accion: "registrar_premio_ruleta",
          referencia: giro.referencia, idJugador: giro.idJugador, paquete: giro.paquete, premio: giro.premio,
        }, { tiempoMs: 6000 });
      } catch (error) {
        console.error(`⚠️ ruleta: ganador NO anotado en la hoja (está en Firestore ${COLECCION_GIROS}/${giro.referencia}):`, error.message);
      }
    }

    return res.status(200).json({
      status: "success",
      jugado: false,
      premioGenerado: premio.texto,
      ganador: premio.ganador,
      casilla,
      casillas: ETIQUETAS_CASILLAS,
    });

  } catch (error) {
    // Apps Script o Firestore lentos/caídos: nunca 500 ni detalles internos al cliente
    console.error("Error en ruleta.js:", error.message);
    return res.status(503).json({ status: "error", message: MENSAJE_NO_DISPONIBLE });
  }
}
