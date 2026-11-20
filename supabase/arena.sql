-- =====================================================================
-- LEVEL UP · ARENA (Duelo de Acero para clientes; desde 2026-11-19). Ver juego-servidor/ARENA.md
--
-- Cómo instalarlo: Supabase → SQL Editor → New query → pega TODO este archivo → Run. Se puede volver a correr.
-- Los secretos (Vault) se crean aparte, una sola vez (ver el final del archivo).
--
-- Torneo pagado: el cliente paga el paquete de inscripción (configuracion "arena") y queda en una partida
-- con quienes eligieron el mismo modo, juego y paquete. Cuando se llena, se le pone hora. Mejor de 3.
-- Ganador: el doble del paquete. Sin rival en 24 h o si no entra nadie: cada uno recibe su paquete.
-- Vercel (api/_lib/arena.js) es el único que escribe (service_role); el cliente solo lee lo suyo.
-- =====================================================================

create table if not exists public.arena_partidas (
  id        text primary key,                               -- 10 letras/números: también es la sala del juego
  modo      text not null check (modo in ('1v1', '2v2')),
  juego     text not null check (juego in ('freefire', 'bloodstrike', 'mobilelegends')),
  paquete   text not null,                                  -- paquete de inscripción (el premio es el doble)
  precio    numeric not null,                               -- lo que pagó cada uno (Bs)
  estado    text not null default 'esperando'
            check (estado in ('esperando', 'lista', 'jugando', 'terminada', 'cancelada', 'revisar')),
  hora      timestamptz,                                    -- se pone al llenarse
  creada    timestamptz not null default now(),
  vence     timestamptz not null,                           -- creada + 24 h: sin rival, se devuelve el paquete
  empezo    timestamptz,
  termino   timestamptz,
  ganador   smallint check (ganador in (0, 1, 2)),          -- 0 Rojo · 1 Azul · 2 nadie (todos reciben su paquete)
  marcador  text,                                           -- "2-1"
  motivo    text,                                           -- por qué terminó así (ausencia, sin rival…)
  avisos    jsonb not null default '{}'::jsonb              -- notificaciones ya enviadas: { lista, diez, ya }
);
create index if not exists arena_partidas_estado on public.arena_partidas (estado, creada);

create table if not exists public.arena_inscripciones (
  id          uuid primary key default gen_random_uuid(),   -- también el idPedido del pago
  partida     text not null references public.arena_partidas (id) on delete cascade,
  usuario     uuid not null,
  nombre      text not null,                                -- nombre en el juego (cuenta de Google o lo que escribió)
  puesto      smallint not null check (puesto between 0 and 3),
  id_jugador  text not null,
  zona        text,
  nick        text,                                         -- nombre del jugador según el validador del juego
  referencia  text,
  monto       numeric,
  creada      timestamptz not null default now(),
  resultado   text check (resultado in ('gano', 'perdio', 'reembolso')),
  entrega     text check (entrega in ('pendiente', 'entregando', 'entregado', 'revisar')),
  entrega_nota text,
  entrega_act timestamptz,
  partes_ok   smallint not null default 0,                  -- paquetes ya entregados (el premio son 2)
  intento     smallint not null default 0,                  -- reintentos desde el panel (cambia la Idempotency-Key)
  unique (partida, puesto),
  unique (partida, usuario)
);
create index if not exists arena_inscripciones_usuario on public.arena_inscripciones (usuario, creada desc);
create index if not exists arena_inscripciones_entrega on public.arena_inscripciones (entrega) where entrega in ('pendiente', 'entregando');

create table if not exists public.arena_ranking (
  semana    date not null,                                  -- lunes (hora de Venezuela)
  usuario   uuid not null,
  nombre    text not null,
  puntos    integer not null default 0,
  ganadas   integer not null default 0,
  perdidas  integer not null default 0,
  primary key (semana, usuario)
);
create index if not exists arena_ranking_puntos on public.arena_ranking (semana, puntos desc);

-- Duelos con puntos por pareja y día: más de 3 entre los mismos dos ya no suman (nadie sube jugando con un amigo)
create table if not exists public.arena_duelos (
  dia     date not null,
  a       uuid not null,
  b       uuid not null,
  cuenta  integer not null default 0,
  primary key (dia, a, b)
);

