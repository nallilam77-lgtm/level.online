-- =====================================================================
-- LEVEL UP · PRECIOS EN SUPABASE (desde 2026-11-14)
--
-- Cómo instalarlo: Supabase → SQL Editor → New query → pega TODO este archivo → Run (después de
-- supabase/tienda.sql y supabase/codigos.sql). Se puede volver a correr. Después, una sola vez,
-- privado/precios-datos.sql (los paquetes que había en las hojas).
--
-- Mudanza por pasos: 3. Estas tablas.  4. Pestaña "Precios" de admin.html.  5. Prueba en paralelo.
--   6. (2026-11-14) LA TIENDA COBRA CON ESTOS PRECIOS: Free Fire, Blood Strike y Mobile Legends (y Roblox).
--      Las hojas solo verifican pagos; sus pestañas de precios ya no se usan (respaldo si Supabase falla).
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

-- precios_de (los paquetes de un juego con su precio final y sus fichas) está más abajo, en la parte de fichas.

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

-- =====================================================================
-- PRUEBA EN PARALELO (paso 5, desde 2026-11-14): la tienda sigue cobrando con las hojas; cuando un cliente
-- abre una tienda, el servidor compara cada precio de la hoja con el de Supabase y anota aquí lo que no
-- coincide (api/_lib/precios.js, compararConHoja). El panel lo muestra en Precios. Lo que ya coincide se borra.
-- =====================================================================
create table if not exists public.precios_diferencias (
  juego           text not null,
  paquete         text not null,
  precio_hoja     numeric(12, 2),       -- null: el paquete no está en la hoja
  precio_supabase numeric(12, 2),       -- null: no está en Supabase o no tiene precio
  visto           timestamptz not null default now(),
  primary key (juego, paquete)
);
alter table public.precios_diferencias enable row level security;
revoke all on public.precios_diferencias from anon, authenticated;

-- =====================================================================
-- FICHAS DEL MINIJUEGO POR PAQUETE (desde 2026-11-14) y ajustes del juego desde el panel
--   precios.fichas: cuántas fichas da ese paquete (lo pone el administrador en la pestaña Precios).
--   Vacío = como antes: precio pagado / bs_por_ficha (mínimo 1). 0 = ese paquete no da fichas.
-- El disparador juego_fichas_por_recarga (supabase/tienda.sql, que ya trae este cambio) las busca por
-- juego + nombre del paquete del pedido.
-- =====================================================================
alter table public.precios add column if not exists fichas integer check (fichas is null or fichas between 0 and 1000);

-- Precio garantizado (desde 2026-11-14, cuando la tienda pasa a cobrar con Supabase): si Central One cambia
-- un costo, durante 30 minutos se cobra el MENOR de los dos precios. Así un cliente que vio el precio de antes
-- y pagó nunca queda con "pago insuficiente" por un cambio que pasó mientras pagaba.
alter table public.centralone_catalogo add column if not exists costo_anterior numeric(12, 4);
alter table public.centralone_catalogo add column if not exists costo_cambio timestamptz;
create or replace function public.centralone_costo_anterior()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.costo_usd is distinct from old.costo_usd and old.costo_usd is not null then
    new.costo_anterior := old.costo_usd;
    new.costo_cambio := now();
  end if;
  return new;
end;
$$;
drop trigger if exists centralone_costo_anterior on public.centralone_catalogo;
create trigger centralone_costo_anterior before update on public.centralone_catalogo
  for each row execute function public.centralone_costo_anterior();

-- precios_de con las fichas (cambia lo que devuelve: hay que borrarla y crearla de nuevo)
drop function if exists public.precios_de(text);
create or replace function public.precios_de(p_juego text)
returns table (id bigint, paquete text, producto text, cantidad smallint, precio_manual numeric, costo_usd numeric,
               precio_calculado numeric, precio numeric, en_stock boolean, stock integer, visto timestamptz,
               orden smallint, activo boolean, fichas_manual integer, fichas integer, precio_cobro numeric)
