-- =====================================================================
-- LEVEL UP · AJUSTES DE SEGURIDAD (2026-11-15, avisos del "Security Advisor" de Supabase)
-- Supabase → SQL Editor → New query → pega todo → Run. Se puede volver a correr.
--
-- 1. Funciones de disparador de la tabla pagos: solo las usa la base (al guardar o cambiar un pago).
--    Nadie debe poder llamarlas desde la API (/rest/v1/rpc/...). Quitar el permiso NO apaga los
--    disparadores: siguen funcionando igual.
-- 2. codigos_porcentaje_creador: fijar search_path (que nadie pueda cambiar qué tablas lee).
-- =====================================================================
revoke execute on function public.pagos_guardar_usado() from public, anon, authenticated;
revoke execute on function public.pagos_limpiar_huellas() from public, anon, authenticated;
revoke execute on function public.pagos_no_repetir_usado() from public, anon, authenticated;
alter function public.codigos_porcentaje_creador() set search_path = public;
