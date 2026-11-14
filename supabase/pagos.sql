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
-- Devuelve la referencia (varias: "ref1 + ref2"; "" si el pedido no llegó a apartar ninguno).
create or replace function public.pagos_usar_del_pedido(p_id_pedido text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare v_ref text;
begin
  -- Un pedido que completó un pago insuficiente tiene varios pagos: todos quedan usados
  with u as (
    update pagos set estado = 'usado', usado = coalesce(usado, now())
     where id_pedido = p_id_pedido and estado in ('en_proceso', 'por_completar')
    returning referencia
  ) select string_agg(referencia, ' + ') into v_ref from u;
  if v_ref is null then select string_agg(referencia, ' + ') into v_ref from pagos where id_pedido = p_id_pedido; end if;
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

-- =====================================================================
-- PAGOS QUE NO ALCANZAN (por completar) EN SUPABASE (desde 2026-11-14). Las mismas reglas que la pestaña
-- "por_completar" de las hojas: el pago queda "por_completar", el cliente recibe una clave (aquí solo su
-- huella SHA-256), tiene 48 horas y hasta 4 pagos para completar la diferencia (con 0,50 Bs de margen).
-- datos: lo que el pedido necesita para entregarse al completar (jugador, zona, paquete, código de descuento,
-- comprobante, WhatsApp), tal cual lo mandó la tienda.
-- =====================================================================
create table if not exists public.pagos_por_completar (
  id_pedido      text primary key,
  juego          text,
  clave_hash     text not null unique check (clave_hash ~ '^[a-f0-9]{64}$'),
  precio         numeric(14, 2) not null,
  pagado         numeric(14, 2) not null,
  referencias    text[] not null,
  datos          jsonb not null default '{}'::jsonb,
  estado         text not null default 'pendiente' check (estado in ('pendiente', 'completo', 'vencido')),
  id_pedido_completo text,
  respuesta      jsonb,                     -- la respuesta de "completo" (un reintento recibe la misma)
  vence          timestamptz not null default now() + interval '48 hours',
  creado         timestamptz not null default now(),
  actualizado    timestamptz not null default now()
);
alter table public.pagos_por_completar enable row level security;
revoke all on public.pagos_por_completar from anon, authenticated;

-- El pago que apartó este pedido no alcanzó: queda "por_completar" y se guarda el pedido.
-- p: { idPedido, referencia, claveHash, precio, pagado, juego, datos: {...} }
create or replace function public.pagos_guardar_por_completar(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ref text := regexp_replace(coalesce(p->>'referencia', ''), '\D', '', 'g');
  v_id text := p->>'idPedido';
begin
  if v_id is null or coalesce(p->>'claveHash', '') !~ '^[a-f0-9]{64}$' or v_ref = '' then
    return jsonb_build_object('status', 'error', 'message', 'Datos inválidos para guardar el pago por completar');
  end if;
  if exists (select 1 from pagos_por_completar where id_pedido = v_id) then
    return jsonb_build_object('status', 'success', 'repetido', true, 'horas', 48);
  end if;
  update pagos set estado = 'por_completar' where referencia = v_ref and id_pedido = v_id and estado = 'en_proceso';
  if not found then return jsonb_build_object('status', 'error', 'message', 'El pago ya no está en proceso'); end if;
  insert into pagos_por_completar (id_pedido, juego, clave_hash, precio, pagado, referencias, datos)
  values (v_id, p->>'juego', p->>'claveHash', round((p->>'precio')::numeric, 2), round((p->>'pagado')::numeric, 2),
          array[v_ref], coalesce(p->'datos', '{}'::jsonb));
  return jsonb_build_object('status', 'success', 'horas', 48);
end;
$$;
revoke execute on function public.pagos_guardar_por_completar(jsonb) from public, anon, authenticated;
grant execute on function public.pagos_guardar_por_completar(jsonb) to service_role;

-- Completar con un pago nuevo (últimos 5 dígitos). Misma respuesta que usar_complemento de las hojas.
create or replace function public.pagos_completar(p_clave_hash text, p_ultimos5 text, p_id_pedido text, p_juego text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  f pagos_por_completar%rowtype;
  t jsonb;
  v_pagado numeric;
  v_falta numeric;
  v_resp jsonb;
begin
  select * into f from pagos_por_completar where clave_hash = p_clave_hash for update;
  if not found then
    return jsonb_build_object('status', 'success', 'valido', false, 'message', 'No encontramos este pago por completar. Escríbenos por WhatsApp con tus referencias.');
  end if;
  -- Reintento del mismo pedido que lo completó: la misma respuesta
  if f.estado = 'completo' and f.id_pedido_completo = p_id_pedido and f.respuesta is not null then return f.respuesta; end if;
  if f.estado <> 'pendiente' then
    return jsonb_build_object('status', 'success', 'valido', false, 'message', 'Este pago ya se completó o está en revisión. Si no recibiste tu recarga, escríbenos por WhatsApp.');
  end if;
  if f.vence < now() then
    update pagos_por_completar set estado = 'vencido', actualizado = now() where id_pedido = f.id_pedido;
    return jsonb_build_object('status', 'success', 'valido', false, 'message', 'Pasaron más de 48 horas: escríbenos por WhatsApp con tus referencias para completar tu recarga.');
  end if;
  if array_length(f.referencias, 1) >= 4 then
    return jsonb_build_object('status', 'success', 'valido', false, 'message', 'Ya usaste el máximo de 4 pagos para este pedido: escríbenos por WhatsApp.');
  end if;

  t := pagos_tomar(p_ultimos5, p_id_pedido, p_juego);
  if not (t->>'encontrado')::boolean then
    return jsonb_build_object('status', 'success', 'valido', true, 'encontrado', false, 'motivo', t->>'motivo');
  end if;
  v_pagado := round(f.pagado + (t->>'monto')::numeric, 2);
  v_falta := round(greatest(0, f.precio - v_pagado), 2);

  if v_pagado < f.precio - 0.50 then
    update pagos set estado = 'por_completar' where referencia = t->>'referencia' and estado = 'en_proceso';
    update pagos_por_completar set pagado = v_pagado, referencias = referencias || (t->>'referencia'), actualizado = now()
     where id_pedido = f.id_pedido;
    return jsonb_build_object('status', 'success', 'valido', true, 'encontrado', true, 'completo', false,
      'precio', f.precio, 'pagadoTotal', v_pagado, 'falta', v_falta);
  end if;

  -- Completo: el último pago queda "en_proceso" para este pedido; la tienda marca TODOS usados al cerrar
  v_resp := (f.datos - 'precio') || jsonb_build_object('status', 'success', 'valido', true, 'encontrado', true, 'completo', true,
    'idPedidoOriginal', f.id_pedido, 'precio', f.precio, 'pagadoTotal', v_pagado,
    'referencias', to_jsonb(f.referencias || (t->>'referencia')), 'version', 3);
  update pagos_por_completar set pagado = v_pagado, referencias = referencias || (t->>'referencia'), estado = 'completo',
         id_pedido_completo = p_id_pedido, respuesta = v_resp, actualizado = now()
   where id_pedido = f.id_pedido;
  -- Los pagos anteriores (por_completar) pasan a este pedido para que bloquear_pedido / marcar usado los encuentren
  update pagos set id_pedido = p_id_pedido where referencia = any(f.referencias);
  return v_resp;
end;
$$;
revoke execute on function public.pagos_completar(text, text, text, text) from public, anon, authenticated;
grant execute on function public.pagos_completar(text, text, text, text) to service_role;

-- pagos_usar_del_pedido: también los pagos "por_completar" de un pedido que se completó y falló al entregarse
create or replace function public.pagos_usar_del_pedido(p_id_pedido text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare v_ref text;
begin
  -- Un pedido que completó un pago insuficiente tiene varios pagos: todos quedan usados
  with u as (
    update pagos set estado = 'usado', usado = coalesce(usado, now())
     where id_pedido = p_id_pedido and estado in ('en_proceso', 'por_completar')
    returning referencia
  ) select string_agg(referencia, ' + ') into v_ref from u;
  if v_ref is null then select string_agg(referencia, ' + ') into v_ref from pagos where id_pedido = p_id_pedido; end if;
  return coalesce(v_ref, '');
end;
$$;
revoke execute on function public.pagos_usar_del_pedido(text) from public, anon, authenticated;
grant execute on function public.pagos_usar_del_pedido(text) to service_role;

-- Limpieza diaria: además, los pedidos por completar viejos (completos o vencidos de hace más de 7 días)
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
  update pagos_por_completar set estado = 'vencido', actualizado = now() where estado = 'pendiente' and vence < now();
  delete from pagos_por_completar where estado <> 'pendiente' and actualizado < now() - interval '7 days';
  return jsonb_build_object('usados_borrados', v_borrados, 'vencidos', v_vencidos, 'vencidos_borrados', v_viejos);
end;
$$;
revoke execute on function public.pagos_limpiar() from public, anon, authenticated;
grant execute on function public.pagos_limpiar() to service_role;

-- =====================================================================
-- REVISIÓN (2026-11-14): huellas de los pagos usados que se borran y mensaje de dos pedidos a la vez
-- =====================================================================
-- Cuando la limpieza diaria borra un pago usado, su referencia queda aquí (60 días): si MacroDroid vuelve a
-- mandar esa notificación, no renace como pago libre (api/_lib/pagos.js la toma como duplicada).
create table if not exists public.pagos_usados (
  referencia text primary key,
  usado      timestamptz not null default now()
);
alter table public.pagos_usados enable row level security;
revoke all on public.pagos_usados from anon, authenticated;

create or replace function public.pagos_guardar_usado()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.estado = 'usado' then
    insert into pagos_usados (referencia, usado) values (old.referencia, coalesce(old.usado, now()))
    on conflict (referencia) do nothing;
  end if;
  return old;
end;
$$;
drop trigger if exists pagos_guardar_usado on public.pagos;
create trigger pagos_guardar_usado before delete on public.pagos
  for each row execute function public.pagos_guardar_usado();

-- La referencia tampoco puede entrar otra vez por "Agregar pago a mano" ni por otra vía
create or replace function public.pagos_no_repetir_usado()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from pagos_usados where referencia = new.referencia) then
    raise exception 'Esa referencia ya se usó antes.' using errcode = '23505';
  end if;
  return new;
end;
$$;
drop trigger if exists pagos_no_repetir_usado on public.pagos;
create trigger pagos_no_repetir_usado before insert on public.pagos
  for each row execute function public.pagos_no_repetir_usado();

-- pagos_tomar: si el pago existe y está libre pero otro pedido lo está apartando en este mismo instante
-- (fila bloqueada), el mensaje es "otro cliente lo está procesando" y no "no encontrada"
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
  if exists (select 1 from pagos where right(referencia, 5) = p_ultimos5
              and (estado = 'en_proceso' or (estado = 'verificado' and recibido > now() - interval '3 days'))) then
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

-- Las huellas de más de 60 días se borran con la limpieza diaria
create or replace function public.pagos_limpiar_huellas()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  delete from pagos_usados where usado < now() - interval '60 days';
  return null;
end;
$$;
drop trigger if exists pagos_limpiar_huellas on public.pagos;
create trigger pagos_limpiar_huellas after delete on public.pagos
  for each statement execute function public.pagos_limpiar_huellas();

-- =====================================================================
-- ALARMA (2026-11-14): alguien prueba referencias al azar
-- =====================================================================
-- Cada búsqueda de un pago que NO existe (los 5 dígitos no son de ningún pago) se anota aquí una hora.
-- Si en 10 minutos hay 20 o más referencias DISTINTAS que no existen, se prende la alarma en el panel
-- (configuracion "alarma_referencias"): alguien puede estar adivinando los últimos 5 dígitos para usar el
-- pago de otro cliente. Un cliente que escribe mal su referencia varias veces cuenta una sola vez.
-- El panel la apaga con "Ya lo revisé" (valor {}); si siguen probando, se vuelve a prender.
create table if not exists public.pagos_intentos (
  id       bigint generated always as identity primary key,
  creado   timestamptz not null default now(),
  ultimos5 text not null
);
create index if not exists pagos_intentos_creado on public.pagos_intentos (creado);
alter table public.pagos_intentos enable row level security;
revoke all on public.pagos_intentos from anon, authenticated;

create or replace function public.pagos_anotar_intento(p_ultimos5 text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_distintos int;
begin
  insert into pagos_intentos (ultimos5) values (left(p_ultimos5, 5));
  delete from pagos_intentos where creado < now() - interval '1 hour';
  select count(distinct ultimos5) into v_distintos from pagos_intentos where creado > now() - interval '10 minutes';
  if v_distintos < 20 then return; end if;
  insert into configuracion (clave, valor, publico, actualizado)
  values ('alarma_referencias', jsonb_build_object('desde', now(), 'hasta', now(), 'pico', v_distintos, 'total', v_distintos), false, now())
  on conflict (clave) do update set
    valor = case when configuracion.valor ? 'desde'
      then configuracion.valor || jsonb_build_object('hasta', now(),
             'pico', greatest(coalesce((configuracion.valor->>'pico')::int, 0), v_distintos),
             'total', coalesce((configuracion.valor->>'total')::int, 0) + 1)
      else excluded.valor end,
    actualizado = now();
end;
$$;
revoke execute on function public.pagos_anotar_intento(text) from public, anon, authenticated;

-- pagos_tomar: igual que antes, pero anota la referencia que no existe
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
  if exists (select 1 from pagos where right(referencia, 5) = p_ultimos5
              and (estado = 'en_proceso' or (estado = 'verificado' and recibido > now() - interval '3 days'))) then
    return jsonb_build_object('encontrado', false, 'motivo', 'en_proceso'); end if;
  if exists (select 1 from pagos where right(referencia, 5) = p_ultimos5 and (estado = 'vencido' or (estado = 'verificado' and recibido <= now() - interval '3 days'))) then
    return jsonb_build_object('encontrado', false, 'motivo', 'vencido'); end if;
  if exists (select 1 from pagos where right(referencia, 5) = p_ultimos5 and estado = 'por_completar') then
    return jsonb_build_object('encontrado', false, 'motivo', 'por_completar'); end if;
  if exists (select 1 from pagos where right(referencia, 5) = p_ultimos5 and estado = 'usado') then
    return jsonb_build_object('encontrado', false, 'motivo', 'usado'); end if;
  perform pagos_anotar_intento(p_ultimos5);
  return jsonb_build_object('encontrado', false, 'motivo', 'no_existe');
end;
$$;
revoke execute on function public.pagos_tomar(text, text, text) from public, anon, authenticated;
grant execute on function public.pagos_tomar(text, text, text) to service_role;

-- De paso: los clientes con sesión no necesitan estos permisos sobre "recargas" (nunca se usaban)
revoke truncate, trigger, references on public.recargas from anon, authenticated;
