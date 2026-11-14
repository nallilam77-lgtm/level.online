-- =====================================================================
-- LEVEL UP · PRECIOS EN SUPABASE (desde 2026-11-14)
--
-- Cómo instalarlo: Supabase → SQL Editor → New query → pega TODO este archivo → Run (después de
-- supabase/tienda.sql y supabase/codigos.sql). Se puede volver a correr. Después, una sola vez,
-- privado/precios-datos.sql (los paquetes que había en las hojas).
--
-- Mudanza por pasos (la tienda sigue con las hojas hasta el paso 6):
--   3. Estas tablas.  4. Pestaña "Precios" de admin.html.  5. Prueba en paralelo.  6. La tienda las usa.
--
-- Un solo dólar y un solo % de ganancia para TODOS los juegos (los pone el administrador en el panel):
--   configuracion "tasa_usd"     Bs por dólar (la misma de los creadores)
--   configuracion "ganancia_pct" % de ganancia sobre el costo de Central One
-- Precio de cada paquete:
--   con precio_manual  → ese precio en Bs, fijo.
--   sin precio_manual  → costo de Central One × cantidad × dólar × (1 + ganancia %), redondeado a céntimos.
-- El costo y el stock salen de centralone_catalogo: una copia del catálogo de Central One que renueva el
-- servidor (botón "Traer productos" del panel y, en el paso 6, al entrar los clientes y con sus avisos).
-- =====================================================================

-- Paquetes que se venden en cada tienda
create table if not exists public.precios (
  id            bigint generated always as identity primary key,
  juego         text not null check (juego in ('freefire', 'bloodstrike', 'mobilelegends', 'roblox')),
  paquete       text not null check (length(paquete) between 1 and 80),   -- lo que ve el cliente ("110 Diamantes")
  producto      text check (producto is null or producto ~ '^[0-9a-f-]{36}$'), -- product_id de Central One (null: códigos propios)
  cantidad      smallint not null default 1 check (cantidad between 1 and 10), -- "220 Diamantes" = 2 × el de 110
  precio_manual numeric(12, 2) check (precio_manual is null or precio_manual > 0),
  orden         smallint not null default 0,
  activo        boolean not null default true,
  actualizado   timestamptz not null default now(),
  unique (juego, paquete)
);
alter table public.precios enable row level security;
revoke all on public.precios from anon, authenticated;

-- Copia del catálogo de Central One (solo lo que necesitamos de cada producto)
create table if not exists public.centralone_catalogo (
  producto     text primary key check (producto ~ '^[0-9a-f-]{36}$'),
  juego        text,                       -- a qué tienda pertenece (lo pone el servidor al traerlo)
  nombre       text,
  familia      text,
  region       text,
  costo_usd    numeric(12, 4) check (costo_usd is null or costo_usd >= 0),   -- reseller_price (4 decimales)
  en_stock     boolean not null default false,
  stock        integer,                    -- available_stock (null = Central One no dice cuántos)
  precio_desde timestamptz,                -- price_updated_at
  visto        timestamptz not null default now()   -- cuándo se leyó de Central One
);
alter table public.centralone_catalogo enable row level security;
revoke all on public.centralone_catalogo from anon, authenticated;

