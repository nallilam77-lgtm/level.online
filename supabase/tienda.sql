-- =====================================================================
-- LEVEL UP · TIENDA EN SUPABASE (fases 1 y 2, desde 2026-11-13)
--
-- Cómo instalarlo: Supabase → SQL Editor → New query → pega TODO este archivo → Run (después de
-- supabase/levelup.sql y supabase/minijuego.sql). Se puede volver a correr.
--
--   Fase 1 (sin Firebase en Vercel ni en las tiendas):
--     limites          límite de intentos fallidos y de uso (antes Firestore "limites_recarga").
--                      Solo el servidor (api/_lib/limitador.js).
--     configuracion    datos de Pago Móvil (y otros ajustes). Lo marcado "publico" lo lee cualquiera
--                      (las tiendas: public/js/datos-pago.js); solo los administradores lo cambian.
--     administradores  quién entra a public/admin.html (con su cuenta de Google).
--                      Panel: pestañas Cuentas y Supabase (admin_cuentas, admin_espacio, admin_borrar_viejo).
--     perfiles         WhatsApp de cada cuenta (se pide al iniciar sesión: public/js/telefono-cuenta.js).
--   Fase 2 (todos los pedidos):
--     recargas         ahora guarda TODOS los pedidos (usuario vacío si el cliente no inició sesión).
--                      Cada cliente sigue viendo solo los suyos; los administradores, todos.
--
-- Para dar acceso a admin.html a alguien (tiene que haber iniciado sesión en la tienda una vez):
--   insert into public.administradores (usuario)
--   select id from auth.users where email = 'CORREO@gmail.com' on conflict do nothing;
-- =====================================================================

-- ---------------------------------------------------------------------
-- Administradores
-- ---------------------------------------------------------------------
create table if not exists public.administradores (
  usuario uuid primary key references auth.users (id) on delete cascade,
  creado  timestamptz not null default now()
);
alter table public.administradores enable row level security;
revoke all on public.administradores from anon, authenticated;

-- ¿El que llama es administrador? (security definer: puede mirar la tabla aunque el cliente no)
create or replace function public.es_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from administradores where usuario = (select auth.uid()));
$$;
revoke execute on function public.es_admin() from public, anon;
grant execute on function public.es_admin() to authenticated, service_role;

-- ---------------------------------------------------------------------
-- Perfiles: WhatsApp de cada cuenta (desde 2026-11-13). Se pide al iniciar sesión
-- (public/js/telefono-cuenta.js) para avisar al cliente si gana algo. Cada cliente lee y cambia
-- solo el suyo; los administradores leen todos (admin.html).
-- ---------------------------------------------------------------------
create table if not exists public.perfiles (
  usuario     uuid primary key references auth.users (id) on delete cascade,
  telefono    text not null check (telefono ~ '^\+584(12|14|16|22|24|26)[0-9]{7}$'),
  actualizado timestamptz not null default now()
);
alter table public.perfiles enable row level security;
revoke all on public.perfiles from anon;
grant select, insert, update on public.perfiles to authenticated;

drop policy if exists "cada cliente lee su perfil" on public.perfiles;
create policy "cada cliente lee su perfil" on public.perfiles
  for select to authenticated using (usuario = (select auth.uid()) or (select public.es_admin()));
drop policy if exists "cada cliente crea su perfil" on public.perfiles;
create policy "cada cliente crea su perfil" on public.perfiles
  for insert to authenticated with check (usuario = (select auth.uid()));
drop policy if exists "cada cliente cambia su perfil" on public.perfiles;
create policy "cada cliente cambia su perfil" on public.perfiles
  for update to authenticated using (usuario = (select auth.uid())) with check (usuario = (select auth.uid()));

-- ---------------------------------------------------------------------
-- Fase 1 · Límite de intentos (api/_lib/limitador.js)
-- ---------------------------------------------------------------------
create table if not exists public.limites (
  clave           text primary key,                -- SHA-256 de "tipo:valor" (IP, ID...): nunca en claro
  fallos          integer not null default 0,
  inicio_ventana  timestamptz not null default now(),
  bloqueado_hasta timestamptz,
  expira          timestamptz not null default now()
);
create index if not exists limites_expira on public.limites (expira);
alter table public.limites enable row level security;
revoke all on public.limites from anon, authenticated;

-- Minutos que faltan del bloqueo más largo entre las claves (0 = sin bloqueo)
create or replace function public.limite_minutos(p_claves text[])
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(ceil(extract(epoch from (max(bloqueado_hasta) - now())) / 60)::integer, 0)
    from limites where clave = any (p_claves) and bloqueado_hasta > now();
