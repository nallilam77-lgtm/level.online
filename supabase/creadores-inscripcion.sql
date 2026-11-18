-- =====================================================================
-- LEVEL UP · INSCRIPCIÓN DE MINI INFLUENCERS (desde 2026-11-17)
--
-- Cómo instalarlo: Supabase → SQL Editor → New query → pega TODO este archivo → Run (después de
-- supabase/codigos.sql). Se puede volver a correr. Si vuelves a correr codigos.sql, corre este después
-- (aquí está la versión nueva de codigos_panel_de).
--
-- Cómo funciona:
--   · El administrador abre las inscripciones en admin.html → Creadores con N cupos (y el mínimo de ventas
--     por semana, 10 por defecto). Al llenarse los N cupos se cierran solas.
--   · El creador entra con Google en creadores.html, elige su código y deja su WhatsApp (de cualquier país)
--     y el enlace de su perfil o de un video suyo (creador_inscribir). El código funciona al instante, con
--     las mismas recompensas de siempre: 1,5 % para el seguidor y 1,5 % para el creador.
--   · Cada lunes a las 12:15 a. m. (hora de Venezuela) pg_cron corre creadores_limpieza_semanal: TODOS los
--     códigos de creador (inscritos y creados a mano; las promos sin creador no) que no llegaron al mínimo de
--     ventas en la semana anterior (lunes a domingo) se desactivan. Solo cuenta una semana COMPLETA: quien
--     entra a mitad de semana empieza a contar el lunes siguiente. Lo que ganó el creador no se pierde
--     (sigue en su panel y se le paga igual).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Columnas nuevas de "codigos"
-- ---------------------------------------------------------------------
alter table public.codigos add column if not exists origen text not null default 'admin'
  check (origen in ('admin', 'inscripcion'));
alter table public.codigos add column if not exists whatsapp text
  check (whatsapp is null or whatsapp ~ '^\+[1-9]\d{7,14}$');                       -- de cualquier país
alter table public.codigos add column if not exists enlace text
  check (enlace is null or (length(enlace) <= 300 and enlace ~ '^https://[^\s<>"]+$')); -- perfil o video
alter table public.codigos add column if not exists usuario uuid references auth.users (id) on delete set null;
-- Desde cuándo cuenta para el mínimo semanal (al inscribirse o al reactivarlo)
alter table public.codigos add column if not exists alta timestamptz;
-- Por qué se desactivó: 'ventas_semana' (limpieza semanal: puede volver a inscribirse) o 'admin' (a mano: no)
alter table public.codigos add column if not exists baja text check (baja is null or baja in ('ventas_semana', 'admin'));
alter table public.codigos add column if not exists baja_fecha timestamptz;
create index if not exists codigos_inscritos on public.codigos (origen, activo) where origen = 'inscripcion';
-- Los creadores que ya existían (creados a mano) cuentan desde el lunes de la semana en que se instala esto,
-- SIN semana de prueba (lo pidió el dueño el 2026-11-17: la semana del 16 al 22 de noviembre ya cuenta).
-- Solo la primera vez: después alta ya no está vacía. La semana de prueba queda para los que se inscriben.
update public.codigos set alta = date_trunc('week', now() at time zone 'America/Caracas') at time zone 'America/Caracas'
 where creador is not null and alta is null;

-- Activar/desactivar deja la marca sola: desactivar a mano = baja "admin"; reactivar borra la baja y
-- vuelve a empezar la cuenta semanal (si no, se desactivaría el lunes por la semana que estuvo apagado)
create or replace function public.codigos_marcar_baja()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.activo and not new.activo then
    new.baja := coalesce(new.baja, 'admin');
    new.baja_fecha := coalesce(new.baja_fecha, now());
  elsif not old.activo and new.activo then
    new.baja := null;
    new.baja_fecha := null;
    new.alta := now();
  end if;
  return new;
end;
$$;
drop trigger if exists codigos_marcar_baja on public.codigos;
create trigger codigos_marcar_baja before update of activo on public.codigos
  for each row execute function public.codigos_marcar_baja();