-- % de ganancia (configuracion "ganancia_pct"); null si todavía no se puso
create or replace function public.precios_ganancia()
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select case when jsonb_typeof(valor) = 'number' and (valor #>> '{}')::numeric >= 0 then (valor #>> '{}')::numeric end
    from configuracion where clave = 'ganancia_pct';
$$;
revoke execute on function public.precios_ganancia() from public, anon, authenticated;

-- Los paquetes de un juego con su precio final (lo usará la tienda en el paso 6 y el panel ya mismo).
-- precio: el manual o el calculado (null si es calculado y falta el dólar, la ganancia o el costo: no se vende).
create or replace function public.precios_de(p_juego text)
returns table (id bigint, paquete text, producto text, cantidad smallint, precio_manual numeric, costo_usd numeric,
               precio_calculado numeric, precio numeric, en_stock boolean, stock integer, visto timestamptz,
               orden smallint, activo boolean)
language sql
stable
security definer
set search_path = public
as $$
  with conf as (select codigos_tasa() as tasa, precios_ganancia() as ganancia)
  select p.id, p.paquete, p.producto, p.cantidad, p.precio_manual, c.costo_usd,
         case when c.costo_usd is not null and conf.tasa is not null and conf.ganancia is not null
              then round(c.costo_usd * p.cantidad * conf.tasa * (1 + conf.ganancia / 100), 2) end,
         coalesce(p.precio_manual,
           case when c.costo_usd is not null and conf.tasa is not null and conf.ganancia is not null
                then round(c.costo_usd * p.cantidad * conf.tasa * (1 + conf.ganancia / 100), 2) end),
         -- Sin producto de Central One (Roblox con códigos propios) el stock lo decide la tienda
         case when p.producto is null then true else coalesce(c.en_stock, false) end,
         c.stock, c.visto, p.orden, p.activo
    from precios p
    cross join conf
    left join centralone_catalogo c on c.producto = p.producto
   where p.juego = p_juego
   order by p.orden, p.id;
$$;
revoke execute on function public.precios_de(text) from public, anon, authenticated;
grant execute on function public.precios_de(text) to service_role;

-- ---------------------------------------------------------------------
-- Panel admin: pestaña "Precios"
-- ---------------------------------------------------------------------
create or replace function public.admin_precios(p_juego text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform admin_revisar();
  return jsonb_build_object(
    'tasa', codigos_tasa(),
    'ganancia', precios_ganancia(),
    'paquetes', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from precios_de(p_juego) x),
    -- Productos de este juego que ya se trajeron de Central One y todavía no se venden
    'sin_usar', (
      select coalesce(jsonb_agg(jsonb_build_object('producto', c.producto, 'nombre', c.nombre, 'region', c.region,
               'costo_usd', c.costo_usd, 'en_stock', c.en_stock) order by c.costo_usd), '[]'::jsonb)
        from centralone_catalogo c
       where c.juego = p_juego and not exists (select 1 from precios p where p.producto = c.producto and p.juego = p_juego)
    )
  );
end;
$$;
revoke execute on function public.admin_precios(text) from public, anon;
grant execute on function public.admin_precios(text) to authenticated, service_role;

-- Crea (p_id null) o cambia un paquete. p_precio_manual null = precio calculado.
create or replace function public.admin_precio_guardar(p_id bigint, p_juego text, p_paquete text, p_producto text,
  p_cantidad integer default 1, p_precio_manual numeric default null, p_activo boolean default true, p_orden integer default null)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_paquete text := trim(coalesce(p_paquete, ''));
  v_producto text := nullif(lower(trim(coalesce(p_producto, ''))), '');
  v_id bigint;
begin
  perform admin_revisar();
  if p_juego not in ('freefire', 'bloodstrike', 'mobilelegends', 'roblox') then
    raise exception 'Juego no válido.' using errcode = '22023';
  end if;
  if length(v_paquete) < 1 or length(v_paquete) > 80 then
    raise exception 'Escribe el nombre del paquete (máximo 80 letras).' using errcode = '22023';
  end if;
  if v_producto is not null and v_producto !~ '^[0-9a-f-]{36}$' then
    raise exception 'El producto de Central One no es válido.' using errcode = '22023';
  end if;
  if coalesce(p_cantidad, 1) < 1 or coalesce(p_cantidad, 1) > 10 then
    raise exception 'La cantidad va de 1 a 10.' using errcode = '22023';
  end if;
  if p_precio_manual is not null and p_precio_manual <= 0 then
    raise exception 'El precio tiene que ser mayor que 0 (o déjalo vacío para calcularlo solo).' using errcode = '22023';
  end if;
  if v_producto is null and p_precio_manual is null then
    raise exception 'Un paquete sin producto de Central One necesita precio a mano.' using errcode = '22023';
  end if;
  if exists (select 1 from precios where juego = p_juego and paquete = v_paquete and id is distinct from p_id) then
    raise exception 'Ya hay un paquete llamado "%" en este juego.', v_paquete using errcode = '23505';
  end if;
  if p_id is null then
    insert into precios (juego, paquete, producto, cantidad, precio_manual, activo, orden)
    values (p_juego, v_paquete, v_producto, coalesce(p_cantidad, 1), round(p_precio_manual, 2), coalesce(p_activo, true),
            coalesce(p_orden, (select coalesce(max(orden), 0) + 1 from precios where juego = p_juego)))
    returning id into v_id;
  else
    update precios set paquete = v_paquete, producto = v_producto, cantidad = coalesce(p_cantidad, 1),
           precio_manual = round(p_precio_manual, 2), activo = coalesce(p_activo, activo),
           orden = coalesce(p_orden, orden), actualizado = now()
     where id = p_id and juego = p_juego
    returning id into v_id;
    if v_id is null then raise exception 'No existe ese paquete.' using errcode = 'P0002'; end if;
  end if;
  return v_id;
end;
$$;
revoke execute on function public.admin_precio_guardar(bigint, text, text, text, integer, numeric, boolean, integer) from public, anon;
grant execute on function public.admin_precio_guardar(bigint, text, text, text, integer, numeric, boolean, integer) to authenticated, service_role;

create or replace function public.admin_precio_borrar(p_id bigint)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  perform admin_revisar();
  delete from precios where id = p_id;
  return found;
end;
$$;
revoke execute on function public.admin_precio_borrar(bigint) from public, anon;
grant execute on function public.admin_precio_borrar(bigint) to authenticated, service_role;

-- Sube (-1) o baja (+1) un paquete en la lista
create or replace function public.admin_precio_mover(p_id bigint, p_paso integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_juego text;
  v_ids bigint[];
  v_i integer;
begin
  perform admin_revisar();
  select juego into v_juego from precios where id = p_id;
  if v_juego is null then return; end if;
  select array_agg(id order by orden, id) into v_ids from precios where juego = v_juego;
  v_i := array_position(v_ids, p_id);
  if v_i + p_paso < 1 or v_i + p_paso > array_length(v_ids, 1) then return; end if;
  v_ids[v_i] := v_ids[v_i + p_paso];
  v_ids[v_i + p_paso] := p_id;
  update precios p set orden = x.n from unnest(v_ids) with ordinality as x(id, n) where p.id = x.id;
end;
$$;
revoke execute on function public.admin_precio_mover(bigint, integer) from public, anon;
grant execute on function public.admin_precio_mover(bigint, integer) to authenticated, service_role;

-- % de ganancia para todos los juegos
create or replace function public.admin_ganancia_guardar(p_pct numeric)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
begin
  perform admin_revisar();
  if p_pct is null or p_pct < 0 or p_pct > 300 then
    raise exception 'Escribe un %% de ganancia entre 0 y 300.' using errcode = '22023';
  end if;
  insert into configuracion (clave, valor, publico, actualizado) values ('ganancia_pct', to_jsonb(round(p_pct, 2)), false, now())
  on conflict (clave) do update set valor = excluded.valor, actualizado = now();
  return round(p_pct, 2);
end;
$$;
revoke execute on function public.admin_ganancia_guardar(numeric) from public, anon;
grant execute on function public.admin_ganancia_guardar(numeric) to authenticated, service_role;
