-- log_audit_event_kv() is a SECURITY DEFINER trigger function (fires on
-- app_kv_store via trg_audit_log). The security advisor flags it as
-- "executable by anon/authenticated" because EXECUTE was granted to PUBLIC.
--
-- Verified live: PostgREST does NOT expose this over /rest/v1/rpc at all --
-- calling it as anon returns PGRST202 "not found in schema cache", because
-- PostgREST excludes functions that return the trigger pseudo-type from its
-- API surface entirely. So there is no real-world exposure today. Trigger
-- execution itself does not require EXECUTE privilege on the function (the
-- trigger mechanism invokes it directly, independent of grants), so revoking
-- these grants is pure hygiene with zero functional impact -- verified live
-- that trg_audit_log on app_kv_store still fires correctly after this change.
--
-- Applied directly to the apex-one project (nducwhlmudksgxggjrbo) on 2026-09-17;
-- this file records it for the repo history.

revoke execute on function public.log_audit_event_kv() from public, anon, authenticated;
