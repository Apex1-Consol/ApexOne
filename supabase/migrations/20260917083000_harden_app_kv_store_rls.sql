-- app_kv_store previously had one blanket policy (authenticated_all: ALL commands,
-- qual/with_check = true) letting ANY authenticated user, of any role, delete or
-- overwrite every row -- including the "programmes-v2" blob that holds every
-- uploaded programme-initiation document (embedded as base64).
--
-- The browser app (programme-initiation.html's window.storage shim) only ever
-- calls .get()/.set() -> SELECT/INSERT/UPDATE (upsert). It never calls DELETE.
-- So we split the policy: keep read/write behavior identical (SELECT/INSERT/UPDATE
-- stay open to any authenticated user, unchanged from today), but restrict DELETE
-- to admins only via the existing auth_is_admin() helper. This closes the
-- "any logged-in user can wipe all programme data + documents" hole with zero
-- risk of breaking current app behavior.
--
-- Applied directly to the apex-one project (nducwhlmudksgxggjrbo) on 2026-09-17;
-- this file records it for the repo history.

drop policy if exists authenticated_all on public.app_kv_store;

create policy kv_store_authenticated_select
  on public.app_kv_store
  for select
  to authenticated
  using (true);

create policy kv_store_authenticated_insert
  on public.app_kv_store
  for insert
  to authenticated
  with check (true);

create policy kv_store_authenticated_update
  on public.app_kv_store
  for update
  to authenticated
  using (true)
  with check (true);

create policy kv_store_admin_delete
  on public.app_kv_store
  for delete
  to authenticated
  using (auth_is_admin());
