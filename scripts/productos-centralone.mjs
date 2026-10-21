// Diagnóstico: muestra el saldo y los productos de Central One (no compra nada). Los productos de la
// tienda se cargan desde la hoja: menú "🩸 Blood Strike → 🔄 Traer productos de Central One".
//
// Uso (PowerShell), con la misma llave de Central One que tiene Vercel en blood_nuevo:
//   $env:blood_nuevo="co_live_..."; node scripts/productos-centralone.mjs            # busca "blood strike"
//   $env:blood_nuevo="co_live_..."; node scripts/productos-centralone.mjs free fire  # busca otro juego
const API = "https://portal.centraloneglobal.com/api/v1";
const clave = (process.env.blood_nuevo || "").trim();
const textoBuscado = process.argv.slice(2).join(" ") || "blood strike";
const normalizar = (t) => String(t ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const buscado = normalizar(textoBuscado);
if (!clave) {
  console.error('Falta blood_nuevo. Ejemplo: $env:blood_nuevo="co_live_..."; node scripts/productos-centralone.mjs');
  process.exit(1);
}

async function pedir(ruta) {
  const respuesta = await fetch(API + ruta, { headers: { Authorization: `Bearer ${clave}` } });
  const texto = await respuesta.text();
  if (!respuesta.ok) throw new Error(`HTTP ${respuesta.status} en ${ruta}: ${texto.slice(0, 300)}`);
  return JSON.parse(texto);
}

const saldo = await pedir("/balance").catch((e) => ({ error: e.message }));
console.log(saldo.error ? `Saldo: no disponible (${saldo.error})` : `Saldo disponible: ${saldo.available_balance} ${saldo.currency} (retenido ${saldo.held_balance})`);

const { items = [] } = await pedir("/catalog");
const productos = items.filter((p) => [p.product_family_name, p.name, p.sku].some((t) => normalizar(t).includes(buscado)));
if (!productos.length) {
  console.log(`\nNo hay productos que coincidan con "${textoBuscado}". Familias de tu catálogo:`);
  for (const familia of new Set(items.map((p) => p.product_family_name))) console.log(`  - ${familia}`);
  process.exit(0);
}

console.log(`\n=== ${productos.length} producto(s) de "${textoBuscado}" ===`);
for (const p of productos) {
  const campos = (p.target_schema || []).map((c) => c.type === "select" ? `${c.key} (elegir: ${(c.options || []).map((o) => o.value).join(" | ")})` : c.key);
  console.log(`\n  "${p.product_id}"  ${p.name}`);
  console.log(`     precio ${p.reseller_price} ${p.currency} · ${p.in_stock ? "con stock" : "SIN STOCK"} · región ${p.region} · pide: ${campos.join(", ") || "nada"}`);
}
