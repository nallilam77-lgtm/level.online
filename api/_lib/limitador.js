// Límite de intentos FALLIDOS de recarga, compartido entre todas las instancias de Vercel.
// Frena que alguien adivine referencias de pago ajenas probando combinaciones de 5 dígitos.
//
// Usa Supabase (tabla "limites" y funciones limite_minutos / limite_fallo de supabase/tienda.sql; antes
// Firestore, hasta 2026-11-13: así Vercel ya no carga firebase-admin, que alargaba el arranque en frío).
// Sin Supabase, o si no responde, cae a memoria local: protección débil, porque cada instancia cuenta
// por separado. Nunca frena una recarga: cada llamada tiene tiempo límite (_lib/supabase.js).
// (Los archivos con "_" dentro de /api no se publican como endpoints en Vercel.)
import { createHash } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { waitUntil } from '@vercel/functions';
import { supabaseActivo, rpc } from './supabase.js';

const VENTANA_MS = 30 * 60 * 1000;  // los fallos se cuentan dentro de 30 minutos
const BLOQUEO_MS = 60 * 60 * 1000;  // al llegar al máximo se bloquea 1 hora
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

let avisoSinSupabase = false;
function usarSupabase() {
  if (supabaseActivo()) return true;
  if (!avisoSinSupabase) {
    console.error("⚠️ limitador: Supabase no está configurado. Usando memoria local (protección débil).");
    avisoSinSupabase = true;
  }
  return false;
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

function minutosEnMemoria(claves, ahora) {
  const hasta = Math.max(0, ...claves.map((c) => memoria.get(c)?.bloqueadoHasta || 0));
  return hasta > ahora ? Math.ceil((hasta - ahora) / 60000) : 0;
}

// Devuelve los minutos que faltan del bloqueo más largo entre las claves, o 0 si no hay bloqueo
export async function minutosBloqueado(claves) {
  const ahora = Date.now();
  // La memoria cuenta también: si Supabase falló al anotar, el bloqueo quedó aquí
  const enMemoria = minutosEnMemoria(claves, ahora);
  if (!usarSupabase()) return enMemoria;
  try {
    const minutos = Number(await rpc('limite_minutos', { p_claves: claves.map(idDocumento) })) || 0;
    return Math.max(minutos, enMemoria);
  } catch (error) {
    console.error("❌ limitador: no se pudo leer Supabase:", error.message);
    return enMemoria;
  }
}

export async function registrarFallo(claves) {
  if (usarSupabase()) {
    try {
      await rpc('limite_fallo', {
        p_claves: claves.map(idDocumento), p_maximos: claves.map(maximoPara),
        p_ventana_s: VENTANA_MS / 1000, p_bloqueo_s: BLOQUEO_MS / 1000,
      });
      return;
    } catch (error) {
      console.error("❌ limitador: no se pudo escribir en Supabase:", error.message);
    }
  }
  const ahora = Date.now();
  for (const clave of claves) guardarEnMemoria(clave, siguienteEstado(memoria.get(clave), clave, ahora));
}

// Límite de USO para lo que gasta recursos (Drive, cuota de Gemini) o deja consultar datos: cada llamada
// cuenta. Devuelve los minutos de bloqueo (0 = adelante). El conteo se anota después de responder
// (waitUntil) para no sumar la escritura a la espera del cliente.
export async function permitirUso(clave) {
  const minutos = await minutosBloqueado([clave]);
  if (minutos > 0) return minutos;
  waitUntil(registrarFallo([clave]).catch((error) => console.error("❌ limitador: no se pudo contar el uso:", error.message)));
  return 0;
}
