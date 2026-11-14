-- =====================================================================
-- LEVEL UP · CÓDIGOS DE DESCUENTO Y CREADORES EN SUPABASE (paso 1, desde 2026-11-13)
--
-- Cómo instalarlo: Supabase → SQL Editor → New query → pega TODO este archivo → Run (después de
-- supabase/tienda.sql). Se puede volver a correr.
--
-- Mudanza por pasos de la pestaña "Descuentos" de la hoja de Free Fire (apps-script/recargas.gs,
-- sección 6). Mientras no se haga el paso 5, LA HOJA SIGUE MANDANDO: esto todavía no lo usa la tienda.
--   1. Esta tabla (vacía) + la columna recargas.codigo_descuento.
--   2. Copiar los códigos: privado/codigos-datos.sql (NO se sube a GitHub: trae PIN y teléfonos).
--   3. Pestaña "Creadores" del panel admin (admin_codigos).
--   4. Vercel anota cada venta con código aquí Y en la hoja (en paralelo).
--   5. La tienda valida los códigos aquí.  6. Panel de creadores.  7. Pagos desde el panel.  8. Fuera la hoja.
--
-- Sin tabla de movimientos (para no gastar espacio): cada venta con código queda en "recargas"
-- (columna codigo_descuento). De ahí salen los últimos movimientos del creador, y como id_pedido es
-- único, una venta no se puede contar dos veces.
--
-- Contadores (igual que en la hoja):
--   usos, ventas_bs, comision_usd   SOLO SUBEN (lo que el creador ve que se ha movido con su código).
--   pendiente_usd                   lo que falta por pagarle: sube con cada venta, vuelve a 0 al pagarle.
--   La comisión NUNCA se recalcula desde ventas_bs: ventas_bs cuenta desde siempre y la comisión
--   solo desde que empezó el programa del 1,5 % (2026-10-13).
-- =====================================================================

create table if not exists public.codigos (
  codigo           text primary key check (codigo ~ '^[A-Z0-9_-]{2,30}$'),   -- siempre en mayúsculas
  creador          text check (creador is null or length(creador) between 1 and 60), -- vacío = promo
  descuento        numeric(5, 2) check (descuento is null or (descuento > 0 and descuento < 100)),
                   -- % de las promos (sin creador); los de creador dan siempre el 1,5 % (PORCENTAJE_CREADOR)
  pin_hash         text,                              -- PIN del panel del creador, cifrado (bcrypt)
  activo           boolean not null default true,
  usos             integer not null default 0 check (usos >= 0),
  ventas_bs        numeric(16, 2) not null default 0 check (ventas_bs >= 0),
  comision_usd     numeric(12, 4) not null default 0 check (comision_usd >= 0),
  pendiente_usd    numeric(12, 4) not null default 0 check (pendiente_usd >= 0),
  por_convertir_bs numeric(14, 2) not null default 0 check (por_convertir_bs >= 0), -- comisión sin tasa del día
  creado           timestamptz not null default now(),
  actualizado      timestamptz not null default now(),
  -- Un código activo tiene que dar algo: o es de un creador o tiene su % de promo
  constraint codigos_activo_valido check (not activo or creador is not null or descuento is not null)
);

-- Nadie desde el navegador: solo Vercel (llave secreta) y las funciones admin_* de abajo.
-- Así el PIN cifrado y los teléfonos de los creadores nunca salen.
alter table public.codigos enable row level security;
revoke all on public.codigos from anon, authenticated;

-- Usos, dinero movido y comisión total nunca bajan (un error de código no puede borrarle ventas a un creador)
create or replace function public.codigos_solo_suben()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.usos < old.usos or new.ventas_bs < old.ventas_bs or new.comision_usd < old.comision_usd then
    raise exception 'usos, ventas_bs y comision_usd de un código solo pueden subir (%)', old.codigo
      using errcode = '23514';
  end if;
  new.actualizado := now();
  return new;
end;
$$;
drop trigger if exists codigos_solo_suben on public.codigos;
create trigger codigos_solo_suben before update on public.codigos
  for each row execute function public.codigos_solo_suben();

-- ---------------------------------------------------------------------
-- Cada venta con código, en el pedido (el nombre "codigo" ya lo usa el código de Roblox)
-- ---------------------------------------------------------------------
alter table public.recargas add column if not exists codigo_descuento text
  check (codigo_descuento is null or codigo_descuento ~ '^[A-Z0-9_-]{2,30}$');
create index if not exists recargas_codigo_descuento on public.recargas (codigo_descuento, creado desc)
  where codigo_descuento is not null;

