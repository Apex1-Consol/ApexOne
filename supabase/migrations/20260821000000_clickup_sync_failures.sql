-- clickup_sync_failures
-- Logs every failed attempt to sync an ApexOne record to ClickUp.
-- Consumed by the clickup-sync Edge Function.

CREATE TABLE IF NOT EXISTS clickup_sync_failures (
  id              uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at      timestamptz DEFAULT now() NOT NULL,
  programme_id    text,
  client_id       text,
  event_type      text        NOT NULL,
  record_id       text,                        -- e.g. "programmes:216"
  clickup_list_id text,
  payload         jsonb,                       -- {task_id, target_status}
  error_message   text,
  http_status     int,
  retry_count     int         DEFAULT 0 NOT NULL,
  last_retry_at   timestamptz,
  resolved_at     timestamptz,
  resolved_by     text
);

ALTER TABLE clickup_sync_failures ENABLE ROW LEVEL SECURITY;

-- Only the service role (Edge Function) may read/write this table.
CREATE POLICY "service_role_only" ON clickup_sync_failures
  FOR ALL USING (auth.role() = 'service_role');

CREATE INDEX IF NOT EXISTS csf_programme_id_idx
  ON clickup_sync_failures (programme_id);

CREATE INDEX IF NOT EXISTS csf_unresolved_idx
  ON clickup_sync_failures (created_at)
  WHERE resolved_at IS NULL;
