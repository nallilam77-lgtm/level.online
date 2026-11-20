-- =========================================================================
-- PAUSAR UN PAQUETE (desde 2026-11-20): se sigue viendo en la tienda pero como "Agotado" y no se puede comprar,
-- aunque Central One tenga stock. Panel → Precios → "⏸️ Pausar (Agotado)" / "▶️ Volver a vender".
-- Solo la página de Free Fire sabe mostrar "Agotado": en los demás juegos un paquete pausado no sale (_lib/precios.js).
-- Correr DESPUÉS de secciones.sql (vuelve a crear precios_de y precios_apartar con "pausado").
-- =========================================================================
alter table public.precios add column if not exists pausado boolean not null default false;

drop function if exists public.precios_de(text);
create function public.precios_de(p_juego text)
returns table (id bigint, paquete text, producto text, cantidad smallint, precio_manual numeric, costo_usd numeric,
               precio_calculado numeric, precio numeric, en_stock boolean, stock integer, visto timestamptz,
               orden smallint, activo boolean, fichas_manual integer, fichas integer, precio_cobro numeric,
               seccion text, ganancia numeric, apartados integer, pausado boolean)
language sql
stable
security definer
set search_path = public
as $$
  with conf as (select codigos_tasa() as tasa, precios_ganancia() as ganancia,
                       (select bs_por_ficha from juego_ajustes where id = 1) as bs_ficha),
  base as (
    select p.id, p.paquete, p.producto, p.cantidad, p.precio_manual, p.orden, p.activo, p.fichas, p.pausado,
           coalesce(p.seccion, precios_seccion_auto(p.juego, p.paquete)) as seccion,
           coalesce(s.ganancia, conf.ganancia) as ganancia,
           c.costo_usd, c.costo_anterior, c.costo_cambio, c.en_stock as c_stock, c.stock as c_cantidad, c.visto as c_visto,
           conf.tasa, conf.bs_ficha,
           (select count(*)::integer from precios_reservas r where r.precio_id = p.id and not r.usada and r.hasta > now()) as apartados
      from precios p cross join conf
      left join centralone_catalogo c on c.producto = p.producto
      left join precios_secciones s on s.juego = p.juego and s.clave = coalesce(p.seccion, precios_seccion_auto(p.juego, p.paquete))
     where p.juego = p_juego
  ),
  calc as (
    select b.*,
           case when b.costo_usd is not null and b.tasa is not null and b.ganancia is not null
                then round(b.costo_usd * b.cantidad * b.tasa * (1 + b.ganancia / 100), 2) end as calculado,
           -- Lo que se cobra: el menor entre el costo de ahora y el de hace menos de 30 min (least ignora null)
           case when b.costo_usd is not null and b.tasa is not null and b.ganancia is not null
                then round(least(b.costo_usd, case when b.costo_cambio > now() - interval '30 minutes' then b.costo_anterior end)
                           * b.cantidad * b.tasa * (1 + b.ganancia / 100), 2) end as calculado_cobro
      from base b
  )
  select b.id, b.paquete, b.producto, b.cantidad, b.precio_manual, b.costo_usd, b.calculado,
         coalesce(b.precio_manual, b.calculado),
         case when b.producto is null then true else coalesce(b.c_stock, false) end,
         b.c_cantidad, b.c_visto, b.orden, b.activo, b.fichas,
         coalesce(b.fichas, case when coalesce(b.precio_manual, b.calculado) > 0 and b.bs_ficha > 0
                                 then greatest(1, floor(coalesce(b.precio_manual, b.calculado) / b.bs_ficha))::integer end),
         coalesce(b.precio_manual, b.calculado_cobro),
         b.seccion, b.ganancia, b.apartados, b.pausado
    from calc b
   order by b.orden, b.id;
$$;
revoke execute on function public.precios_de(text) from public, anon, authenticated;
grant execute on function public.precios_de(text) to service_role;

create or replace function public.precios_apartar(p_juego text, p_paquete text, p_clave text, p_ip text,
  p_minutos integer default 10, p_margen integer default 2)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id bigint; v_stock integer; v_en_stock boolean; v_pausado boolean; v_otros integer; v_hasta timestamptz;
begin
  if coalesce(p_clave, '') !~ '^[A-Za-z0-9_-]{16,64}$' then raise exception 'clave no válida' using errcode = '22023'; end if;
  select p.id, c.stock, coalesce(c.en_stock, false), p.pausado into v_id, v_stock, v_en_stock, v_pausado
    from precios p left join centralone_catalogo c on c.producto = p.producto
   where p.juego = p_juego and p.paquete = p_paquete and p.activo;
  if v_id is null then return jsonb_build_object('ok', false, 'motivo', 'no_existe'); end if;
  -- Pausado en el panel: la tienda lo muestra "Agotado" aunque Central One tenga
  if v_pausado then return jsonb_build_object('ok', false, 'motivo', 'agotado', 'quedan', 0); end if;
  if v_stock is null then return jsonb_build_object('ok', true, 'limitado', false); end if;
  perform pg_advisory_xact_lock(v_id);
  -- Ya lo tiene apartado esta pestaña: el mismo apartado (no se alarga solo)
  select hasta into v_hasta from precios_reservas where precio_id = v_id and clave = p_clave and not usada and hasta > now();
  if v_hasta is not null then
    select count(*) into v_otros from precios_reservas where precio_id = v_id and not usada and hasta > now() and clave <> p_clave;
    return jsonb_build_object('ok', true, 'limitado', true, 'hasta', v_hasta, 'quedan', greatest(0, v_stock - p_margen - v_otros - 1));
  end if;
  if p_ip is not null and (select count(*) from precios_reservas where ip = p_ip and not usada and hasta > now()) >= 2 then
    return jsonb_build_object('ok', false, 'motivo', 'muchos');
  end if;
  select count(*) into v_otros from precios_reservas where precio_id = v_id and not usada and hasta > now() and clave <> p_clave;
  if not v_en_stock or v_stock - p_margen - v_otros <= 0 then
    return jsonb_build_object('ok', false, 'motivo', 'agotado', 'quedan', 0);
  end if;
  v_hasta := now() + make_interval(mins => least(greatest(coalesce(p_minutos, 10), 1), 30));
  insert into precios_reservas (precio_id, clave, ip, hasta) values (v_id, p_clave, p_ip, v_hasta)
  on conflict (precio_id, clave) do update set hasta = excluded.hasta, usada = false, ip = excluded.ip, creada = now();
  delete from precios_reservas where hasta < now() - interval '1 day';
  return jsonb_build_object('ok', true, 'limitado', true, 'hasta', v_hasta, 'quedan', greatest(0, v_stock - p_margen - v_otros - 1));
end;
$$;

create or replace function public.admin_precio_pausar(p_id bigint, p_pausado boolean)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not (select es_admin()) then raise exception 'solo administradores' using errcode = '42501'; end if;
  update precios set pausado = coalesce(p_pausado, false), actualizado = now() where id = p_id;
  return found;
end;
$$;
revoke execute on function public.admin_precio_pausar(bigint, boolean) from public, anon;
grant execute on function public.admin_precio_pausar(bigint, boolean) to authenticated;
