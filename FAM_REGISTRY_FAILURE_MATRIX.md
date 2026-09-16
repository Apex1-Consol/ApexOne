# FAM Registry — Boot & Session Failure-State Test Matrix

**Status:** Executed — all 4 Pass
**Execution date:** 2026-09-16
**Scope:** `fam-registry.html`, `boot()` function and its two entry points (top-level call, `onAuthStateChange` listener) as of commit `6a5f0cd` (dedup fix) / `6fd7b13` (nav link fix, unrelated file).

**Purpose:** Acceptance gate for the boot-dedup and session-error-handling fix. Each case below must produce a **visible, recoverable UI state** — never a silent hang, an unstyled crash, or data from the wrong tenant. This matrix is frozen as the sign-off condition before any further data is wired into FAM Registry or the feature is expanded (e.g. folding into `index.html`, adding ClickUp sync).

**Pass bar:** A case passes only if the user can tell what happened from the screen alone, without opening devtools, and has a way forward (retry, re-login, or contact support) without reloading blind.

**BLOCKING:** Until all four cases below are marked Pass and the sign-off block is filled in, do not: wire FAM Registry to any additional data sources or workflows; fold it into `index.html`'s Assessors tab; or add ClickUp sync or any other integration on top of the FAM tables. This gate has no expiry — a partially-executed matrix does not authorize partial progress on any of the three.

## Prerequisites

Before executing this matrix, have ready:

- **Browser devtools access** (Network tab, for request counting in Test 4; ability to throttle/simulate offline in Tests 1 and 4).
- **A test Supabase Auth user with valid credentials** for `apex-one` (`nducwhlmudksgxggjrbo`) that can sign in to `fam-registry.html` normally — used as the control case and for Tests 1, 2, 4.
- **A second test Supabase Auth user whose `app_metadata` has no `tenant` claim**, or one set to a tenant ID absent from the `tenants` table — required for Test 3. Provision via the Supabase dashboard or `execute_sql`/admin API; do not repurpose a real practitioner or staff account.
- **A way to intercept or delay the Supabase REST/auth calls** (browser devtools request blocking, a local proxy, or temporarily editing `SUPA_URL` in a local copy of the file to an unreachable host) — needed for Tests 1 and 2 to force a timeout/throw deterministically rather than relying on real network flakiness.
- **Write access to this file** (or the PR/commit workflow in use) to record results and flip Status to Executed once complete.

---

## Test 1 — Session check times out (>10s)

| | |
|---|---|
| **Trigger** | Throttle network to simulate `sb.auth.getSession()` never resolving (or resolving >10s), e.g. Chrome DevTools "Offline" or a custom `Promise` that never settles, applied before page load. |
| **Setup** | Fresh page load, no cached session assumed either way. |
| **Expected** | Within ~10s, the timeout in `boot()` rejects. `#login-error` shows "Session check timed out. Check your connection and try again." Login screen (or app shell, if a session existed) does not sit on a bare spinner indefinitely. `bootInProgress` resets to `false` in `finally`, so a manual retry (reload, or re-clicking Sign in) is not blocked by the stale flag. |
| **Fail condition** | Page stays on "Loading…" or blank with no message past 10s; or the error text never clears on a successful retry. |
| **Result** | ☑ Pass ☐ Fail |
| **Notes** | Verified directly against live `boot()` on the deployed page: `sb.auth.getSession` overridden to a never-resolving promise, `boot()` awaited. Timeout fired at 10003ms, `#login-error` showed the exact expected copy, `bootInProgress` reset to `false` in `finally`. |

---

## Test 2 — Session check throws

| | |
|---|---|
| **Trigger** | Force `sb.auth.getSession()` to reject synchronously or asynchronously (e.g. corrupt the Supabase client, or intercept the request and return a malformed/500 response so the SDK throws). |
| **Setup** | Fresh page load. |
| **Expected** | `catch` block in `boot()` fires. `console.error('boot() failed:', err)` logs for diagnostics. `#login-error` shows the error message (or the fallback "Failed to load. Please refresh and try again." if `err.message` is empty). `bootInProgress` resets via `finally`, so a subsequent successful `boot()` call (retry) is not permanently blocked. |
| **Fail condition** | Uncaught exception in console with no on-screen indication; or `bootInProgress` stays `true` after the throw, permanently blocking future boot attempts for the rest of the session. |
| **Result** | ☑ Pass ☐ Fail |
| **Notes** | `sb.auth.getSession` overridden to reject synchronously. `catch` fired in ~1ms, `#login-error` showed `err.message` verbatim, `bootInProgress` reset to `false`. |

---

## Test 3 — Valid session, missing/null `app_metadata.tenant`

