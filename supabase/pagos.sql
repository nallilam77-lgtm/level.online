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
