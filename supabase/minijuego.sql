-- =====================================================================
-- LEVEL UP · MINIJUEGO "LLUVIA DE DIAMANTES" (fichas, partidas y ranking semanal)
--
-- Cómo instalarlo: Supabase → SQL Editor → New query → pega TODO este archivo → Run (después de
-- supabase/levelup.sql). Se puede volver a correr.
--
-- Reglas (desde 2026-11-13):
--   - Las fichas se ganan con las recargas COMPLETADAS de clientes con sesión (tabla "recargas") en las
--     tiendas automáticas: fichas = precio pagado ÷ bs_por_ficha (redondeado hacia abajo, mínimo 1).
--     Lo hace el disparador de abajo, una sola vez por pedido. Si el pedido se reembolsa, se descuentan.
--   - Cada partida cuesta costo_partida fichas (4 desde 2026-11-14; se cambia en admin.html → Precios). Al empezar, el servidor cobra y da la SEMILLA.
--   - Al terminar, el servidor (api/minijuego.js) REPITE la partida con la semilla y los movimientos y
--     guarda los puntos que calcula él. Las partidas que no cuadran quedan "invalida" y no cuentan.
--   - Ranking: mejor partida válida de cada cliente desde el lunes 00:00 (hora de Venezuela). Empate:
--     gana quien llegó primero a ese puntaje.
--
-- Para cambiar cuántos Bs vale 1 ficha (por ejemplo, cuando suben los precios):
--   update public.juego_ajustes set bs_por_ficha = 900 where id = 1;
--
-- Quién escribe: SOLO Vercel (llave secreta) y el disparador. El navegador no puede leer ni escribir
-- estas tablas (RLS sin políticas): todo pasa por /api/minijuego.
-- =====================================================================

create table if not exists public.juego_ajustes (
  id            integer primary key default 1 check (id = 1),
  bs_por_ficha  numeric(12, 2) not null default 780 check (bs_por_ficha > 0),
  costo_partida integer not null default 4 check (costo_partida > 0),
  actualizado   timestamptz not null default now()
);
insert into public.juego_ajustes (id) values (1) on conflict (id) do nothing;

create table if not exists public.juego_fichas (
  usuario     uuid primary key references auth.users (id) on delete cascade,
  fichas      integer not null default 0,
  actualizado timestamptz not null default now()
);

-- Cada ficha que entra o sale (para revisar a mano). Un pedido solo da fichas una vez.
create table if not exists public.juego_movimientos (
  id         bigint generated always as identity primary key,
  usuario    uuid not null references auth.users (id) on delete cascade,
  cambio     integer not null,
  motivo     text not null check (motivo in ('recarga', 'reembolso', 'partida', 'ajuste')),
  id_pedido  text,
  id_partida uuid,
  creado     timestamptz not null default now(),
  unique (id_pedido, motivo)
);
create index if not exists juego_movimientos_usuario on public.juego_movimientos (usuario, creado desc);

create table if not exists public.juego_partidas (
  id          uuid primary key default gen_random_uuid(),
  usuario     uuid not null references auth.users (id) on delete cascade,
  semilla     bigint not null,
  estado      text not null default 'abierta' check (estado in ('abierta', 'valida', 'invalida', 'vencida')),
  puntos      integer,
  ticks       integer,                             -- pasos de 1/60 s que duró (máx. 3600 = 1 minuto)
  registro    jsonb,                               -- movimientos del cofre [[tick, x], ...] (para revisar)
  motivo      text,                                -- por qué quedó inválida
  creada      timestamptz not null default now(),
  terminada   timestamptz
);
create index if not exists juego_partidas_validas on public.juego_partidas (terminada) where estado = 'valida';
create index if not exists juego_partidas_usuario on public.juego_partidas (usuario, creada desc);

alter table public.juego_ajustes enable row level security;
alter table public.juego_fichas enable row level security;
alter table public.juego_movimientos enable row level security;
alter table public.juego_partidas enable row level security;
revoke all on public.juego_ajustes, public.juego_fichas, public.juego_movimientos, public.juego_partidas from anon, authenticated;

