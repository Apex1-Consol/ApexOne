# ApexOne

Consolidated home for the ApexU QCTO Monitoring System - Supabase-backed build.

## What's here

index.html - the working build (single-file app; this is the file that ships, not a separate QCTO_v7_integrated.html). Auth runs on Supabase Auth (not local accounts).

Every tab - Programmes, Learners, Enrolments, EISA, Attendance, Attendance Sessions, PoE Checklist, Clients, Assessors, Monitoring Visits, and Recommendations - reads and writes to Supabase via a generic fetchRecords/createRecord/updateRecord/deleteRecord layer that hits the REST API directly (table mapping + typed-column handling in the SUPABASE section of index.html). localStorage is used only as an offline read cache and fallback, not as the primary data path - saveAll() mirrors state there after every Supabase write.

## Deployment (READ THIS - repo is out of sync with production)

The live app is served from Apex1-Consol/apex1-consol.github.io (GitHub Pages) at https://apex1-consol.github.io/ - that repo's index.html, NOT this one, is what real users load. As of this writing the two have diverged significantly (different theme/title, live is missing the Turnstile captcha script entirely):

- BUG: live index.html maps MonitoringVisits to Supabase table 'monitoring', but the real table is 'monitoring_visits'. Every Monitoring Visits read/write on production hits a table that doesn't exist and silently fails.
- - Live index.html has no mapping at all for AttendanceSessions or PoeChecklist - those tabs aren't wired to Supabase in production, only in this repo's newer index.html.
  - - This is the likely reason monitoring_visits, poe_checklist, and recommendations show 0 rows in the database - at least monitoring and PoE are broken on production, not just unused.
   
    - This repo's current index.html has all of this fixed and complete. It needs to be pushed to apex1-consol.github.io to actually take effect for users.
   
    - ## Backend
   
    - Supabase project: apexu-qcto (ref nducwhlmudksgxggjrbo), org ApexOne. The anon key embedded in the HTML is the public one - safe client-side; all real access control is enforced by RLS policies plus the signed-in user's JWT, not by keeping that key secret.
   
    - ## Accounts
   
    - Users are created in the Supabase dashboard (Authentication -> Users -> Invite), with role and display name set under Raw App Meta Data - e.g. role: project_manager, name: Thabo N. Not Raw User Meta Data - that field is editable by the user themselves and isn't trusted for role checks.
   
    - ## Known gaps
   
    - See Deployment above - production is running a stale, partly-broken build. This needs a deploy, and ideally an automated way (CI action, or the GitHub-sync function) to stop the two repos drifting apart again.
   
    - GitHub auto-sync goes through a server-side proxy (/.netlify/functions/github-sync) rather than a token shipped in the HTML - keep it that way if sync logic changes.
   
    - Related repos: apexu-qcto-sync (private - data snapshot store), project_initiator (PI intake tool - separate Supabase project, not yet bridged to this one), Apex1-Consol-apexu-reports (client report generator), apex1-consol.github.io (live deployment target - currently stale, see Deployment above).
    - 
