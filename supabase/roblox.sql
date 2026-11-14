-- =====================================================================
-- LEVEL UP · CÓDIGOS DE ROBLOX EN SUPABASE (desde 2026-11-14)
--
-- Cómo instalarlo: Supabase → SQL Editor → New query → pega TODO este archivo → Run. Se puede volver a
-- correr. Después, una sola vez, privado/roblox-codigos-datos.sql (los códigos que tenía la hoja).
--
-- El pago se sigue verificando en la hoja (apps-script/roblox.gs, MacroDroid no cambia); los CÓDIGOS
-- viven aquí. Una compra:
--   1. roblox.gs encuentra el pago, lo deja "En proceso" y anota el pedido en "pedidos_api" (status "comprar",
--      productId "SUPABASE").
--   2. api/_lib/juegos/roblox.js toma un código con roblox_tomar_codigo (uno solo por pedido, nunca el mismo
--      código a dos pedidos aunque compren en el mismo instante).
--   3. Con código: entregar_api (pago "Usado", venta en "Exitosas"). Sin código: liberar_api (el pago vuelve
--      a "Verificado") y el cliente ve "Agotado".
-- Los códigos se cargan, se cuentan y se anulan en admin.html → pestaña "Roblox". Son dinero: nadie los
-- lee desde el navegador (el panel solo ve los últimos 4 caracteres).
-- =====================================================================

create table if not exists public.roblox_codigos (
  id         bigint generated always as identity primary key,
  paquete    text not null check (paquete ~ '^\d{1,7}(-EEUU)?$'),   -- clave del paquete: "355" (igual que claveDePaquete de roblox.gs)
  codigo     text not null unique check (codigo ~ '^[A-Za-z0-9-]{6,100}$'),
  estado     text not null default 'libre' check (estado in ('libre', 'entregado', 'anulado')),
  cargado    timestamptz not null default now(),
  entregado  timestamptz,
  id_pedido  text unique,                                           -- "rbx-…" del pedido que se lo llevó
  usuario    text
);
create index if not exists roblox_codigos_libres on public.roblox_codigos (paquete, id) where estado = 'libre';
alter table public.roblox_codigos enable row level security;
revoke all on public.roblox_codigos from anon, authenticated;

-- Da un código libre del paquete a este pedido (o el que ya se le dio, si se repite). null = no quedan.
create or replace function public.roblox_tomar_codigo(p_paquete text, p_id_pedido text, p_usuario text default null)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_codigo text;
begin
  if p_id_pedido is null or p_id_pedido !~ '^rbx-[0-9a-f-]{36}$' then
    raise exception 'pedido inválido' using errcode = '22023';
  end if;
  select codigo into v_codigo from roblox_codigos where id_pedido = p_id_pedido;
  if found then return v_codigo; end if;
  -- "skip locked": dos compras a la vez se llevan códigos distintos, sin esperarse
  update roblox_codigos set estado = 'entregado', entregado = now(), id_pedido = p_id_pedido, usuario = left(p_usuario, 40)
   where id = (select id from roblox_codigos where paquete = p_paquete and estado = 'libre' order by id limit 1 for update skip locked)
  returning codigo into v_codigo;
  return v_codigo;
end;
$$;
revoke execute on function public.roblox_tomar_codigo(text, text, text) from public, anon, authenticated;
grant execute on function public.roblox_tomar_codigo(text, text, text) to service_role;

-- Códigos libres por paquete: { "355": 31, ... } (para mostrar "Agotado" / "¡Últimos!" en la tienda)
create or replace function public.roblox_stock()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_object_agg(paquete, n), '{}'::jsonb)
    from (select paquete, count(*) as n from roblox_codigos where estado = 'libre' group by paquete) x;
$$;
revoke execute on function public.roblox_stock() from public, anon, authenticated;
grant execute on function public.roblox_stock() to service_role;

