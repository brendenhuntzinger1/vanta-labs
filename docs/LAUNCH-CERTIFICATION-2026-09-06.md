
---

## 6. Final state

| | |
|---|---|
| Base SHA | `00658a1` (`origin/main` and the deployment in production when the audit began) |
| Audited SHA | `7792003` |
| `main` after merge | `7792003` (fast-forward; `origin/main` did not move during the audit) |
| Production deployment | `dpl_A3yA1A3FkEqpxZFwutmUpxZ7HeQk`, READY, target production, commit `7792003`, aliased to `www.vantalabsresearch.com` |
| Working tree | clean |

**Production source changed by this audit: one file.** `src/app/api/ads/funnel-event/route.ts`.
Everything else on the branch is tests, QA harnesses and this document.

### The gate, run from `7792003`

| | |
|---|---|
| Test files | 614 passed, 1 skipped (615) |
| Tests | 9370 passed, 10 skipped (9380) |
| Skips | `hero-video` (6, media fixtures) and `webhooks/email/live-signature` (4, needs the production signing secret). **No DB-backed suite skipped** — 118 Postgres tests across the six concurrency/SQL files re-run individually and confirmed executing. |
| TypeScript | clean |
| ESLint | 0 errors (59 pre-existing warnings) |
| Production build | success — 241 routes, 107 static pages |

### Browsers, all interacted

| | Chromium | WebKit | Firefox |
|---|---|---|---|
| Journey (desktop / 390 / 375) | 36/36 | 36/36 | 36/36 |
| Portal geometry, 10 viewports | 0 findings | 0 findings | 0 findings |

WebKit is certified over the TLS-fronted harness. On plain http it cannot store
the Secure session cookie and fails every authenticated step — an artifact of
the transport, not of the site, and the reason the runbook insists on §5c.

### QA harnesses

| Suite | Result |
|---|---|
| `qa:roles` | 1099 probes, 0 findings; positive control reached 78 admin routes |
| `qa:crossaccount` | 16 probes, 0 findings |
| `qa:abuse` | 19 steps, 19 passed, 0 skipped |
| `qa:journey` | 70 steps, 70 passed, 0 skipped |
| `qa:purchase` | 18 steps, 18 passed, 0 skipped — desktop and 390x844 |
| `qa:discounts` | 20 checks, all passed — desktop and 390x844 |
| Admin | all 27 admin pages 200 with content under an admin session |

### Production smoke, after the deployment went READY

Wall: `/`, `/products`, a real PDP, an invented PDP, `/coa-library`, `/cart`,
`/checkout`, `/account`, `/account/orders`, `/research`, `/membership` all 307
to the portal with the path preserved; `/api/catalog/products`,
`/api/catalog/bpc-157`, `/api/cart` all 401. Real and invented slugs
indistinguishable. HEAD, `RSC: 1`, `Next-Router-Prefetch` and `?_rsc=` refused
identically to GET.

Public: `/wholesale`, `/ambassador`, `/partner`, `/contact`, `/account/login`,
`/legal/terms`, `/robots.txt`, `/sitemap.xml`, `/site.webmanifest` all 200.

Crawler parity: eight user-agents (Googlebot, bingbot, facebookexternalhit,
Bytespider, Slackbot, curl, an Nmap UA and an ordinary browser) — identical
status and identical `Location`.

funnel-event: six probes of three shapes, two rounds — identical
`{"received":true}` every time, and on the warm round 0.303s / 0.304s / 0.310s,
indistinguishable across shapes.

`/wholesale` anonymous: 0 product-image URLs, 0 storage URLs, 0 Supabase hosts,
0 product slugs. The portal likewise, and it renders both attestations, the
Google button, the "Fastest option" marker and both doors.

Ad attribution: `?utm_source=TikTok&utm_medium=paid&utm_campaign=Hook_A&utm_content=Creative_3&ttclid=ABC123`
arrives at the portal as lowercased tags plus the verbatim click id at the top
level, with the whole original URL preserved inside `next`. Same for a Meta
shape with `fbclid`.

Webhooks: `/api/webhooks/email` 401 (so `EMAIL_WEBHOOK_SECRET` is set — 503
would mean it is not), `/api/webhooks/payment` 400, `/api/webhooks/shippo` 401.
All three configured and rejecting.

Sitemap: the same ten public URLs, no catalogue. `robots.txt`: one `*` group,
`Allow: /` with the gated prefixes disallowed.
