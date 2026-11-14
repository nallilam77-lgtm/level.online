-- =====================================================================
-- LEVEL UP · RANKING "MEJORES CLIENTES" POR BOLÍVARES (desde 2026-11-14)
-- Pega TODO este archivo en Supabase → SQL Editor → Run. Solo reemplaza la función ranking_clientes
-- (la misma de supabase/levelup.sql, que ya trae este cambio). Se puede volver a correr.
-- =====================================================================

create or replace function public.ranking_clientes(p_desde timestamptz, p_limite integer default 10)
returns table (puesto integer, nombre text, foto text, recargas integer, total numeric)
language sql
stable
security definer
set search_path = public
as $$
  with conteo as (
    select r.usuario, count(*)::integer as recargas, coalesce(sum(r.precio), 0) as total
      from recargas r
     -- Solo clientes con sesión: los pedidos sin cuenta (usuario vacío, desde 2026-11-13) no compiten
     where r.estado = 'completado' and r.creado >= p_desde and r.usuario is not null
     group by r.usuario
  )
  -- Desde 2026-11-14 el puesto va por bolívares recargados (desempata la cantidad de recargas)
  select (row_number() over (order by c.total desc, c.recargas desc))::integer,
         -- Primer nombre + inicial del apellido
         coalesce(nullif(trim(
           split_part(trim(coalesce(u.raw_user_meta_data ->> 'full_name', u.raw_user_meta_data ->> 'name', '')), ' ', 1) || ' ' ||
           coalesce(nullif(left(split_part(trim(coalesce(u.raw_user_meta_data ->> 'full_name', u.raw_user_meta_data ->> 'name', '')), ' ', 2), 1), '') || '.', '')
         ), ''), 'Cliente'),
         nullif(u.raw_user_meta_data ->> 'avatar_url', ''),
         c.recargas,
         round(c.total, 2)
    from conteo c
    join auth.users u on u.id = c.usuario
   order by c.total desc, c.recargas desc
   limit least(greatest(coalesce(p_limite, 10), 1), 20);
$$;

revoke execute on function public.ranking_clientes(timestamptz, integer) from public, anon, authenticated;
grant execute on function public.ranking_clientes(timestamptz, integer) to service_role;
