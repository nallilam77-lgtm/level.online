// LIBRO DIARIO EN GOOGLE SHEETS (desde 2026-11-15). Interruptor del panel: admin.html → Resumen →
// "Anotar las ventas también en Google Sheets" (configuracion "hojas_ventas" en Supabase).
//   true o sin valor → como antes: Free Fire, Blood Strike y Mobile Legends anotan en sus hojas
//                      "finalizados", "errores", el uso de los códigos en "Descuentos" y el estado de los
//                      pedidos de Central One ("fazer_card" / "pedidos").
//   false            → no se escribe NADA de eso en las hojas. Todo queda en Supabase: recargas (Panel →
//                      Pedidos, y "Descargar Excel"), incidencias (Panel → Revisión) y codigos (Creadores).
// No toca lo que SÍ hace falta de una hoja: Roblox (roblox.gs), las tiendas manuales (manuales.gs), la
// ruleta, ni los pines del modo "Como antes" de Free Fire.
// Copia de 30 s por instancia; si Supabase no responde, como antes (se anota en las hojas).
import { supabaseActivo, leer } from './supabase.js';
import { conCache } from './externo.js';

export async function anotarEnHojas() {
  if (!supabaseActivo()) return true;
  try {
    const { datos } = await conCache('hojas:ventas', async () => {
      const filas = await leer('configuracion', { clave: 'hojas_ventas' }, 'valor');
      return !(Array.isArray(filas) && filas[0]?.valor === false);
    }, { frescoMs: 30_000, respaldoMs: 10 * 60_000, esValido: (v) => typeof v === 'boolean' });
    return datos;
  } catch (error) {
    console.error('⚠️ libro: no se pudo leer "hojas_ventas" de Supabase, se anota en las hojas:', error.message);
    return true;
  }
}