-- =====================================================================
-- PASOS 4 A 7 (desde 2026-11-13, el mismo día): SUPABASE MANDA EN LOS CÓDIGOS
-- Los códigos se crean, editan, pagan y borran SOLO desde admin.html (pestaña "Creadores").
--   · La tienda valida los códigos aquí (api/_lib/descuentos.js; si Supabase no responde, usa la hoja).
--   · Cada venta con código se cuenta SOLA al guardarse el pedido (disparador de abajo), una sola vez.
--   · El panel de cada creador (creadores.html → api/creadores.js) lee de aquí con creador_panel().
-- La pestaña "Descuentos" de la hoja queda como respaldo: Apps Script sigue anotando ahí los códigos
-- viejos, pero ya no se usa para nada (no crees códigos ahí: no funcionarían).
-- =====================================================================

-- Comisión de cada venta guardada en el pedido (para "Últimos movimientos" del creador) y marca de
-- "ya contada": así una venta nunca suma dos veces aunque el pedido se guarde o cambie de estado varias veces.
alter table public.recargas add column if not exists codigo_contado boolean not null default false;
alter table public.recargas add column if not exists comision_usd numeric(12, 4);

-- Pagos a creadores (lo que hace "Ya le pagué" en el panel)
create table if not exists public.codigos_pagos (
  id          bigint generated always as identity primary key,
  codigo      text not null references public.codigos (codigo) on update cascade,
  creador     text,
  monto_usd   numeric(12, 4) not null check (monto_usd > 0),
  fecha       timestamptz not null default now()
);
alter table public.codigos_pagos enable row level security;
revoke all on public.codigos_pagos from anon, authenticated;

-- % que da un código de creador al cliente y que gana el creador (igual que PORCENTAJE_CREADOR de
-- apps-script/recargas.gs y api/_lib/descuentos.js)
create or replace function public.codigos_porcentaje_creador()
returns numeric language sql immutable as $$ select 1.5::numeric $$;

