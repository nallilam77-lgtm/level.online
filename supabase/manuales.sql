-- =====================================================================
-- LEVEL UP · TIENDAS MANUALES EN SUPABASE (FC Mobile, COD Mobile, Clash Royale) (desde 2026-11-16)
--
-- Cómo instalarlo: Supabase → SQL Editor → New query → pega TODO este archivo → Run (después de
-- supabase/precios.sql y supabase/pagos.sql). Se puede volver a correr.
--
-- Antes vivía todo en la hoja de manuales.gs (SCRIPT_MANUALES): precios, pedidos y la contraseña del cliente
-- en texto plano. Ahora:
--   - Precios: tabla "precios" (juego fcmobile / codmobile / clashroyale), precio a mano en Bs
--     (admin.html → Precios → elige el juego → "Paquete sin Central One").
--   - Pedidos: tabla "pedidos_manuales" (admin.html → Manuales). La contraseña va CIFRADA (AES-256-GCM, la
--     llave solo está en Vercel: CLAVE_MANUALES) y se borra sola al marcar el pedido "completado".
--   - El cliente ve el estado en la tienda y en su perfil (tabla "recargas", misma id_pedido).
-- =====================================================================

-- Los tres juegos pueden tener paquetes en "precios"
alter table public.precios drop constraint if exists precios_juego_check;
alter table public.precios add constraint precios_juego_check
  check (juego in ('freefire', 'bloodstrike', 'mobilelegends', 'roblox', 'fcmobile', 'codmobile', 'clashroyale'));

-- Igual que en supabase/precios.sql, con los tres juegos manuales en la lista
create or replace function public.admin_precio_guardar(p_id bigint, p_juego text, p_paquete text, p_producto text,
  p_cantidad integer default 1, p_precio_manual numeric default null, p_activo boolean default true, p_orden integer default null)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_paquete text := trim(coalesce(p_paquete, ''));
  v_producto text := nullif(lower(trim(coalesce(p_producto, ''))), '');
  v_id bigint;
begin
  perform admin_revisar();
  if p_juego not in ('freefire', 'bloodstrike', 'mobilelegends', 'roblox', 'fcmobile', 'codmobile', 'clashroyale') then
    raise exception 'Juego no válido.' using errcode = '22023';
  end if;
  if p_juego in ('fcmobile', 'codmobile', 'clashroyale') and v_producto is not null then
    raise exception 'Las tiendas manuales no usan productos de Central One: pon el precio a mano.' using errcode = '22023';
  end if;
  if length(v_paquete) < 1 or length(v_paquete) > 80 then
    raise exception 'Escribe el nombre del paquete (máximo 80 letras).' using errcode = '22023';
  end if;
  if v_producto is not null and v_producto !~ '^[0-9a-f-]{36}$' then
    raise exception 'El producto de Central One no es válido.' using errcode = '22023';
  end if;
  if coalesce(p_cantidad, 1) < 1 or coalesce(p_cantidad, 1) > 10 then
    raise exception 'La cantidad va de 1 a 10.' using errcode = '22023';
  end if;
  if p_precio_manual is not null and p_precio_manual <= 0 then
    raise exception 'El precio tiene que ser mayor que 0 (o déjalo vacío para calcularlo solo).' using errcode = '22023';
  end if;
  if v_producto is null and p_precio_manual is null then
    raise exception 'Un paquete sin producto de Central One necesita precio a mano.' using errcode = '22023';
  end if;
  if exists (select 1 from precios where juego = p_juego and paquete = v_paquete and id is distinct from p_id) then
    raise exception 'Ya hay un paquete llamado "%" en este juego.', v_paquete using errcode = '23505';
  end if;
  if p_id is null then
    insert into precios (juego, paquete, producto, cantidad, precio_manual, activo, orden)
    values (p_juego, v_paquete, v_producto, coalesce(p_cantidad, 1), round(p_precio_manual, 2), coalesce(p_activo, true),
            coalesce(p_orden, (select coalesce(max(orden), 0) + 1 from precios where juego = p_juego)))
    returning id into v_id;
  else
    update precios set paquete = v_paquete, producto = v_producto, cantidad = coalesce(p_cantidad, 1),
           precio_manual = round(p_precio_manual, 2), activo = coalesce(p_activo, activo),
           orden = coalesce(p_orden, orden), actualizado = now()
     where id = p_id and juego = p_juego
    returning id into v_id;
    if v_id is null then raise exception 'No existe ese paquete.' using errcode = 'P0002'; end if;
  end if;
  return v_id;
