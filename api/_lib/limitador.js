// Límite de intentos FALLIDOS de recarga, compartido entre todas las instancias de Vercel.
// Frena que alguien adivine referencias de pago ajenas probando combinaciones de 5 dígitos.
//
// Usa Firestore (firebase-admin) si existe la variable FIREBASE_SERVICE_ACCOUNT.
// Sin ella cae a memoria local: protección débil, porque cada instancia cuenta por separado.
// (Los archivos con "_" dentro de /api no se publican como endpoints en Vercel.)
import { createHash } from 'node:crypto';
import { obtenerDb, conTiempoLimite as limitarTiempo } from './firestore.js';

const COLECCION = 'limites_recarga';
const VENTANA_MS = 30 * 60 * 1000;  // los fallos se cuentan dentro de 30 minutos
const BLOQUEO_MS = 60 * 60 * 1000;  // al llegar al máximo se bloquea 1 hora
// Firestore nunca debe frenar una recarga: si tarda más que esto se usa la memoria local
const TIEMPO_FIRESTORE_MS = 2500;
const MAX_CLAVES_EN_MEMORIA = 10000;

// Fallos permitidos por tipo de clave. La IP tiene más margen porque en Venezuela
// muchos clientes móviles comparten IP (CGNAT de las operadoras).
const MAX_FALLOS = { ip: 15, jugador: 5 };

// Sin FIREBASE_SERVICE_ACCOUNT, obtenerDb() devuelve null y se usa la memoria local
const conTiempoLimite = (promesa) => limitarTiempo(promesa, TIEMPO_FIRESTORE_MS);

const memoria = new Map();
function guardarEnMemoria(clave, registro) {
  memoria.delete(clave);
  memoria.set(clave, registro);
  // Map conserva el orden de inserción: se descartan las claves más antiguas
  while (memoria.size > MAX_CLAVES_EN_MEMORIA) memoria.delete(memoria.keys().next().value);
}

// Las IPs y usuarios no se guardan en claro
const idDocumento = (clave) => createHash('sha256').update(clave).digest('hex');
const maximoPara = (clave) => MAX_FALLOS[clave.split(':')[0]] || 5;

export function obtenerIp(req) {
  const reenviada = req.headers['x-forwarded-for'];
  return req.headers['x-real-ip']
    || (reenviada ? String(reenviada).split(',')[0].trim() : '')
    || req.socket?.remoteAddress
    || 'desconocida';
}

async function leerRegistro(clave) {
  const firestore = await obtenerDb();
  if (firestore) {
    try {
      const snap = await conTiempoLimite(firestore.collection(COLECCION).doc(idDocumento(clave)).get());
      return snap.exists ? snap.data() : null;
    } catch (error) {
      console.error("❌ limitador: no se pudo leer Firestore:", error.message);
    }
  }
  return memoria.get(clave) || null;
}

function siguienteEstado(registro, clave, ahora) {
  const enVentana = registro && ahora - registro.inicioVentana < VENTANA_MS;
  const fallos = enVentana ? registro.fallos + 1 : 1;
  const bloquear = fallos >= maximoPara(clave);
  return {
    fallos: bloquear ? 0 : fallos,
    inicioVentana: enVentana && !bloquear ? registro.inicioVentana : ahora,
    bloqueadoHasta: bloquear ? ahora + BLOQUEO_MS : (registro?.bloqueadoHasta || 0),
  };
}

// Devuelve los minutos que faltan del bloqueo más largo entre las claves, o 0 si no hay bloqueo
export async function minutosBloqueado(claves) {
  const ahora = Date.now();
  const registros = await Promise.all(claves.map(leerRegistro));
  const hasta = Math.max(0, ...registros.map(r => r?.bloqueadoHasta || 0));
  return hasta > ahora ? Math.ceil((hasta - ahora) / 60000) : 0;
}

export async function registrarFallo(claves) {
  const ahora = Date.now();
  const firestore = await obtenerDb();

  await Promise.all(claves.map(async (clave) => {
    if (firestore) {
      try {
        const ref = firestore.collection(COLECCION).doc(idDocumento(clave));
        await conTiempoLimite(firestore.runTransaction(async (tx) => {
          const snap = await tx.get(ref);
          tx.set(ref, {
            ...siguienteEstado(snap.exists ? snap.data() : null, clave, ahora),
            // Campo para una política TTL de Firestore que borre registros viejos
            expira: new Date(ahora + VENTANA_MS + BLOQUEO_MS),
          });
        }));
        return;
      } catch (error) {
        console.error("❌ limitador: no se pudo escribir en Firestore:", error.message);
      }
    }
    guardarEnMemoria(clave, siguienteEstado(memoria.get(clave), clave, ahora));
  }));
}
