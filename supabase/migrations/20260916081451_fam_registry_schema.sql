-- FAM Registry: additive schema. Does not modify existing assessors/assessor_scope tables
-- or their triggers/ClickUp sync wiring. assessors remains the canonical practitioner record;
-- these tables layer multi-SETA / multi-role registrations, scope, documents and contract
-- status on top, keyed by assessor_id.
--
-- Applied directly to apex-one (nducwhlmudksgxggjrbo) on 2026-09-16. Committed here after
-- the fact so the live schema and this repo's tracked migrations stay in sync, matching the
-- convention started by 20260821000000_clickup_sync_failures.sql.

-- Optional practitioner-level fields used by the FAM full-profile view. Nullable/additive,
-- no impact on existing Assessors tab or ClickUp sync.
alter table public.assessors
  add column if not exists id_number text,
  add column if not exists physical_address text,
  add column if not exists gender text,
  add column if not exists population_group text,
  add column if not exists disability_status text;

-- One row per (person, SETA, role). Replaces the single seta_registration_number /
-- accreditation_body / registration_expiry_date columns on assessors for anyone entered
-- through FAM Registry; those columns stay untouched for backward compatibility.
create table if not exists public.fam_seta_registrations (
  id                 bigint generated always as identity primary key,
  tenant_id          text not null references public.tenants(id),
  assessor_id        bigint not null references public.assessors(id) on delete cascade,
  seta_name          text not null,
  role               text not null check (role in ('Assessor','Moderator','Facilitator')),
  registration_number text,
  registration_expiry_date date,
  training_providers text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  owner_email        text default auth_user_email()
);

-- Scope of registration: which qualifications a given registration covers.
-- Reuses the existing public.qualifications table (same one Programmes/EISA use).
create table if not exists public.fam_registration_scope (
  id              bigint generated always as identity primary key,
  tenant_id       text not null references public.tenants(id),
  registration_id bigint not null references public.fam_seta_registrations(id) on delete cascade,
  qualification_id text not null references public.qualifications(id),
  created_at      timestamptz not null default now(),
  unique (registration_id, qualification_id)
);

-- Supporting documents per practitioner (CV, ID, SLA, Code of Conduct, certificates, etc.)
create table if not exists public.fam_documents (
  id           bigint generated always as identity primary key,
  tenant_id    text not null references public.tenants(id),
  assessor_id  bigint not null references public.assessors(id) on delete cascade,
  doc_type     text not null,
  status       text not null default 'Missing' check (status in ('Missing','Current','Verified','Signed','Expired')),
  doc_date     date,
  file_url     text,
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  owner_email  text default auth_user_email()
);

-- Contract / SLA status per practitioner.
create table if not exists public.fam_contracts (
  id            bigint generated always as identity primary key,
  tenant_id     text not null references public.tenants(id),
  assessor_id   bigint not null references public.assessors(id) on delete cascade,
  sla_status    text not null default 'Not signed' check (sla_status in ('Not signed','Signed','Expired')),
  signed_date   date,
  provider_names text,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  owner_email   text default auth_user_email()
);

alter table public.fam_seta_registrations enable row level security;
alter table public.fam_registration_scope enable row level security;
alter table public.fam_documents          enable row level security;
alter table public.fam_contracts          enable row level security;

create policy owner_all on public.fam_seta_registrations for all
  using (tenant_id = auth_tenant_id() and (auth_is_admin() or owner_email is null or owner_email = auth_user_email()))
  with check (tenant_id = auth_tenant_id() and (auth_is_admin() or owner_email is null or owner_email = auth_user_email()));

create policy owner_all on public.fam_documents for all
  using (tenant_id = auth_tenant_id() and (auth_is_admin() or owner_email is null or owner_email = auth_user_email()))
  with check (tenant_id = auth_tenant_id() and (auth_is_admin() or owner_email is null or owner_email = auth_user_email()));

create policy owner_all on public.fam_contracts for all
  using (tenant_id = auth_tenant_id() and (auth_is_admin() or owner_email is null or owner_email = auth_user_email()))
  with check (tenant_id = auth_tenant_id() and (auth_is_admin() or owner_email is null or owner_email = auth_user_email()));

-- Scope rows inherit access via their parent registration's tenant.
create policy tenant_all on public.fam_registration_scope for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create trigger set_updated_at_fam_seta_registrations before update on public.fam_seta_registrations
  for each row execute function update_updated_at();
create trigger set_updated_at_fam_documents before update on public.fam_documents
  for each row execute function update_updated_at();
create trigger set_updated_at_fam_contracts before update on public.fam_contracts
  for each row execute function update_updated_at();

create trigger trg_audit_log after insert or update or delete on public.fam_seta_registrations
  for each row execute function log_audit_event();
create trigger trg_audit_log after insert or update or delete on public.fam_documents
  for each row execute function log_audit_event();
create trigger trg_audit_log after insert or update or delete on public.fam_contracts
  for each row execute function log_audit_event();

-- Helper view: registration status derived from expiry date, used by the FAM Registry UI
-- and (later) by the ApexOne dashboard KPI tiles. security_invoker so it respects RLS
-- like v_learner_kpis / v_clickup_sync_health already do.
create or replace view public.v_fam_registration_status
  with (security_invoker = true) as
select
  r.*,
  case
    when r.registration_expiry_date is null then 'Unknown'
    when r.registration_expiry_date < current_date then 'Expired'
    else 'Active'
  end as computed_status
from public.fam_seta_registrations r;
