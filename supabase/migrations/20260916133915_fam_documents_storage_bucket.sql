-- Applied directly to apex-one (nducwhlmudksgxggjrbo) on 2026-09-16. Committed here after
-- the fact — see 20260916081451_fam_registry_schema.sql for the drift convention.
--
-- NOTE: this migration created the fam-documents bucket as PUBLIC. That was closed off
-- five minutes later in 20260916153211_fam_documents_bucket_private_signed_urls.sql once
-- the public-read exposure was noticed. Kept here verbatim for an accurate history; do not
-- copy the public=true pattern for new buckets that will hold PII.

-- Public bucket for FAM practitioner documents (CV, ID, SLA, etc). App is behind auth already.
INSERT INTO storage.buckets (id, name, public)
VALUES ('fam-documents', 'fam-documents', true)
ON CONFLICT (id) DO NOTHING;

-- Reads: anyone with the URL (bucket is public) — matches how file_url is stored/used in fam_documents.
DROP POLICY IF EXISTS "fam_documents_public_read" ON storage.objects;
CREATE POLICY "fam_documents_public_read" ON storage.objects
  FOR SELECT USING (bucket_id = 'fam-documents');

-- Writes: only authenticated users, and only into a folder matching their own tenant_id (first path segment).
DROP POLICY IF EXISTS "fam_documents_tenant_write" ON storage.objects;
CREATE POLICY "fam_documents_tenant_write" ON storage.objects
  FOR INSERT WITH CHECK (
    bucket_id = 'fam-documents'
    AND auth.role() = 'authenticated'
    AND (storage.foldername(name))[1] = auth_tenant_id()
  );

DROP POLICY IF EXISTS "fam_documents_tenant_update" ON storage.objects;
CREATE POLICY "fam_documents_tenant_update" ON storage.objects
  FOR UPDATE USING (
    bucket_id = 'fam-documents'
    AND auth.role() = 'authenticated'
    AND (storage.foldername(name))[1] = auth_tenant_id()
  );
