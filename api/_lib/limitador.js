// Límite de intentos FALLIDOS de recarga, compartido entre todas las instancias de Vercel.
// Frena que alguien adivine referencias de pago ajenas probando combinaciones de 5 dígitos.
//
// Usa Firestore (firebase-admin) si existe la variable FIREBASE_SERVICE_ACCOUNT.
// Sin ella cae a memoria local: protección débil, porque cada instancia cuenta por separado.
// (Los archivos con "_" dentro de /api no se publican como endpoints en Vercel.)
import { createHash } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { waitUntil } from '@vercel/functions';

const COLECCION = 'limites_recarga';
const VENTANA_MS = 30 * 60 * 1000;  // los fallos se cuentan dentro de 30 minutos
const BLOQUEO_MS = 60 * 60 * 1000;  // al llegar al máximo se bloquea 1 hora
// Firestore nunca debe frenar una recarga: si tarda más que esto se usa la memoria local
const TIEMPO_FIRESTORE_MS = 2500;
const MAX_CLAVES_EN_MEMORIA = 10000;

// Fallos permitidos por tipo de clave. La IP tiene más margen porque en Venezuela
// muchos clientes móviles comparten IP (CGNAT de las operadoras).
// "descuento": códigos de descuento inválidos por IP (frena que se adivinen probando).
// "panel" / "panelcodigo": PIN incorrecto en el panel de creadores, por IP y por código.
// Límites de USO (permitirUso: cuenta cada llamada, no solo los fallos), por IP en 30 minutos.
// Holgados: una compra normal sube 1-3 comprobantes y una conversación usa 10-20 mensajes.
// "subida": comprobantes a Drive · "chat": mensajes a Gemini · "consulta": consultar órdenes por ID.
// "fidelidad": consultas del premio de cliente fiel · "estado": seguimiento de pedidos manuales (cada 30 s).
const MAX_FALLOS = { ip: 15, jugador: 5, descuento: 10, panel: 8, panelcodigo: 20, subida: 30, chat: 60, consulta: 30, fidelidad: 60, estado: 150 };

let promesaDb = null;
let avisoSinFirestore = false;

// firebase-admin pesa: se importa solo si hay credenciales y solo la primera vez que se usa,
// para no alargar el arranque en frío de las funciones.
// También la usa _lib/fidelidad.js (premio de cliente fiel y paquetes más vendidos)
export function obtenerDb() {
  const cuenta = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!cuenta) {
    if (!avisoSinFirestore) {
      console.error("⚠️ limitador: falta FIREBASE_SERVICE_ACCOUNT. Usando memoria local (protección débil).");
      avisoSinFirestore = true;
    }
    return Promise.resolve(null);
  }
  if (!promesaDb) {
    promesaDb = (async () => {
      try {
        const [{ initializeApp, cert, getApps }, { getFirestore }] = await Promise.all([
          import('firebase-admin/app'),
          import('firebase-admin/firestore'),
        ]);
        const app = getApps().length ? getApps()[0] : initializeApp({ credential: cert(JSON.parse(cuenta)) });
        return getFirestore(app);
      } catch (error) {
        console.error("❌ limitador: FIREBASE_SERVICE_ACCOUNT inválida o firebase-admin no disponible:", error.message);
        return null;
      }
    })();
  }
  return promesaDb;
}

export function conTiempoLimite(promesa) {
  let temporizador;
  const limite = new Promise((_, rechazar) => {
    temporizador = setTimeout(() => rechazar(new Error(`Firestore tardó más de ${TIEMPO_FIRESTORE_MS} ms`)), TIEMPO_FIRESTORE_MS);
  });
  return Promise.race([promesa, limite]).finally(() => clearTimeout(temporizador));
}

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

// Cloudflare está delante del dominio: Vercel ve la IP del nodo de Cloudflare (x-real-ip), no la del
// cliente, y todos los clientes de ese nodo compartirían el mismo contador. La IP real viene en
// cf-connecting-ip, pero esa cabecera la puede inventar cualquiera que llame a Vercel saltándose
// Cloudflare: solo se cree si la petición llegó DESDE una IP de Cloudflare.
// Rangos oficiales: https://www.cloudflare.com/ips/ (cambian muy rara vez; revisar una vez al año).
const RANGOS_CLOUDFLARE = new BlockList();
[
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18',
  '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17',
  '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
].forEach((r) => { const [red, bits] = r.split('/'); RANGOS_CLOUDFLARE.addSubnet(red, Number(bits), 'ipv4'); });
[
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32',
  '2a06:98c0::/29', '2c0f:f248::/32',
].forEach((r) => { const [red, bits] = r.split('/'); RANGOS_CLOUDFLARE.addSubnet(red, Number(bits), 'ipv6'); });

function esDeCloudflare(ip) {
  const tipo = isIP(ip);
  return tipo !== 0 && RANGOS_CLOUDFLARE.check(ip, tipo === 6 ? 'ipv6' : 'ipv4');
}

export function obtenerIp(req) {
  const reenviada = req.headers['x-forwarded-for'];
  const ipConexion = String(req.headers['x-real-ip']
    || (reenviada ? String(reenviada).split(',')[0].trim() : '')
    || req.socket?.remoteAddress
    || '').trim();
  const ipCloudflare = String(req.headers['cf-connecting-ip'] || '').trim();
  if (ipCloudflare && isIP(ipCloudflare) && esDeCloudflare(ipConexion)) return ipCloudflare;
  return ipConexion || 'desconocida';
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

// Límite de USO para lo que gasta recursos (Drive, cuota de Gemini) o deja consultar datos: cada llamada
// cuenta. Devuelve los minutos de bloqueo (0 = adelante). El conteo se anota después de responder
// (waitUntil) para no sumar la escritura de Firestore a la espera del cliente.
export async function permitirUso(clave) {
  const minutos = await minutosBloqueado([clave]);
  if (minutos > 0) return minutos;
  waitUntil(registrarFallo([clave]).catch((error) => console.error("❌ limitador: no se pudo contar el uso:", error.message)));
  return 0;
}
