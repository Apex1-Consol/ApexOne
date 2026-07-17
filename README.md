# ApexOne

Consolidated home for the ApexU QCTO Monitoring System - Supabase-backed build.

## What's here

QCTO_v7_integrated.html - the working build. Auth runs on Supabase Auth (not local accounts). The Programmes tab reads/writes the real programmes table directly. Every other tab (Learners, Enrolments, EISA, Monitoring, Recommendations, Clients, Assessors, Attendance, PoE) still runs on its original local-storage path - not yet migrated.

## Backend

Supabase project: apexu-qcto (ref nducwhlmudksgxggjrbo), org ApexOne. The anon key embedded in the HTML is the public one - safe client-side; all real access control is enforced by RLS policies plus the signed-in user's JWT, not by keeping that key secret.

## Accounts

Users are created in the Supabase dashboard (Authentication -> Users -> Invite), with role and display name set under Raw App Meta Data - e.g. role: project_manager, name: Thabo N. Not Raw User Meta Data - that field is editable by the user themselves and isn't trusted for role checks.

## Known gaps

Only Programmes is wired to Supabase so far; the rest still needs the same treatment (schema gaps get discovered per table - Programmes needed several new columns the original table didn't have).

GitHub auto-sync is disabled (a previous version had a live token hardcoded in the client - removed). If sync comes back, it needs to go through a server-side proxy, never a token shipped in the HTML.

Related repos: apexu-qcto-sync (data snapshot store), project_initiator (PI intake tool - separate Supabase project, not yet bridged to this one), Apex1-Consol-apexu-reports (client report generator).
