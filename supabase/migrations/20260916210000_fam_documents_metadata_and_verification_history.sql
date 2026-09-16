-- Applied directly to apex-one (nducwhlmudksgxggjrbo) on 2026-09-16, committed here in the
-- same PR — no drift this time, per the "from here on" note in
-- 20260916201500_fam_registry_team_wide_tenant_access.sql.
--
-- Closes review gap: "documents have no document expiry, file metadata, uploader,
-- verification history". Additive only — existing rows/columns untouched.

alter table public.fam_documents
  add column if not exists expiry_date     date,
  add column if not exists file_name       text,
  add column if not exists file_size_bytes bigint,
  add column if not exists mime_type       text,
  add column if not exists uploaded_by     text,
  add column if not exists uploaded_at     timestamptz;

-- Append-only history of every status this document has held, who set it, and when.
-- Populated automatically by trigger below so the app can't forget to log a change,
-- and so history survives even edits made outside the FAM Registry UI.
create table if not exists public.fam_document_verifications (
  id           bigint generated always as identity primary key,
  tenant_id    text not null references public.tenants(id),
  document_id  bigint not null references public.fam_documents(id) on delete cascade,
  status       text not null check (status in ('Missing','Current','Verified','Signed','Expired')),
  verified_by  text default auth_user_email(),
  verified_at  timestamptz not null default now(),
  notes        text
);

alter table public.fam_document_verifications enable row level security;

create policy tenant_all on public.fam_document_verifications for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create trigger trg_audit_log after insert or update or delete on public.fam_document_verifications
  for each row execute function log_audit_event();

-- Auto-log a verification history row on every insert and on every status change.
-- security definer + fixed search_path, matching log_audit_event's convention, so the
-- history write isn't blocked by the inserting session's own RLS context.
create or replace function public.fam_documents_log_verification()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if (tg_op = 'INSERT') or (new.status is distinct from old.status) then
    insert into public.fam_document_verifications (tenant_id, document_id, status, verified_by)
    values (new.tenant_id, new.id, new.status, auth_user_email());
  end if;
  return new;
end;
$$;

create trigger trg_fam_documents_verification_history
  after insert or update on public.fam_documents
  for each row execute function fam_documents_log_verification();

-- Security advisor flagged the function above as directly callable via RPC by
-- anon/authenticated (SECURITY DEFINER functions are exposed via PostgREST RPC by
-- default). It's meant only to fire as a trigger, so revoke direct execute; the
-- trigger itself is unaffected since triggers don't need role-level EXECUTE grants.
revoke execute on function public.fam_documents_log_verification() from anon, authenticated, public;
