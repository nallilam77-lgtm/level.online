-- =====================================================================
-- LEVEL UP · RULETA EN SUPABASE (desde 2026-11-15)
--
-- Cómo instalarlo: Supabase → SQL Editor → New query → pega TODO este archivo → Run.
-- Se puede volver a correr. Después de correrlo, la ruleta de las 4 tiendas automáticas
-- (api/ruleta.js) ya no usa el Apps Script de la ruleta ni la pestaña "pagos" de la hoja.
--
-- Regla: cada recarga COMPLETADA (o en camino) de los últimos 3 días gira UNA vez. El cliente escribe
-- su ID y los 5 últimos dígitos de la referencia (lo mismo que puso al recargar). El premio lo sortea
-- Vercel; aquí solo se anota, en un solo paso (dos giros a la vez de la misma recarga no se pisan) y,
-- si el mismo jugador repite el giro (se cortó la conexión), recibe el MISMO premio.
-- Los ganadores salen en admin.html → Revisión → "Ruleta: premios por entregar".
-- =====================================================================

create table if not exists public.ruleta_giros (
  id_pedido   text primary key,                 -- la recarga que giró (tabla recargas)
  juego       text not null,
  id_jugador  text not null,
  referencia  text not null,                    -- los 5 dígitos que escribió el cliente
  premio      text not null,
  gano        boolean not null default false,
  entregado   timestamptz,                      -- el administrador ya entregó el premio
  creado      timestamptz not null default now()
);
create index if not exists ruleta_giros_ganadores on public.ruleta_giros (creado desc) where gano;
create index if not exists ruleta_giros_jugador on public.ruleta_giros (juego, lower(id_jugador), referencia);

alter table public.ruleta_giros enable row level security;
revoke all on public.ruleta_giros from anon, authenticated;
grant select, update on public.ruleta_giros to authenticated;
drop policy if exists "los administradores leen los giros" on public.ruleta_giros;
create policy "los administradores leen los giros" on public.ruleta_giros
  for select to authenticated using ((select public.es_admin()));
drop policy if exists "los administradores marcan entregado" on public.ruleta_giros;
create policy "los administradores marcan entregado" on public.ruleta_giros
  for update to authenticated using ((select public.es_admin())) with check ((select public.es_admin()));

-- Para buscar rápido la recarga por jugador y referencia
create index if not exists recargas_ruleta on public.recargas (juego, lower(id_jugador), right(referencia, 5), creado desc);

-- Gira (o devuelve el giro ya hecho). Respuestas:
--   { ok: true, premio, repetido: false }     giro nuevo anotado
--   { ok: true, premio, repetido: true }      ese jugador ya había girado esa recarga: el mismo premio
--   { ok: false, motivo: 'sin_completar' }    la recarga existe pero no se completó (revisión, incompleta…)
--   { ok: false, motivo: 'en_cierre' }        el pago se acaba de usar y la recarga se está guardando: repetir en segundos
--   { ok: false, motivo: 'no_existe' }        no hay recarga de ese jugador con esa referencia en 3 días
create or replace function public.ruleta_girar(p_juego text, p_id_jugador text, p_ultimos5 text, p_premio text, p_gano boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id     text := left(trim(coalesce(p_id_jugador, '')), 40);
  v_pedido text;
  v_premio text;
begin
  if coalesce(p_ultimos5, '') !~ '^\d{5}$' or v_id = '' or coalesce(p_premio, '') = '' then
    return jsonb_build_object('ok', false, 'motivo', 'no_existe');
  end if;

  -- 1. Una recarga completada (o en camino) de ese jugador con esa referencia que todavía no giró
  select r.id_pedido into v_pedido
    from recargas r
   where r.juego = p_juego and lower(r.id_jugador) = lower(v_id) and right(r.referencia, 5) = p_ultimos5
     and r.estado in ('completado', 'en_proceso') and r.creado > now() - interval '3 days'
     and not exists (select 1 from ruleta_giros g where g.id_pedido = r.id_pedido)
   order by r.creado desc
   limit 1;
  if v_pedido is not null then
    insert into ruleta_giros (id_pedido, juego, id_jugador, referencia, premio, gano)
    values (v_pedido, p_juego, v_id, p_ultimos5, left(p_premio, 60), coalesce(p_gano, false))
    on conflict (id_pedido) do nothing;
    if found then
      return jsonb_build_object('ok', true, 'premio', left(p_premio, 60), 'repetido', false);
    end if;
    -- Otro giro igual entró al mismo tiempo: se devuelve el suyo
  end if;

  -- 2. Ese jugador ya giró esa recarga: el mismo premio (no se gira dos veces)
  select g.premio into v_premio
    from ruleta_giros g
   where g.juego = p_juego and lower(g.id_jugador) = lower(v_id) and g.referencia = p_ultimos5
     and g.creado > now() - interval '3 days'
   order by g.creado desc
   limit 1;
  if v_premio is not null then
    return jsonb_build_object('ok', true, 'premio', v_premio, 'repetido', true);
  end if;

  -- 3. La recarga existe pero no se completó
  if exists (select 1 from recargas r
              where r.juego = p_juego and lower(r.id_jugador) = lower(v_id) and right(r.referencia, 5) = p_ultimos5
                and r.creado > now() - interval '3 days') then
    return jsonb_build_object('ok', false, 'motivo', 'sin_completar');
  end if;

  -- 4. El pago se acaba de usar y la fila de la recarga todavía no se guardó (se guarda después de responder)
  if exists (select 1 from pagos p
              where right(p.referencia, 5) = p_ultimos5 and p.estado in ('usado', 'en_proceso')
                and coalesce(p.usado, p.tomado) > now() - interval '3 minutes') then
    return jsonb_build_object('ok', false, 'motivo', 'en_cierre');
  end if;

  return jsonb_build_object('ok', false, 'motivo', 'no_existe');
end;
$$;
revoke execute on function public.ruleta_girar(text, text, text, text, boolean) from public, anon, authenticated;
grant execute on function public.ruleta_girar(text, text, text, text, boolean) to service_role;
