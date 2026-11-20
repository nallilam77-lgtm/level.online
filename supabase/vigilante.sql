-- =====================================================================
-- LEVEL UP · VIGILANTE DE PAGOS Y RECARGAS (desde 2026-11-20)
--
-- Cómo instalarlo: Supabase → SQL Editor → New query → pega TODO este archivo → Run. Se puede volver a correr.
--
-- Cada minuto (el tic de api/_lib/arena.js, llamado por el cron del Worker del juego) Vercel llama a
-- vigilante_revisar(): busca lo raro y lo anota UNA vez en "alertas" (clave única). Lo nuevo se le avisa al
-- administrador por notificación (api/_lib/push.js) y queda en admin.html → Resumen → Vigilante hasta que
-- lo marque visto. Qué busca:
--   pago_libre        pago del banco verificado hace más de 30 min que nadie usó (casi siempre: el cliente
--                     escribió mal la referencia). Si hay una solicitud de "Revisar pagos" con el mismo monto
--                     cerca de esa hora, la nombra.
--   usado_a_mano      pago marcado usado a mano (sin pedido) con alguien esperando o rechazado con esos 5 números.
--   pago_sin_recarga  pago tomado por un pedido hace más de 10 min sin recarga anotada.
--   cobro_trabado     pago "en proceso" hace más de 15 min (una compra que se cortó a mitad).
--   doble             dos recargas entregadas al mismo ID con los mismos 5 números en 2 días (posible pago usado dos veces).
--   revision          recarga en revisión (al cliente se le mostró "en revisión"/error): confirmar en Central One.
--   en_proceso        recarga "en proceso" hace más de 30 min (Central One no confirmó).
--   esperando         solicitud de "Revisar pagos" esperando hace más de 15 min.
-- =====================================================================

create table if not exists public.alertas (
  id       bigint generated always as identity primary key,
  clave    text not null unique,                 -- lo mismo no se avisa dos veces
  tipo     text not null,
  titulo   text not null,
  detalle  text,
  creada   timestamptz not null default now(),
  vista    timestamptz
);
create index if not exists alertas_sin_ver on public.alertas (creada desc) where vista is null;
alter table public.alertas enable row level security;
revoke all on public.alertas from anon, authenticated;

create or replace function public.vigilante_revisar()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_nuevas jsonb := '[]'::jsonb;
  r record;
  hora text;
  sug text;
