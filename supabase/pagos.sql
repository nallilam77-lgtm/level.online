-- =====================================================================
-- LEVEL UP · PAGOS (PAGO MÓVIL Y TRANSFERENCIAS) EN SUPABASE (desde 2026-11-14)
--
-- Cómo instalarlo: Supabase → SQL Editor → New query → pega TODO este archivo → Run. Se puede volver a correr.
--
-- Mudanza por etapas (MacroDroid anota cada pago que llega al teléfono):
--   1. EN PARALELO (esta): cada macro de MacroDroid manda el pago a la hoja "pagos" COMO SIEMPRE y además a
--      Vercel (POST /api/juego?accion=pago_recibido, con la clave MACRODROID_CLAVE_VERCEL), que lo guarda
--      aquí. Las tiendas siguen verificando en la hoja. Se compara unos días (admin.html → Pagos).
--   2. Las tiendas verifican y apartan el pago AQUÍ (una referencia no se puede usar dos veces: regla de la base).
--   3. MacroDroid deja de mandar a la hoja.
-- (La tabla vieja "pagos_recibidos" nunca se usó: se puede borrar a mano cuando quieras.)
-- =====================================================================

create table if not exists public.pagos (
  id          bigint generated always as identity primary key,
  referencia  text not null unique check (referencia ~ '^\d{4,30}$'),   -- una referencia = un solo pago, siempre
  monto       numeric(14, 2) not null check (monto >= 0),
  monto_texto text,                                                     -- tal cual lo mandó MacroDroid ("1.560,00")
  remitente   text,                                                     -- teléfono, "BDV" o nombre (según la notificación)
  origen      text not null default 'otro' check (origen in ('pago_movil', 'bdv', 'transferencia', 'otro')),
  recibido    timestamptz not null default now(),
  estado      text not null default 'verificado'
              check (estado in ('verificado', 'en_proceso', 'usado', 'por_completar', 'vencido')),
  id_pedido   text,                                                     -- el pedido que lo tomó (etapa 2)
  tomado      timestamptz
);
create index if not exists pagos_recibido on public.pagos (recibido desc);
-- Para buscar por los últimos 5 dígitos (como hacen los clientes) en la etapa 2
create index if not exists pagos_ultimos5 on public.pagos (right(referencia, 5), recibido desc);
alter table public.pagos enable row level security;
revoke all on public.pagos from anon, authenticated;

-- El administrador los ve en el panel (solo lectura)
drop policy if exists "los administradores leen los pagos" on public.pagos;
create policy "los administradores leen los pagos" on public.pagos
  for select to authenticated using ((select public.es_admin()));
grant select on public.pagos to authenticated;

-- =====================================================================
-- MOTOR DE PAGOS (desde 2026-11-14). Las mismas reglas que la hoja "pagos" de los Apps Script:
--   - Se busca por los ÚLTIMOS 5 DÍGITOS de la referencia (lo que escribe el cliente); entre varios, el más
--     reciente libre.
--   - Estados: verificado (libre) → en_proceso (lo apartó un pedido) → usado. Nunca vuelve atrás, salvo
--     liberar (un pedido que no llegó a usarlo: vuelve a verificado) y por_completar (no alcanzó).
--   - Un pago de más de 3 días sin usar no se toma solo (vencido: el cliente escribe por WhatsApp).
--   - "for update skip locked": si dos pedidos piden el mismo pago en el mismo instante, uno solo se lo lleva.
-- Interruptor: configuracion "pagos_motor" = 'hoja' (por defecto) o 'supabase' (admin.html → Pagos).
-- Limpieza (pagos_limpiar, una vez al día): se borran los usados de días anteriores; los libres de más de
-- 3 días pasan a vencido y los vencidos se borran a los 7 días (por si un cliente reclama tarde).
-- =====================================================================
alter table public.pagos add column if not exists juego text;
alter table public.pagos add column if not exists usado timestamptz;
alter table public.pagos add column if not exists nota text check (nota is null or length(nota) <= 200);
alter table public.pagos drop constraint if exists pagos_origen_check;
alter table public.pagos add constraint pagos_origen_check check (origen in ('pago_movil', 'bdv', 'transferencia', 'manual', 'otro'));
create index if not exists pagos_pedido on public.pagos (id_pedido) where id_pedido is not null;

-- ¿Con qué cobran las tiendas? 'hoja' o 'supabase'
create or replace function public.pagos_motor()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select valor #>> '{}' from configuracion where clave = 'pagos_motor'), 'hoja');
$$;
revoke execute on function public.pagos_motor() from public, anon, authenticated;
grant execute on function public.pagos_motor() to service_role;

create or replace function public.admin_pagos_motor(p_motor text)
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  perform admin_revisar();
  if p_motor not in ('hoja', 'supabase') then raise exception 'Motor no válido.' using errcode = '22023'; end if;
  insert into configuracion (clave, valor, publico, actualizado) values ('pagos_motor', to_jsonb(p_motor), false, now())
  on conflict (clave) do update set valor = excluded.valor, actualizado = now();
  return p_motor;
end;
$$;
revoke execute on function public.admin_pagos_motor(text) from public, anon;
grant execute on function public.admin_pagos_motor(text) to authenticated, service_role;