-- Tasa Bs por dólar para la comisión (la pone el administrador en el panel). null = sin tasa todavía.
create or replace function public.codigos_tasa()
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select case when jsonb_typeof(valor) = 'number' and (valor #>> '{}')::numeric > 0 then (valor #>> '{}')::numeric end
    from configuracion where clave = 'tasa_usd';
$$;
revoke execute on function public.codigos_tasa() from public, anon, authenticated;

-- Quien llama tiene que ser administrador (o el servidor)
create or replace function public.admin_revisar()
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if not ((select auth.role()) is null or (select auth.role()) = 'service_role' or (select es_admin())) then
    raise exception 'solo administradores' using errcode = '42501';
  end if;
end;
$$;
revoke execute on function public.admin_revisar() from public, anon;
grant execute on function public.admin_revisar() to authenticated, service_role;

-- Cuenta la venta en su código cuando el pedido queda entregado ("completado") o recibido en las
-- tiendas manuales ("pendiente"). Nunca frena el pedido: si algo falla, solo deja un aviso en el registro.
create or replace function public.codigos_contar_venta()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_creador text;
  v_tasa numeric;
  v_bs numeric;
  v_usd numeric;
begin
  if new.codigo_descuento is null or new.codigo_contado or new.estado not in ('completado', 'pendiente') then
    return null;
  end if;
  begin
    -- Marca primero (con la fila bloqueada): si dos avisos llegan juntos, solo uno la cambia y cuenta
    update recargas set codigo_contado = true where id_pedido = new.id_pedido and not codigo_contado;
    if not found then return null; end if;

    select creador into v_creador from codigos where codigo = new.codigo_descuento;
    if not found then return null; end if;                          -- código borrado: no hay a quién sumar
    v_tasa := codigos_tasa();
    if v_creador is not null and coalesce(new.precio, 0) > 0 then
      v_bs := round(new.precio * codigos_porcentaje_creador() / 100, 2);  -- comisión en Bs
      v_usd := case when v_tasa is not null then round(v_bs / v_tasa, 4) end;
    end if;

    update codigos set
      usos = usos + 1,
      ventas_bs = ventas_bs + coalesce(new.precio, 0),
      comision_usd = comision_usd + coalesce(v_usd, 0),
      pendiente_usd = pendiente_usd + coalesce(v_usd, 0),
      por_convertir_bs = por_convertir_bs + case when v_usd is null then coalesce(v_bs, 0) else 0 end
    where codigo = new.codigo_descuento;
    if v_usd is not null then
      update recargas set comision_usd = v_usd where id_pedido = new.id_pedido;
    end if;
  exception when others then
    raise warning 'codigos_contar_venta (%): %', new.id_pedido, sqlerrm;
  end;
  return null;
end;
$$;
revoke execute on function public.codigos_contar_venta() from public, anon, authenticated;
drop trigger if exists codigos_contar_venta on public.recargas;
create trigger codigos_contar_venta after insert or update of estado, codigo_descuento on public.recargas
  for each row when (new.codigo_descuento is not null and not new.codigo_contado)
  execute function public.codigos_contar_venta();

-- ---------------------------------------------------------------------
-- Panel del creador (api/creadores.js, solo con la llave secreta): código + PIN → sus números
-- ---------------------------------------------------------------------
create or replace function public.creador_panel(p_codigo text, p_pin text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  k codigos%rowtype;
  v_tasa numeric := codigos_tasa();
  v_extra numeric;
begin
  select * into k from codigos where codigo = upper(trim(coalesce(p_codigo, '')));
  if not found or k.creador is null then return jsonb_build_object('encontrado', false); end if;
  if k.pin_hash is null then return jsonb_build_object('encontrado', false, 'sinPin', true); end if;
  if crypt(coalesce(p_pin, ''), k.pin_hash) <> k.pin_hash then return jsonb_build_object('encontrado', false); end if;
  v_extra := case when v_tasa is not null then k.por_convertir_bs / v_tasa else 0 end;
  return jsonb_build_object(
    'encontrado', true,
    'codigo', k.codigo,
    'porcentaje', codigos_porcentaje_creador(),
    'usos', k.usos,
    'ventasBs', k.ventas_bs,
    'comisionTotalUsd', round(k.comision_usd + v_extra, 2),
    'pendienteUsd', round(k.pendiente_usd + v_extra, 2),
    'tasa', v_tasa,
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
revoke execute on function public.creador_panel(text, text) from public, anon, authenticated;
grant execute on function public.creador_panel(text, text) to service_role;

-- ---------------------------------------------------------------------
-- Panel admin, pestaña "Creadores": ver, crear, editar, pagar y borrar códigos; la tasa del dólar
-- ---------------------------------------------------------------------
create or replace function public.admin_codigos()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform admin_revisar();
  return jsonb_build_object(
    'tasa', codigos_tasa(),
    'total', (select count(*) from codigos),
    'activos', (select count(*) from codigos where activo),
    'usos', (select coalesce(sum(usos), 0) from codigos),
    'ventas_bs', (select coalesce(sum(ventas_bs), 0) from codigos),
    'comision_usd', (select coalesce(sum(comision_usd), 0) from codigos),
    'pendiente_usd', (select coalesce(sum(pendiente_usd), 0) from codigos),
    'por_convertir_bs', (select coalesce(sum(por_convertir_bs), 0) from codigos),
    'pagado_usd', (select coalesce(sum(monto_usd), 0) from codigos_pagos),
    'codigos', (
      select coalesce(jsonb_agg(c order by c.activo desc, c.pendiente_usd desc, c.usos desc, c.codigo), '[]'::jsonb) from (
        select k.codigo, k.creador, k.descuento, k.activo, (k.pin_hash is not null) as tiene_pin,
               k.usos, k.ventas_bs, round(k.comision_usd, 2) as comision_usd, round(k.pendiente_usd, 2) as pendiente_usd,
               k.por_convertir_bs, k.creado,
               (select round(coalesce(sum(p.monto_usd), 0), 2) from codigos_pagos p where p.codigo = k.codigo) as pagado_usd,
               (select max(p.fecha) from codigos_pagos p where p.codigo = k.codigo) as ultimo_pago
          from codigos k
      ) c
    )
  );
end;
$$;
revoke execute on function public.admin_codigos() from public, anon;
grant execute on function public.admin_codigos() to authenticated, service_role;

-- Crea un código (p_nuevo) o cambia uno que ya existe. p_pin vacío = deja el PIN como está.
-- p_descuento solo para promos (sin creador). Devuelve el código guardado.
create or replace function public.admin_codigo_guardar(p_codigo text, p_creador text, p_pin text default null,
  p_descuento numeric default null, p_activo boolean default true, p_nuevo boolean default false)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_codigo text := upper(trim(coalesce(p_codigo, '')));
  v_creador text := nullif(trim(coalesce(p_creador, '')), '');
  v_pin text := nullif(trim(coalesce(p_pin, '')), '');
begin
  perform admin_revisar();
  if v_codigo !~ '^[A-Z0-9_-]{2,30}$' then
    raise exception 'El código solo puede tener letras, números, - y _ (de 2 a 30).' using errcode = '22023';
  end if;
  if v_creador is not null and length(v_creador) > 60 then
    raise exception 'El nombre del creador es muy largo (máximo 60).' using errcode = '22023';
  end if;
  if v_pin is not null and v_pin !~ '^\d{4,8}$' then
    raise exception 'El PIN debe tener de 4 a 8 números.' using errcode = '22023';
  end if;
  if v_creador is null and (p_descuento is null or p_descuento <= 0 or p_descuento >= 100) then
    raise exception 'Una promo sin creador necesita su porcentaje de descuento (mayor que 0 y menor que 100).' using errcode = '22023';
  end if;
  if p_nuevo then
    if exists (select 1 from codigos where codigo = v_codigo) then
      raise exception 'Ya existe el código %.', v_codigo using errcode = '23505';
    end if;
    insert into codigos (codigo, creador, descuento, pin_hash, activo)
    values (v_codigo, v_creador, case when v_creador is null then p_descuento end,
            case when v_pin is not null then crypt(v_pin, gen_salt('bf')) end, coalesce(p_activo, true));
  else
    update codigos set creador = v_creador,
           descuento = case when v_creador is null then p_descuento end,
           pin_hash = case when v_pin is not null then crypt(v_pin, gen_salt('bf')) else pin_hash end,
           activo = coalesce(p_activo, activo)
     where codigo = v_codigo;
    if not found then raise exception 'No existe el código %.', v_codigo using errcode = 'P0002'; end if;
  end if;
  return v_codigo;
end;
$$;
revoke execute on function public.admin_codigo_guardar(text, text, text, numeric, boolean, boolean) from public, anon;
grant execute on function public.admin_codigo_guardar(text, text, text, numeric, boolean, boolean) to authenticated, service_role;

-- Comisiones guardadas en Bs (ventas sin tasa) → dólares con la tasa actual
create or replace function public.admin_convertir_pendientes()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_tasa numeric := codigos_tasa();
begin
  perform admin_revisar();
  if v_tasa is null then return; end if;
  update codigos set comision_usd = comision_usd + round(por_convertir_bs / v_tasa, 4),
                     pendiente_usd = pendiente_usd + round(por_convertir_bs / v_tasa, 4),
                     por_convertir_bs = 0
   where por_convertir_bs > 0;
end;
$$;
revoke execute on function public.admin_convertir_pendientes() from public, anon;
grant execute on function public.admin_convertir_pendientes() to authenticated, service_role;

-- "Ya le pagué": guarda el pago y deja lo pendiente en 0. Devuelve lo pagado (USD).
create or replace function public.admin_codigo_pagar(p_codigo text)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  k codigos%rowtype;
begin
  perform admin_revisar();
  perform admin_convertir_pendientes();
  select * into k from codigos where codigo = upper(trim(coalesce(p_codigo, ''))) for update;
  if not found then raise exception 'No existe ese código.' using errcode = 'P0002'; end if;
  if k.pendiente_usd <= 0 then return 0; end if;
  insert into codigos_pagos (codigo, creador, monto_usd) values (k.codigo, k.creador, k.pendiente_usd);
  update codigos set pendiente_usd = 0 where codigo = k.codigo;
  return round(k.pendiente_usd, 2);
end;
$$;
revoke execute on function public.admin_codigo_pagar(text) from public, anon;
grant execute on function public.admin_codigo_pagar(text) to authenticated, service_role;

-- Borrar: solo códigos sin ventas (los que tienen ventas se desactivan, para no perder lo que ganó el creador)
create or replace function public.admin_codigo_borrar(p_codigo text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_codigo text := upper(trim(coalesce(p_codigo, '')));
begin
  perform admin_revisar();
  if exists (select 1 from codigos where codigo = v_codigo and (usos > 0 or comision_usd > 0 or pendiente_usd > 0))
     or exists (select 1 from codigos_pagos where codigo = v_codigo)
     or exists (select 1 from recargas where codigo_descuento = v_codigo) then
    raise exception 'Este código ya tiene ventas: desactívalo en vez de borrarlo.' using errcode = '23503';
  end if;
  delete from codigos where codigo = v_codigo;
  return found;
end;
$$;
revoke execute on function public.admin_codigo_borrar(text) from public, anon;
grant execute on function public.admin_codigo_borrar(text) to authenticated, service_role;

-- Tasa Bs por dólar (la misma de la celda B1 de "config" en la hoja). Al guardarla, lo que estaba en Bs pasa a dólares.
create or replace function public.admin_tasa_guardar(p_tasa numeric)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
begin
  perform admin_revisar();
  if p_tasa is null or p_tasa <= 0 or p_tasa > 1000000 then
    raise exception 'Escribe una tasa válida (Bs por dólar).' using errcode = '22023';
  end if;
  insert into configuracion (clave, valor, publico, actualizado) values ('tasa_usd', to_jsonb(round(p_tasa, 4)), false, now())
  on conflict (clave) do update set valor = excluded.valor, actualizado = now();
  perform admin_convertir_pendientes();
  return round(p_tasa, 4);
end;
$$;
revoke execute on function public.admin_tasa_guardar(numeric) from public, anon;
grant execute on function public.admin_tasa_guardar(numeric) to authenticated, service_role;
