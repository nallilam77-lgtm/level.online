-- =====================================================================
-- LEVEL UP · CÓDIGOS DE REGALO (desde 2026-11-15)
--
-- Cómo instalarlo: Supabase → SQL Editor → New query → pega TODO este archivo → Run.
-- Se puede volver a correr.
--
-- El administrador crea códigos (admin.html → Canjes, p. ej. 5 códigos de 110 Diamantes de Free Fire).
-- El PRIMERO que canjea un código en canjear.html con su ID se lleva el premio: Vercel (api/_lib/canjes.js)
-- lo toma aquí en un solo paso (dos personas a la vez: solo una gana) y pide la recarga a Central One.
-- Si Central One la rechaza (ID malo, sin stock…), el código vuelve a quedar libre.
-- canjear.html muestra los últimos canjes: nombre del jugador en Free Fire, ID tapado y cuándo.
-- =====================================================================

create table if not exists public.codigos_regalo (
  codigo      text primary key,                         -- "LEVELUP-XXXXXXXX" (letras y números sin O/0/I/1); los primeros, "LU-XXXX-XXXX"
  juego       text not null default 'freefire',
  paquete     text not null default '110 Diamantes',    -- nombre exacto del paquete en Precios
  nota        text,                                     -- para el administrador (p. ej. "sorteo del canal")
  creado      timestamptz not null default now(),
  canjeado    timestamptz,                              -- vacío = libre
  id_jugador  text,
  nombre      text,                                     -- nombre del jugador según Free Fire
  id_pedido   text,                                     -- la recarga (tabla recargas)
  estado      text not null default 'libre' check (estado in ('libre', 'entregando', 'entregado', 'revisar'))
);
create index if not exists codigos_regalo_canjeados on public.codigos_regalo (canjeado desc) where canjeado is not null;
-- Cuánto tardó en resolver el reto de sumas (desde 2026-11-15; lo mide el servidor): se muestra en la lista
alter table public.codigos_regalo add column if not exists tiempo_ms integer;

alter table public.codigos_regalo enable row level security;
revoke all on public.codigos_regalo from anon, authenticated;
grant select on public.codigos_regalo to authenticated;
drop policy if exists "los administradores ven los codigos de regalo" on public.codigos_regalo;
create policy "los administradores ven los codigos de regalo" on public.codigos_regalo
  for select to authenticated using ((select public.es_admin()));

-- ---------------------------------------------------------------------
-- Panel: crear y borrar códigos (solo administradores)
-- ---------------------------------------------------------------------
create or replace function public.admin_canjes_crear(p_cantidad integer, p_paquete text default '110 Diamantes', p_nota text default null)
returns setof text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_letras constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_codigo text;
  v_creados integer := 0;
  i integer;
begin
  if not (select es_admin()) then raise exception 'solo administradores' using errcode = '42501'; end if;
  if coalesce(p_cantidad, 0) < 1 or p_cantidad > 50 then raise exception 'Entre 1 y 50 códigos.' using errcode = '22023'; end if;
  if not exists (select 1 from precios where juego = 'freefire' and paquete = p_paquete and producto is not null) then
    raise exception 'El paquete "%" no existe en Precios de Free Fire.', p_paquete using errcode = '22023';
  end if;
  -- "LEVELUP-" + 8 letras/números al azar (desde 2026-11-15; los primeros eran "LU-XXXX-XXXX" y siguen valiendo)
  while v_creados < p_cantidad loop
    v_codigo := 'LEVELUP-';
    for i in 1..8 loop
      v_codigo := v_codigo || substr(v_letras, 1 + (get_byte(extensions.gen_random_bytes(1), 0) % length(v_letras)), 1);
    end loop;
    insert into codigos_regalo (codigo, paquete, nota) values (v_codigo, p_paquete, nullif(left(trim(coalesce(p_nota, '')), 120), ''))
      on conflict (codigo) do nothing;
    if found then v_creados := v_creados + 1; return next v_codigo; end if;
  end loop;
end;
$$;
revoke execute on function public.admin_canjes_crear(integer, text, text) from public, anon;
grant execute on function public.admin_canjes_crear(integer, text, text) to authenticated;

