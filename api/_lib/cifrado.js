// CIFRADO de datos sensibles que se guardan en Supabase (la contraseña del cliente en las tiendas manuales).
// AES-256-GCM: la base solo guarda texto cifrado; la llave vive en Vercel y nunca llega al navegador.
//   CLAVE_MANUALES        llave propia (recomendada; cualquier texto largo y aleatorio)
//   SCRIPT_RECARGAS_TOKEN respaldo mientras no exista CLAVE_MANUALES
// Cada texto cifrado dice con cuál se hizo ("m1:" o "t1:"), así que poner CLAVE_MANUALES después no impide
// leer los anteriores (mientras el token siga igual).
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const FUENTES = {
  m1: () => process.env.CLAVE_MANUALES,
  t1: () => process.env.SCRIPT_RECARGAS_TOKEN,
};

function llave(version) {
  const secreto = String(FUENTES[version]?.() || '').trim();
  return secreto ? createHash('sha256').update(`levelup:manuales:${secreto}`).digest() : null;
}

/** Texto → "m1:<iv>.<etiqueta>.<cifrado>" (base64url). Lanza si no hay ninguna llave en Vercel. */
export function cifrar(texto) {
  const version = llave('m1') ? 'm1' : 't1';
  const k = llave(version);
  if (!k) throw new Error('falta CLAVE_MANUALES (o SCRIPT_RECARGAS_TOKEN) en Vercel');
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', k, iv);
  const datos = Buffer.concat([c.update(String(texto), 'utf8'), c.final()]);
  return `${version}:${[iv, c.getAuthTag(), datos].map((b) => b.toString('base64url')).join('.')}`;
}

/** Lo contrario de cifrar. Lanza si el texto no es válido o la llave cambió. */
export function descifrar(guardado) {
  const [version, resto] = String(guardado || '').split(':');
  const k = llave(version);
  if (!k || !resto) throw new Error('no se puede descifrar (falta la llave o el texto no es válido)');
  const [iv, etiqueta, datos] = resto.split('.').map((t) => Buffer.from(t, 'base64url'));
  const d = createDecipheriv('aes-256-gcm', k, iv);
  d.setAuthTag(etiqueta);
  return Buffer.concat([d.update(datos), d.final()]).toString('utf8');
}
