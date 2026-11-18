-- =====================================================================
-- LEVEL UP · ROBLOX: QUÉ CÓDIGO SE LE ENTREGÓ A QUIÉN (desde 2026-11-18)
--
-- Cómo instalarlo: Supabase → SQL Editor → New query → pega TODO este archivo → Run. Se puede volver a correr.
-- Necesita supabase/roblox.sql.
--
-- admin.html → pestaña "Roblox" → "Entregados: qué código a quién". Muestra el código COMPLETO solo de los
-- ya entregados (ese código ya es del cliente; sirve para atender reclamos). Los libres siguen ocultos.
-- Busca por usuario de Roblox, código, referencia, correo o paquete.
-- =====================================================================

create or replace function public.admin_roblox_entregados(p_buscar text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_buscar text := nullif(lower(btrim(coalesce(p_buscar, ''))), '');
begin
  perform admin_revisar();
  if v_buscar is not null and length(v_buscar) > 60 then
    raise exception 'búsqueda muy larga' using errcode = '22023';
  end if;
  return (
    select coalesce(jsonb_agg(x order by x.entregado desc), '[]'::jsonb) from (
      select c.paquete, c.codigo, c.entregado, c.id_pedido,
             r.id_jugador as roblox, r.referencia, r.precio, r.estado, r.codigo_descuento,
             (select lower(u.email) from auth.users u where u.id::text = c.usuario) as correo
        from roblox_codigos c
        left join recargas r on r.id_pedido = c.id_pedido
       where c.estado = 'entregado'
         and (v_buscar is null
              or lower(c.codigo) like '%' || v_buscar || '%'
              or lower(coalesce(r.id_jugador, '')) like '%' || v_buscar || '%'
              or coalesce(r.referencia, '') like '%' || v_buscar || '%'
              or c.paquete like v_buscar || '%'
              or exists (select 1 from auth.users u where u.id::text = c.usuario and lower(u.email) like '%' || v_buscar || '%'))
       order by c.entregado desc
       limit 200
    ) x
  );
end;
$$;
revoke execute on function public.admin_roblox_entregados(text) from public, anon;
grant execute on function public.admin_roblox_entregados(text) to authenticated, service_role;
