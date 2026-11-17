-- =====================================================================
-- LEVEL UP · PAGOS VERIFICADOS A MANO (desde 2026-11-16)
--
-- Cómo instalarlo: Supabase → SQL Editor → New query → pega TODO este archivo → Run. Se puede volver a correr.
--
-- Cuando una notificación del banco no llega (MacroDroid no la ve) y el interruptor del panel
-- (admin.html → Ajustes → "Verificar a mano los pagos que no lleguen", configuracion "pagos_manual") está
-- encendido, una referencia que no existe en "pagos" no se rechaza: queda aquí como SOLICITUD, el pedido se
-- guarda en "recargas" como "pendiente" (Recibido) y el cliente ve "Estamos verificando tu pago" y dónde mirar
-- el estado (public/js/pago-manual.js). El administrador la aprueba en admin.html → Pagos con la referencia
-- completa del banco (se guarda en "pagos" como un pago más y Vercel repite la recarga sola, con el mismo
-- pedido) o la rechaza (el pedido queda "problema"). Lo escribe solo Vercel (api/_lib/pagos-manual.js, con la
-- llave secreta); el panel solo lee.
-- =====================================================================

create table if not exists public.pagos_solicitudes (
  id          uuid primary key default gen_random_uuid(),
  ultimos5    text not null check (ultimos5 ~ '^\d{5}$'),
  juego       text not null,
  monto       numeric(14, 2),                 -- lo que cuesta el paquete (lo que el cliente debió pagar)
  id_jugador  text,
  paquete     text,
  telefono    text,                           -- WhatsApp que dejó el cliente (opcional)
  estado      text not null default 'pendiente' check (estado in ('pendiente', 'aprobado', 'rechazado')),
  referencia  text,                           -- la referencia completa con la que se aprobó (va a "pagos")
  nota        text,
  creado      timestamptz not null default now(),
  resuelto    timestamptz,
  id_pedido   text,                           -- el pedido "pendiente" en recargas (la recarga se repite con este id)
  usuario     uuid,                           -- la cuenta de Level Up del cliente (si tenía sesión)
  ip          text,                           -- para los límites de intentos al repetir la recarga
  datos       text,                           -- la petición de la tienda CIFRADA (api/_lib/cifrado.js); se borra al repetir
  recargada   timestamptz                     -- cuándo Vercel repitió la recarga (una sola vez)
);
-- Si la tabla ya existía de una versión anterior de este archivo
alter table public.pagos_solicitudes add column if not exists id_pedido text;
alter table public.pagos_solicitudes add column if not exists usuario uuid;
alter table public.pagos_solicitudes add column if not exists ip text;
alter table public.pagos_solicitudes add column if not exists datos text;
alter table public.pagos_solicitudes add column if not exists recargada timestamptz;
create index if not exists pagos_solicitudes_estado on public.pagos_solicitudes (estado, creado desc);
-- UNA sola solicitud pendiente por referencia (últimos 5), sin importar juego, ID ni teléfono: el segundo
-- pedido con esa referencia recibe "referencia repetida" (pagos-manual.js → crearSolicitud). (2026-11-17;
-- antes era una por referencia + juego + ID y un mismo pago se mandaba para dos IDs distintos.)
-- Si falla con "could not create unique index", primero resuelve en el panel las pendientes repetidas.
drop index if exists public.pagos_solicitudes_una_pendiente;
drop index if exists public.pagos_solicitudes_una_pendiente_por_cliente;
create unique index if not exists pagos_solicitudes_una_pendiente_por_referencia
  on public.pagos_solicitudes (ultimos5) where estado = 'pendiente';

alter table public.pagos_solicitudes enable row level security;
revoke all on public.pagos_solicitudes from anon, authenticated;

-- El administrador las ve en el panel (solo lectura; aprobar y rechazar pasan por Vercel)
drop policy if exists "los administradores leen las solicitudes" on public.pagos_solicitudes;
create policy "los administradores leen las solicitudes" on public.pagos_solicitudes
  for select to authenticated using ((select public.es_admin()));
-- El panel nunca lee "datos" (la petición cifrada): solo estas columnas
grant select (id, ultimos5, juego, monto, id_jugador, paquete, telefono, estado, referencia, nota, creado, resuelto, id_pedido, recargada)
  on public.pagos_solicitudes to authenticated;

-- (Sin Realtime: el panel revisa la lista cada 10 s.)
