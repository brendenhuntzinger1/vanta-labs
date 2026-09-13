# Live visitor tracker — design

Status: approved, implementing. Requested via chat 2026-09-13.

## Goal

An admin-only `/admin/live` page showing who is on the site right now:
count, current page, coarse location/device, session duration, new vs
returning, and — only when the browser is legitimately identifying itself
via a signed-in session — the actual customer/ambassador name.

## What already exists (reused, not rebuilt)

- `SiteAnalyticsTracker` (`components/site-analytics-tracker.tsx`) — mounted
  on every page, consent-gated, holds a persistent `visitorId`/`sessionId`
  pair in `localStorage`, fires `session_start`/`page_view` to
  `/api/analytics/track`.
- `website_analytics_events` — the one events table this writes into.
  Phase-1 lockdown already revoked `anon`/`authenticated` grants on it; only
  the service-role client (this route) can write, only admin reads query it.
- `getCurrentOnlineVisitorCount()` (`admin-analytics.ts`) — an existing rough
  5-minute-window count on the `/admin` dashboard tile. Left as-is; not the
  same feature (no per-visitor detail, no live refresh, doesn't need a
  heartbeat to stay meaningful at a 5-minute grain).

## Architecture

```
Browser tab (consented)
  └─ heartbeat every 15s while document.visibilityState === "visible"
       │  (same session_id/visitor_id/pathname as the existing tracker)
       ▼
POST /api/analytics/track  { eventType: "heartbeat", ... }
  ├─ resolve signed-in identity SERVER-SIDE from the session cookie
  │    (getAuthenticatedUser() — never trust a client-supplied name/email)
  ├─ resolve coarse geo from Vercel's edge-resolved headers
  │    (x-vercel-ip-country / x-vercel-ip-city — raw IP never touched)
  ├─ classify User-Agent as bot/not (display filter only, not an access
  │    control — see "Bot filtering" below)
  └─ insert into website_analytics_events (event_type: "heartbeat",
       user_id, is_bot, country, city, ...) — ip_address left null

GET /api/admin/live-visitors  (admin-session gated)
  └─ getLiveVisitors() in lib/admin-live-visitors.ts:
       1. rows from [heartbeat, page_view, session_start] in last 60s
       2. latest row per session_id → current page/device/country/user_id
       3. is_bot rows dropped; rows whose page starts with /admin dropped
       4. session_start rows for those session_ids → "here since"
       5. sessions sharing one non-null user_id merged into one visitor
       6. user_id → name/email resolved here, at render time, for the
          handful of live rows only (never stored redundantly per-event)
       ▼
/admin/live (polls the endpoint every 5s)
```

## Identity: what "who" actually means here

- **Signed in** (customer or ambassador role, verified via the same session
  cookie `/account` already trusts): shown by name/email.
- **Signed in as admin/staff**: excluded entirely — this is "who else," not
  a mirror of your own admin session. Belt-and-suspenders: excluded both by
  role check and by page-path (`/admin/*` never appears in the list).
- **Not signed in**: shown as "Anonymous — <city, country or 'unknown'>." No
  attempt to identify them beyond what their own browser/session legitimately
  offers (device class, coarse IP-resolved location, new-vs-returning via
  the existing localStorage id). No fingerprinting added for this feature.

## Multi-tab / multi-device dedup

- Same browser, multiple tabs: already one `session_id` (localStorage is
  shared across tabs), so this is free — step 2 above naturally collapses
  them.
- Same signed-in customer across two sessions (e.g. phone + laptop): merged
  into one visitor entry in step 5, using the most-recently-active session's
  page/device and the earliest first-seen among them for duration.
- Login mid-session: `session_id` doesn't change on login, so the entry
  transitions from grouped-by-session (anonymous) to grouped-by-user
  (named) in place — same row, not a new one. Logout is the same in reverse.
  Session duration is always anchored to `session_id`'s own `session_start`,
  which survives login/logout, so it doesn't reset at the transition.

## Bot filtering

A coarse User-Agent match (`is_bot`, stored per-row) hides obvious
crawlers/headless clients from the **admin display only**. This does not
change what is served to anyone, does not gate access, and does not vary
site behavior by requester — deliberately unlike `access-policy.ts`'s
"uniform wall," which is a different concern (that guards against cloaking
in what the *site* serves; this only curates what one internal dashboard
*counts*). Most real crawlers never run the client JS that sends a
heartbeat at all; this is a backstop for the ones that do (headless
browsers, scraping tools).

## Privacy / data minimization

- Consent: heartbeats obey the exact same `hasAcceptedConsent()` gate as
  the existing tracker. A decline means no heartbeat, ever — same as today.
- No raw IP stored for this feature. Geo comes from Vercel's pre-resolved
  edge headers; the raw address is never read or persisted by the heartbeat
  path.
- No name/email duplicated onto every event row — only `user_id`, resolved
  to a name at admin-page render time, for live rows only.
- Retention: `heartbeat` rows are pruned (see below); they carry no
  business-analytics value once stale, unlike `page_view`/`session_start`.

## Retention

New job in the existing `/api/cron/sweep` job map (runs every 30 min
already, no new cron schedule needed): delete `heartbeat` rows older than
15 minutes — well past the 60s liveness window, comfortable margin against
a slow cron tick. `page_view`/`session_start`/other event types are
untouched (existing analytics/attribution reporting depends on them).

## Resilience

- Tab close/crash: no explicit goodbye signal needed or sent — absence of a
  heartbeat for ~60s is itself the "gone" signal, which is inherently
  robust to an unclean exit.
- Refresh: `session_id` persists (localStorage), first heartbeat fires
  immediately on mount, no gap.
- Back/forward/SPA nav: heartbeat interval reads current pathname from a
  ref, not a closure, so it doesn't restart or miss a beat on navigation.
- Network loss/reconnect: sends are fire-and-forget with a `.catch` no-op;
  a dropped heartbeat just means one missed beat, self-heals on the next
  tick once connectivity returns.

## Schema change

Two nullable columns added to `website_analytics_events` (idempotent
migration, catalog-only change, no table rewrite):

- `user_id uuid references auth.users(id) on delete set null`
- `is_bot boolean not null default false`

Both go through the existing `createOptionalColumnInserter` fallback so a
deploy without the migration degrades instead of breaking analytics.

## Testing

- Unit: bot classification, the pure grouping/dedup function (multi-tab,
  multi-device-same-user, login/logout transition, staleness/age-out,
  admin-path exclusion) — all as plain-data-in/plain-data-out functions,
  no DB needed.
- Route-level: `heartbeat` accepted/rejected by the allow-list; identity
  never taken from the request body.
- Browser (local harness, per BROWSER-TESTING-RUNBOOK.md): logged-in,
  anonymous, declined-consent, admin, multiple tabs, login/logout
  mid-session, refresh, concurrent visitors — confirmed no duplicates and
  correct age-out.