create or replace function public.admin_canje_borrar(p_codigo text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not (select es_admin()) then raise exception 'solo administradores' using errcode = '42501'; end if;
  delete from codigos_regalo where codigo = upper(trim(p_codigo)) and canjeado is null;
  return found;
end;
$$;
revoke execute on function public.admin_canje_borrar(text) from public, anon;
grant execute on function public.admin_canje_borrar(text) to authenticated;

-- ---------------------------------------------------------------------
-- Canje (solo el servidor: api/_lib/canjes.js con la llave secreta)
-- ---------------------------------------------------------------------
-- Toma el código si está libre. { ok, paquete } · { ok: false, motivo: 'no_existe' | 'ya_canjeado' }
-- p_tiempo_ms: lo que tardó en el reto de sumas (opcional: así el servidor viejo sigue funcionando)
drop function if exists public.canje_tomar(text, text, text, text);
create or replace function public.canje_tomar(p_codigo text, p_id_jugador text, p_nombre text, p_id_pedido text, p_tiempo_ms integer default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_paquete text;
begin
  update codigos_regalo
     set canjeado = now(), id_jugador = left(p_id_jugador, 20), nombre = left(coalesce(p_nombre, ''), 60),
         id_pedido = left(p_id_pedido, 80), estado = 'entregando',
         tiempo_ms = case when p_tiempo_ms between 0 and 600000 then p_tiempo_ms end
   where codigo = upper(trim(p_codigo)) and canjeado is null
  returning paquete into v_paquete;
  if v_paquete is not null then return jsonb_build_object('ok', true, 'paquete', v_paquete); end if;
  if exists (select 1 from codigos_regalo where codigo = upper(trim(p_codigo))) then
    return jsonb_build_object('ok', false, 'motivo', 'ya_canjeado');
  end if;
  return jsonb_build_object('ok', false, 'motivo', 'no_existe');
end;
$$;

-- Central One rechazó la recarga (no cobró): el código vuelve a quedar libre
create or replace function public.canje_liberar(p_codigo text, p_id_pedido text)
returns void
language sql
security definer
set search_path = public
as $$
  update codigos_regalo set canjeado = null, id_jugador = null, nombre = null, id_pedido = null, estado = 'libre', tiempo_ms = null
   where codigo = upper(trim(p_codigo)) and id_pedido = p_id_pedido;
$$;

-- 'entregando' (Central One lo aceptó) o 'revisar' (no se sabe si se creó el pedido: lo ve el administrador)
create or replace function public.canje_estado(p_codigo text, p_id_pedido text, p_estado text)
returns void
language sql
security definer
set search_path = public
as $$
  update codigos_regalo set estado = p_estado
   where codigo = upper(trim(p_codigo)) and id_pedido = p_id_pedido and p_estado in ('entregando', 'entregado', 'revisar');
$$;

revoke execute on function public.canje_tomar(text, text, text, text, integer) from public, anon, authenticated;
revoke execute on function public.canje_liberar(text, text) from public, anon, authenticated;
revoke execute on function public.canje_estado(text, text, text) from public, anon, authenticated;
grant execute on function public.canje_tomar(text, text, text, text, integer) to service_role;
grant execute on function public.canje_liberar(text, text) to service_role;
grant execute on function public.canje_estado(text, text, text) to service_role;

-- Cuando la recarga del canje queda entregada (aviso de Central One o "Ya la entregué" del panel),
-- el código pasa a 'entregado'
create or replace function public.canje_recarga_entregada()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.estado = 'completado' and old.estado is distinct from 'completado' then
    update codigos_regalo set estado = 'entregado' where id_pedido = new.id_pedido and estado <> 'entregado';
  end if;
  return new;
end;
$$;
revoke execute on function public.canje_recarga_entregada() from public, anon, authenticated;
drop trigger if exists canje_recarga_entregada on public.recargas;
create trigger canje_recarga_entregada after update of estado on public.recargas
  for each row execute function public.canje_recarga_entregada();

-- ---------------------------------------------------------------------
-- Lo que ve cualquiera en canjear.html: los últimos 30 canjes. El ID y el código van tapados.
-- ---------------------------------------------------------------------
drop function if exists public.canjes_publicos();
create or replace function public.canjes_publicos()
returns table (codigo text, paquete text, nombre text, id_jugador text, canjeado timestamptz, entregado boolean, tiempo_ms integer)
language sql
stable
security definer
set search_path = public
as $$
  select case when c.codigo like 'LEVELUP-%' then left(c.codigo, 10) || '••••••' else left(c.codigo, 5) || '••-••••' end, c.paquete, coalesce(nullif(c.nombre, ''), 'Jugador'),
         left(c.id_jugador, 3) || repeat('•', greatest(length(c.id_jugador) - 5, 2)) || right(c.id_jugador, 2),
         c.canjeado, c.estado = 'entregado', c.tiempo_ms
    from codigos_regalo c
   where c.canjeado is not null
   order by c.canjeado desc
   limit 30;
$$;
revoke execute on function public.canjes_publicos() from public;
grant execute on function public.canjes_publicos() to anon, authenticated, service_role;

-- Cuántos quedan libres (para "Quedan N códigos" en la página)
create or replace function public.canjes_libres()
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::integer from codigos_regalo where canjeado is null;
$$;
revoke execute on function public.canjes_libres() from public;
grant execute on function public.canjes_libres() to anon, authenticated, service_role;
