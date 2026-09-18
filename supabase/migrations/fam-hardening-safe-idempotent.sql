-- FAM-only hardening migration, idempotent review version
-- Apply first on a Supabase branch, then production after FAM smoke tests.
-- Uses existing public.auth_tenant_id(). Does not alter unrelated tables/functions.
begin;
create unique index if not exists fam_registration_scope_unique_link on public.fam_registration_scope (tenant_id, registration_id, qualification_id);
create index if not exists fam_seta_registrations_assessor_idx on public.fam_seta_registrations (tenant_id, assessor_id);
create index if not exists fam_seta_registrations_expiry_idx on public.fam_seta_registrations (tenant_id, registration_expiry_date);
create index if not exists fam_registration_scope_registration_idx on public.fam_registration_scope (tenant_id, registration_id);
create index if not exists fam_documents_assessor_current_idx on public.fam_documents (tenant_id, assessor_id, is_current);
create index if not exists fam_follow_ups_open_idx on public.fam_follow_ups (tenant_id, status, due_date);
do $$ declare t text; p text; begin
  foreach t in array array['assessors','fam_seta_registrations','fam_registration_scope','fam_documents','fam_document_verifications','fam_contracts','fam_follow_ups'] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
  foreach p in array array['fam_assessors_tenant_select','fam_assessors_tenant_insert','fam_assessors_tenant_update','fam_regs_tenant_select','fam_regs_tenant_insert','fam_regs_tenant_update','fam_scope_tenant_select','fam_scope_tenant_insert','fam_scope_tenant_update','fam_docs_tenant_select','fam_docs_tenant_insert','fam_docs_tenant_update','fam_doc_verify_tenant_select','fam_doc_verify_tenant_insert','fam_doc_verify_tenant_update','fam_contracts_tenant_select','fam_contracts_tenant_insert','fam_contracts_tenant_update','fam_followups_tenant_select','fam_followups_tenant_insert','fam_followups_tenant_update'] loop
    if p like 'fam_assessors_%' then execute format('drop policy if exists %I on public.assessors', p);
    elsif p like 'fam_regs_%' then execute format('drop policy if exists %I on public.fam_seta_registrations', p);
    elsif p like 'fam_scope_%' then execute format('drop policy if exists %I on public.fam_registration_scope', p);
    elsif p like 'fam_docs_%' then execute format('drop policy if exists %I on public.fam_documents', p);
    elsif p like 'fam_doc_verify_%' then execute format('drop policy if exists %I on public.fam_document_verifications', p);
    elsif p like 'fam_contracts_%' then execute format('drop policy if exists %I on public.fam_contracts', p);
    elsif p like 'fam_followups_%' then execute format('drop policy if exists %I on public.fam_follow_ups', p);
    end if;
  end loop;
end $$;
create policy fam_assessors_tenant_select on public.assessors for select to authenticated using (tenant_id = public.auth_tenant_id());
create policy fam_assessors_tenant_insert on public.assessors for insert to authenticated with check (tenant_id = public.auth_tenant_id());
create policy fam_assessors_tenant_update on public.assessors for update to authenticated using (tenant_id = public.auth_tenant_id()) with check (tenant_id = public.auth_tenant_id());
create policy fam_regs_tenant_select on public.fam_seta_registrations for select to authenticated using (tenant_id = public.auth_tenant_id());
create policy fam_regs_tenant_insert on public.fam_seta_registrations for insert to authenticated with check (tenant_id = public.auth_tenant_id());
create policy fam_regs_tenant_update on public.fam_seta_registrations for update to authenticated using (tenant_id = public.auth_tenant_id()) with check (tenant_id = public.auth_tenant_id());
create policy fam_scope_tenant_select on public.fam_registration_scope for select to authenticated using (tenant_id = public.auth_tenant_id());
create policy fam_scope_tenant_insert on public.fam_registration_scope for insert to authenticated with check (tenant_id = public.auth_tenant_id());
create policy fam_scope_tenant_update on public.fam_registration_scope for update to authenticated using (tenant_id = public.auth_tenant_id()) with check (tenant_id = public.auth_tenant_id());
create policy fam_docs_tenant_select on public.fam_documents for select to authenticated using (tenant_id = public.auth_tenant_id());
create policy fam_docs_tenant_insert on public.fam_documents for insert to authenticated with check (tenant_id = public.auth_tenant_id());
create policy fam_docs_tenant_update on public.fam_documents for update to authenticated using (tenant_id = public.auth_tenant_id()) with check (tenant_id = public.auth_tenant_id());
create policy fam_doc_verify_tenant_select on public.fam_document_verifications for select to authenticated using (tenant_id = public.auth_tenant_id());
create policy fam_doc_verify_tenant_insert on public.fam_document_verifications for insert to authenticated with check (tenant_id = public.auth_tenant_id());
create policy fam_doc_verify_tenant_update on public.fam_document_verifications for update to authenticated using (tenant_id = public.auth_tenant_id()) with check (tenant_id = public.auth_tenant_id());
create policy fam_contracts_tenant_select on public.fam_contracts for select to authenticated using (tenant_id = public.auth_tenant_id());
create policy fam_contracts_tenant_insert on public.fam_contracts for insert to authenticated with check (tenant_id = public.auth_tenant_id());
create policy fam_contracts_tenant_update on public.fam_contracts for update to authenticated using (tenant_id = public.auth_tenant_id()) with check (tenant_id = public.auth_tenant_id());
create policy fam_followups_tenant_select on public.fam_follow_ups for select to authenticated using (tenant_id = public.auth_tenant_id());
create policy fam_followups_tenant_insert on public.fam_follow_ups for insert to authenticated with check (tenant_id = public.auth_tenant_id());
create policy fam_followups_tenant_update on public.fam_follow_ups for update to authenticated using (tenant_id = public.auth_tenant_id()) with check (tenant_id = public.auth_tenant_id());
commit;
