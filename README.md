# ApexOne

Consolidated home for the ApexU QCTO Monitoring System - Supabase-backed build.

## What's here

index.html - the working build (single-file app; this is the file that ships, not a separate QCTO_v7_integrated.html). Auth runs on Supabase Auth (not local accounts).

Every tab - Programmes, Learners, Enrolments, EISA, Attendance, Attendance Sessions, PoE Checklist, Clients, Assessors, Monitoring Visits, and Recommendations - reads and writes to Supabase via a generic fetchRecords/createRecord/updateRecord/deleteRecord layer that hits the REST API directly (table mapping + typed-column handling in the SUPABASE section of index.html). localStorage is used only as an offline read cache and fallback, not as the primary data path - saveAll() mirrors state there after every Supabase write.

## Deployment

This repo (Apex1-Consol/ApexOne) is the canonical source. A GitHub Actions workflow (.github/workflows/deploy.yml) auto-syncs index.html, programme-initiation.html, report-generator.html and qcto-seta-links.html to Apex1-Consol/apex1-consol.github.io on every push to main, so the live site at https://apex1-consol.github.io/ tracks this repo automatically - no manual deploy step needed. The MonitoringVisits table mapping (-> monitoring_visits), AttendanceSessions and PoeChecklist wiring described above are all live in production as of this writing.

## Backend

Supabase project: apexu-qcto (ref nducwhlmudksgxggjrbo), org ApexOne. The anon key embedded in the HTML is the public one - safe client-side; all real access control is enforced by RLS policies plus the signed-in user's JWT, not by keeping that key secret.

## Accounts

Users are created in the Supabase dashboard (Authentication -> Users -> Invite), with role and display name set under Raw App Meta Data - e.g. role: project_manager, name: Thabo N. Not Raw User Meta Data - that field is editable by the user themselves and isn't trusted for role checks.

## Related repos

apexu-qcto-sync (private - data snapshot store), project_initiator (PI intake tool - separate Supabase project, not yet bridged to this one), Apex1-Consol-apexu-reports (client report generator), apex1-consol.github.io (live deployment target - auto-synced from this repo, see Deployment above).
