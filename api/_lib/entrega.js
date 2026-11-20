// =========================================================================
// ENTREGA DE UN PAQUETE SIN PAGO DE POR MEDIO (premios y devoluciones de la Arena; juego-servidor/ARENA.md)
//
// entregarPaquete({ juego, paquete, idJugador, zona, idPedido, idFila, nota }) pide el paquete a Central One con el
// ID del jugador y deja su fila en "recargas" (Panel → Pedidos / Revisión; precio vacío porque no hubo cobro).
// Idempotency-Key como cada tienda (api/centralone-webhook.js la reconoce y actualiza la fila):
//   Free Fire "ff-<idPedido>" (paquete partido en N pedidos: "-1", "-2"…), Mobile Legends "ml-<idPedido>",
//   Blood Strike "<idPedido>". Repetir con el MISMO idPedido nunca cobra dos veces en Central One
//   (devuelve el mismo pedido); para volver a intentar algo rechazado hay que usar otro idPedido.
// idFila: id_pedido de la fila en "recargas" (por defecto idPedido). Un reintento usa "<idFila>-r<N>" como
// idPedido: el webhook le quita el "-r<N>" y actualiza la misma fila.
// Devuelve { estado: 'entregado' | 'en_proceso' | 'rechazo' | 'incierto' | 'no_disponible', motivo, ordenes }.
// =========================================================================
import { rpc, guardar } from './supabase.js';
import { datosParaPedido, crearPedidoCentralOne } from './centralone.js';

const PRODUCTO = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const JUEGOS_ENTREGA = {
  freefire: { nombre: 'Free Fire', llave: () => process.env.freefire_nuevo, clave: (id, i, n) => `ff-${id}${n > 1 ? `-${i + 1}` : ''}` },
  bloodstrike: { nombre: 'Blood Strike', llave: () => process.env.blood_nuevo, clave: (id, i, n) => `${id}${n > 1 ? `-${i + 1}` : ''}` },
  mobilelegends: { nombre: 'Mobile Legends', zona: true, llave: () => process.env.mlbb_nuevo || process.env.blood_nuevo, clave: (id, i, n) => `ml-${id}${n > 1 ? `-${i + 1}` : ''}` },
};

/** Fila de "precios" del paquete: { precio (lo que se cobra hoy), productos: [product_id × cantidad] } o null. */
export async function paqueteDe(juego, paquete) {
  const filas = await rpc('precios_de', { p_juego: juego });
  const f = (Array.isArray(filas) ? filas : []).find((x) => String(x.paquete).trim() === String(paquete).trim());
  if (!f || !PRODUCTO.test(String(f.producto || ''))) return null;
  const precio = Number(f.precio_cobro ?? f.precio);
  return {
    precio: Number.isFinite(precio) && precio > 0 ? precio : null,
    activo: f.activo !== false && f.en_stock !== false,
    productos: Array(Math.max(1, Math.min(9, Number(f.cantidad) || 1))).fill(String(f.producto).toLowerCase()),
  };
}

export async function entregarPaquete({ juego, paquete, idJugador, zona = '', idPedido, idFila = idPedido, nota, tiempoMs = 16000 }) {
  const datosJuego = JUEGOS_ENTREGA[juego];
  const apiKey = String(datosJuego?.llave() || '').trim();
  if (!datosJuego || !apiKey) return { estado: 'no_disponible', motivo: `Falta la llave de Central One de ${juego}` };

  let paq;
  let datos;
  try {
    paq = await paqueteDe(juego, paquete);
    datos = paq ? await datosParaPedido({ apiKey, productId: paq.productos[0], idJugador, zona: datosJuego.zona ? zona : '' })
      : { error: `"${paquete}" no tiene producto de Central One en Precios de ${datosJuego.nombre}` };
  } catch (error) {
    datos = { error: error.message };
  }
  // Nada se pidió: se puede volver a intentar más tarde con el mismo idPedido
  if (datos.error) return { estado: 'no_disponible', motivo: datos.error };

  const n = paq.productos.length;
  const ordenes = [];
  let falla = null;
  for (let i = 0; i < n && !falla; i++) {
    const r = await crearPedidoCentralOne({
      apiKey, productId: paq.productos[i], payload: datos.payload, idempotencia: datosJuego.clave(idPedido, i, n),
      nota: `Level Up ${idPedido} (${nota})${n > 1 ? ` (${i + 1} de ${n})` : ''}`, tiempoMs: Math.floor(tiempoMs / n),
    });
    if (r.tipo === 'ok') ordenes.push(r.orden); else falla = r;
  }

  const fila = (estado, texto) => guardar('recargas', {
    id_pedido: idFila, usuario: null, juego, cuenta: `ID ${idJugador}${zona ? ` (${zona})` : ''}`, id_jugador: idJugador,
    zona: zona || null, paquete, precio: null, referencia: null, estado, nota_admin: texto.slice(0, 500), actualizado: new Date().toISOString(),
  }, 'id_pedido').catch((error) => console.error(`⚠️ entrega: no se pudo guardar la recarga ${idPedido}:`, error.message));

  if (falla && !ordenes.length && falla.tipo === 'rechazo') {
    await fila('en_revision', `🏆 ${nota}: Central One la rechazó (${falla.motivo})`);
    return { estado: 'rechazo', motivo: falla.motivo, errorCliente: falla.errorCliente };
  }
  if (falla) {
    await fila('en_revision', `🏆 ${nota}: ${falla.motivo}`);
    return { estado: 'incierto', motivo: falla.motivo, ordenes };
  }
  const entregada = ordenes.every((o) => /^(completed|delivered)$/i.test(o.status));
  await fila(entregada ? 'completado' : 'en_proceso', `🏆 ${nota}: ${ordenes.map((o) => o.referencia).join(', ')}`);
  return { estado: entregada ? 'entregado' : 'en_proceso', ordenes };
}