$$;

-- +1 fallo en cada clave, en un solo paso (dos peticiones a la vez no se pisan). p_maximos[i] es el
-- máximo de p_claves[i]: al llegar, la clave queda bloqueada p_bloqueo_s segundos y el conteo vuelve a 0.
create or replace function public.limite_fallo(p_claves text[], p_maximos integer[], p_ventana_s integer, p_bloqueo_s integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  i        integer;
  r        limites%rowtype;
  v_fallos integer;
  v_inicio timestamptz;
  v_hasta  timestamptz;
begin
  for i in 1 .. coalesce(array_length(p_claves, 1), 0) loop
    insert into limites (clave) values (p_claves[i]) on conflict (clave) do nothing;
    select * into r from limites where clave = p_claves[i] for update;
    if r.fallos > 0 and r.inicio_ventana > now() - make_interval(secs => p_ventana_s) then
      v_fallos := r.fallos + 1; v_inicio := r.inicio_ventana;
    else
      v_fallos := 1; v_inicio := now();
    end if;
    v_hasta := r.bloqueado_hasta;
    if v_fallos >= coalesce(p_maximos[i], 5) then
      v_hasta := now() + make_interval(secs => p_bloqueo_s); v_fallos := 0; v_inicio := now();
    end if;
    update limites set fallos = v_fallos, inicio_ventana = v_inicio, bloqueado_hasta = v_hasta,
           expira = now() + make_interval(secs => p_ventana_s + p_bloqueo_s)
     where clave = p_claves[i];
  end loop;
  -- Limpieza de vez en cuando (sin tareas programadas)
  if random() < 0.02 then delete from limites where expira < now(); end if;
end $$;

revoke execute on function public.limite_minutos(text[]) from public, anon, authenticated;
revoke execute on function public.limite_fallo(text[], integer[], integer, integer) from public, anon, authenticated;
grant execute on function public.limite_minutos(text[]) to service_role;
grant execute on function public.limite_fallo(text[], integer[], integer, integer) to service_role;

-- ---------------------------------------------------------------------
-- Fase 1 · Configuración (Pago Móvil)
-- ---------------------------------------------------------------------
create table if not exists public.configuracion (
  clave       text primary key,
  valor       jsonb not null,
  publico     boolean not null default false,       -- true: la tienda lo lee sin sesión
  actualizado timestamptz not null default now()
);
alter table public.configuracion enable row level security;
revoke all on public.configuracion from anon, authenticated;
grant select on public.configuracion to anon, authenticated;
grant insert, update on public.configuracion to authenticated;

-- Datos de Pago Móvil que tenía Firestore (configuracion/pago_movil) al mudarse. Solo si todavía no
-- existen: si ya los cambiaste en admin.html, volver a correr este archivo no los pisa.
insert into public.configuracion (clave, valor, publico)
values ('pago_movil', '{"banco": "Venezuela 0102", "telefono": "04148653510", "cedula": "13476015"}'::jsonb, true)
on conflict (clave) do nothing;

drop policy if exists "lo publico lo lee cualquiera" on public.configuracion;
create policy "lo publico lo lee cualquiera" on public.configuracion
  for select to anon, authenticated using (publico);
drop policy if exists "los administradores leen todo" on public.configuracion;
create policy "los administradores leen todo" on public.configuracion
  for select to authenticated using ((select public.es_admin()));
-- Si alguien pudiera escribir aquí, cambiaría el número al que pagan los clientes: solo administradores
drop policy if exists "los administradores editan" on public.configuracion;
create policy "los administradores editan" on public.configuracion
  for update to authenticated using ((select public.es_admin())) with check ((select public.es_admin()));
drop policy if exists "los administradores crean" on public.configuracion;
create policy "los administradores crean" on public.configuracion
  for insert to authenticated with check ((select public.es_admin()));

-- ---------------------------------------------------------------------
-- Fase 2 · Todos los pedidos en "recargas"
-- ---------------------------------------------------------------------
alter table public.recargas alter column usuario drop not null;
-- "Consulta tus últimas recargas" busca por ID (Roblox: el usuario ya se guarda en minúsculas)
create index if not exists recargas_id_jugador on public.recargas (id_jugador, creado desc) where id_jugador is not null;

drop policy if exists "los administradores leen todas" on public.recargas;
create policy "los administradores leen todas" on public.recargas
  for select to authenticated using ((select public.es_admin()));

-- Las fichas del minijuego siguen siendo solo para clientes con sesión: un pedido sin usuario no da fichas
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

-- Contador del inicio: recargas completadas desde p_desde (00:00 de hoy, hora de Venezuela)
create or replace function public.recargas_completadas_desde(p_desde timestamptz)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::integer from recargas where estado = 'completado' and creado >= p_desde;
$$;
revoke execute on function public.recargas_completadas_desde(timestamptz) from public, anon, authenticated;
grant execute on function public.recargas_completadas_desde(timestamptz) to service_role;

-- ---------------------------------------------------------------------
-- Panel admin.html: resumen de ventas y revisión del minijuego
-- (solo administradores; desde el SQL Editor también funcionan)
-- ---------------------------------------------------------------------
create or replace function public.admin_resumen(p_desde timestamptz)
returns table (juego text, estado text, pedidos integer, total numeric)
language sql
stable
security definer
set search_path = public
as $$
  select r.juego, r.estado, count(*)::integer, coalesce(sum(r.precio), 0)
    from recargas r
   where r.creado >= p_desde
     and ((select auth.role()) is null or (select auth.role()) = 'service_role' or (select public.es_admin()))
   group by r.juego, r.estado;
$$;
revoke execute on function public.admin_resumen(timestamptz) from public, anon;
grant execute on function public.admin_resumen(timestamptz) to authenticated, service_role;

-- juego_revision (supabase/minijuego.sql) ahora también la puede usar un administrador desde admin.html,
-- con el WhatsApp del jugador (tabla perfiles) para avisarle si gana. Cambian las columnas: se borra antes.
drop function if exists public.juego_revision(timestamptz, timestamptz, integer);
create or replace function public.juego_revision(p_desde timestamptz, p_hasta timestamptz default null, p_limite integer default 10)
returns table (puesto integer, correo text, puntos integer, revisar boolean, stats jsonb, segundos numeric,
               partidas_validas integer, partidas_invalidas integer, terminada timestamptz, id_partida uuid,
               telefono text, nombre text)
language sql
stable
security definer
set search_path = public
as $$
  with semana as (
    select * from juego_partidas p
     where p.terminada >= p_desde and (p_hasta is null or p.terminada < p_hasta)
       and ((select auth.role()) is null or (select auth.role()) = 'service_role' or (select public.es_admin()))
  ), mejores as (
    select distinct on (s.usuario) s.* from semana s where s.estado = 'valida'
     order by s.usuario, s.puntos desc, s.terminada asc
  ), ordenados as (
    select m.*, (row_number() over (order by m.puntos desc, m.terminada asc))::integer as puesto from mejores m
  )
  select o.puesto, u.email::text, o.puntos, o.revisar, o.stats, round(o.ticks / 60.0, 1),
         (select count(*) from semana x where x.usuario = o.usuario and x.estado = 'valida')::integer,
         (select count(*) from semana x where x.usuario = o.usuario and x.estado = 'invalida')::integer,
         o.terminada, o.id,
         (select p.telefono from perfiles p where p.usuario = o.usuario),
         coalesce(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name')
    from ordenados o join auth.users u on u.id = o.usuario
   where o.puesto <= least(greatest(coalesce(p_limite, 10), 1), 50)
   order by o.puesto;
$$;
revoke execute on function public.juego_revision(timestamptz, timestamptz, integer) from public, anon;
grant execute on function public.juego_revision(timestamptz, timestamptz, integer) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- Panel admin.html · Espacio: cuánto ocupa la base y borrar lo de semanas viejas
-- (solo administradores; el plan gratis de Supabase da 500 MB de base de datos)
-- Se puede borrar:
--   juego_partidas     partidas terminadas (nunca una "abierta")
--   juego_movimientos  solo el gasto de fichas por partida ("partida"). Los de "recarga" y "reembolso"
--                      NO: son los que impiden dar dos veces las fichas de un mismo pedido.
--   limites            bloqueos ya vencidos (sin importar la fecha)
-- No se borra nunca: recargas (historial de clientes, contador del inicio), fidelidad, ventas_paquetes,
-- juego_fichas (saldos), configuracion, administradores. La semana actual y la pasada (premio por pagar)
-- quedan protegidas aunque la página pida otra fecha.
-- ---------------------------------------------------------------------
create or replace function public.admin_limite_borrado()
returns timestamptz
language sql
stable
set search_path = public
as $$
  -- Lunes 00:00 (Venezuela) de la semana pasada
  select (date_trunc('week', now() at time zone 'America/Caracas') - interval '7 days') at time zone 'America/Caracas';
$$;

create or replace function public.admin_espacio(p_antes timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_antes timestamptz := least(p_antes, admin_limite_borrado());
begin
  if not ((select auth.role()) is null or (select auth.role()) = 'service_role' or (select es_admin())) then
    raise exception 'solo administradores' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'total', pg_database_size(current_database()),
    'limite', admin_limite_borrado(),
    'conexiones', (select count(*) from pg_stat_activity where datname = current_database()),
    'conexiones_max', current_setting('max_connections')::integer,
    'version', current_setting('server_version'),
    'tablas', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'tabla', c.relname,
               'bytes', pg_total_relation_size(c.oid),
               'filas', greatest(c.reltuples, 0)::bigint
             ) order by pg_total_relation_size(c.oid) desc), '[]'::jsonb)
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'
    ),
    'borrables', jsonb_build_object(
      'juego_partidas', (select count(*) from juego_partidas
                          where estado <> 'abierta' and coalesce(terminada, creada) < v_antes),
      'juego_movimientos', (select count(*) from juego_movimientos where motivo = 'partida' and creado < v_antes),
      'limites', (select count(*) from limites where expira < now())
    )
  );