create table if not exists public.arena_push (
  endpoint  text primary key,
  usuario   uuid not null,
  p256dh    text not null,
  auth      text not null,
  creado    timestamptz not null default now()
);
create index if not exists arena_push_usuario on public.arena_push (usuario);

alter table public.arena_partidas enable row level security;
alter table public.arena_inscripciones enable row level security;
alter table public.arena_ranking enable row level security;
alter table public.arena_duelos enable row level security;
alter table public.arena_push enable row level security;
revoke all on public.arena_partidas, public.arena_inscripciones, public.arena_ranking, public.arena_duelos, public.arena_push from anon, authenticated;
grant select on public.arena_partidas, public.arena_inscripciones to authenticated;
drop policy if exists "admin ve las partidas de la arena" on public.arena_partidas;
create policy "admin ve las partidas de la arena" on public.arena_partidas for select to authenticated using ((select public.es_admin()));
drop policy if exists "admin ve las inscripciones de la arena" on public.arena_inscripciones;
create policy "admin ve las inscripciones de la arena" on public.arena_inscripciones for select to authenticated using ((select public.es_admin()));

-- Configuración pública (la lee arena.html): torneo encendido y paquete de inscripción por juego
insert into public.configuracion (clave, valor, publico, actualizado)
values ('arena', '{"activo": false, "paquetes": {"freefire": "110 Diamantes", "bloodstrike": "105 Oro", "mobilelegends": "86 Diamantes"}}'::jsonb, true, now())
on conflict (clave) do nothing;

-- ---------------------------------------------------------------------
-- Ayudas
-- ---------------------------------------------------------------------
create or replace function public.arena_nuevo_id()
returns text
language plpgsql
volatile
set search_path = public
as $$
declare
  v_letras constant text := 'abcdefghjkmnpqrstuvwxyz23456789';
  v text;
begin
  loop
    v := '';
    for i in 1..10 loop
      v := v || substr(v_letras, 1 + (get_byte(extensions.gen_random_bytes(1), 0) % length(v_letras)), 1);
    end loop;
    exit when not exists (select 1 from arena_partidas where id = v);
  end loop;
  return v;
end;
$$;

-- Siguiente media hora (en punto o y media) desde p_desde, entre 9:00 y 22:00 de Venezuela
create or replace function public.arena_hora(p_desde timestamptz)
returns timestamptz
language plpgsql
stable
as $$
declare
  v timestamp := p_desde at time zone 'America/Caracas';
begin
  v := timestamp 'epoch' + ceil(extract(epoch from v) / 1800) * interval '30 minutes';
  if v::time < time '09:00' then v := date_trunc('day', v) + interval '9 hours';
  elsif v::time > time '22:00' then v := date_trunc('day', v) + interval '1 day 9 hours';
  end if;
  return v at time zone 'America/Caracas';
end;
$$;

create or replace function public.arena_semana()
returns date
language sql
stable
as $$ select date_trunc('week', now() at time zone 'America/Caracas')::date $$;

-- ---------------------------------------------------------------------
-- Inscribir (Vercel, después de tomar el pago). Busca una partida esperando del mismo modo, juego y
-- paquete donde no esté ya; si no hay, crea una. Al llenarse le pone hora.
-- ---------------------------------------------------------------------
create or replace function public.arena_inscribir(
  p_id uuid, p_usuario uuid, p_nombre text, p_modo text, p_juego text, p_paquete text, p_precio numeric,
  p_id_jugador text, p_zona text, p_nick text, p_referencia text, p_monto numeric)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_orden smallint[] := case p_modo when '1v1' then array[0, 2]::smallint[] else array[0, 2, 1, 3]::smallint[] end;
  v_p arena_partidas%rowtype;
  v_puesto smallint;
  v_llenos integer;
