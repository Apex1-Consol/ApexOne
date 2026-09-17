-- Applied directly to apex-one (nducwhlmudksgxggjrbo) on 2026-09-17, committed here in the
-- same PR as the app changes that use it — no drift.
--
-- Closes review gap: "the current status view only derives Active, Expired, and
-- Unknown, while the UI needs Pending Entry, Due <=30, Due <=60, Inactive, and
-- Mixed consistently across registry, queue, dashboard, and exports."
--
-- v_fam_registration_status previously only knew Active/Expired/Unknown and,
-- for a null expiry date, returned 'Unknown' — which never matched what the
-- FAM Registry UI actually showed for that same row (it falls back to the
-- registration's own status column). This rewrite makes the view match the
-- app's regRiskState()/overallStatus() logic exactly, so any future consumer
-- (main-app dashboard KPIs, exports, reports) reads the same categorization
-- practitioners see in the registry and action queue — not a second,
-- disagreeing source of truth.

-- Dropped and recreated rather than CREATE OR REPLACE: fam_seta_registrations
-- gained columns (roles, status) after this view was first created, so r.*'s
-- column order no longer matches the existing view definition.
drop view if exists public.v_fam_registration_status;

create view public.v_fam_registration_status
  with (security_invoker = true) as
select
  r.*,
  case
    when r.status = 'Pending Entry' then 'Pending Entry'
    when r.registration_expiry_date is null
      then case when coalesce(r.status,'Active') = 'Active' then 'Active' else 'Inactive' end
    when r.registration_expiry_date < current_date then 'Expired'
    when r.registration_expiry_date <= current_date + interval '30 days' then 'Due <=30'
    when r.registration_expiry_date <= current_date + interval '60 days' then 'Due <=60'
    else case when coalesce(r.status,'Active') = 'Active' then 'Active' else 'Inactive' end
  end as computed_status
from public.fam_seta_registrations r;

-- New: per-assessor aggregate status (adds 'Mixed' on top of the per-registration
-- states above), mirroring the app's overallStatus() so the main ApexOne dashboard
-- and any exports can reuse this instead of re-deriving the aggregation rule.
create or replace view public.v_fam_assessor_status
  with (security_invoker = true) as
with agg as (
  select r.assessor_id, r.tenant_id, array_agg(distinct vs.computed_status) as statuses
  from public.fam_seta_registrations r
  join public.v_fam_registration_status vs on vs.id = r.id
  group by r.assessor_id, r.tenant_id
)
select
  a.id as assessor_id,
  a.tenant_id,
  case
    when agg.statuses is null then 'Unknown'
    when agg.statuses = array['Active'] then 'Active'
    when 'Expired' = any(agg.statuses)
      and array_length(array_remove(agg.statuses, 'Expired'), 1) is null then 'Expired'
    when 'Expired' = any(agg.statuses) then 'Mixed'
    when agg.statuses && array['Due <=30','Due <=60','Pending Entry','Inactive']
      and 'Active' = any(agg.statuses) then 'Mixed'
    when agg.statuses && array['Due <=30','Due <=60','Pending Entry','Inactive'] then 'Inactive'
    else 'Active'
  end as overall_status
from public.assessors a
left join agg on agg.assessor_id = a.id;

-- fam_follow_ups.kind previously only allowed 'due_soon' (a single <=60-day bucket).
-- Split to match the two-tier due-soon derivation above.
alter table public.fam_follow_ups drop constraint if exists fam_follow_ups_kind_check;
update public.fam_follow_ups set kind = 'due_60' where kind = 'due_soon';
alter table public.fam_follow_ups add constraint fam_follow_ups_kind_check
  check (kind in ('expired','due_30','due_60','pending','inactive','missing_doc'));