-- ---------------------------------------------------------------------
-- Fichas por recarga (disparador sobre "recargas")
-- ---------------------------------------------------------------------
create or replace function public.juego_fichas_por_recarga()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fichas integer;
  v_filas  integer;
begin
  -- Sin usuario (pedido sin sesión, supabase/tienda.sql) no hay fichas
  if new.usuario is null or new.juego not in ('freefire', 'bloodstrike', 'mobilelegends', 'roblox') then
    return new;
  end if;

  -- Recarga completada: fichas = precio ÷ bs_por_ficha (mínimo 1), una sola vez por pedido
  if new.estado = 'completado' and (tg_op = 'INSERT' or old.estado is distinct from 'completado') then
    select greatest(1, floor(coalesce(new.precio, 0) / a.bs_por_ficha))::integer into v_fichas
      from juego_ajustes a where a.id = 1;
    insert into juego_movimientos (usuario, cambio, motivo, id_pedido)
      values (new.usuario, v_fichas, 'recarga', new.id_pedido)
      on conflict (id_pedido, motivo) do nothing;
    get diagnostics v_filas = row_count;
    if v_filas > 0 then
      insert into juego_fichas (usuario, fichas) values (new.usuario, v_fichas)
        on conflict (usuario) do update set fichas = juego_fichas.fichas + v_fichas, actualizado = now();
    end if;
  end if;

  -- Reembolsada: se quitan las fichas que dio (si dio y no se quitaron ya)
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

drop trigger if exists juego_fichas_por_recarga on public.recargas;
create trigger juego_fichas_por_recarga
  after insert or update of estado on public.recargas
  for each row execute function public.juego_fichas_por_recarga();