-- Aparta el pago para un pedido. Devuelve { encontrado, referencia, monto, repetido } o { encontrado: false, motivo }.
-- Repetir con el mismo pedido devuelve el mismo pago (un reintento de Vercel no aparta otro).
create or replace function public.pagos_tomar(p_ultimos5 text, p_id_pedido text, p_juego text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v pagos%rowtype;
begin
  if p_ultimos5 !~ '^\d{5}$' then return jsonb_build_object('encontrado', false, 'motivo', 'formato'); end if;
  if p_id_pedido is not null then
    select * into v from pagos where id_pedido = p_id_pedido and estado = 'en_proceso' and right(referencia, 5) = p_ultimos5 limit 1;
    if found then return jsonb_build_object('encontrado', true, 'referencia', v.referencia, 'monto', v.monto, 'repetido', true); end if;
  end if;
  select * into v from pagos
   where right(referencia, 5) = p_ultimos5 and estado = 'verificado' and recibido > now() - interval '3 days'
   order by recibido desc limit 1 for update skip locked;
  if found then
    update pagos set estado = 'en_proceso', id_pedido = left(p_id_pedido, 80), juego = left(p_juego, 30), tomado = now()
     where id = v.id;
    return jsonb_build_object('encontrado', true, 'referencia', v.referencia, 'monto', v.monto, 'repetido', false);
  end if;
  -- Por qué no (el mismo orden de mensajes que la hoja)
  if exists (select 1 from pagos where right(referencia, 5) = p_ultimos5 and estado = 'en_proceso') then
    return jsonb_build_object('encontrado', false, 'motivo', 'en_proceso'); end if;
  if exists (select 1 from pagos where right(referencia, 5) = p_ultimos5 and (estado = 'vencido' or (estado = 'verificado' and recibido <= now() - interval '3 days'))) then
    return jsonb_build_object('encontrado', false, 'motivo', 'vencido'); end if;
  if exists (select 1 from pagos where right(referencia, 5) = p_ultimos5 and estado = 'por_completar') then
    return jsonb_build_object('encontrado', false, 'motivo', 'por_completar'); end if;
  if exists (select 1 from pagos where right(referencia, 5) = p_ultimos5 and estado = 'usado') then
    return jsonb_build_object('encontrado', false, 'motivo', 'usado'); end if;
  return jsonb_build_object('encontrado', false, 'motivo', 'no_existe');
end;
$$;
revoke execute on function public.pagos_tomar(text, text, text) from public, anon, authenticated;
grant execute on function public.pagos_tomar(text, text, text) to service_role;

-- Cambia el estado de un pago (por la referencia completa). p_solo_si: solo si está en ese estado.
-- 'usado' anota la hora; 'verificado' (liberar) borra el pedido que lo tenía.
create or replace function public.pagos_cambiar(p_referencia text, p_nuevo text, p_solo_si text default null, p_id_pedido text default null)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ref text := regexp_replace(coalesce(p_referencia, ''), '\D', '', 'g');
begin
  if p_nuevo not in ('verificado', 'en_proceso', 'usado', 'por_completar', 'vencido') then return false; end if;
  -- Un pago usado ya no cambia nunca
  update pagos set estado = p_nuevo,
         usado = case when p_nuevo = 'usado' then coalesce(usado, now()) else usado end,
         id_pedido = case when p_nuevo = 'verificado' then null else coalesce(left(p_id_pedido, 80), id_pedido) end,
         tomado = case when p_nuevo = 'verificado' then null else tomado end
   where referencia = v_ref and (p_solo_si is null or estado = p_solo_si) and estado <> 'usado';
  if found then return true; end if;
  -- Marcar usado algo que ya estaba usado: listo (repetirlo no cambia nada)
  return p_nuevo = 'usado' and exists (select 1 from pagos where referencia = v_ref and estado = 'usado');
end;
$$;
revoke execute on function public.pagos_cambiar(text, text, text, text) from public, anon, authenticated;
grant execute on function public.pagos_cambiar(text, text, text, text) to service_role;

-- El pago que apartó ESTE pedido pasa a usado (un error a mitad de la recarga: nunca vuelve a estar libre).
-- Devuelve la referencia ("" si el pedido no llegó a apartar ninguno).
create or replace function public.pagos_usar_del_pedido(p_id_pedido text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare v_ref text;
begin
  update pagos set estado = 'usado', usado = coalesce(usado, now())
   where id_pedido = p_id_pedido and estado = 'en_proceso'
  returning referencia into v_ref;
  if v_ref is null then select referencia into v_ref from pagos where id_pedido = p_id_pedido limit 1; end if;
  return coalesce(v_ref, '');
end;
$$;
revoke execute on function public.pagos_usar_del_pedido(text) from public, anon, authenticated;
grant execute on function public.pagos_usar_del_pedido(text) to service_role;

-- Limpieza diaria (la llama Vercel la primera vez que llega un pago cada día; también el panel)
create or replace function public.pagos_limpiar()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hoy timestamptz := date_trunc('day', now() at time zone 'America/Caracas') at time zone 'America/Caracas';
  v_borrados int;
  v_vencidos int;
  v_viejos int;
begin
  delete from pagos where estado = 'usado' and coalesce(usado, tomado, recibido) < v_hoy;
  get diagnostics v_borrados = row_count;
  update pagos set estado = 'vencido' where estado = 'verificado' and recibido < now() - interval '3 days';
  get diagnostics v_vencidos = row_count;
  delete from pagos where estado = 'vencido' and recibido < now() - interval '7 days';
  get diagnostics v_viejos = row_count;
  return jsonb_build_object('usados_borrados', v_borrados, 'vencidos', v_vencidos, 'vencidos_borrados', v_viejos);
end;
$$;
revoke execute on function public.pagos_limpiar() from public, anon, authenticated;
grant execute on function public.pagos_limpiar() to service_role;
