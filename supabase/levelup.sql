-- =====================================================================
-- LEVEL UP · PERFIL DEL CLIENTE, HISTORIAL Y PREMIO DE CLIENTE FIEL (Supabase, plan gratis)
--
-- Cómo instalarlo: Supabase → tu proyecto → SQL Editor → New query → pega TODO este archivo → Run.
-- Se puede volver a correr: crea lo que falta y reemplaza las funciones.
--
-- Qué guarda (solo lo necesario):
--   recargas        los pedidos: juego, cuenta (ID o WhatsApp, nunca correo ni contraseña del juego),
--                   paquete, precio, últimos dígitos de la referencia, fecha y hora y estado (se
--                   actualiza en vivo). Desde supabase/tienda.sql guarda TODOS los pedidos (usuario
--                   vacío si no hay sesión). Al borrar el usuario se borran sus recargas.
--   fidelidad       conteo del premio de cliente fiel por juego + cuenta (la cuenta va como huella
--                   SHA-256, nunca en claro). Cuenta para todos, tengan sesión o no.
--   fidelidad_usos  cada venta con el premio (juego, cuenta, pedido, %, precio normal y cobrado).
--   ventas_paquetes ventas por paquete de cada juego ("⭐ Más vendido").
--
-- Quién escribe: SOLO Vercel (api/_lib/supabase.js) con la llave secreta. El navegador del cliente solo
-- puede LEER sus propias recargas (RLS) y recibirlas en vivo (Realtime). Las demás tablas no se pueden
-- leer ni escribir desde el navegador.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Recargas del perfil
-- ---------------------------------------------------------------------
create table if not exists public.recargas (
  id_pedido   text primary key,
  usuario     uuid not null references auth.users (id) on delete cascade,
  juego       text not null check (juego in ('freefire', 'bloodstrike', 'mobilelegends', 'roblox', 'fcmobile', 'codmobile', 'clashroyale')),
  cuenta      text not null,                       -- lo que ve el cliente: "ID 123456789", "WhatsApp +58 414-…"
  id_jugador  text,                                -- para "Repetir" y el premio de cliente fiel (automáticas)
  zona        text,                                -- Mobile Legends
  paquete     text not null,
  precio      numeric(12, 2),                      -- lo que se cobró (Bs)
  referencia  text,                                -- últimos dígitos de la referencia
  estado      text not null check (estado in ('pendiente', 'en_proceso', 'completado', 'incompleto', 'en_revision', 'problema', 'reembolsado')),
  codigo      text,                                -- código de Roblox (solo lo ve su dueño)
  clave_hash  text,                                -- huella de la clave para completar un pago insuficiente
  creado      timestamptz not null default now(),
  actualizado timestamptz not null default now()
);
create index if not exists recargas_usuario_creado on public.recargas (usuario, creado desc);
create index if not exists recargas_clave_hash on public.recargas (clave_hash) where clave_hash is not null;

alter table public.recargas enable row level security;
drop policy if exists "cada cliente lee sus recargas" on public.recargas;
create policy "cada cliente lee sus recargas" on public.recargas
  for select to authenticated using (usuario = (select auth.uid()));
-- Sin políticas de insert/update/delete: solo el servidor (llave secreta) escribe
revoke insert, update, delete on public.recargas from anon, authenticated;
revoke all on public.recargas from anon;

-- Estado en vivo en el perfil (Realtime respeta la política de arriba)
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'recargas') then
    alter publication supabase_realtime add table public.recargas;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Premio de cliente fiel
-- ---------------------------------------------------------------------
create table if not exists public.fidelidad (
  juego       text not null,
  cuenta      text not null,                       -- SHA-256 de "juego:cuenta"
  recargas    integer not null default 0,
  premio      numeric(4, 2) not null default 0,    -- % guardado para la próxima recarga (0 = ninguno)
  actualizado timestamptz not null default now(),
  primary key (juego, cuenta)
);

create table if not exists public.fidelidad_usos (
  id             bigint generated always as identity primary key,
  juego          text not null,
  cuenta         text not null,                    -- ID tal cual (para revisar a mano)
  id_pedido      text,
  porcentaje     numeric(4, 2) not null,
  precio_lista   numeric(12, 2),
  precio_cobrado numeric(12, 2),
  fecha          timestamptz not null default now()
);

create table if not exists public.ventas_paquetes (
  juego       text not null,
  clave       text not null,                       -- nombre del paquete normalizado
  ventas      integer not null default 0,
  actualizado timestamptz not null default now(),
  primary key (juego, clave)
);

alter table public.fidelidad enable row level security;
alter table public.fidelidad_usos enable row level security;
alter table public.ventas_paquetes enable row level security;
revoke all on public.fidelidad, public.fidelidad_usos, public.ventas_paquetes from anon, authenticated;

-- +1 recarga de la cuenta, en un solo paso (dos compras a la vez no se pisan).
-- p_premio_usado: esta recarga usó el premio (se gasta). Cuando la PRÓXIMA es la número p_cada
-- (6.ª, 12.ª…) queda guardado p_premio %. La regla (6 y 1,5 %) vive en api/_lib/fidelidad.js.
create or replace function public.fidelidad_anotar(p_juego text, p_cuenta text, p_premio_usado boolean, p_cada integer, p_premio numeric)
returns table (recargas integer, premio numeric)
language plpgsql
set search_path = public
as $$
declare
  v_recargas integer;
  v_premio numeric;
begin
  insert into fidelidad (juego, cuenta) values (p_juego, p_cuenta) on conflict do nothing;
  select f.recargas, f.premio into v_recargas, v_premio
    from fidelidad f where f.juego = p_juego and f.cuenta = p_cuenta for update;
  v_recargas := v_recargas + 1;
  if p_premio_usado then v_premio := 0; end if;
  if v_premio = 0 and v_recargas % p_cada = p_cada - 1 then v_premio := p_premio; end if;
  update fidelidad f set recargas = v_recargas, premio = v_premio, actualizado = now()
    where f.juego = p_juego and f.cuenta = p_cuenta;
  return query select v_recargas, v_premio;
end $$;

-- +1 venta del paquete
create or replace function public.ventas_sumar(p_juego text, p_clave text)
returns void
language sql
set search_path = public
as $$
  insert into ventas_paquetes (juego, clave, ventas) values (p_juego, p_clave, 1)
  on conflict (juego, clave) do update set ventas = ventas_paquetes.ventas + 1, actualizado = now();
$$;

-- Las funciones solo las llama el servidor
revoke execute on function public.fidelidad_anotar(text, text, boolean, integer, numeric) from public, anon, authenticated;
revoke execute on function public.ventas_sumar(text, text) from public, anon, authenticated;
grant execute on function public.fidelidad_anotar(text, text, boolean, integer, numeric) to service_role;
grant execute on function public.ventas_sumar(text, text) to service_role;

-- ---------------------------------------------------------------------
-- Mejores clientes del día y de la semana (desde 2026-11-13)
-- Sale de "recargas" (solo clientes con sesión) y cuenta las recargas COMPLETADAS desde p_desde.
-- Devuelve lo mínimo para mostrar en público: nombre corto ("Jesús D."), foto de Google, cantidad y
-- total en Bs. Nunca el correo, el ID del juego ni el UUID. Solo la llama el servidor (api/ranking.js),
-- que guarda la respuesta 5 min en la CDN.
-- ---------------------------------------------------------------------
create index if not exists recargas_completadas_creado on public.recargas (creado) where estado = 'completado';

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