-- ---------------------------------------------------------------------
-- Datos de pago: WhatsApp de cualquier país y Pago Móvil solo para quien cobra en bolívares
-- (un creador de fuera de Venezuela cobra en diamantes)
-- ---------------------------------------------------------------------
alter table public.creadores_perfil drop constraint if exists creadores_perfil_telefono_check;
alter table public.creadores_perfil add constraint creadores_perfil_telefono_check
  check (telefono ~ '^\+[1-9]\d{7,14}$');
alter table public.creadores_perfil alter column pm_cedula drop not null;
alter table public.creadores_perfil alter column pm_telefono drop not null;
alter table public.creadores_perfil alter column pm_banco drop not null;
alter table public.creadores_perfil drop constraint if exists creadores_perfil_bolivares;
alter table public.creadores_perfil add constraint creadores_perfil_bolivares
  check (preferencia <> 'bolivares' or (pm_cedula is not null and pm_telefono is not null and pm_banco is not null));

-- ---------------------------------------------------------------------
-- Estado de las inscripciones: configuracion "creadores_inscripcion"
--   { abierta, cupos, usados, minimo, abierta_desde, revisada (lunes de la última semana revisada), bajas }
-- ---------------------------------------------------------------------
insert into public.configuracion (clave, valor, publico, actualizado)
values ('creadores_inscripcion', '{"abierta": false, "cupos": 0, "usados": 0, "minimo": 10}'::jsonb, false, now())
on conflict (clave) do nothing;

-- Semana de Venezuela (lunes 00:00 a lunes siguiente) que contiene p_ahora
create or replace function public.creadores_semana(p_ahora timestamptz default now())
returns table (ini timestamptz, fin timestamptz)
language sql
stable
set search_path = public
as $$
  select date_trunc('week', p_ahora at time zone 'America/Caracas') at time zone 'America/Caracas',
         (date_trunc('week', p_ahora at time zone 'America/Caracas') + interval '7 days') at time zone 'America/Caracas';
$$;

-- Ventas contadas de un código entre dos fechas (las mismas que suben "usos")
create or replace function public.creadores_ventas_entre(p_codigo text, p_ini timestamptz, p_fin timestamptz)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::int from recargas
   where codigo_descuento = p_codigo and codigo_contado and creado >= p_ini and creado < p_fin;
$$;
revoke execute on function public.creadores_ventas_entre(text, timestamptz, timestamptz) from public, anon, authenticated;

-- Lo que ve la página (sin datos de nadie): ¿abiertas?, cupos que quedan y el mínimo semanal
create or replace function public.creadores_inscripcion_estado()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'abierta', coalesce((valor->>'abierta')::boolean, false)
               and coalesce((valor->>'usados')::int, 0) < coalesce((valor->>'cupos')::int, 0),
    'quedan', greatest(coalesce((valor->>'cupos')::int, 0) - coalesce((valor->>'usados')::int, 0), 0),
    'minimo', coalesce((valor->>'minimo')::int, 10))
    from configuracion where clave = 'creadores_inscripcion';
$$;
revoke execute on function public.creadores_inscripcion_estado() from public, anon, authenticated;
grant execute on function public.creadores_inscripcion_estado() to service_role;

