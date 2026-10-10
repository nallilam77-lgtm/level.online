// Juegos con tienda. Lista cerrada: el nombre llega del cliente (?juego=...), así que solo
// se acepta una clave propia de este objeto (nada de "__proto__", "constructor"...).
// Carga diferida: cada petición solo carga el módulo de su juego (menos arranque en frío) y un
// error en un módulo no afecta a los otros. Las rutas van escritas tal cual para que Vercel
// incluya los tres archivos en el paquete de la función.
const JUEGOS = {
  freefire: () => import('./freefire.js'),
  bloodstrike: () => import('./bloodstrike.js'),
  roblox: () => import('./roblox.js'),
};

// Devuelve el módulo del juego, o null si el nombre no es válido
export async function cargarJuego(nombre) {
  if (typeof nombre !== 'string' || !Object.hasOwn(JUEGOS, nombre)) return null;
  return JUEGOS[nombre]();
}