language sql
stable
security definer
set search_path = public
as $$
  with conf as (select codigos_tasa() as tasa, precios_ganancia() as ganancia,
                       (select bs_por_ficha from juego_ajustes where id = 1) as bs_ficha),
  base as (
    select p.id, p.paquete, p.producto, p.cantidad, p.precio_manual, p.orden, p.activo, p.fichas,
           c.costo_usd, c.costo_anterior, c.costo_cambio, c.en_stock as c_stock, c.stock as c_cantidad, c.visto as c_visto,
           case when c.costo_usd is not null and conf.tasa is not null and conf.ganancia is not null
                then round(c.costo_usd * p.cantidad * conf.tasa * (1 + conf.ganancia / 100), 2) end as calculado,
           -- Lo que se cobra: el menor entre el costo de ahora y el de hace menos de 30 min (least ignora null)
           case when c.costo_usd is not null and conf.tasa is not null and conf.ganancia is not null
                then round(least(c.costo_usd, case when c.costo_cambio > now() - interval '30 minutes' then c.costo_anterior end)
                           * p.cantidad * conf.tasa * (1 + conf.ganancia / 100), 2) end as calculado_cobro,
           conf.bs_ficha
      from precios p cross join conf left join centralone_catalogo c on c.producto = p.producto
     where p.juego = p_juego
  )
  select b.id, b.paquete, b.producto, b.cantidad, b.precio_manual, b.costo_usd, b.calculado,
         coalesce(b.precio_manual, b.calculado),
         case when b.producto is null then true else coalesce(b.c_stock, false) end,
         b.c_cantidad, b.c_visto, b.orden, b.activo, b.fichas,
         coalesce(b.fichas, case when coalesce(b.precio_manual, b.calculado) > 0 and b.bs_ficha > 0
                                 then greatest(1, floor(coalesce(b.precio_manual, b.calculado) / b.bs_ficha))::integer end),
         coalesce(b.precio_manual, b.calculado_cobro)
    from base b
   order by b.orden, b.id;
$$;
revoke execute on function public.precios_de(text) from public, anon, authenticated;
grant execute on function public.precios_de(text) to service_role;

-- Fichas de un paquete (null = vacío: se calculan por precio)
create or replace function public.admin_precio_fichas(p_id bigint, p_fichas integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  perform admin_revisar();
  if p_fichas is not null and (p_fichas < 0 or p_fichas > 1000) then
    raise exception 'Las fichas van de 0 a 1000 (vacío = según el precio).' using errcode = '22023';
  end if;
  update precios set fichas = p_fichas, actualizado = now() where id = p_id;
  return found;
end;
$$;
revoke execute on function public.admin_precio_fichas(bigint, integer) from public, anon;
grant execute on function public.admin_precio_fichas(bigint, integer) to authenticated, service_role;

-- Fichas de cada paquete para las tiendas ("+N fichas" bajo cada precio): { "freefire": { "110 Diamantes": 1 } }
create or replace function public.fichas_por_paquete()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_object_agg(t.juego, t.paquetes), '{}'::jsonb) from (
    -- Solo las puestas a mano: las demás las calcula la página con el precio que se ve (con descuento, el final)
    select j as juego, (select coalesce(jsonb_object_agg(x.paquete, x.fichas_manual), '{}'::jsonb)
                          from precios_de(j) x where x.activo and x.fichas_manual is not null) as paquetes
      from unnest(array['freefire', 'bloodstrike', 'mobilelegends', 'roblox']) j
  ) t;
$$;
revoke execute on function public.fichas_por_paquete() from public, anon, authenticated;
grant execute on function public.fichas_por_paquete() to service_role;

-- Ajustes del minijuego: fichas por partida y Bs por ficha (para los paquetes sin fichas a mano)
create or replace function public.admin_juego_ajustes(p_costo integer, p_bs_por_ficha numeric)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform admin_revisar();
  if p_costo is null or p_costo < 1 or p_costo > 100 then
    raise exception 'Las fichas por partida van de 1 a 100.' using errcode = '22023';
  end if;
  if p_bs_por_ficha is null or p_bs_por_ficha <= 0 then
    raise exception 'Escribe cuántos Bs vale una ficha.' using errcode = '22023';
  end if;
  update juego_ajustes set costo_partida = p_costo, bs_por_ficha = round(p_bs_por_ficha, 2) where id = 1;
  return jsonb_build_object('costo', p_costo, 'bs_por_ficha', round(p_bs_por_ficha, 2));