begin
  if p_modo not in ('1v1', '2v2') then raise exception 'modo no válido' using errcode = '22023'; end if;
  -- Misma inscripción repetida (reintento): devuelve lo que ya hay
  select a.* into v_p from arena_inscripciones i join arena_partidas a on a.id = i.partida where i.id = p_id;
  if found then
    return jsonb_build_object('partida', v_p.id, 'estado', v_p.estado, 'hora', v_p.hora, 'repetida', true);
  end if;
  perform pg_advisory_xact_lock(hashtext('arena_inscribir'));
  select a.* into v_p from arena_partidas a
   where a.estado = 'esperando' and a.modo = p_modo and a.juego = p_juego and a.paquete = p_paquete and a.vence > now()
     and not exists (select 1 from arena_inscripciones i where i.partida = a.id and i.usuario = p_usuario)
   order by a.creada limit 1 for update;
  if not found then
    insert into arena_partidas (id, modo, juego, paquete, precio, vence)
    values (arena_nuevo_id(), p_modo, p_juego, p_paquete, p_precio, now() + interval '24 hours')
    returning * into v_p;
  end if;
  select x into v_puesto from unnest(v_orden) with ordinality u(x, o)
   where not exists (select 1 from arena_inscripciones i where i.partida = v_p.id and i.puesto = u.x)
   order by o limit 1;
  insert into arena_inscripciones (id, partida, usuario, nombre, puesto, id_jugador, zona, nick, referencia, monto)
  values (p_id, v_p.id, p_usuario, left(coalesce(nullif(trim(p_nombre), ''), 'Jugador'), 14), v_puesto,
          p_id_jugador, nullif(p_zona, ''), left(p_nick, 40), p_referencia, p_monto);
  select count(*) into v_llenos from arena_inscripciones where partida = v_p.id;
  if v_llenos >= array_length(v_orden, 1) then
    update arena_partidas set estado = 'lista', hora = arena_hora(now() + interval '30 minutes')
     where id = v_p.id returning * into v_p;
  end if;
  return jsonb_build_object('partida', v_p.id, 'estado', v_p.estado, 'hora', v_p.hora, 'puesto', v_puesto,
                            'faltan', array_length(v_orden, 1) - v_llenos);
end;
$$;

