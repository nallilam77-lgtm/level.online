-- =====================================================================
-- LEVEL UP · ÚLTIMO EN PIE: ENLACES PRIVADOS PARA JUGAR (desde 2026-11-18)
--
-- Cómo instalarlo: Supabase → SQL Editor → New query → pega TODO este archivo → Run. Se puede volver a correr.
-- Necesita supabase/codigos.sql (admin_revisar).
--
-- El juego (juego-servidor/, Cloudflare) es privado: solo entra quien abre un enlace
-- https://www.levelupstore.online/juego/?c=<código>. Los enlaces se crean en admin.html → Minijuego:
--   · "Jugar ahora": tu enlace (no vence; el panel lo crea la primera vez).
--   · "Crear enlace": para otra persona, con una nota y si vence o no. Se anula cuando quieras.
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

-- ¿Sirve este código? Lo llama el servidor del juego al conectarse alguien. Cuenta la entrada.
create or replace function public.juego_entrar(p_codigo text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_codigo is null or p_codigo !~ '^[a-f0-9]{32}$' then return false; end if;
  update juego_enlaces set entradas = entradas + 1, ultimo_uso = now()
   where codigo = p_codigo and activo and (vence is null or vence > now());
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

-- Panel: enlace para otra persona. p_dias null o 0 = no vence.
create or replace function public.admin_juego_crear_enlace(p_nota text, p_dias integer)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_codigo text := replace(gen_random_uuid()::text, '-', '');
begin
  perform admin_revisar();
  if p_dias is not null and (p_dias < 0 or p_dias > 365) then
    raise exception 'días inválidos' using errcode = '22023';
  end if;
  insert into juego_enlaces (codigo, nota, vence)
  values (v_codigo, left(btrim(coalesce(p_nota, '')), 60), case when coalesce(p_dias, 0) > 0 then now() + make_interval(days => p_dias) end);
  return v_codigo;
end;
$$;
revoke execute on function public.admin_juego_crear_enlace(text, integer) from public, anon;
grant execute on function public.admin_juego_crear_enlace(text, integer) to authenticated, service_role;

-- Panel: lista de enlaces dados (los 50 más nuevos, sin el tuyo)
create or replace function public.admin_juego_enlaces()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform admin_revisar();
  return (
    select coalesce(jsonb_agg(x order by x.creado desc), '[]'::jsonb) from (
      select codigo, nota, creado, vence, activo, entradas, ultimo_uso
        from juego_enlaces where not dueno order by creado desc limit 50
    ) x
  );
end;
$$;
revoke execute on function public.admin_juego_enlaces() from public, anon;
grant execute on function public.admin_juego_enlaces() to authenticated, service_role;

-- Panel: anular un enlace (deja de servir de inmediato para entrar)
create or replace function public.admin_juego_anular_enlace(p_codigo text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform admin_revisar();
  update juego_enlaces set activo = false where codigo = p_codigo and not dueno;
end;
$$;
revoke execute on function public.admin_juego_anular_enlace(text) from public, anon;
grant execute on function public.admin_juego_anular_enlace(text) to authenticated, service_role;