begin
  -- 0. Lo que ya se resolvió solo deja de mostrarse (vista = ahora)
  update alertas a set vista = now() where a.vista is null and (
       (a.tipo = 'pago_libre' and not exists (select 1 from pagos p where 'pago_libre:' || p.referencia = a.clave and p.estado = 'verificado'))
    or (a.tipo = 'cobro_trabado' and not exists (select 1 from pagos p where 'cobro_trabado:' || p.referencia = a.clave and p.estado = 'en_proceso'))
    or (a.tipo = 'esperando' and not exists (select 1 from pagos_solicitudes s where 'esperando:' || s.id = a.clave and s.estado = 'pendiente'))
    or (a.tipo = 'revision' and not exists (select 1 from recargas x where 'revision:' || x.id_pedido = a.clave and x.estado = 'en_revision'))
    or (a.tipo = 'en_proceso' and not exists (select 1 from recargas x where 'en_proceso:' || x.id_pedido = a.clave and x.estado = 'en_proceso')));

  -- 1. Pagos libres de más de 30 min (y la solicitud parecida, si hay)
  for r in select p.* from pagos p
            where p.estado = 'verificado' and p.recibido < now() - interval '30 minutes' and p.recibido > now() - interval '3 days' loop
    select string_agg(format('…%s (%s, ID %s, %s Bs, %s)', s.ultimos5, s.paquete, s.id_jugador, s.monto, s.estado), '; ')
      into sug from pagos_solicitudes s
     where s.estado in ('pendiente', 'rechazado') and abs(coalesce(s.monto, 0) - r.monto) <= 1
       and s.creado between r.recibido - interval '20 minutes' and r.recibido + interval '60 minutes';
    insert into alertas (clave, tipo, titulo, detalle)
    values ('pago_libre:' || r.referencia, 'pago_libre',
            format('Pago sin usar: %s Bs (…%s)', r.monto, right(r.referencia, 5)),
            format('Llegó %s y nadie lo ha usado (ref. %s%s). Suele ser un cliente que escribió mal la referencia.%s',
                   to_char(r.recibido at time zone 'America/Caracas', 'DD/MM HH12:MI am'), r.referencia,
                   coalesce(', ' || r.remitente, ''), coalesce(' Posible dueño en Revisar pagos: ' || sug, '')))
    on conflict (clave) do nothing;
  end loop;

  -- 2. Pago marcado usado a mano con alguien esperando (o rechazado) con esos 5 números
  for r in select p.*, s.paquete, s.id_jugador, s.estado as s_estado from pagos p
             join pagos_solicitudes s on s.ultimos5 = right(p.referencia, 5) and s.estado in ('pendiente', 'rechazado')
              and s.creado > now() - interval '2 days'
            where p.estado = 'usado' and p.id_pedido is null and p.usado > now() - interval '2 days' loop
    insert into alertas (clave, tipo, titulo, detalle)
    values ('usado_a_mano:' || r.referencia, 'usado_a_mano',
            format('Pago marcado usado a mano: …%s (%s Bs)', right(r.referencia, 5), r.monto),
            format('Lo marcaste usado, pero hay una solicitud %s con esos números (%s, ID %s). Si es su pago, no lo marques usado: suéltala con la referencia %s.',
                   r.s_estado, r.paquete, r.id_jugador, r.referencia))
    on conflict (clave) do nothing;
  end loop;

  -- 3. Pago tomado por un pedido sin recarga anotada
  for r in select p.* from pagos p
            where p.estado = 'usado' and p.id_pedido is not null and p.usado < now() - interval '10 minutes' and p.usado > now() - interval '2 days'
              and not exists (select 1 from recargas x where x.id_pedido = p.id_pedido or x.id_pedido like p.id_pedido || '%')
              and not exists (select 1 from arena_inscripciones a where a.id::text = p.id_pedido) loop
    insert into alertas (clave, tipo, titulo, detalle)
    values ('pago_sin_recarga:' || r.referencia, 'pago_sin_recarga',
            format('Pago usado sin recarga anotada: …%s (%s Bs)', right(r.referencia, 5), r.monto),
            format('El pago %s se usó %s para el pedido %s (%s), pero no hay recarga anotada. Revisa en Central One si salió.',
                   r.referencia, to_char(r.usado at time zone 'America/Caracas', 'DD/MM HH12:MI am'), r.id_pedido, coalesce(r.juego, '?')))
    on conflict (clave) do nothing;
  end loop;

  -- 4. Cobro trabado (en proceso hace más de 15 min)
  for r in select p.* from pagos p where p.estado = 'en_proceso' and p.tomado < now() - interval '15 minutes' loop
    insert into alertas (clave, tipo, titulo, detalle)
    values ('cobro_trabado:' || r.referencia, 'cobro_trabado',
            format('Compra cortada a mitad: …%s (%s Bs)', right(r.referencia, 5), r.monto),
            format('El pago %s quedó "en proceso" desde %s (pedido %s). La compra se cortó: revisa si la recarga salió.',
                   r.referencia, to_char(r.tomado at time zone 'America/Caracas', 'DD/MM HH12:MI am'), coalesce(r.id_pedido, '?')))
    on conflict (clave) do nothing;
  end loop;

  -- 5. Posible doble: mismo ID y mismos 5 números, dos recargas entregadas en 2 días
  for r in select a.id_pedido as id_a, b.id_pedido as id_b, a.cuenta, a.referencia, a.paquete as paq_a, b.paquete as paq_b,
                  a.creado as hora_a, b.creado as hora_b
             from recargas a join recargas b on b.cuenta = a.cuenta and b.referencia = a.referencia and b.id_pedido > a.id_pedido
              and b.estado in ('completado', 'en_proceso') and abs(extract(epoch from b.creado - a.creado)) < 2 * 86400
            where a.estado in ('completado', 'en_proceso') and a.referencia is not null
              and greatest(a.actualizado, b.actualizado) > now() - interval '1 day'
              and coalesce(a.nota_admin, '') not like 'Pasada de incompleto%' and coalesce(b.nota_admin, '') not like 'Pasada de incompleto%' loop
    insert into alertas (clave, tipo, titulo, detalle)
    values ('doble:' || r.id_a || ':' || r.id_b, 'doble',
            format('¿Recarga doble? %s · …%s', r.cuenta, r.referencia),
            format('Dos recargas entregadas al %s con la referencia …%s: %s (%s) y %s (%s). Si fue un solo pago, se entregó dos veces.',
                   r.cuenta, r.referencia, r.paq_a, to_char(r.hora_a at time zone 'America/Caracas', 'DD/MM HH12:MI am'),
                   r.paq_b, to_char(r.hora_b at time zone 'America/Caracas', 'DD/MM HH12:MI am')))
    on conflict (clave) do nothing;
  end loop;

  -- 6. Recarga en revisión (al cliente se le mostró "en revisión" o error)
  for r in select x.* from recargas x where x.estado = 'en_revision' and x.actualizado > now() - interval '1 day' loop
    insert into alertas (clave, tipo, titulo, detalle)
    values ('revision:' || r.id_pedido, 'revision',
            format('Recarga en revisión: %s · %s', r.paquete, r.cuenta),
            format('Al cliente se le mostró "en revisión" (%s, ref. …%s, %s Bs). Revisa en Revisión si salió en Central One. %s',
                   to_char(r.creado at time zone 'America/Caracas', 'DD/MM HH12:MI am'), coalesce(r.referencia, '—'), coalesce(r.precio::text, '—'),
                   coalesce(left(r.nota_admin, 200), '')))
    on conflict (clave) do nothing;
  end loop;

  -- 7. En proceso hace más de 30 min (Central One no confirmó)
  for r in select x.* from recargas x where x.estado = 'en_proceso' and x.actualizado < now() - interval '30 minutes'
                                         and x.actualizado > now() - interval '2 days'
                                         and not exists (select 1 from pedidos_espera e where e.id_pedido = x.id_pedido and e.estado in ('esperando', 'entregando')) loop
    insert into alertas (clave, tipo, titulo, detalle)
    values ('en_proceso:' || r.id_pedido, 'en_proceso',
            format('Recarga sin confirmar: %s · %s', r.paquete, r.cuenta),
            format('Lleva más de 30 min "en proceso" (desde %s, ref. …%s). Central One no confirmó: revísala.',
                   to_char(r.actualizado at time zone 'America/Caracas', 'DD/MM HH12:MI am'), coalesce(r.referencia, '—')))
    on conflict (clave) do nothing;
  end loop;

  -- 8. Clientes esperando en "Revisar pagos" hace más de 15 min
  for r in select s.* from pagos_solicitudes s where s.estado = 'pendiente' and s.creado < now() - interval '15 minutes' loop
    insert into alertas (clave, tipo, titulo, detalle)
    values ('esperando:' || r.id, 'esperando',
            format('Cliente esperando: …%s · %s', r.ultimos5, coalesce(r.paquete, r.juego)),
            format('Desde %s espera en "Revisar pagos" (ID %s, %s Bs).', to_char(r.creado at time zone 'America/Caracas', 'DD/MM HH12:MI am'),
                   coalesce(r.id_jugador, '—'), coalesce(r.monto::text, '—')))
    on conflict (clave) do nothing;
  end loop;

  -- Lo nuevo de este minuto (para avisar) y limpieza de lo viejo ya visto
  select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'tipo', a.tipo, 'titulo', a.titulo, 'detalle', a.detalle) order by a.id), '[]'::jsonb)
    into v_nuevas from alertas a where a.creada > now() - interval '50 seconds';
  delete from alertas where vista is not null and vista < now() - interval '30 days';
  return jsonb_build_object('nuevas', v_nuevas,
    'admins', (select coalesce(jsonb_agg(usuario), '[]'::jsonb) from administradores));
end;
$$;
revoke execute on function public.vigilante_revisar() from public, anon, authenticated;
grant execute on function public.vigilante_revisar() to service_role;

-- Panel
create or replace function public.admin_alertas(p_vistas boolean default false)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not (select es_admin()) then raise exception 'solo administradores' using errcode = '42501'; end if;
  return (select coalesce(jsonb_agg(to_jsonb(a) order by a.creada desc), '[]'::jsonb) from (
    select * from alertas where (p_vistas or vista is null) order by creada desc limit 100) a);
end;
$$;
create or replace function public.admin_alerta_vista(p_id bigint)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not (select es_admin()) then raise exception 'solo administradores' using errcode = '42501'; end if;
  if p_id is null then update alertas set vista = now() where vista is null;
  else update alertas set vista = now() where id = p_id and vista is null; end if;
  return found;
end;
$$;
revoke execute on function public.admin_alertas(boolean), public.admin_alerta_vista(bigint) from public, anon;
grant execute on function public.admin_alertas(boolean), public.admin_alerta_vista(bigint) to authenticated;