end;
$$;
revoke execute on function public.admin_precio_guardar(bigint, text, text, text, integer, numeric, boolean, integer) from public, anon;
grant execute on function public.admin_precio_guardar(bigint, text, text, text, integer, numeric, boolean, integer) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- Pedidos de las tiendas manuales
-- ---------------------------------------------------------------------
create table if not exists public.pedidos_manuales (
  id_pedido        text primary key check (id_pedido ~ '^man-[0-9a-f-]{36}$'),
  juego            text not null check (juego in ('fcmobile', 'codmobile', 'clashroyale')),
  paquete          text not null check (length(paquete) between 1 and 80),
  precio           numeric(12, 2) not null check (precio > 0),          -- lo que se cobró (con descuento si hubo)
  pagado           numeric(12, 2) not null check (pagado >= 0),
  referencia       text not null,                                       -- la referencia completa del pago
  metodo           text not null,                                       -- "Cuenta EA", "Facebook"…
  usuario          text not null check (length(usuario) between 1 and 100),  -- correo o teléfono de la cuenta
  clave_cifrada    text check (clave_cifrada is null or length(clave_cifrada) <= 400),  -- null: sin clave o ya borrada
  telefono         text,                                                -- WhatsApp del cliente ("+58…")
  estado           text not null default 'pendiente'
                   check (estado in ('pendiente', 'en_proceso', 'completado', 'incompleto', 'problema', 'reembolsado')),
  nota             text check (nota is null or length(nota) <= 500),
  comprobante      text check (comprobante is null or length(comprobante) <= 500),
  codigo_descuento text,
  creado           timestamptz not null default now(),
  actualizado      timestamptz not null default now()
);
create index if not exists pedidos_manuales_estado on public.pedidos_manuales (estado, creado desc);
alter table public.pedidos_manuales enable row level security;
revoke all on public.pedidos_manuales from anon, authenticated;

-- El administrador los ve en el panel, SIN la columna de la contraseña (se pide a Vercel, que la descifra)
drop policy if exists "los administradores leen los pedidos manuales" on public.pedidos_manuales;
create policy "los administradores leen los pedidos manuales" on public.pedidos_manuales
  for select to authenticated using ((select public.es_admin()));
grant select (id_pedido, juego, paquete, precio, pagado, referencia, metodo, usuario, telefono, estado, nota,
              comprobante, codigo_descuento, creado, actualizado) on public.pedidos_manuales to authenticated;

-- ¿Tiene contraseña guardada? (el panel no puede leer la columna)
create or replace function public.admin_manuales_con_clave()
returns text[]
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform admin_revisar();
  return coalesce((select array_agg(id_pedido) from pedidos_manuales where clave_cifrada is not null), '{}');
end;
$$;
revoke execute on function public.admin_manuales_con_clave() from public, anon;
grant execute on function public.admin_manuales_con_clave() to authenticated, service_role;

-- Panel → Manuales: cambiar el estado (y la nota). "completado" borra la contraseña. El cliente lo ve en su
-- perfil y en la tienda (la fila de "recargas" con la misma id_pedido cambia igual).
create or replace function public.admin_manual_estado(p_id_pedido text, p_estado text, p_nota text default null)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  perform admin_revisar();
  if p_estado not in ('pendiente', 'en_proceso', 'completado', 'incompleto', 'problema', 'reembolsado') then
    raise exception 'Estado no válido.' using errcode = '22023';
  end if;
  update pedidos_manuales
     set estado = p_estado,
         nota = case when p_nota is null then nota else nullif(left(trim(p_nota), 500), '') end,
         clave_cifrada = case when p_estado = 'completado' then null else clave_cifrada end,
         actualizado = now()
   where id_pedido = p_id_pedido;
  if not found then return false; end if;
  update recargas set estado = p_estado, actualizado = now() where id_pedido = p_id_pedido and estado <> p_estado;
  return true;
end;
$$;
revoke execute on function public.admin_manual_estado(text, text, text) from public, anon;
grant execute on function public.admin_manual_estado(text, text, text) to authenticated, service_role;

-- Limpieza (la llama pagos_limpiar o cualquiera con la llave secreta): contraseñas de más de 7 días se borran
-- aunque el pedido no se haya marcado completado
create or replace function public.manuales_borrar_claves_viejas()
returns integer
language sql
security definer
set search_path = public
as $$
  with x as (
    update pedidos_manuales set clave_cifrada = null, actualizado = now()
     where clave_cifrada is not null and creado < now() - interval '7 days'
    returning 1
  ) select count(*)::integer from x;
$$;
revoke execute on function public.manuales_borrar_claves_viejas() from public, anon, authenticated;
grant execute on function public.manuales_borrar_claves_viejas() to service_role;
