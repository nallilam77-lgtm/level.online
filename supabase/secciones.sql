-- =====================================================================
-- LEVEL UP · SECCIONES CON SU GANANCIA, STOCK LIMITADO Y PEDIDOS EN ESPERA (desde 2026-11-20)
--
-- Cómo instalarlo: Supabase → SQL Editor → New query → pega TODO este archivo → Run (después de
-- supabase/precios.sql). Se puede volver a correr.
--
-- 1. SECCIONES: cada paquete tiene su sección (precios.seccion; en Free Fire: diamantes, pases, evo) y cada
--    sección puede tener su propio % de ganancia (precios_secciones.ganancia; vacío = el % general).
--    Precio de un paquete sin precio a mano = costo de Central One × cantidad × dólar × (1 + ganancia de SU sección).
-- 2. STOCK LIMITADO: los productos de Central One que dicen cuántas unidades quedan (centralone_catalogo.stock,
--    p. ej. los tokens Evo). La tienda muestra "Quedan X" y, con 2 o menos (margen para otros revendedores),
--    "Agotado". Al ir a pagar, el cliente APARTA una unidad 10 minutos (precios_apartar): dos clientes de la
--    tienda no pagan por la última. Máximo 2 apartados vigentes por conexión.
-- 3. PEDIDOS EN ESPERA: si aun así el producto se agota con el pago ya verificado, el pedido no va a revisión:
--    queda "esperando" stock (pedidos_espera) y Vercel lo entrega solo cuando Central One repone (lo revisa
--    cada minuto). A las 24 h sin reposición queda "vencido" y el administrador decide en el panel: devolver el
--    dinero o cambiarlo por diamantes.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Secciones
-- ---------------------------------------------------------------------
alter table public.precios add column if not exists seccion text check (seccion is null or seccion ~ '^[a-z_]{2,20}$');

create table if not exists public.precios_secciones (
  juego     text not null,
  clave     text not null check (clave ~ '^[a-z_]{2,20}$'),
  titulo    text not null check (length(titulo) between 1 and 40),
  ganancia  numeric(6, 2) check (ganancia is null or (ganancia >= 0 and ganancia <= 300)),   -- vacío = el % general
  orden     smallint not null default 0,
  primary key (juego, clave)
);
alter table public.precios_secciones enable row level security;
revoke all on public.precios_secciones from anon, authenticated;

insert into public.precios_secciones (juego, clave, titulo, orden) values
  ('freefire', 'diamantes', 'Diamantes directos', 1),
  ('freefire', 'pases', 'Pases y membresías', 2),
  ('freefire', 'evo', 'Tokens Evo', 3)
on conflict (juego, clave) do nothing;

-- Sección por el nombre (Free Fire): "Evo" → evo; con letras (además de "Diamantes") → pases; solo números → diamantes
create or replace function public.precios_seccion_auto(p_juego text, p_paquete text)
returns text
language sql
immutable
set search_path = public
as $$
  select case when p_juego <> 'freefire' then null
              when p_paquete ~* '\mevo\M' then 'evo'
              when regexp_replace(lower(p_paquete), 'free\s*fire|latam|diamantes?|diamonds?', '', 'g') ~ '[a-zñáéíóú]' then 'pases'
              else 'diamantes' end
$$;

update public.precios set seccion = precios_seccion_auto(juego, paquete) where juego = 'freefire' and seccion is null;

-- ---------------------------------------------------------------------
-- 2. Apartados de 10 minutos (stock limitado)
-- ---------------------------------------------------------------------
create table if not exists public.precios_reservas (
  id        bigint generated always as identity primary key,
  precio_id bigint not null references public.precios (id) on delete cascade,
  clave     text not null,                         -- la de la pestaña del cliente (la manda con la compra)
  ip        text,                                  -- huella de la conexión (máximo 2 apartados vigentes)
  hasta     timestamptz not null,
  usada     boolean not null default false,
  creada    timestamptz not null default now(),
  unique (precio_id, clave)
);
create index if not exists precios_reservas_vigentes on public.precios_reservas (precio_id, hasta) where not usada;
alter table public.precios_reservas enable row level security;
revoke all on public.precios_reservas from anon, authenticated;

