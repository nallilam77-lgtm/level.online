// SUPABASE desde Vercel (sin librería: fetch a la API REST, arranque en frío mínimo).
// Tablas y funciones en supabase/levelup.sql. Variables (.env.example):
//   SUPABASE_URL          https://<proyecto>.supabase.co
//   SUPABASE_SECRET_KEY   llave secreta (sb_secret_… o la service_role vieja): SOLO aquí, salta el RLS
//   SUPABASE_PUBLISHABLE_KEY  llave pública (sb_publishable_… o la anon vieja): la recibe el navegador
// Sin URL o sin llave secreta, supabaseActivo() es false y nada de esto se usa (la tienda sigue igual).
// Ninguna función de aquí debe frenar una recarga: cada llamada tiene tiempo límite y quien la usa
// atrapa el error.

const TIEMPO_MS = 2500;

const base = () => (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const llaveSecreta = () => (process.env.SUPABASE_SECRET_KEY || '').trim();
const llavePublica = () => (process.env.SUPABASE_PUBLISHABLE_KEY || '').trim();

export const supabaseActivo = () => !!(base() && llaveSecreta());

// Las llaves nuevas (sb_secret_…) van solo en "apikey"; la service_role vieja (JWT) también en Authorization
function cabecerasServidor(extra = {}) {
  const llave = llaveSecreta();
  return { apikey: llave, ...(llave.startsWith('sb_') ? {} : { Authorization: `Bearer ${llave}` }), 'Content-Type': 'application/json', ...extra };
}

async function pedir(ruta, { method = 'GET', body, headers, tiempoMs = TIEMPO_MS } = {}) {
  const respuesta = await fetch(base() + ruta, {
    method, headers: cabecerasServidor(headers), signal: AbortSignal.timeout(tiempoMs),
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const texto = await respuesta.text();
  // Sin el cuerpo completo en el error: podría traer datos del cliente
  if (!respuesta.ok) throw new Error(`Supabase ${respuesta.status} en ${ruta.split('?')[0]}: ${texto.slice(0, 120)}`);
  return texto ? JSON.parse(texto) : null;
}

const filtro = (campos) => Object.entries(campos).map(([k, v]) => `${k}=eq.${encodeURIComponent(v)}`).join('&');

/** Llama a una función SQL (rpc). */
export const rpc = (funcion, args) => pedir(`/rest/v1/rpc/${funcion}`, { method: 'POST', body: args });

/** Filas de una tabla: leer('fidelidad', { juego, cuenta }, 'recargas,premio'). */
export const leer = (tabla, donde, columnas = '*') => pedir(`/rest/v1/${tabla}?select=${columnas}&${filtro(donde)}`);

/** Inserta una fila (o la reemplaza si choca con `conflicto`). */
export const guardar = (tabla, fila, conflicto) => pedir(`/rest/v1/${tabla}${conflicto ? `?on_conflict=${conflicto}` : ''}`, {
  method: 'POST', body: fila,
  headers: { Prefer: `${conflicto ? 'resolution=merge-duplicates,' : ''}return=minimal` },
});

/** Cambia las filas que cumplan `donde` (texto de filtro de PostgREST, p. ej. "id_pedido=eq.X&estado=neq.Y"). */
export const actualizar = (tabla, donde, datos) => pedir(`/rest/v1/${tabla}?${donde}`, {
  method: 'PATCH', body: datos, headers: { Prefer: 'return=minimal' },
});

/** UUID del cliente dueño de este token de sesión (el que manda la página), o null si no vale. */
export async function usuarioDelToken(token) {
  if (!supabaseActivo() || !/^[A-Za-z0-9._-]{20,4000}$/.test(String(token || ''))) return null;
  try {
    const respuesta = await fetch(`${base()}/auth/v1/user`, {
      headers: { apikey: llavePublica() || llaveSecreta(), Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIEMPO_MS),
    });
    if (!respuesta.ok) return null;
    const usuario = await respuesta.json();
    return /^[0-9a-f-]{36}$/i.test(String(usuario?.id || '')) ? usuario.id : null;
  } catch {
    return null;
  }
}

/** Lo que el navegador necesita para iniciar sesión (todo público). */
export const configuracionPublica = () => (base() && llavePublica() ? { supabaseUrl: base(), supabaseKey: llavePublica() } : {});
