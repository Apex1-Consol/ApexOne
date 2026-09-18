-- FAM-only hardening review migration
-- Review before applying. This file intentionally does not execute against production.
-- Assumes authenticated users carry tenant_id in auth.jwt()->'app_metadata'.

begin;

-- Prevent duplicate qualification links at the database layer.
create unique index if not exists fam_registration_scope_unique_link
  on public.fam_registration_scope (tenant_id, registration_id, qualification_id);

-- Support the registry's common joins and expiry/action-queue queries.
create index if not exists fam_seta_registrations_assessor_idx
  on public.fam_seta_registrations (tenant_id, assessor_id);
create index if not exists fam_seta_registrations_expiry_idx
  on public.fam_seta_registrations (tenant_id, registration_expiry_date);
create index if not exists fam_registration_scope_registration_idx
  on public.fam_registration_scope (tenant_id, registration_id);
create index if not exists fam_documents_assessor_current_idx
  on public.fam_documents (tenant_id, assessor_id, is_current);
create index if not exists fam_follow_ups_open_idx
  on public.fam_follow_ups (tenant_id, status, due_date);

-- Enable tenant-scoped RLS on FAM tables.
alter table public.assessors enable row level security;
alter table public.fam_seta_registrations enable row level security;
alter table public.fam_registration_scope enable row level security;
alter table public.fam_documents enable row level security;
alter table public.fam_document_verifications enable row level security;
alter table public.fam_contracts enable row level security;
alter table public.fam_follow_ups enable row level security;

-- Replace these predicates with the workspace's approved tenant helper if one exists.
-- Do not apply until the JWT tenant claim and admin policy are confirmed.
-- Example policy shape:
-- using (tenant_id = (select auth.jwt()->'app_metadata'->>'tenant'))
-- with check (tenant_id = (select auth.jwt()->'app_metadata'->>'tenant'))

-- Private Storage bucket policy design for storage.objects:
-- bucket_id = 'fam-documents'
-- name begins with tenant_id || '/'
-- authenticated read/write only; no public access.

commit;