-- precios_de con sección, su ganancia y lo apartado (cambia lo que devuelve: se borra y se vuelve a crear)
drop function if exists public.precios_de(text);
create function public.precios_de(p_juego text)
returns table (id bigint, paquete text, producto text, cantidad smallint, precio_manual numeric, costo_usd numeric,
               precio_calculado numeric, precio numeric, en_stock boolean, stock integer, visto timestamptz,
               orden smallint, activo boolean, fichas_manual integer, fichas integer, precio_cobro numeric,
               seccion text, ganancia numeric, apartados integer)
language sql
stable
security definer
set search_path = public
as $$
  with conf as (select codigos_tasa() as tasa, precios_ganancia() as ganancia,
                       (select bs_por_ficha from juego_ajustes where id = 1) as bs_ficha),
  base as (
    select p.id, p.paquete, p.producto, p.cantidad, p.precio_manual, p.orden, p.activo, p.fichas,
           coalesce(p.seccion, precios_seccion_auto(p.juego, p.paquete)) as seccion,
           coalesce(s.ganancia, conf.ganancia) as ganancia,
           c.costo_usd, c.costo_anterior, c.costo_cambio, c.en_stock as c_stock, c.stock as c_cantidad, c.visto as c_visto,
           conf.tasa, conf.bs_ficha,
           (select count(*)::integer from precios_reservas r where r.precio_id = p.id and not r.usada and r.hasta > now()) as apartados
      from precios p cross join conf
      left join centralone_catalogo c on c.producto = p.producto
      left join precios_secciones s on s.juego = p.juego and s.clave = coalesce(p.seccion, precios_seccion_auto(p.juego, p.paquete))
     where p.juego = p_juego
  ),
  calc as (
    select b.*,
           case when b.costo_usd is not null and b.tasa is not null and b.ganancia is not null
                then round(b.costo_usd * b.cantidad * b.tasa * (1 + b.ganancia / 100), 2) end as calculado,
           -- Lo que se cobra: el menor entre el costo de ahora y el de hace menos de 30 min (least ignora null)
           case when b.costo_usd is not null and b.tasa is not null and b.ganancia is not null
                then round(least(b.costo_usd, case when b.costo_cambio > now() - interval '30 minutes' then b.costo_anterior end)
                           * b.cantidad * b.tasa * (1 + b.ganancia / 100), 2) end as calculado_cobro
      from base b
  )
  select b.id, b.paquete, b.producto, b.cantidad, b.precio_manual, b.costo_usd, b.calculado,
         coalesce(b.precio_manual, b.calculado),
         case when b.producto is null then true else coalesce(b.c_stock, false) end,
         b.c_cantidad, b.c_visto, b.orden, b.activo, b.fichas,
         coalesce(b.fichas, case when coalesce(b.precio_manual, b.calculado) > 0 and b.bs_ficha > 0
                                 then greatest(1, floor(coalesce(b.precio_manual, b.calculado) / b.bs_ficha))::integer end),
         coalesce(b.precio_manual, b.calculado_cobro),
         b.seccion, b.ganancia, b.apartados
    from calc b
   order by b.orden, b.id;
$$;
revoke execute on function public.precios_de(text) from public, anon, authenticated;
grant execute on function public.precios_de(text) to service_role;

-- Apartar una unidad 10 min. { ok, limitado: false } si el paquete no tiene stock contado; { ok, limitado, hasta,
-- quedan } si se apartó; { ok: false, motivo: 'agotado' | 'no_existe' | 'muchos' }.
create or replace function public.precios_apartar(p_juego text, p_paquete text, p_clave text, p_ip text,
  p_minutos integer default 10, p_margen integer default 2)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id bigint; v_stock integer; v_en_stock boolean; v_otros integer; v_hasta timestamptz;