-- Lo que la sala del juego necesita saber (Worker → Vercel → aquí)
create or replace function public.arena_sala(p_partida text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object('id', a.id, 'modo', a.modo, 'juego', a.juego, 'paquete', a.paquete, 'estado', a.estado,
           'hora', a.hora, 'ganador', a.ganador, 'marcador', a.marcador,
           'jugadores', coalesce((select jsonb_agg(jsonb_build_object('usuario', i.usuario, 'nombre', i.nombre, 'puesto', i.puesto) order by i.puesto)
                                    from arena_inscripciones i where i.partida = a.id), '[]'::jsonb))
    from arena_partidas a where a.id = p_partida
$$;

create or replace function public.arena_empezo(p_partida text)
returns boolean
language sql
security definer
set search_path = public
as $$
  with u as (update arena_partidas set estado = 'jugando', empezo = coalesce(empezo, now())
              where id = p_partida and estado in ('lista', 'jugando') returning 1)
  select exists (select 1 from u)
$$;

-- Resultado de la serie (Worker). p_ganador: 0/1 = equipo, 2 = no entró nadie. Solo cuenta una vez.
create or replace function public.arena_resultado(p_partida text, p_ganador smallint, p_marcador text, p_motivo text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_ganador not in (0, 1, 2) then raise exception 'ganador no válido' using errcode = '22023'; end if;
  update arena_partidas set estado = 'terminada', ganador = p_ganador, marcador = left(p_marcador, 10),
         motivo = left(p_motivo, 200), termino = now(), empezo = coalesce(empezo, now())
   where id = p_partida and estado in ('lista', 'jugando');
  if not found then return false; end if;
  if p_ganador = 2 then
    update arena_inscripciones set resultado = 'reembolso', entrega = 'pendiente', entrega_act = now() where partida = p_partida;
  else
    update arena_inscripciones set resultado = case when (puesto >= 2)::int = p_ganador then 'gano' else 'perdio' end,
           entrega = case when (puesto >= 2)::int = p_ganador then 'pendiente' end, entrega_act = now()
     where partida = p_partida;
  end if;
  return true;
end;
$$;

-- Cada minuto (Vercel, llamado por el cron del Worker): vence lo que tiene que vencer y dice qué avisar.
-- Devuelve { avisos: [{ partida, tipo, hora, usuarios }] } con tipo lista/diez/ya/sin_rival/nadie.
create or replace function public.arena_tic()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_avisos jsonb := '[]'::jsonb;
  r record;
begin
  -- Sin rival en 24 h: cada uno recibe su paquete
  for r in update arena_partidas set estado = 'cancelada', ganador = 2, motivo = 'Sin rival en 24 horas', termino = now()
            where estado = 'esperando' and vence <= now() returning id loop
    update arena_inscripciones set resultado = 'reembolso', entrega = 'pendiente', entrega_act = now() where partida = r.id;
    v_avisos := v_avisos || jsonb_build_object('partida', r.id, 'tipo', 'sin_rival');
  end loop;
  -- Lista, pero a la hora + 15 min nadie entró (la sala nunca avisó que empezó)
  for r in update arena_partidas set estado = 'terminada', ganador = 2, motivo = 'No entró nadie', termino = now()
            where estado = 'lista' and hora + interval '15 minutes' <= now() returning id loop
    update arena_inscripciones set resultado = 'reembolso', entrega = 'pendiente', entrega_act = now() where partida = r.id;
    v_avisos := v_avisos || jsonb_build_object('partida', r.id, 'tipo', 'nadie');
  end loop;
  -- Jugando hace más de 3 horas sin resultado: que lo revise el administrador
  update arena_partidas set estado = 'revisar', motivo = 'La sala no mandó el resultado'
   where estado = 'jugando' and empezo < now() - interval '3 hours';
  -- Avisos de hora
  for r in select id, hora, avisos from arena_partidas where estado = 'lista' and hora is not null loop
    if not (r.avisos ? 'lista') then
      v_avisos := v_avisos || jsonb_build_object('partida', r.id, 'tipo', 'lista', 'hora', r.hora);
      update arena_partidas set avisos = avisos || '{"lista": true}' where id = r.id;
    end if;
    if r.hora - now() <= interval '10 minutes' and r.hora > now() and not (r.avisos ? 'diez') then
      v_avisos := v_avisos || jsonb_build_object('partida', r.id, 'tipo', 'diez', 'hora', r.hora);
      update arena_partidas set avisos = avisos || '{"diez": true}' where id = r.id;
    end if;
    if r.hora <= now() and not (r.avisos ? 'ya') then
      v_avisos := v_avisos || jsonb_build_object('partida', r.id, 'tipo', 'ya', 'hora', r.hora);
      update arena_partidas set avisos = avisos || '{"ya": true}' where id = r.id;
    end if;
  end loop;
  -- Con quién hablar en cada aviso
  select coalesce(jsonb_agg(a || jsonb_build_object('usuarios',
           (select coalesce(jsonb_agg(i.usuario), '[]'::jsonb) from arena_inscripciones i where i.partida = a->>'partida'))), '[]'::jsonb)
    into v_avisos from jsonb_array_elements(v_avisos) a;
  return jsonb_build_object('avisos', v_avisos);
end;
$$;

-- Entregas por hacer (premios y devoluciones): las marca "entregando" para que otro tic no las tome.
-- Las que quedaron "entregando" más de 10 min (se cortó la función) se repiten: la Idempotency-Key es la misma.
create or replace function public.arena_entregas(p_limite integer default 3)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v jsonb;
begin
  with t as (
    select i.id from arena_inscripciones i
     where i.entrega = 'pendiente' or (i.entrega = 'entregando' and i.entrega_act < now() - interval '10 minutes')
     order by i.entrega_act nulls first limit least(greatest(p_limite, 1), 10)
     for update skip locked
  ), u as (
    update arena_inscripciones i set entrega = 'entregando', entrega_act = now() from t where i.id = t.id returning i.*
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'partida', u.partida, 'usuario', u.usuario, 'resultado', u.resultado,
           'id_jugador', u.id_jugador, 'zona', u.zona, 'nick', u.nick, 'juego', a.juego, 'paquete', a.paquete,
           'partes_ok', u.partes_ok, 'intento', u.intento,
           'veces', case when u.resultado = 'gano' then 2 else 1 end)), '[]'::jsonb)
    into v from u join arena_partidas a on a.id = u.partida;
  return v;
end;
$$;

