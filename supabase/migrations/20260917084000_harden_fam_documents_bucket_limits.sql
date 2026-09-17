-- The fam-documents storage bucket had no file_size_limit or allowed_mime_types,
-- so the only thing stopping an oversized or arbitrary-type upload was
-- client-side code in fam-registry.html -- which itself had no such checks
-- until this change. Enforce the same limits at the storage layer as the
-- client now checks (see fam-registry.html's validateDocumentFile()), so this
-- holds even if someone bypasses the UI and calls the storage API directly.
--
-- Applied directly to the apex-one project (nducwhlmudksgxggjrbo) on 2026-09-17;
-- this file records it for the repo history.

update storage.buckets
set
  file_size_limit = 10485760, -- 10 MB
  allowed_mime_types = array[
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'image/jpeg',
    'image/png'
  ]
where id = 'fam-documents';
