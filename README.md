# ApexOne

Consolidated home for the ApexU QCTO Monitoring System - Supabase-backed build.

## What's here

index.html - the working build (single-file app; this is the file that ships, not a separate QCTO_v7_integrated.html). Auth runs on Supabase Auth (not local accounts).

Every tab - Programmes, Learners, Enrolments, EISA, Attendance, Attendance Sessions, PoE Checklist, Clients, Assessors, Monitoring Visits, and Recommendations - reads and writes to Supabase via a generic fetchRecords/createRecord/updateRecord/deleteRecord layer that hits the REST API directly (table mapping + typed-column handling in the SUPABASE section of index.html). localStorage is used only as an offline read cache and fallback, not as the primary data path - saveAll() mirrors state there after every Supabase write.

Monitoring Visits, Recommendations, and PoE Checklist currently have zero rows in the database. The wiring is live; nobody has entered data through those tabs yet.

## Backend

Supabase project: apexu-qcto (ref nducwhlmudksgxggjrbo), org ApexOne. The anon key embedded in the HTML is the public one - safe client-side; all real access control is enforced by RLS policies plus the signed-in user's JWT, not by keeping that key secret.

## Accounts

Users are created in the Supabase dashboard (Authentication -> Users -> Invite), with role and display name set under Raw App Meta Data - e.g. role: project_manager, name: Thabo N. Not Raw User Meta Data - that field is editable by the user themselves and isn't trusted for role checks.

## Known gaps

Monitoring Visits, Recommendations, and PoE Checklist tabs are wired but unused so far (0 rows) - confirm real users are entering data there, not just Programmes/Learners/EISA/Attendance.

GitHub auto-sync goes through a server-side proxy (/.netlify/functions/github-sync) rather than a token shipped in the HTML - keep it that way if sync logic changes.

Related repos: apexu-qcto-sync (data snapshot store), project_initiator (PI intake tool - separate Supabase project, not yet bridged to this one), Apex1-Consol-apexu-reports (client report generator).