create or replace function public.arena_entrega_fin(p_id uuid, p_estado text, p_nota text, p_partes_ok smallint)
returns boolean
language sql
security definer
set search_path = public
as $$
  with u as (update arena_inscripciones set entrega = p_estado, entrega_nota = left(p_nota, 500), entrega_act = now(),
                    partes_ok = greatest(partes_ok, coalesce(p_partes_ok, 0))
              where id = p_id and p_estado in ('pendiente', 'entregado', 'revisar') returning 1)
  select exists (select 1 from u)
$$;

-- ---------------------------------------------------------------------
-- Ranking semanal (duelo rápido contra personas)
-- ---------------------------------------------------------------------
create or replace function public.arena_ranking_sumar(p_ganador uuid, p_nombre_g text, p_perdedor uuid, p_nombre_p text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_semana date := arena_semana();
  v_dia date := (now() at time zone 'America/Caracas')::date;
  v_cuenta integer;
begin
  if p_ganador = p_perdedor then return jsonb_build_object('cuenta', false); end if;
  insert into arena_duelos (dia, a, b, cuenta) values (v_dia, least(p_ganador, p_perdedor), greatest(p_ganador, p_perdedor), 1)
  on conflict (dia, a, b) do update set cuenta = arena_duelos.cuenta + 1
  returning cuenta into v_cuenta;
  if v_cuenta > 3 then return jsonb_build_object('cuenta', false, 'motivo', 'mismo rival'); end if;
  insert into arena_ranking (semana, usuario, nombre, puntos, ganadas) values (v_semana, p_ganador, left(p_nombre_g, 14), 25, 1)
  on conflict (semana, usuario) do update set puntos = arena_ranking.puntos + 25, ganadas = arena_ranking.ganadas + 1, nombre = excluded.nombre;
  insert into arena_ranking (semana, usuario, nombre, puntos, perdidas) values (v_semana, p_perdedor, left(p_nombre_p, 14), 0, 1)
  on conflict (semana, usuario) do update set puntos = greatest(0, arena_ranking.puntos - 10), perdidas = arena_ranking.perdidas + 1, nombre = excluded.nombre;
  delete from arena_duelos where dia < v_dia - 2;
  return jsonb_build_object('cuenta', true);
end;
$$;

-- Para arena.html (público): los 20 primeros de la semana y, con sesión, mi puesto
create or replace function public.arena_ranking_semana()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with s as (select arena_semana() as semana),
  t as (select r.*, rank() over (order by r.puntos desc, r.ganadas desc) as puesto from arena_ranking r, s where r.semana = s.semana)
  select jsonb_build_object(
    'semana', (select semana from s),
    'top', coalesce((select jsonb_agg(jsonb_build_object('puesto', puesto, 'nombre', nombre, 'puntos', puntos, 'ganadas', ganadas, 'perdidas', perdidas,
                                                         'yo', usuario = auth.uid()) order by puesto, nombre) from (select * from t order by puesto limit 20) x), '[]'::jsonb),
    'yo', (select jsonb_build_object('puesto', puesto, 'puntos', puntos, 'ganadas', ganadas, 'perdidas', perdidas) from t where usuario = auth.uid()))
$$;

-- Para arena.html (con sesión): mis inscripciones de los últimos 15 días con sus partidas
create or replace function public.arena_mias()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'partida', a.id, 'modo', a.modo, 'juego', a.juego, 'paquete', a.paquete, 'precio', a.precio, 'estado', a.estado,
           'hora', a.hora, 'vence', a.vence, 'ganador', a.ganador, 'marcador', a.marcador, 'motivo', a.motivo,
           'puesto', i.puesto, 'resultado', i.resultado, 'entrega', i.entrega, 'id_jugador', i.id_jugador, 'creada', i.creada,
           'jugadores', (select jsonb_agg(jsonb_build_object('nombre', j.nombre, 'puesto', j.puesto) order by j.puesto) from arena_inscripciones j where j.partida = a.id))
           order by i.creada desc), '[]'::jsonb)
    from arena_inscripciones i join arena_partidas a on a.id = i.partida
   where i.usuario = auth.uid() and i.creada > now() - interval '15 days'
$$;

