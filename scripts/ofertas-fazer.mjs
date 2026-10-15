// Muestra las categorías y ofertas de FazerCards para rellenar OFERTAS_FAZER en
// api/_lib/juegos/freefire.js (no toca nada: solo lee el catálogo).
//
// Uso (PowerShell), con la misma clave FAZER_API_KEY que tiene Vercel:
//   $env:FAZER_API_KEY="tu_clave"; node scripts/ofertas-fazer.mjs            # busca "free fire"
//   $env:FAZER_API_KEY="tu_clave"; node scripts/ofertas-fazer.mjs blood      # busca otro juego
const API = "https://api.fzr.cards/api/v2";
const clave = (process.env.FAZER_API_KEY || "").trim();
const buscado = (process.argv[2] || "free fire").toLowerCase().replace(/[^a-z0-9]/g, "");
if (!clave) {
  console.error('Falta FAZER_API_KEY. Ejemplo: $env:FAZER_API_KEY="tu_clave"; node scripts/ofertas-fazer.mjs');
  process.exit(1);
}

async function pedir(ruta) {
  const respuesta = await fetch(API + ruta, { headers: { "X-API-Key": clave } });
  const texto = await respuesta.text();
  if (!respuesta.ok) throw new Error(`HTTP ${respuesta.status} en ${ruta}: ${texto.slice(0, 300)}`);
  return JSON.parse(texto);
}
// La API mezcla formatos: se busca la primera lista dentro de la respuesta
const lista = (datos) => (Array.isArray(datos) ? datos : Object.values(datos || {}).find(Array.isArray) || []);

const categorias = lista(await pedir("/topups?limit=500"))
  .filter((c) => JSON.stringify(c).toLowerCase().replace(/[^a-z0-9]/g, "").includes(buscado));
if (!categorias.length) {
  console.log(`No hay categorías que coincidan con "${process.argv[2] || "free fire"}".`);
  process.exit(0);
}
for (const c of categorias) {
  const id = c.id ?? c.category_id;
  console.log(`\n=== Categoría: ${c.name ?? c.title ?? ""}  ->  CATEGORIA_FAZER = "${id}"`);
  const ofertas = await pedir(`/topups/offers?category_id=${encodeURIComponent(id)}`);
  const campos = ofertas.fields ?? ofertas.data?.fields;
  if (campos) console.log("Campos que pide (CAMPO_JUGADOR_FAZER):", JSON.stringify(campos));
  for (const o of lista(ofertas)) {
    console.log(`  "${o.id ?? o.offer_id}"  ${o.name ?? o.title ?? ""}  ${o.price ?? ""} ${o.currency ?? ""}`);
  }
}