-- ---------------------------------------------------------------------
-- Inscribirse (api/creadores.js; el usuario sale del token de Google, ya comprobado por Vercel).
-- Devuelve { ok: true, codigo, quedan } o { ok: false, error, cerrada? } con el texto para el creador.
-- Todo con la fila de configuración bloqueada: dos inscripciones a la vez no pasan del cupo.
-- ---------------------------------------------------------------------
create or replace function public.creador_inscribir(p_usuario uuid, p_codigo text, p_whatsapp text, p_enlace text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_correo text;
  v_cfg jsonb;
  v_cupos int;
  v_usados int;
  v_codigo text := upper(regexp_replace(coalesce(p_codigo, ''), '\s', '', 'g'));
  v_whatsapp text := trim(coalesce(p_whatsapp, ''));
  v_enlace text := trim(coalesce(p_enlace, ''));
begin
  select lower(email) into v_correo from auth.users where id = p_usuario and email_confirmed_at is not null;
  if v_correo is null then
    return jsonb_build_object('ok', false, 'error', 'Tu sesión no es válida. Vuelve a entrar con Google.');
  end if;

  select valor into v_cfg from configuracion where clave = 'creadores_inscripcion' for update;
  v_cupos := coalesce((v_cfg->>'cupos')::int, 0);
  v_usados := coalesce((v_cfg->>'usados')::int, 0);
  if v_cfg is null or not coalesce((v_cfg->>'abierta')::boolean, false) or v_usados >= v_cupos then
    return jsonb_build_object('ok', false, 'cerrada', true,
      'error', 'Las inscripciones están cerradas: se llenaron los cupos. Síguenos para saber cuándo abrimos otra vez.');
  end if;

  if exists (select 1 from codigos where correo = v_correo and creador is not null and activo) then
    return jsonb_build_object('ok', false, 'error', 'Tu cuenta ya tiene un código de creador activo. Lo ves aquí mismo, en tu panel.');
  end if;
  if exists (select 1 from codigos where correo = v_correo and creador is not null and not activo and baja is distinct from 'ventas_semana') then
    return jsonb_build_object('ok', false, 'error', 'Tu código de creador fue desactivado. Escríbenos por WhatsApp si crees que es un error.');
  end if;

  if v_codigo !~ '^[A-Z0-9]{4,15}$' then
    return jsonb_build_object('ok', false, 'error', 'Tu código debe tener de 4 a 15 letras o números, sin espacios ni símbolos (ej: JOSEFF).');
  end if;
  if v_codigo ~ '^LEVEL' or v_codigo in ('ADMIN', 'SOPORTE', 'GRATIS', 'PROMO', 'DESCUENTO', 'TEST', 'PRUEBA', 'CREADOR', 'CREADORES') then
    return jsonb_build_object('ok', false, 'error', 'Ese código está reservado. Elige otro.');
  end if;
  if exists (select 1 from codigos where codigo = v_codigo) then
    return jsonb_build_object('ok', false, 'error', 'Ese código ya lo tiene otro creador. Elige otro.');
  end if;
  if v_whatsapp !~ '^\+[1-9]\d{7,14}$' then
    return jsonb_build_object('ok', false, 'error', 'Escribe tu WhatsApp con el código de tu país (ej: +58 414 1234567).');
  end if;
  if exists (select 1 from codigos where whatsapp = v_whatsapp and activo) then
    return jsonb_build_object('ok', false, 'error', 'Ese WhatsApp ya tiene un código de creador activo.');
  end if;
  if length(v_enlace) > 300 or v_enlace !~ '^https://[^\s<>"]+\.[^\s<>"]+$' then
    return jsonb_build_object('ok', false, 'error', 'Pega el enlace de tu perfil o de un video tuyo (TikTok, YouTube, Instagram…).');
  end if;

  insert into codigos (codigo, creador, correo, activo, origen, whatsapp, enlace, usuario, alta)
  values (v_codigo, v_whatsapp, v_correo, true, 'inscripcion', v_whatsapp, v_enlace, p_usuario, now());

  v_usados := v_usados + 1;
  update configuracion
     set valor = v_cfg || jsonb_build_object('usados', v_usados, 'abierta', v_usados < v_cupos), actualizado = now()
   where clave = 'creadores_inscripcion';
  return jsonb_build_object('ok', true, 'codigo', v_codigo, 'quedan', greatest(v_cupos - v_usados, 0));
exception
  when unique_violation then
    return jsonb_build_object('ok', false, 'error', 'Ese código ya lo tiene otro creador. Elige otro.');
end;
$$;
revoke execute on function public.creador_inscribir(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.creador_inscribir(uuid, text, text, text) to service_role;

-- ---------------------------------------------------------------------
-- Limpieza semanal: desactiva los creadores (inscritos o a mano) que no llegaron al mínimo en la semana ANTERIOR.
-- Una sola vez por semana (guarda el lunes revisado): si se llama dos veces, la segunda no hace nada.
-- ---------------------------------------------------------------------
create or replace function public.creadores_limpieza_semanal()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fin timestamptz;
  v_ini timestamptz;
  v_lunes text;
  v_cfg jsonb;
  v_minimo int;
  v_bajas jsonb := '[]'::jsonb;
  v_ventas int;
  k record;
begin
  select ini into v_fin from creadores_semana();
  v_ini := v_fin - interval '7 days';
  v_lunes := to_char(v_ini at time zone 'America/Caracas', 'YYYY-MM-DD');

  select valor into v_cfg from configuracion where clave = 'creadores_inscripcion' for update;
  v_cfg := coalesce(v_cfg, '{}'::jsonb);
  if v_cfg->>'revisada' = v_lunes then
    return jsonb_build_object('hecho', false, 'semana', v_lunes, 'motivo', 'Esa semana ya se revisó.');
  end if;
  v_minimo := coalesce((v_cfg->>'minimo')::int, 10);

  for k in select codigo from codigos
            where creador is not null and activo and coalesce(alta, creado) <= v_ini
            for update loop
    v_ventas := creadores_ventas_entre(k.codigo, v_ini, v_fin);
    if v_ventas < v_minimo then
      update codigos set activo = false, baja = 'ventas_semana', baja_fecha = now() where codigo = k.codigo;
      v_bajas := v_bajas || jsonb_build_object('codigo', k.codigo, 'ventas', v_ventas);
    end if;
  end loop;

  insert into configuracion (clave, valor, publico, actualizado)
  values ('creadores_inscripcion', v_cfg || jsonb_build_object('revisada', v_lunes, 'revisada_en', now(), 'bajas', v_bajas), false, now())
  on conflict (clave) do update set valor = excluded.valor, actualizado = now();
  return jsonb_build_object('hecho', true, 'semana', v_lunes, 'minimo', v_minimo, 'bajas', v_bajas);
end;
$$;
revoke execute on function public.creadores_limpieza_semanal() from public, anon, authenticated;
grant execute on function public.creadores_limpieza_semanal() to service_role;

-- Cada lunes 04:15 UTC = 12:15 a. m. en Venezuela
create extension if not exists pg_cron;
select cron.schedule('creadores-limpieza-semanal', '15 4 * * 1', 'select public.creadores_limpieza_semanal()');

-- ---------------------------------------------------------------------
-- Panel admin (admin.html → Creadores → Inscripciones)
-- ---------------------------------------------------------------------
create or replace function public.admin_inscripciones()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_cfg jsonb;
  v_ini timestamptz;
  v_fin timestamptz;
begin
  perform admin_revisar();
  select valor into v_cfg from configuracion where clave = 'creadores_inscripcion';
  select ini, fin into v_ini, v_fin from creadores_semana();
  return jsonb_build_object(
    'config', coalesce(v_cfg, '{}'::jsonb),
    'estado', creadores_inscripcion_estado(),
    'semana_fin', v_fin,
    'creadores', (
      select coalesce(jsonb_agg(c order by c.activo desc, c.ventas_semana desc, c.creado desc), '[]'::jsonb) from (
        select k.codigo, k.origen, k.creador, coalesce(k.whatsapp, (select f.telefono from creadores_perfil f where f.correo = k.correo)) as whatsapp,
               k.enlace, k.correo, k.activo, k.baja, k.baja_fecha, k.creado, k.alta, k.usos,
               round(k.pendiente_usd, 2) as pendiente_usd,
               creadores_ventas_entre(k.codigo, v_ini, v_fin) as ventas_semana,
               creadores_ventas_entre(k.codigo, v_ini - interval '7 days', v_ini) as ventas_pasada,
               coalesce(k.alta, k.creado) > v_ini as primera_semana
          from codigos k
         where k.creador is not null
         order by k.creado desc
         limit 500
      ) c
    )
  );
end;
$$;
revoke execute on function public.admin_inscripciones() from public, anon;
grant execute on function public.admin_inscripciones() to authenticated, service_role;

-- Abre las inscripciones con p_cupos cuentas nuevas (los cupos vuelven a empezar) y el mínimo semanal
create or replace function public.admin_inscripcion_abrir(p_cupos integer, p_minimo integer default 10)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform admin_revisar();
  if p_cupos is null or p_cupos < 1 or p_cupos > 1000 then
    raise exception 'Escribe cuántas cuentas se pueden crear (de 1 a 1000).' using errcode = '22023';
  end if;
  if p_minimo is null or p_minimo < 1 or p_minimo > 500 then
    raise exception 'Escribe el mínimo de ventas por semana (de 1 a 500).' using errcode = '22023';
  end if;
  insert into configuracion (clave, valor, publico, actualizado)
  values ('creadores_inscripcion', jsonb_build_object('abierta', true, 'cupos', p_cupos, 'usados', 0, 'minimo', p_minimo, 'abierta_desde', now()), false, now())
  on conflict (clave) do update
    set valor = configuracion.valor || jsonb_build_object('abierta', true, 'cupos', p_cupos, 'usados', 0, 'minimo', p_minimo, 'abierta_desde', now()),
        actualizado = now();
  return creadores_inscripcion_estado();
end;
$$;
revoke execute on function public.admin_inscripcion_abrir(integer, integer) from public, anon;
grant execute on function public.admin_inscripcion_abrir(integer, integer) to authenticated, service_role;

create or replace function public.admin_inscripcion_cerrar()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform admin_revisar();
  update configuracion set valor = valor || '{"abierta": false}'::jsonb, actualizado = now() where clave = 'creadores_inscripcion';
  return creadores_inscripcion_estado();
end;
$$;
revoke execute on function public.admin_inscripcion_cerrar() from public, anon;
grant execute on function public.admin_inscripcion_cerrar() to authenticated, service_role;

-- Cambia solo el mínimo de ventas semanales (sin abrir ni cerrar)
create or replace function public.admin_inscripcion_minimo(p_minimo integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform admin_revisar();
  if p_minimo is null or p_minimo < 1 or p_minimo > 500 then
    raise exception 'Escribe el mínimo de ventas por semana (de 1 a 500).' using errcode = '22023';
  end if;
  update configuracion set valor = valor || jsonb_build_object('minimo', p_minimo), actualizado = now() where clave = 'creadores_inscripcion';
  return creadores_inscripcion_estado();
end;
$$;
revoke execute on function public.admin_inscripcion_minimo(integer) from public, anon;
grant execute on function public.admin_inscripcion_minimo(integer) to authenticated, service_role;

-- "Revisar la semana ahora" (por si pg_cron no corrió): la misma limpieza, una vez por semana
create or replace function public.admin_limpieza_semanal()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform admin_revisar();
  return creadores_limpieza_semanal();
end;
$$;
revoke execute on function public.admin_limpieza_semanal() from public, anon;
grant execute on function public.admin_limpieza_semanal() to authenticated, service_role;

-- ---------------------------------------------------------------------
-- Panel del creador: lo mismo de codigos.sql + cómo va su semana (todo código de creador activo)
-- ---------------------------------------------------------------------
create or replace function public.codigos_panel_de(p_codigo text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  k codigos%rowtype;
  v_tasa numeric := codigos_tasa();
  v_extra numeric;
  v_ini timestamptz;
  v_fin timestamptz;
begin
  select * into k from codigos where codigo = p_codigo;
  if not found then return null; end if;
  select ini, fin into v_ini, v_fin from creadores_semana();
  v_extra := case when v_tasa is not null then k.por_convertir_bs / v_tasa else 0 end;
  return jsonb_build_object(
    'encontrado', true,
    'codigo', k.codigo,
    'activo', k.activo,
    'porcentaje', codigos_porcentaje_creador(),
    'usos', k.usos,
    'ventasBs', k.ventas_bs,
    'comisionTotalUsd', round(k.comision_usd + v_extra, 2),
    'pendienteUsd', round(k.pendiente_usd + v_extra, 2),
    'tasa', v_tasa,
    'inscrito', k.origen = 'inscripcion',
    'baja', k.baja,
    'semana', case when k.creador is not null and k.activo then jsonb_build_object(
      'ventas', creadores_ventas_entre(k.codigo, v_ini, v_fin),
      'minimo', coalesce((select (valor->>'minimo')::int from configuracion where clave = 'creadores_inscripcion'), 10),
      'cierra', v_fin,                                                     -- lunes 00:00 de Venezuela
      'primera', coalesce(k.alta, k.creado) > v_ini) end,
    'movimientos', (
      select coalesce(jsonb_agg(m order by m.creado desc), '[]'::jsonb) from (
        select r.creado, to_char(r.creado at time zone 'America/Caracas', 'DD/MM/YYYY HH24:MI') as fecha,
               r.juego, coalesce(r.precio, 0) as "ventaBs", round(r.comision_usd, 2) as "comisionUsd"
          from recargas r
         where r.codigo_descuento = k.codigo and r.codigo_contado
         order by r.creado desc limit 10
      ) m
    )
  );
end;
$$;
revoke execute on function public.codigos_panel_de(text) from public, anon, authenticated;