-- Notificaciones
create or replace function public.arena_push_guardar(p_usuario uuid, p_endpoint text, p_p256dh text, p_auth text)
returns boolean
language sql
security definer
set search_path = public
as $$
  insert into arena_push (endpoint, usuario, p256dh, auth) values (left(p_endpoint, 600), p_usuario, left(p_p256dh, 200), left(p_auth, 100))
  on conflict (endpoint) do update set usuario = excluded.usuario, p256dh = excluded.p256dh, auth = excluded.auth, creado = now();
  -- Máximo 5 equipos por cuenta (los más nuevos)
  delete from arena_push where usuario = p_usuario and endpoint not in (select endpoint from arena_push where usuario = p_usuario order by creado desc limit 5);
  select true
$$;
create or replace function public.arena_push_de(p_usuarios uuid[])
returns setof arena_push
language sql
stable
security definer
set search_path = public
as $$ select * from arena_push where usuario = any(p_usuarios) $$;
create or replace function public.arena_push_borrar(p_endpoint text)
returns void
language sql
security definer
set search_path = public
as $$ delete from arena_push where endpoint = p_endpoint $$;

-- Secretos (Vault): arena_secreto (Worker ↔ Vercel), vapid_publica y vapid_privada (notificaciones)
create or replace function public.arena_secretos()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_object_agg(name, decrypted_secret), '{}'::jsonb)
    from vault.decrypted_secrets where name in ('arena_secreto', 'vapid_publica', 'vapid_privada')
$$;