end;
$$;
revoke execute on function public.admin_juego_ajustes(integer, numeric) from public, anon;
grant execute on function public.admin_juego_ajustes(integer, numeric) to authenticated, service_role;

-- admin_precios con los ajustes del minijuego y las diferencias con la hoja
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
    'costo_partida', (select costo_partida from juego_ajustes where id = 1),
    'bs_por_ficha', (select bs_por_ficha from juego_ajustes where id = 1),
    'paquetes', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from precios_de(p_juego) x),
    'sin_usar', (
      select coalesce(jsonb_agg(jsonb_build_object('producto', c.producto, 'nombre', c.nombre, 'region', c.region,
               'costo_usd', c.costo_usd, 'en_stock', c.en_stock) order by c.costo_usd), '[]'::jsonb)
        from centralone_catalogo c
       where c.juego = p_juego and not exists (select 1 from precios p where p.producto = c.producto and p.juego = p_juego)
    ),
    'diferencias', (
      select coalesce(jsonb_agg(to_jsonb(d) order by d.paquete), '[]'::jsonb) from precios_diferencias d where d.juego = p_juego
    )
  );
end;
$$;
revoke execute on function public.admin_precios(text) from public, anon;
grant execute on function public.admin_precios(text) to authenticated, service_role;

-- Desde 2026-11-14 cada partida cuesta 4 fichas (antes 5). Después se cambia desde el panel → Precios.
update public.juego_ajustes set costo_partida = 4 where id = 1 and costo_partida = 5;

-- Fichas por recarga: las del paquete si se pusieron a mano; si no, precio / bs_por_ficha (mínimo 1).
-- (Misma función que supabase/tienda.sql, que ya trae este cambio: correr cualquiera de los dos deja esta.)
create or replace function public.juego_fichas_por_recarga()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fichas integer;
  v_manual integer;
  v_filas  integer;
begin
  if new.usuario is null or new.juego not in ('freefire', 'bloodstrike', 'mobilelegends', 'roblox') then
    return new;
  end if;
  if new.estado = 'completado' and (tg_op = 'INSERT' or old.estado is distinct from 'completado') then
    -- Fichas puestas a mano en ese paquete (admin.html → Precios). Si la tabla no existe, como antes.
    begin
      select p.fichas into v_manual from precios p where p.juego = new.juego and p.paquete = new.paquete;
    exception when others then v_manual := null;
    end;
    if v_manual is not null then
      v_fichas := v_manual;
    else
      select greatest(1, floor(coalesce(new.precio, 0) / a.bs_por_ficha))::integer into v_fichas
        from juego_ajustes a where a.id = 1;
    end if;
    if coalesce(v_fichas, 0) > 0 then
      insert into juego_movimientos (usuario, cambio, motivo, id_pedido)
        values (new.usuario, v_fichas, 'recarga', new.id_pedido)
        on conflict (id_pedido, motivo) do nothing;
      get diagnostics v_filas = row_count;
      if v_filas > 0 then
        insert into juego_fichas (usuario, fichas) values (new.usuario, v_fichas)
          on conflict (usuario) do update set fichas = juego_fichas.fichas + v_fichas, actualizado = now();
      end if;
    end if;
  end if;
  if new.estado = 'reembolsado' and tg_op = 'UPDATE' and old.estado is distinct from 'reembolsado' then
    select m.cambio into v_fichas from juego_movimientos m where m.id_pedido = new.id_pedido and m.motivo = 'recarga';
    if v_fichas is not null then
      insert into juego_movimientos (usuario, cambio, motivo, id_pedido)
        values (new.usuario, -v_fichas, 'reembolso', new.id_pedido)
        on conflict (id_pedido, motivo) do nothing;
      get diagnostics v_filas = row_count;
      if v_filas > 0 then
        update juego_fichas set fichas = fichas - v_fichas, actualizado = now() where usuario = new.usuario;
      end if;
    end if;
  end if;
  return new;
end $$;
revoke execute on function public.juego_fichas_por_recarga() from public, anon, authenticated;