begin
  if coalesce(p_clave, '') !~ '^[A-Za-z0-9_-]{16,64}$' then raise exception 'clave no válida' using errcode = '22023'; end if;
  select p.id, c.stock, coalesce(c.en_stock, false) into v_id, v_stock, v_en_stock
    from precios p left join centralone_catalogo c on c.producto = p.producto
   where p.juego = p_juego and p.paquete = p_paquete and p.activo;
  if v_id is null then return jsonb_build_object('ok', false, 'motivo', 'no_existe'); end if;
  if v_stock is null then return jsonb_build_object('ok', true, 'limitado', false); end if;
  perform pg_advisory_xact_lock(v_id);
  -- Ya lo tiene apartado esta pestaña: el mismo apartado (no se alarga solo)
  select hasta into v_hasta from precios_reservas where precio_id = v_id and clave = p_clave and not usada and hasta > now();
  if v_hasta is not null then
    select count(*) into v_otros from precios_reservas where precio_id = v_id and not usada and hasta > now() and clave <> p_clave;
    return jsonb_build_object('ok', true, 'limitado', true, 'hasta', v_hasta, 'quedan', greatest(0, v_stock - p_margen - v_otros - 1));
  end if;
  if p_ip is not null and (select count(*) from precios_reservas where ip = p_ip and not usada and hasta > now()) >= 2 then
    return jsonb_build_object('ok', false, 'motivo', 'muchos');
  end if;
  select count(*) into v_otros from precios_reservas where precio_id = v_id and not usada and hasta > now() and clave <> p_clave;
  if not v_en_stock or v_stock - p_margen - v_otros <= 0 then
    return jsonb_build_object('ok', false, 'motivo', 'agotado', 'quedan', 0);
  end if;
  v_hasta := now() + make_interval(mins => least(greatest(coalesce(p_minutos, 10), 1), 30));
  insert into precios_reservas (precio_id, clave, ip, hasta) values (v_id, p_clave, p_ip, v_hasta)
  on conflict (precio_id, clave) do update set hasta = excluded.hasta, usada = false, ip = excluded.ip, creada = now();
  delete from precios_reservas where hasta < now() - interval '1 day';
  return jsonb_build_object('ok', true, 'limitado', true, 'hasta', v_hasta, 'quedan', greatest(0, v_stock - p_margen - v_otros - 1));
end;
$$;

-- La compra usa el apartado de esa pestaña (deja de contar como apartado)
create or replace function public.precios_usar_apartado(p_clave text)
returns void
language sql
security definer
set search_path = public
as $$ update precios_reservas set usada = true where clave = p_clave and not usada $$;

revoke execute on function public.precios_apartar(text, text, text, text, integer, integer), public.precios_usar_apartado(text)
  from public, anon, authenticated;
grant execute on function public.precios_apartar(text, text, text, text, integer, integer), public.precios_usar_apartado(text) to service_role;

-- ---------------------------------------------------------------------
-- 3. Pedidos en espera de stock
-- ---------------------------------------------------------------------
create table if not exists public.pedidos_espera (
  id_pedido   text primary key,                    -- el mismo de "recargas"
  juego       text not null,
  paquete     text not null,
  id_jugador  text not null,
  referencias text,                                -- del pago (solo para el administrador)
  monto       numeric,
  creado      timestamptz not null default now(),
  vence       timestamptz not null,                -- creado + 24 h
  estado      text not null default 'esperando'
              check (estado in ('esperando', 'entregando', 'entregado', 'vencido', 'reembolsado', 'cambiado')),
  intento     smallint not null default 0,         -- veces que se intentó al volver el stock (cambia la Idempotency-Key)
  nota        text,
  actualizado timestamptz not null default now()
);
create index if not exists pedidos_espera_estado on public.pedidos_espera (estado, creado);
alter table public.pedidos_espera enable row level security;
revoke all on public.pedidos_espera from anon, authenticated;
grant select on public.pedidos_espera to authenticated;
drop policy if exists "admin ve los pedidos en espera" on public.pedidos_espera;
create policy "admin ve los pedidos en espera" on public.pedidos_espera for select to authenticated using ((select public.es_admin()));

-- Toma un pedido para entregarlo (dos minutos a la vez no lo toman los dos). Los "entregando" de hace más de 10 min
-- (se cortó la función) se pueden volver a tomar: el intento nuevo usa otra Idempotency-Key solo si el anterior falló.
create or replace function public.espera_tomar(p_id text)
returns setof pedidos_espera
language sql
security definer
set search_path = public
as $$
  update pedidos_espera set estado = 'entregando', actualizado = now()
   where id_pedido = p_id and (estado = 'esperando' or (estado = 'entregando' and actualizado < now() - interval '10 minutes'))
  returning *
$$;