-- ---------------------------------------------------------------------
-- Empezar partida: cobra las fichas y crea la partida con la semilla (todo o nada)
-- Devuelve { ok, id, fichas, costo } o { ok: false, fichas, costo } si no alcanzan.
-- Una partida abierta anterior queda "vencida" (sus fichas ya se cobraron).
-- ---------------------------------------------------------------------
create or replace function public.juego_empezar(p_usuario uuid, p_semilla bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_costo  integer;
  v_fichas integer;
  v_id     uuid;
begin
  select costo_partida into v_costo from juego_ajustes where id = 1;
  insert into juego_fichas (usuario) values (p_usuario) on conflict (usuario) do nothing;
  select fichas into v_fichas from juego_fichas where usuario = p_usuario for update;
  if v_fichas < v_costo then
    return jsonb_build_object('ok', false, 'fichas', v_fichas, 'costo', v_costo);
  end if;
  update juego_partidas set estado = 'vencida', motivo = 'se empezó otra', terminada = now()
    where usuario = p_usuario and estado = 'abierta';
  insert into juego_partidas (usuario, semilla) values (p_usuario, p_semilla) returning id into v_id;
  update juego_fichas set fichas = fichas - v_costo, actualizado = now() where usuario = p_usuario;
  insert into juego_movimientos (usuario, cambio, motivo, id_partida) values (p_usuario, -v_costo, 'partida', v_id);
  return jsonb_build_object('ok', true, 'id', v_id, 'fichas', v_fichas - v_costo, 'costo', v_costo);
end $$;

-- ---------------------------------------------------------------------
-- Ranking: mejor partida válida de cada cliente entre p_desde y p_hasta (null = hasta ahora). Devuelve los p_limite primeros y,
-- si p_yo no está entre ellos, también su fila (soy_yo = true).
-- ---------------------------------------------------------------------
create or replace function public.juego_ranking(p_desde timestamptz, p_hasta timestamptz default null, p_limite integer default 10, p_yo uuid default null)
returns table (puesto integer, nombre text, foto text, puntos integer, soy_yo boolean)
language sql
stable
security definer
set search_path = public
as $$
  with mejores as (
    select distinct on (p.usuario) p.usuario, p.puntos, p.terminada
      from juego_partidas p
     where p.estado = 'valida' and p.terminada >= p_desde and (p_hasta is null or p.terminada < p_hasta)
     order by p.usuario, p.puntos desc, p.terminada asc
  ), ordenados as (
    select m.*, (row_number() over (order by m.puntos desc, m.terminada asc))::integer as puesto from mejores m
  )
  select o.puesto,
         coalesce(nullif(trim(
           split_part(trim(coalesce(u.raw_user_meta_data ->> 'full_name', u.raw_user_meta_data ->> 'name', '')), ' ', 1) || ' ' ||
           coalesce(nullif(left(split_part(trim(coalesce(u.raw_user_meta_data ->> 'full_name', u.raw_user_meta_data ->> 'name', '')), ' ', 2), 1), '') || '.', '')
         ), ''), 'Jugador'),
         nullif(u.raw_user_meta_data ->> 'avatar_url', ''),
         o.puntos,
         (p_yo is not null and o.usuario = p_yo)
    from ordenados o
    join auth.users u on u.id = o.usuario
   where o.puesto <= least(greatest(coalesce(p_limite, 10), 1), 50) or (p_yo is not null and o.usuario = p_yo)
   order by o.puesto;
$$;

revoke execute on function public.juego_fichas_por_recarga() from public, anon, authenticated;
revoke execute on function public.juego_empezar(uuid, bigint) from public, anon, authenticated;
revoke execute on function public.juego_ranking(timestamptz, timestamptz, integer, uuid) from public, anon, authenticated;
grant execute on function public.juego_empezar(uuid, bigint) to service_role;
grant execute on function public.juego_ranking(timestamptz, timestamptz, integer, uuid) to service_role;

-- Recargas completadas de antes de instalar esto: también dan sus fichas (una sola vez)
with dadas as (
  insert into public.juego_movimientos (usuario, cambio, motivo, id_pedido)
  select r.usuario, greatest(1, floor(coalesce(r.precio, 0) / a.bs_por_ficha))::integer, 'recarga', r.id_pedido
    from public.recargas r cross join public.juego_ajustes a
   where a.id = 1 and r.estado = 'completado' and r.juego in ('freefire', 'bloodstrike', 'mobilelegends', 'roblox')
  on conflict (id_pedido, motivo) do nothing
  returning usuario, cambio
)
insert into public.juego_fichas (usuario, fichas)
select usuario, sum(cambio)::integer from dadas group by usuario
on conflict (usuario) do update set fichas = juego_fichas.fichas + excluded.fichas, actualizado = now();

-- Ganador de la semana pasada (para pagar los 341 diamantes): corre esto el lunes
--   select * from public.juego_ranking(
--     date_trunc('week', (now() at time zone 'America/Caracas') - interval '7 days') at time zone 'America/Caracas',
--     date_trunc('week', now() at time zone 'America/Caracas') at time zone 'America/Caracas', 3);

-- =====================================================================
-- v2 (2026-11-13): contra errores y trampas. Se puede correr sobre lo anterior.
--   - clave: el teléfono manda una clave por cada "Jugar". Si se corta la conexión y reintenta con la
--     misma clave, recibe la MISMA partida (no se cobran fichas dos veces).
--   - stats: lo que pasó en la partida según el servidor (diamantes atrapados/escapados, golpes...).
--   - revisar: partida demasiado perfecta (posible programa que juega solo). Cuenta para el ranking,
--     pero revísala antes de pagar el premio con juego_revision (abajo).
-- =====================================================================
alter table public.juego_partidas add column if not exists clave uuid;
alter table public.juego_partidas add column if not exists stats jsonb;
alter table public.juego_partidas add column if not exists revisar boolean not null default false;
create unique index if not exists juego_partidas_clave on public.juego_partidas (usuario, clave) where clave is not null;

drop function if exists public.juego_empezar(uuid, bigint);
create or replace function public.juego_empezar(p_usuario uuid, p_semilla bigint, p_clave uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_costo   integer;
  v_fichas  integer;
  v_id      uuid;
  v_semilla bigint;
begin
  select costo_partida into v_costo from juego_ajustes where id = 1;
  insert into juego_fichas (usuario) values (p_usuario) on conflict (usuario) do nothing;
  select fichas into v_fichas from juego_fichas where usuario = p_usuario for update;

  -- Reintento del mismo "Jugar": la misma partida, sin cobrar otra vez
  if p_clave is not null then
    select p.id, p.semilla into v_id, v_semilla from juego_partidas p
     where p.usuario = p_usuario and p.clave = p_clave and p.estado = 'abierta';
    if v_id is not null then
      return jsonb_build_object('ok', true, 'id', v_id, 'semilla', v_semilla, 'fichas', v_fichas, 'costo', v_costo, 'repetida', true);
    end if;
  end if;

  if v_fichas < v_costo then
    return jsonb_build_object('ok', false, 'fichas', v_fichas, 'costo', v_costo);
  end if;
  update juego_partidas set estado = 'vencida', motivo = 'se empezó otra', terminada = now()
    where usuario = p_usuario and estado = 'abierta';
  insert into juego_partidas (usuario, semilla, clave) values (p_usuario, p_semilla, p_clave) returning id into v_id;
  update juego_fichas set fichas = fichas - v_costo, actualizado = now() where usuario = p_usuario;
  insert into juego_movimientos (usuario, cambio, motivo, id_partida) values (p_usuario, -v_costo, 'partida', v_id);
  return jsonb_build_object('ok', true, 'id', v_id, 'semilla', p_semilla, 'fichas', v_fichas - v_costo, 'costo', v_costo);
end $$;

-- Revisión antes de pagar: los mejores de la semana con correo, su mejor partida, estadísticas y si
-- quedó marcada para revisar. Solo desde el SQL Editor (o el servidor), nunca desde el navegador.
--   Semana actual:
--     select * from public.juego_revision(date_trunc('week', now() at time zone 'America/Caracas') at time zone 'America/Caracas', null, 10);
--   Semana pasada (para pagar el lunes):
--     select * from public.juego_revision(
--       date_trunc('week', (now() at time zone 'America/Caracas') - interval '7 days') at time zone 'America/Caracas',
--       date_trunc('week', now() at time zone 'America/Caracas') at time zone 'America/Caracas', 10);
-- OJO: supabase/tienda.sql la reemplaza con más columnas (telefono, nombre). Si corres este archivo de nuevo,
-- corre después tienda.sql (o antes: drop function public.juego_revision(timestamptz, timestamptz, integer)).
create or replace function public.juego_revision(p_desde timestamptz, p_hasta timestamptz default null, p_limite integer default 10)
returns table (puesto integer, correo text, puntos integer, revisar boolean, stats jsonb, segundos numeric,
               partidas_validas integer, partidas_invalidas integer, terminada timestamptz, id_partida uuid)
language sql
stable
security definer
set search_path = public
as $$
  with semana as (
    select * from juego_partidas p
     where p.terminada >= p_desde and (p_hasta is null or p.terminada < p_hasta)
  ), mejores as (
    select distinct on (s.usuario) s.* from semana s where s.estado = 'valida'
     order by s.usuario, s.puntos desc, s.terminada asc
  ), ordenados as (
    select m.*, (row_number() over (order by m.puntos desc, m.terminada asc))::integer as puesto from mejores m
  )
  select o.puesto, u.email::text, o.puntos, o.revisar, o.stats, round(o.ticks / 60.0, 1),
         (select count(*) from semana x where x.usuario = o.usuario and x.estado = 'valida')::integer,
         (select count(*) from semana x where x.usuario = o.usuario and x.estado = 'invalida')::integer,
         o.terminada, o.id
    from ordenados o join auth.users u on u.id = o.usuario
   where o.puesto <= least(greatest(coalesce(p_limite, 10), 1), 50)
   order by o.puesto;
$$;

revoke execute on function public.juego_empezar(uuid, bigint, uuid) from public, anon, authenticated;
revoke execute on function public.juego_revision(timestamptz, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.juego_empezar(uuid, bigint, uuid) to service_role;
grant execute on function public.juego_revision(timestamptz, timestamptz, integer) to service_role;
