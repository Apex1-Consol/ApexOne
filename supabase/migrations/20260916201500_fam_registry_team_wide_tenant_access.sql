-- Applied directly to apex-one (nducwhlmudksgxggjrbo) on 2026-09-16. Committed here after
-- the fact — see 20260916081451_fam_registry_schema.sql for the drift convention. This is
-- also the last migration allowed to follow that pattern: from here on, FAM schema changes
-- go through a feature branch + PR with the migration file committed *before* apply_migration
-- runs, per the pilot review's recommendation.
--
-- Product decision (2026-09-16): FAM records are visible/manageable by any authenticated
-- user within the same tenant, not just the record's owner or admins. This matches how a
-- compliance team actually works (backup coverage, shared responsibility, audits) and
-- resolves the review finding that owner_email scoping silently hid one colleague's
-- records from another in the same org.
--
-- Previously: tenant_id = auth_tenant_id() AND (auth_is_admin() OR owner_email IS NULL OR
-- owner_email = auth_user_email()). Now: tenant_id = auth_tenant_id() only, matching
-- fam_registration_scope's policy, which was already tenant-wide. owner_email columns are
-- kept for "created/last touched by" attribution but no longer gate row visibility.

DROP POLICY IF EXISTS owner_all ON public.fam_seta_registrations;
CREATE POLICY tenant_all ON public.fam_seta_registrations
  FOR ALL
  USING (tenant_id = auth_tenant_id())
  WITH CHECK (tenant_id = auth_tenant_id());

DROP POLICY IF EXISTS owner_all ON public.fam_documents;
CREATE POLICY tenant_all ON public.fam_documents
  FOR ALL
  USING (tenant_id = auth_tenant_id())
  WITH CHECK (tenant_id = auth_tenant_id());

DROP POLICY IF EXISTS owner_all ON public.fam_contracts;
CREATE POLICY tenant_all ON public.fam_contracts
  FOR ALL
  USING (tenant_id = auth_tenant_id())
  WITH CHECK (tenant_id = auth_tenant_id());
