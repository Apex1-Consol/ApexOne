# ApexOne

Consolidated home for the ApexU QCTO Monitoring System - Supabase-backed build.

## What's here

index.html - the working build (single-file app; this is the file that ships, not a separate QCTO_v7_integrated.html). Auth runs on Supabase Auth (not local accounts).

Every tab - Programmes, Learners, Enrolments, EISA, Attendance, Attendance Sessions, PoE Checklist, Clients, Assessors, Monitoring Visits, and Recommendations - reads and writes to Supabase via a generic fetchRecords/createRecord/updateRecord/deleteRecord layer that hits the REST API directly (table mapping + typed-column handling in the SUPABASE section of index.html). localStorage is used only as an offline read cache and fallback, not as the primary data path - saveAll() mirrors state there after every Supabase write.

Two Postgres views back reconciled KPI tiles instead of every page re-deriving its own count: v_learner_kpis (distinct learners by ID number - the canonical "Total Learners" shown on both the Dashboard and Reports & Analytics) and v_clickup_sync_health (rolling ClickUp sync failure counts, surfaced on the Dashboard's Data Health Check panel). Both are security_invoker views, so they respect the same RLS as the underlying tables.

## Deployment

This repo (Apex1-Consol/ApexOne) is the canonical source. A GitHub Actions workflow (.github/workflows/deploy.yml) auto-syncs index.html, programme-initiation.html, report-generator.html, qcto-seta-links.html and fam-registry.html to Apex1-Consol/apex1-consol.github.io on every push to main, so the live site at https://apex1-consol.github.io/ tracks this repo automatically - no manual deploy step needed.

## Backend

Supabase project: apex-one (ref nducwhlmudksgxggjrbo), org ApexOne. The anon key embedded in the HTML is the public one - safe client-side; all real access control is enforced by RLS policies plus the signed-in user's JWT, not by keeping that key secret.

## Accounts

Users are created in the Supabase dashboard (Authentication -> Users -> Invite), with role and display name set under Raw App Meta Data - e.g. role: project_manager, name: Thabo N. Not Raw User Meta Data - that field is editable by the user themselves and isn't trusted for role checks.

## Known data quality issue

The Learners Registry has a large amount of duplicate seed data (a small number of real people re-inserted under new IDs by a seed script run multiple times) - v_learner_kpis works around this for KPI tiles by counting distinct ID numbers, but the underlying duplicate rows are still in the learners table pending a manual cleanup pass. See the flagged-records list produced 2026-08-29 for specifics per table.

## Related repos

apexu-qcto-sync (private - data snapshot store), Apex1-Consol-apexu-reports (client report generator), apex1-consol.github.io (live deployment target - auto-synced from this repo, see Deployment above). project_initiator (PI intake tool, separate Supabase project pi-specialist / srbytujnohsgaegzecbe) IS bridged into this project's data: public.pi_bridge_synced maps its locally-created programmes to apexu_client_id / apexu_programme_id here (2 programmes synced as of 2026-08-29), with failures logged to public.pi_bridge_failures.

## FAM Registry (facilitators, assessors & moderators)

fam-registry.html is a standalone page in this same repo, auto-deployed to apex1-consol.github.io/fam-registry.html alongside the other standalone pages (same deploy step as programme-initiation.html / report-generator.html). It uses the same ApexOne Supabase project and the same sign-in - no separate account or database. Unlike the other standalone pages it isn't bridged data from elsewhere: it reads/writes public.assessors directly, the same table the existing "Assessors & Moderators" tab in index.html uses, so both stay in sync with no sync job needed.

The schema is additive, not a replacement: public.assessors keeps its existing columns (seta_registration_number, accreditation_body, registration_expiry_date) untouched for backward compatibility, plus five new nullable columns (id_number, physical_address, gender, population_group, disability_status). Multi-SETA / multi-role registrations, scope of registration, supporting documents and contract/SLA status live in four new tables: public.fam_seta_registrations (one row per person x SETA x role), public.fam_registration_scope (which public.qualifications a registration covers - reuses the same qualifications table Programmes/EISA use), public.fam_documents, and public.fam_contracts. All four have RLS matching the existing owner_all pattern and are NOT wired into the ClickUp sync outbox yet (deliberately - that would need its own ClickUp list mapping, out of scope for the first cut).

Why standalone first: this mirrors the project_initiator precedent above - build and use it independently while ApexOne's own tab structure catches up, then fold it in without a data migration since it's already reading the same tenant-scoped tables. Folding in later means: replacing the current Assessors & Moderators nav item (data-view="assessors") in index.html with the FAM Registry UI (or embedding it), reusing the same fetchRecords-style calls against fam_seta_registrations / fam_registration_scope / fam_documents / fam_contracts, and retiring fam-registry.html as a separate page once that's live. No bridge table is needed the way pi_bridge_synced is for project_initiator, because FAM Registry was never on a separate database to begin with.

