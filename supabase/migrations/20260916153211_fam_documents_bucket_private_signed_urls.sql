-- Applied directly to apex-one (nducwhlmudksgxggjrbo) on 2026-09-16. Committed here after
-- the fact — see 20260916081451_fam_registry_schema.sql for the drift convention.

-- Close the public-read exposure on fam-documents (holds CVs, IDs, SLAs with PII).
-- Bucket had public=true plus an unconditional storage.objects SELECT policy —
-- anyone with a file URL, no auth required, could read it. Storage is empty right
-- now (0 objects, 0 fam_documents.file_url rows), so this closes the gap before
-- any real document is ever uploaded, no data migration needed.

update storage.buckets set public = false where id = 'fam-documents';

drop policy if exists fam_documents_public_read on storage.objects;

create policy fam_documents_tenant_read on storage.objects
  for select
  using (
    bucket_id = 'fam-documents'
    and auth.role() = 'authenticated'
    and (storage.foldername(name))[1] = auth_tenant_id()
  );