create or replace function public.espera_fin(p_id text, p_estado text, p_nota text, p_intento smallint)
returns boolean
language sql
security definer
set search_path = public
as $$
  with u as (update pedidos_espera set estado = p_estado, nota = left(p_nota, 500), intento = greatest(intento, coalesce(p_intento, 0)), actualizado = now()
              where id_pedido = p_id and p_estado in ('esperando', 'entregado', 'vencido', 'cambiado') returning 1)
  select exists (select 1 from u)
$$;

-- Los que pasaron 24 h esperando: "vencido" (los decide el administrador). Devuelve cuántos.
create or replace function public.esperas_vencer()
returns integer
language sql
security definer
set search_path = public
as $$
  with u as (update pedidos_espera set estado = 'vencido', nota = coalesce(nota || ' · ', '') || 'Pasaron 24 h sin stock', actualizado = now()
              where estado = 'esperando' and vence <= now() returning 1)
  select count(*)::integer from u
$$;

revoke execute on function public.espera_tomar(text), public.espera_fin(text, text, text, smallint), public.esperas_vencer()
  from public, anon, authenticated;
grant execute on function public.espera_tomar(text), public.espera_fin(text, text, text, smallint), public.esperas_vencer() to service_role;

-- Panel: devolver el dinero (lo hace el administrador por Pago Móvil; aquí solo se anota)
create or replace function public.admin_espera_reembolsar(p_id text, p_nota text default null)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  perform admin_revisar();
  update pedidos_espera set estado = 'reembolsado', nota = coalesce(nota || ' · ', '') || coalesce(nullif(left(trim(p_nota), 200), ''), 'Dinero devuelto'), actualizado = now()
   where id_pedido = p_id and estado in ('esperando', 'vencido');
  if not found then return false; end if;
  update recargas set estado = 'reembolsado', actualizado = now() where id_pedido = p_id;
  return true;
end;
$$;
revoke execute on function public.admin_espera_reembolsar(text, text) from public, anon;
grant execute on function public.admin_espera_reembolsar(text, text) to authenticated;

-- ---------------------------------------------------------------------
-- 4. Panel: secciones y paquetes
-- ---------------------------------------------------------------------
create or replace function public.admin_seccion_guardar(p_juego text, p_clave text, p_titulo text, p_ganancia numeric)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  perform admin_revisar();
  if p_ganancia is not null and (p_ganancia < 0 or p_ganancia > 300) then
    raise exception 'Escribe un %% de ganancia entre 0 y 300 (o déjalo vacío para usar el general).' using errcode = '22023';
  end if;
  if length(trim(coalesce(p_titulo, ''))) not between 1 and 40 then
    raise exception 'Escribe el nombre de la sección (máximo 40 letras).' using errcode = '22023';
  end if;
  update precios_secciones set titulo = trim(p_titulo), ganancia = round(p_ganancia, 2) where juego = p_juego and clave = p_clave;
  return found;
end;
$$;
revoke execute on function public.admin_seccion_guardar(text, text, text, numeric) from public, anon;
grant execute on function public.admin_seccion_guardar(text, text, text, numeric) to authenticated;

-- admin_precio_guardar con sección (p_seccion vacío = la de siempre; en uno nuevo, por el nombre)
drop function if exists public.admin_precio_guardar(bigint, text, text, text, integer, numeric, boolean, integer);
create or replace function public.admin_precio_guardar(p_id bigint, p_juego text, p_paquete text, p_producto text,
  p_cantidad integer default 1, p_precio_manual numeric default null, p_activo boolean default true, p_orden integer default null,
  p_seccion text default null)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_paquete text := trim(coalesce(p_paquete, ''));
  v_producto text := nullif(lower(trim(coalesce(p_producto, ''))), '');
  v_seccion text := nullif(trim(coalesce(p_seccion, '')), '');
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
  if v_seccion is not null and not exists (select 1 from precios_secciones where juego = p_juego and clave = v_seccion) then
    raise exception 'Esa sección no existe.' using errcode = '22023';
  end if;
  if exists (select 1 from precios where juego = p_juego and paquete = v_paquete and id is distinct from p_id) then
    raise exception 'Ya hay un paquete llamado "%" en este juego.', v_paquete using errcode = '23505';
  end if;
  if p_id is null then
    insert into precios (juego, paquete, producto, cantidad, precio_manual, activo, orden, seccion)
    values (p_juego, v_paquete, v_producto, coalesce(p_cantidad, 1), round(p_precio_manual, 2), coalesce(p_activo, true),
            coalesce(p_orden, (select coalesce(max(orden), 0) + 1 from precios where juego = p_juego)),
            coalesce(v_seccion, precios_seccion_auto(p_juego, v_paquete)))
    returning id into v_id;
  else
    update precios set paquete = v_paquete, producto = v_producto, cantidad = coalesce(p_cantidad, 1),
           precio_manual = round(p_precio_manual, 2), activo = coalesce(p_activo, activo),
           orden = coalesce(p_orden, orden), seccion = coalesce(v_seccion, seccion), actualizado = now()
     where id = p_id and juego = p_juego
    returning id into v_id;
    if v_id is null then raise exception 'No existe ese paquete.' using errcode = 'P0002'; end if;
  end if;
  return v_id;
