-- clickup_sync_failures indexes
-- Table already exists in production (created by Supabase dashboard).
-- Real columns: id, occurred_at, source_table, operation, record_id, status_code, response_body, error_message.
-- This migration only adds indexes; it is safe to re-run.

CREATE INDEX IF NOT EXISTS csf_record_id_idx
  ON clickup_sync_failures (record_id);

CREATE INDEX IF NOT EXISTS csf_unresolved_idx
  ON clickup_sync_failures (occurred_at)
  WHERE status_code IS NOT NULL;