end;
$$;
revoke execute on function public.admin_espacio(timestamptz) from public, anon;
grant execute on function public.admin_espacio(timestamptz) to authenticated, service_role;

-- Devuelve cuántas filas borró
create or replace function public.admin_borrar_viejo(p_tabla text, p_antes timestamptz)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_antes timestamptz := least(p_antes, admin_limite_borrado());
  v_filas integer := 0;
begin
  if not ((select auth.role()) is null or (select auth.role()) = 'service_role' or (select es_admin())) then
    raise exception 'solo administradores' using errcode = '42501';
  end if;
  if p_tabla = 'juego_partidas' then
    delete from juego_partidas where estado <> 'abierta' and coalesce(terminada, creada) < v_antes;
  elsif p_tabla = 'juego_movimientos' then
    delete from juego_movimientos where motivo = 'partida' and creado < v_antes;
  elsif p_tabla = 'limites' then
    delete from limites where expira < now();
  else
    raise exception 'esa tabla no se puede limpiar' using errcode = '22023';
  end if;
  get diagnostics v_filas = row_count;
  return v_filas;
end;
$$;
revoke execute on function public.admin_borrar_viejo(text, timestamptz) from public, anon;
grant execute on function public.admin_borrar_viejo(text, timestamptz) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- Panel admin.html · Cuentas: cuentas creadas, sus recargas y fichas del minijuego
-- (solo administradores). Las recargas cuentan solo las ENTREGADAS.
-- ---------------------------------------------------------------------
create or replace function public.admin_cuentas(p_limite integer default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_hoy timestamptz := date_trunc('day', now() at time zone 'America/Caracas') at time zone 'America/Caracas';
begin
  if not ((select auth.role()) is null or (select auth.role()) = 'service_role' or (select es_admin())) then
    raise exception 'solo administradores' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'total', (select count(*) from auth.users),
    'hoy', (select count(*) from auth.users where created_at >= v_hoy),
    'semana', (select count(*) from auth.users where created_at >= now() - interval '7 days'),
    'recargas', (select count(*) from recargas where estado = 'completado'),
    'recargas_con_cuenta', (select count(*) from recargas where estado = 'completado' and usuario is not null),
    'fichas', (select coalesce(sum(fichas), 0) from juego_fichas),
    'con_telefono', (select count(*) from perfiles),
    'cuentas', (
      select coalesce(jsonb_agg(c order by c.creado desc), '[]'::jsonb) from (
        select u.id,
               u.email::text as correo,
               (select p.telefono from perfiles p where p.usuario = u.id) as telefono,
               coalesce(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name') as nombre,
               u.created_at as creado,
               u.last_sign_in_at as ultimo,
               (select count(*) from recargas r where r.usuario = u.id and r.estado = 'completado') as recargas,
               (select coalesce(sum(r.precio), 0) from recargas r where r.usuario = u.id and r.estado = 'completado') as gastado,
               coalesce((select f.fichas from juego_fichas f where f.usuario = u.id), 0) as fichas
          from auth.users u
         order by u.created_at desc
         limit least(greatest(coalesce(p_limite, 50), 1), 500)
      ) c
    )
  );
end;
$$;
revoke execute on function public.admin_cuentas(integer) from public, anon;
grant execute on function public.admin_cuentas(integer) to authenticated, service_role;
