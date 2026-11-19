-- =====================================================================
-- LEVEL UP · JUEGO PRIVADO (Duelo de Acero desde 2026-11-19; antes Último en Pie): ENLACES DE ACCESO (desde 2026-11-18)
-- Solo el código del administrador ("Crear partida" en el panel) CREA salas; cada sala tiene su propio enlace
-- ?s=<sala> para invitar (no pasa por aquí).
--
-- Cómo instalarlo: Supabase → SQL Editor → New query → pega TODO este archivo → Run. Se puede volver a correr.
-- Necesita supabase/codigos.sql (admin_revisar).
--
-- El juego (juego-servidor/, Cloudflare) es privado. admin.html → Minijuego → "Crear partida" abre
-- https://www.levelupstore.online/juego/?c=<tu código> (no vence; el panel lo crea la primera vez).
-- El servidor del juego pregunta con juego_entrar() si el código sirve (con la clave pública de Supabase).
-- =====================================================================

create table if not exists public.juego_enlaces (
  codigo     text primary key check (codigo ~ '^[a-f0-9]{32}$'),
  nota       text not null default '' check (length(nota) <= 60),
  dueno      boolean not null default false,          -- el enlace del administrador
  creado     timestamptz not null default now(),
  vence      timestamptz,                              -- null = no vence
  activo     boolean not null default true,
  entradas   integer not null default 0,
  ultimo_uso timestamptz
);
alter table public.juego_enlaces enable row level security;
revoke all on public.juego_enlaces from anon, authenticated;

-- ¿Este código puede crear una sala? Solo el del administrador. Lo llama el servidor del juego. Cuenta la entrada.
create or replace function public.juego_entrar(p_codigo text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_codigo is null or p_codigo !~ '^[a-f0-9]{32}$' then return false; end if;
  update juego_enlaces set entradas = entradas + 1, ultimo_uso = now()
   where codigo = p_codigo and dueno and activo and (vence is null or vence > now());
  return found;
end;
$$;
revoke execute on function public.juego_entrar(text) from public;
grant execute on function public.juego_entrar(text) to anon, authenticated, service_role;

-- Panel: mi enlace (lo crea la primera vez)
create or replace function public.admin_juego_mi_enlace()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_codigo text;
begin
  perform admin_revisar();
  select codigo into v_codigo from juego_enlaces where dueno and activo order by creado limit 1;
  if v_codigo is null then
    v_codigo := replace(gen_random_uuid()::text, '-', '');
    insert into juego_enlaces (codigo, nota, dueno) values (v_codigo, 'Administrador', true);
  end if;
  return v_codigo;
end;
$$;
revoke execute on function public.admin_juego_mi_enlace() from public, anon;
grant execute on function public.admin_juego_mi_enlace() to authenticated, service_role;

-- Desde 2026-11-19 solo el administrador crea partidas (desde el panel). Ya no hay enlaces para otras personas:
-- se invita con el enlace de cada sala. Se quitan las funciones viejas del panel.
drop function if exists public.admin_juego_crear_enlace(text, integer);
drop function if exists public.admin_juego_enlaces();
drop function if exists public.admin_juego_anular_enlace(text);
update juego_enlaces set activo = false where not dueno and activo;
