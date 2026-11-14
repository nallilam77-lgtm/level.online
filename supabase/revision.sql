-- =====================================================================
-- LEVEL UP · PEDIDOS EN REVISIÓN EN SUPABASE (desde 2026-11-14)
--
-- Cómo instalarlo: Supabase → SQL Editor → New query → pega TODO este archivo → Run (después de
-- supabase/tienda.sql). Se puede volver a correr.
--
-- Antes, cada problema de una recarga quedaba solo en la pestaña "errores" de la hoja de cada juego.
-- Ahora, además (las hojas siguen anotándolo igual):
--   incidencias   cada vez que Vercel anota un problema en "errores" (api/_lib/incidencias.js), una fila aquí
--                 con la fase, el motivo, el estado del pago, el jugador, el paquete, la referencia y el WhatsApp.
-- admin.html → pestaña "Revisión": los pedidos en revisión o con problema y sus incidencias, con botones para
-- resolverlos (ya la entregué / devolví el pago / nota). Resolver cambia el estado del pedido: el cliente lo
-- ve en su perfil al instante, y "entregado" da las fichas del minijuego y la comisión del creador.
-- =====================================================================

create table if not exists public.incidencias (
  id          bigint generated always as identity primary key,
  id_pedido   text,
  juego       text,
  fase        text,
  motivo      text,
  estado_pago text,
  id_jugador  text,
  paquete     text,
  referencia  text,
  telefono    text,
  comprobante text,
  creado      timestamptz not null default now(),
  resuelto    timestamptz,
  resolucion  text check (resolucion is null or resolucion in ('entregado', 'reembolsado', 'descartado')),
  nota        text check (nota is null or length(nota) <= 500)
);
create index if not exists incidencias_abiertas on public.incidencias (creado desc) where resuelto is null;
create index if not exists incidencias_pedido on public.incidencias (id_pedido);
alter table public.incidencias enable row level security;
revoke all on public.incidencias from anon, authenticated;

-- Nota del administrador sobre un pedido (la ve solo él)
alter table public.recargas add column if not exists nota_admin text check (nota_admin is null or length(nota_admin) <= 500);
alter table public.recargas add column if not exists revisado timestamptz;

-- ---------------------------------------------------------------------
-- Panel: lo que hay que revisar
--   abiertos: pedidos en revisión / con problema / en proceso hace más de 1 hora, y las incidencias sin
--             resolver de pedidos que no llegaron a guardarse (el problema pasó antes de encontrar el pago).
--   resueltos: los últimos 20 resueltos (para deshacer un error de dedo).
-- ---------------------------------------------------------------------
create or replace function public.admin_revision()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform admin_revisar();
  return jsonb_build_object(
    'abiertos', (
      select coalesce(jsonb_agg(x order by x.creado desc), '[]'::jsonb) from (
        select r.id_pedido, r.juego, r.paquete, r.cuenta, r.precio, r.referencia, r.estado, r.creado, r.actualizado,
               r.motivo_fallo, r.motivo_accion, r.nota_admin,
               coalesce((select p.telefono from perfiles p where p.usuario = r.usuario),
                        (select i.telefono from incidencias i where i.id_pedido = r.id_pedido and coalesce(i.telefono, '') <> '' limit 1)) as telefono,
               (select coalesce(jsonb_agg(jsonb_build_object('fase', i.fase, 'motivo', i.motivo, 'estado_pago', i.estado_pago,
                         'comprobante', i.comprobante, 'creado', i.creado) order by i.creado), '[]'::jsonb)
                  from incidencias i where i.id_pedido = r.id_pedido) as incidencias
          from recargas r
         where (r.estado in ('en_revision', 'problema')
                or (r.estado = 'en_proceso' and r.creado < now() - interval '1 hour')
                or exists (select 1 from incidencias i where i.id_pedido = r.id_pedido and i.resuelto is null))
           and r.creado > now() - interval '30 days'
         order by r.creado desc limit 100
      ) x
    ),
    'sueltas', (
      select coalesce(jsonb_agg(to_jsonb(i) order by i.creado desc), '[]'::jsonb) from (
        select i.id, i.id_pedido, i.juego, i.fase, i.motivo, i.estado_pago, i.id_jugador, i.paquete, i.referencia,
               i.telefono, i.comprobante, i.creado
          from incidencias i
         where i.resuelto is null and i.creado > now() - interval '30 days'
           and not exists (select 1 from recargas r where r.id_pedido = i.id_pedido)
         order by i.creado desc limit 100
      ) i
    ),
    'resueltos', (
      select coalesce(jsonb_agg(x order by x.revisado desc), '[]'::jsonb) from (
        select r.id_pedido, r.juego, r.paquete, r.cuenta, r.precio, r.estado, r.revisado, r.nota_admin
          from recargas r where r.revisado is not null order by r.revisado desc limit 20
      ) x
    )
  );
end;
$$;
revoke execute on function public.admin_revision() from public, anon;
grant execute on function public.admin_revision() to authenticated, service_role;

-- Resolver un pedido: 'entregado' (completado), 'reembolsado', o solo guardar la nota ('nota').
-- p_incidencia: para una incidencia suelta (sin pedido guardado): 'descartado' la cierra.
create or replace function public.admin_revision_resolver(p_id_pedido text, p_accion text, p_nota text default null, p_incidencia bigint default null)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_nota text := nullif(trim(coalesce(p_nota, '')), '');
begin
  perform admin_revisar();
  if p_accion not in ('entregado', 'reembolsado', 'nota', 'descartado') then
    raise exception 'Acción no válida.' using errcode = '22023';
  end if;
  if v_nota is not null and length(v_nota) > 500 then
    raise exception 'La nota es muy larga (máximo 500).' using errcode = '22023';
  end if;
  -- Incidencia sin pedido guardado
  if p_incidencia is not null then
    update incidencias set resuelto = now(), resolucion = case when p_accion = 'nota' then 'descartado' else p_accion end,
           nota = coalesce(v_nota, nota)
     where id = p_incidencia and resuelto is null;
    return 'ok';
  end if;
  if p_accion = 'nota' then
    update recargas set nota_admin = v_nota where id_pedido = p_id_pedido;
    if not found then raise exception 'No existe ese pedido.' using errcode = 'P0002'; end if;
    return 'ok';
  end if;
  -- Cambiar el estado dispara lo mismo que una entrega normal: fichas, comisión del creador, perfil en vivo
  update recargas set estado = case when p_accion = 'entregado' then 'completado'
                                    when p_accion = 'reembolsado' then 'reembolsado' else estado end,
         revisado = now(), actualizado = now(), nota_admin = coalesce(v_nota, nota_admin)
   where id_pedido = p_id_pedido;
  if not found then raise exception 'No existe ese pedido.' using errcode = 'P0002'; end if;
  update incidencias set resuelto = now(), resolucion = case when p_accion = 'descartado' then 'descartado' else p_accion end
   where id_pedido = p_id_pedido and resuelto is null;
  return 'ok';
end;
$$;
revoke execute on function public.admin_revision_resolver(text, text, text, bigint) from public, anon;
grant execute on function public.admin_revision_resolver(text, text, text, bigint) to authenticated, service_role;