| | |
|---|---|
| **Trigger** | Authenticate as a user whose Supabase Auth `app_metadata` has no `tenant` claim (or an invalid one that doesn't match any row in `tenants`). `auth_tenant_id()` then returns `NULL`, and every RLS policy's `tenant_id = auth_tenant_id()` check fails closed — all `assessors` / `fam_seta_registrations` / etc. queries return `[]`, not an error. |
| **Setup** | A test user account provisioned without a tenant claim, or with `app_metadata.tenant` set to a nonexistent tenant ID. |
| **Expected** | Login succeeds (auth and tenant scoping are separate concerns). `boot()` completes normally — `session.user.app_metadata.role` may be undefined, `whoami` still renders with just the email. `loadAll()` receives empty arrays for every table (200 OK, `[]`) and the UI shows its existing "no practitioners" / empty-state rows, **not** an infinite loading spinner and **not** a thrown error. This must be visually distinguishable from Test 1/2's error state — empty data is a legitimate state, not a failure, and should not display the `#login-error` text. |
| **Fail condition** | UI looks identical to "still loading" (user can't tell whether it's empty or stuck); or the app throws trying to read `.length` / iterate on data it assumes is non-empty; or, worse, `auth_tenant_id()` returning `NULL` is silently treated as "no tenant filter" anywhere in application code (would be a serious RLS-adjacent bug, not just a UX one — flag immediately if seen). |
| **Result** | ☑ Pass ☐ Fail |
| **Notes** | RLS verified directly at the database layer via `set_config('request.jwt.claims', ...)`: no-tenant and invalid-tenant claims both make `auth_tenant_id()` return `NULL` and every FAM/`assessors` query return `[]` (not an error); a valid tenant+email claim correctly returns the real 8 assessor rows. The "silently treated as no filter" failure mode does **not** occur. UI half then confirmed with a real browser login (disposable Supabase Auth user, no `tenant` claim, human-solved Turnstile — see captcha finding below, since it initially blocked this) against the live `fam-registry.html`: `state.tenantId` was `null`, `#login-error` was empty, and the registry rendered a clear "All practitioners (0) / No practitioners match this view / Nothing needs attention right now" empty state — visibly distinct from a loading or error state, exactly per the pass bar. |

---

## Test 4 — Login triggers `boot()` while a previous `boot()` is still in flight

| | |
|---|---|
| **Trigger** | This is the direct regression test for the dedup fix. Reproduce the original bug scenario: a session already exists in `localStorage` on page load (top-level `boot()` call fires), and — before that call resolves — force a second trigger, e.g. call `handleLogin()`'s flow or manually fire `sb.auth.onAuthStateChange` with a `SIGNED_IN` or `TOKEN_REFRESHED` event while the first `boot()` is still awaiting `getSession()`/`loadAll()`. (Throttling the network makes the in-flight window easy to hit manually.) |
| **Setup** | Existing valid session in storage; network throttled to widen the race window; browser devtools Network tab open to count requests. |
| **Expected** | The second call hits `if (bootInProgress) return;` and exits immediately — no second data-load cycle. Exactly one set of requests to `assessors`, `fam_seta_registrations`, `fam_registration_scope`, `fam_documents`, `fam_contracts`, `qualifications` per genuine boot cycle (confirmed via Network tab, matching the fix verified in this session for the non-concurrent case). UI ends in a single consistent state — no flicker between two renders, no duplicate toasts. |
| **Fail condition** | Network tab shows the load sequence fired more than once for one user-visible transition; or the UI flickers/re-renders visibly; or a genuinely new event (e.g. a real token refresh after the first boot *completed*, which is legitimate and should still boot) gets incorrectly suppressed forever because the flag was never reset. |
| **Result** | ☑ Pass ☐ Fail |
| **Notes** | `boot()` called twice back-to-back with no await between calls (widened via a 2s-delayed `getSession` mock). First call set `bootInProgress = true` synchronously; second call returned in 0ms without invoking `loadAll` (instrumented count: 0 extra calls). `bootInProgress` correctly settled back to `false` once both resolved. Dedup guard confirmed working at the code level. |

---

## Sign-off

This matrix is the acceptance gate for the current boot/session-handling fix. All four cases must be marked **Pass** before:

- FAM Registry is wired into any additional data sources or workflows, or
- The feature is folded into `index.html`'s Assessors tab, or
- Any ClickUp sync or other integration is added on top of the FAM tables.

| Tested by | Date | All 4 Pass? |
|---|---|---|
| Claude (Cowork session) + Stav (Turnstile fix, human verification steps) | 2026-09-16 | ☑ Yes ☐ No |

All four cases pass. Tests 1, 2, and 4 were verified directly against the live `boot()` code on the deployed page. Test 3 was verified both at the RLS layer (fails closed, never silently drops the tenant filter) and, once the captcha misconfiguration below was fixed, end-to-end through a real login showing the correct empty state. The BLOCKING condition is lifted — FAM Registry may now be wired to additional data sources/workflows, folded into `index.html`'s Assessors tab, or have further integrations added, subject to normal review.

---

## Separate finding: Supabase Auth captcha misconfiguration (blocks ALL new logins, not just testing)

Not one of the four boot/session cases above, but discovered while attempting Test 3 and worth flagging with equal urgency: on 2026-09-16, a real login attempt against `fam-registry.html` (human-solved Turnstile checkbox, valid disposable credentials) failed with **`captcha protection: request disallowed (invalid-input-secret)`**. `invalid-input-secret` is Cloudflare Turnstile's own error code for "the secret key configured server-side is wrong, revoked, or mismatched with the site key" — this is not about the user's token or browser, it's a Supabase Auth project setting.

**Practical impact:** any session that doesn't already have a valid cached Supabase session (i.e. any new/first-time sign-in, or any existing user whose session has expired) currently cannot sign in to `fam-registry.html` at all. Only already-authenticated browser sessions from before this broke still work — which is why the boot()-level tests above could be validated but a real fresh login could not.

**Fix (outside what this session can do — no Supabase Auth-config tool is exposed here):** in the Supabase Dashboard, Authentication → Settings → Bot and Abuse Protection, re-enter/match the Turnstile secret key against the Turnstile site key `0x4AAAAAAE4gMGMxYC7Zn1qJ` used in `fam-registry.html`, or reissue both from the Cloudflare Turnstile dashboard if the secret was rotated/deleted there.

**Status: Fixed.** Stav rotated the Turnstile secret in the Cloudflare dashboard and updated it in Supabase Dashboard → Authentication → Settings → Bot and Abuse Protection on 2026-09-16. Re-tested immediately after with a fresh disposable login — sign-in now succeeds normally. This also unblocked Test 3's UI verification above.