-- ---------------------------------------------------------------------
-- Panel admin: pestaña "Roblox"
-- ---------------------------------------------------------------------
create or replace function public.admin_roblox()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform admin_revisar();
  return jsonb_build_object(
    'central_one', roblox_central_one(),
    'paquetes', (
      select coalesce(jsonb_agg(x order by (regexp_replace(x.paquete, '\D', '', 'g'))::int), '[]'::jsonb) from (
        select paquete, count(*) filter (where estado = 'libre') as libres,
               count(*) filter (where estado = 'entregado') as entregados,
               count(*) filter (where estado = 'anulado') as anulados
          from roblox_codigos group by paquete
      ) x
    ),
    'ultimos', (
      select coalesce(jsonb_agg(x), '[]'::jsonb) from (
        select paquete, right(codigo, 4) as fin, entregado, usuario, id_pedido
          from roblox_codigos where estado = 'entregado' order by entregado desc limit 30
      ) x
    ),
    'libres', (
      select coalesce(jsonb_agg(x), '[]'::jsonb) from (
        select id, paquete, right(codigo, 4) as fin, cargado
          from roblox_codigos where estado = 'libre' order by paquete, id limit 300
      ) x
    )
  );
end;
$$;
revoke execute on function public.admin_roblox() from public, anon;
grant execute on function public.admin_roblox() to authenticated, service_role;

-- Carga una lista de códigos a un paquete. Devuelve { nuevos, repetidos, invalidos }.
create or replace function public.admin_roblox_cargar(p_paquete text, p_codigos text[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_limpios text[];
  v_invalidos integer;
  v_nuevos integer;
begin
  perform admin_revisar();
  if p_paquete is null or p_paquete !~ '^\d{1,7}(-EEUU)?$' then
    raise exception 'Elige el paquete.' using errcode = '22023';
  end if;
  if coalesce(array_length(p_codigos, 1), 0) = 0 or array_length(p_codigos, 1) > 500 then
    raise exception 'Pega de 1 a 500 códigos, uno por línea.' using errcode = '22023';
  end if;
  select array_agg(distinct c), count(*) filter (where c !~ '^[A-Za-z0-9-]{6,100}$')
    into v_limpios, v_invalidos
    from (select regexp_replace(trim(x), '\s', '', 'g') as c from unnest(p_codigos) x) t
   where c <> '';
  v_limpios := array(select c from unnest(v_limpios) c where c ~ '^[A-Za-z0-9-]{6,100}$');
  with nuevos as (
    insert into roblox_codigos (paquete, codigo) select p_paquete, c from unnest(v_limpios) c
    on conflict (codigo) do nothing returning 1
  ) select count(*) into v_nuevos from nuevos;
  return jsonb_build_object('nuevos', v_nuevos, 'repetidos', coalesce(array_length(v_limpios, 1), 0) - v_nuevos,
                            'invalidos', coalesce(v_invalidos, 0));
end;
$$;
revoke execute on function public.admin_roblox_cargar(text, text[]) from public, anon;
grant execute on function public.admin_roblox_cargar(text, text[]) to authenticated, service_role;

-- Anula un código libre (malo o que se entregó a mano): ya no se le da a nadie
create or replace function public.admin_roblox_anular(p_id bigint)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  perform admin_revisar();
  update roblox_codigos set estado = 'anulado' where id = p_id and estado = 'libre';
  return found;
end;
$$;
revoke execute on function public.admin_roblox_anular(bigint) from public, anon;
grant execute on function public.admin_roblox_anular(bigint) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- Desde 2026-11-14 (segunda parte): paquetes y precios de Roblox desde Supabase (tabla "precios" de
-- supabase/precios.sql, juego "roblox") y compra en Central One cuando se acaban los códigos.
--   configuracion "roblox_central_one" = true → si un paquete no tiene códigos y está unido a un producto
--   de Central One (precios.producto), el código se compra ahí (llave roblox_nuevo de Vercel).
-- ---------------------------------------------------------------------
create or replace function public.admin_roblox_central_one(p_activo boolean)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  perform admin_revisar();
  insert into configuracion (clave, valor, publico, actualizado) values ('roblox_central_one', to_jsonb(coalesce(p_activo, false)), false, now())
  on conflict (clave) do update set valor = excluded.valor, actualizado = now();
  return coalesce(p_activo, false);
end;
$$;
revoke execute on function public.admin_roblox_central_one(boolean) from public, anon;
grant execute on function public.admin_roblox_central_one(boolean) to authenticated, service_role;

-- ¿Comprar en Central One cuando no hay códigos? (lo lee el servidor y el panel)
create or replace function public.roblox_central_one()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select valor = 'true'::jsonb from configuracion where clave = 'roblox_central_one'), false);
$$;
revoke execute on function public.roblox_central_one() from public, anon, authenticated;
grant execute on function public.roblox_central_one() to service_role;