-- ---------------------------------------------------------------------
-- Panel (solo administradores)
-- ---------------------------------------------------------------------
create or replace function public.admin_arena(p_limite integer default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not (select es_admin()) then raise exception 'solo administradores' using errcode = '42501'; end if;
  return (select coalesce(jsonb_agg(x order by x.creada desc), '[]'::jsonb) from (
    select a.*, (select jsonb_agg(jsonb_build_object('id', i.id, 'nombre', i.nombre, 'puesto', i.puesto, 'id_jugador', i.id_jugador,
                   'zona', i.zona, 'nick', i.nick, 'referencia', i.referencia, 'monto', i.monto, 'resultado', i.resultado,
                   'entrega', i.entrega, 'entrega_nota', i.entrega_nota, 'partes_ok', i.partes_ok,
                   'correo', (select u.email from auth.users u where u.id = i.usuario)) order by i.puesto)
                   from arena_inscripciones i where i.partida = a.id) as jugadores
      from arena_partidas a order by a.creada desc limit least(greatest(coalesce(p_limite, 50), 1), 200)) x);
end;
$$;

-- Volver a intentar una entrega que quedó "revisar" (después de revisar en Central One que no llegó)
create or replace function public.admin_arena_reintentar(p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not (select es_admin()) then raise exception 'solo administradores' using errcode = '42501'; end if;
  update arena_inscripciones set entrega = 'pendiente', entrega_act = now(), intento = least(intento + 1, 9) where id = p_id and entrega = 'revisar';
  return found;
end;
$$;

-- Marcar a mano una entrega como hecha (si se entregó por fuera)
create or replace function public.admin_arena_entregada(p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not (select es_admin()) then raise exception 'solo administradores' using errcode = '42501'; end if;
  update arena_inscripciones set entrega = 'entregado', entrega_nota = coalesce(entrega_nota, '') || ' · marcada a mano', entrega_act = now()
   where id = p_id and entrega in ('revisar', 'pendiente');
  return found;
end;
$$;

-- Permisos
revoke execute on function public.arena_nuevo_id(), public.arena_hora(timestamptz), public.arena_semana(),
  public.arena_inscribir(uuid, uuid, text, text, text, text, numeric, text, text, text, text, numeric),
  public.arena_sala(text), public.arena_empezo(text), public.arena_resultado(text, smallint, text, text), public.arena_tic(),
  public.arena_entregas(integer), public.arena_entrega_fin(uuid, text, text, smallint), public.arena_ranking_sumar(uuid, text, uuid, text),
  public.arena_push_guardar(uuid, text, text, text), public.arena_push_de(uuid[]), public.arena_push_borrar(text), public.arena_secretos()
  from public, anon, authenticated;
grant execute on function public.arena_inscribir(uuid, uuid, text, text, text, text, numeric, text, text, text, text, numeric),
  public.arena_sala(text), public.arena_empezo(text), public.arena_resultado(text, smallint, text, text), public.arena_tic(),
  public.arena_entregas(integer), public.arena_entrega_fin(uuid, text, text, smallint), public.arena_ranking_sumar(uuid, text, uuid, text),
  public.arena_push_guardar(uuid, text, text, text), public.arena_push_de(uuid[]), public.arena_push_borrar(text), public.arena_secretos()
  to service_role;
revoke execute on function public.arena_ranking_semana(), public.arena_mias() from public, anon;
grant execute on function public.arena_ranking_semana() to anon, authenticated;
grant execute on function public.arena_mias() to authenticated;
revoke execute on function public.admin_arena(integer), public.admin_arena_reintentar(uuid), public.admin_arena_entregada(uuid) from public, anon;
grant execute on function public.admin_arena(integer), public.admin_arena_reintentar(uuid), public.admin_arena_entregada(uuid) to authenticated;

-- =====================================================================
-- SECRETOS (una sola vez, NO se vuelve a correr): en el SQL Editor, con valores propios
--   select vault.create_secret('<64 letras hex al azar>', 'arena_secreto');   -- y el mismo en el Worker:
--       cd juego-servidor && npx wrangler secret put ARENA_SECRETO
--   select vault.create_secret('<llave pública VAPID>', 'vapid_publica');
--   select vault.create_secret('<llave privada VAPID>', 'vapid_privada');
-- (npx web-push generate-vapid-keys da el par de llaves VAPID.)
-- =====================================================================

-- =====================================================================
-- DUELOS POR FICHAS (desde 2026-11-20, pedido del dueño: "por ahora con fichas")
-- Cada duelo (mejor de 3) cuesta p_costo fichas (2) a cada jugador; se cobran al EMPEZAR (la sala del Worker
-- pide arena_fichas_cobrar por Vercel). El ganador recibe el doble (las suyas + las del rival). Contra el bot
-- experto (nadie en la cola), ganar también da el doble. Duelos cobrados sin resultado en 90 min: se devuelven.
-- Movimientos en juego_movimientos con id_pedido "duelo:<sala>:<usuario>" (un cobro/premio por duelo y jugador).
-- =====================================================================
alter table public.juego_movimientos drop constraint if exists juego_movimientos_motivo_check;
alter table public.juego_movimientos add constraint juego_movimientos_motivo_check
  check (motivo in ('recarga', 'reembolso', 'partida', 'ajuste', 'duelo', 'duelo_premio', 'duelo_devolucion'));

create table if not exists public.arena_duelos_fichas (
  sala      text primary key,
  tipo      text not null check (tipo in ('persona', 'bot')),
  usuarios  uuid[] not null,
  nombres   text[] not null,
  costo     integer not null check (costo > 0),
  estado    text not null default 'cobrado' check (estado in ('cobrado', 'terminado', 'devuelto')),
  ganador   uuid,                                          -- null = ganó el bot
  creado    timestamptz not null default now(),
  terminado timestamptz
);
create index if not exists arena_duelos_fichas_estado on public.arena_duelos_fichas (estado, creado);
alter table public.arena_duelos_fichas enable row level security;
revoke all on public.arena_duelos_fichas from anon, authenticated;
grant select on public.arena_duelos_fichas to authenticated;
drop policy if exists "admin ve los duelos por fichas" on public.arena_duelos_fichas;
create policy "admin ve los duelos por fichas" on public.arena_duelos_fichas for select to authenticated using ((select public.es_admin()));

-- Cobra a todos o a nadie. { ok, fichas: { usuario: saldo } } o { ok: false, faltan: [usuarios sin fichas] }.
-- Repetir con la misma sala no cobra otra vez.
create or replace function public.arena_fichas_cobrar(p_sala text, p_tipo text, p_usuarios uuid[], p_nombres text[], p_costo integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_u uuid;
  v_faltan uuid[] := '{}';
  v_saldos jsonb := '{}'::jsonb;
  v_f integer;
begin
  if exists (select 1 from arena_duelos_fichas where sala = p_sala) then
    return jsonb_build_object('ok', true, 'repetido', true);
  end if;
  if p_costo is null or p_costo < 1 or coalesce(array_length(p_usuarios, 1), 0) not between 1 and 4 then
    raise exception 'duelo no válido' using errcode = '22023';
  end if;
  foreach v_u in array p_usuarios loop
    insert into juego_fichas (usuario) values (v_u) on conflict (usuario) do nothing;
  end loop;
  -- Bloquea los saldos en orden (dos duelos a la vez no se cruzan)
  perform 1 from juego_fichas where usuario = any(p_usuarios) order by usuario for update;
  foreach v_u in array p_usuarios loop
    select fichas into v_f from juego_fichas where usuario = v_u;
    if v_f < p_costo then v_faltan := v_faltan || v_u; end if;
  end loop;
  if array_length(v_faltan, 1) > 0 then
    return jsonb_build_object('ok', false, 'faltan', to_jsonb(v_faltan));
  end if;
  insert into arena_duelos_fichas (sala, tipo, usuarios, nombres, costo) values (p_sala, p_tipo, p_usuarios, p_nombres, p_costo);
  foreach v_u in array p_usuarios loop
    update juego_fichas set fichas = fichas - p_costo, actualizado = now() where usuario = v_u returning fichas into v_f;
    insert into juego_movimientos (usuario, cambio, motivo, id_pedido) values (v_u, -p_costo, 'duelo', 'duelo:' || p_sala || ':' || v_u);
    v_saldos := v_saldos || jsonb_build_object(v_u::text, v_f);
  end loop;
  return jsonb_build_object('ok', true, 'fichas', v_saldos);
end;
$$;

-- Resultado: el ganador (null = el bot) recibe el doble del costo. Solo cuenta una vez.
create or replace function public.arena_fichas_resultado(p_sala text, p_ganador uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  d arena_duelos_fichas%rowtype;
  v_f integer;
begin
  update arena_duelos_fichas set estado = 'terminado', ganador = p_ganador, terminado = now()
   where sala = p_sala and estado = 'cobrado' and (p_ganador is null or p_ganador = any(usuarios))
   returning * into d;
  if not found then return jsonb_build_object('ok', false); end if;
  if p_ganador is not null then
    update juego_fichas set fichas = fichas + d.costo * 2, actualizado = now() where usuario = p_ganador returning fichas into v_f;
    insert into juego_movimientos (usuario, cambio, motivo, id_pedido) values (p_ganador, d.costo * 2, 'duelo_premio', 'duelo:' || p_sala || ':' || p_ganador);
  end if;
  return jsonb_build_object('ok', true, 'premio', case when p_ganador is null then 0 else d.costo * 2 end, 'fichas', v_f);
end;
$$;

-- Cada minuto (arena tic): duelos cobrados hace más de 90 min sin resultado → se devuelven las fichas
create or replace function public.arena_fichas_vencer()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  d record;
  v_u uuid;
  n integer := 0;
begin
  for d in update arena_duelos_fichas set estado = 'devuelto', terminado = now()
            where estado = 'cobrado' and creado < now() - interval '90 minutes' returning * loop
    foreach v_u in array d.usuarios loop
      update juego_fichas set fichas = fichas + d.costo, actualizado = now() where usuario = v_u;
      insert into juego_movimientos (usuario, cambio, motivo, id_pedido) values (v_u, d.costo, 'duelo_devolucion', 'duelo:' || d.sala || ':' || v_u)
        on conflict do nothing;
    end loop;
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- Para arena.html (con sesión): mis fichas
create or replace function public.arena_mis_fichas()
returns integer
language sql
stable
security definer
set search_path = public
as $$ select coalesce((select fichas from juego_fichas where usuario = auth.uid()), 0) $$;

revoke execute on function public.arena_fichas_cobrar(text, text, uuid[], text[], integer), public.arena_fichas_resultado(text, uuid),
  public.arena_fichas_vencer() from public, anon, authenticated;
grant execute on function public.arena_fichas_cobrar(text, text, uuid[], text[], integer), public.arena_fichas_resultado(text, uuid),
  public.arena_fichas_vencer() to service_role;
revoke execute on function public.arena_mis_fichas() from public, anon;
grant execute on function public.arena_mis_fichas() to authenticated;

-- Por ahora el torneo con Bs queda apagado (se enciende en admin.html → Arena)
update public.configuracion set valor = jsonb_set(valor, '{activo}', 'false') where clave = 'arena' and (valor->>'activo') is distinct from 'false';
