-- 2026-11-15: completar un pago acepta hasta 1 Bs de menos (antes 0,50). Copia de la función de supabase/pagos.sql.
-- Correr una vez en Supabase → SQL Editor. Se puede repetir sin problema.

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

  if v_pagado < f.precio - 1.00 then   -- hasta 1 Bs de menos se acepta (desde 2026-11-15; antes 0,50)
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
