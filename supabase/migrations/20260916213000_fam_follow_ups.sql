-- Applied directly to apex-one (nducwhlmudksgxggjrbo) on 2026-09-16, committed here in the
-- same PR as the app changes that use it — no drift.
--
-- Closes review gap: "the action queue is still mostly a view — no durable
-- follow-up/task model". The underlying risk detection (expired / due soon /
-- missing doc) stays derived from real dates, as it should — this table adds a
-- durable layer on top so a queue item can be claimed, worked, noted, and
-- dismissed, and that state survives across sessions/reloads instead of being
-- recomputed away.
--
-- One row per distinct queue item (assessor + what triggered it + which record),
-- upserted lazily from the app the first time someone acts on it — not
-- auto-created for every computed risk item on every page load.

create table if not exists public.fam_follow_ups (
  id           bigint generated always as identity primary key,
  tenant_id    text not null references public.tenants(id),
  assessor_id  bigint not null references public.assessors(id) on delete cascade,
  source_type  text not null check (source_type in ('registration','document')),
  source_id    bigint not null,
  kind         text not null check (kind in ('expired','due_soon','pending','inactive','missing_doc')),
  status       text not null default 'Open' check (status in ('Open','In Progress','Done','Dismissed')),
  assigned_to  text,
  due_date     date,
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   text default auth_user_email(),
  resolved_at  timestamptz,
  resolved_by  text,
  unique (tenant_id, assessor_id, source_type, source_id)
);

alter table public.fam_follow_ups enable row level security;

create policy tenant_all on public.fam_follow_ups for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create trigger set_updated_at_fam_follow_ups before update on public.fam_follow_ups
  for each row execute function update_updated_at();

create trigger trg_audit_log after insert or update or delete on public.fam_follow_ups
  for each row execute function log_audit_event();