end;
$$;
revoke execute on function public.admin_precio_guardar(bigint, text, text, text, integer, numeric, boolean, integer, text) from public, anon;
grant execute on function public.admin_precio_guardar(bigint, text, text, text, integer, numeric, boolean, integer, text) to authenticated, service_role;

-- admin_precios con las secciones del juego y los pedidos en espera
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
    'secciones', (select coalesce(jsonb_agg(jsonb_build_object('clave', s.clave, 'titulo', s.titulo, 'ganancia', s.ganancia) order by s.orden), '[]'::jsonb)
                    from precios_secciones s where s.juego = p_juego),
    'paquetes', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from precios_de(p_juego) x),
    'sin_usar', (
      select coalesce(jsonb_agg(jsonb_build_object('producto', c.producto, 'nombre', c.nombre, 'region', c.region,
               'costo_usd', c.costo_usd, 'en_stock', c.en_stock, 'stock', c.stock) order by c.costo_usd), '[]'::jsonb)
        from centralone_catalogo c
       where c.juego = p_juego and not exists (select 1 from precios p where p.producto = c.producto and p.juego = p_juego)
    ),
    'diferencias', (
      select coalesce(jsonb_agg(to_jsonb(d) order by d.paquete), '[]'::jsonb) from precios_diferencias d where d.juego = p_juego
    ),
    'cambios', (
      select coalesce(jsonb_agg(to_jsonb(x) order by x.fecha desc), '[]'::jsonb) from (
        select fecha, nombre, tipo, antes, despues from centralone_cambios
         where juego = p_juego and fecha > now() - interval '7 days' order by fecha desc limit 30
      ) x
    ),
    'esperas', (
      select coalesce(jsonb_agg(to_jsonb(e) order by e.creado desc), '[]'::jsonb) from (
        select * from pedidos_espera where juego = p_juego and (estado in ('esperando', 'entregando', 'vencido') or creado > now() - interval '3 days')
         order by creado desc limit 50
      ) e
    )
  );
end;
$$;
revoke execute on function public.admin_precios(text) from public, anon;
grant execute on function public.admin_precios(text) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 5. Tokens Evo de Free Fire (con la ganancia de su sección). Entran OCULTOS: se muestran desde el panel
--    (Precios → Mostrar) o con: update precios set activo = true where juego = 'freefire' and seccion = 'evo';
-- ---------------------------------------------------------------------
insert into public.precios (juego, paquete, producto, cantidad, activo, orden, seccion)
select 'freefire', trim(regexp_replace(c.nombre, '^\s*Free\s*Fire\s*LATAM\s*·\s*', '', 'i')), c.producto, 1, false,
       (select coalesce(max(orden), 0) from precios where juego = 'freefire') + row_number() over (order by c.costo_usd),
       'evo'
  from centralone_catalogo c
 where c.juego = 'freefire' and c.nombre ~* '\mevo\M'
   and not exists (select 1 from precios p where p.producto = c.producto)
on conflict (juego, paquete) do nothing;

-- Juegos con algún paquete a la venta de stock contado (Vercel relee su catálogo cada minuto)
create or replace function public.precios_juegos_limitados()
returns setof text
language sql
stable
security definer
set search_path = public
as $$
  select distinct p.juego from precios p join centralone_catalogo c on c.producto = p.producto
   where p.activo and c.stock is not null
$$;
revoke execute on function public.precios_juegos_limitados() from public, anon, authenticated;
grant execute on function public.precios_juegos_limitados() to service_role;
