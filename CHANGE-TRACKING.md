# Change Tracking Log — Vanta Labs

Purpose: track every change made across **GitHub, Vercel, Supabase, and the live
website** while a third party reviews and edits the project, and explain in plain
English what each change did.

Each monitoring pass appends a dated entry below. The top section is the fixed
baseline the passes are compared against.

---

## Coverage & blind spots (read this first)

What can actually be observed depends on where a change lands:

| Platform  | What I can see | How |
|-----------|----------------|-----|
| **GitHub** | Everything — commits, PRs, branches, file diffs, reviews, CI results | Full API access |
| **Website (code)** | All of it — the site is built from this repo, so any code/UI/logic change is a GitHub commit | Via GitHub |
| **Vercel** | Only what reaches the repo (deploys are triggered by GitHub pushes) | Indirect |
| **Supabase** | Only schema changes committed as SQL files in `website/src/lib/sql/` | Indirect |

**Blind spots** (no direct API access from this environment):
- **Vercel dashboard-only changes** — environment variables, domains, project
  settings, redeploys, rollbacks. Not visible unless they touch the repo.
- **Supabase data/schema changes made directly** — products, prices, inventory,
  content edited through the admin dashboard or Supabase Studio live in the
  database, not in git, so they leave no trace here.

To close those blind spots, a **read-only** Vercel token and/or Supabase
(service-role or read-only DB) connection would be needed. Until then, GitHub is
the window, and it captures every *code* change completely.

---

## Baseline snapshot — 2026-07-28T17:55Z

**`main` HEAD:** `a8dea425ed1e1bed244d4a9433ff3cd48b71f1f4`
— "Add Vanta Labs favicon set (V monogram tabs + wordmark install icons) (#15)"

**Branches at baseline (11):**
| Branch | HEAD SHA |
|--------|----------|
| main | a8dea42 |
| claude/batch-testing-3pl-setup-2vf8su | af2ee9e |
| claude/chat-session-lhkhnz | 28dab8a |
| claude/continue-previous-work-kqo7s9 | 1a9ae84 |
| claude/continue-working-06kews | 9f0b660 |
| claude/ecommerce-platform-audit-h4oxln | 529a642 |
| claude/glp1-site-pricing-5a6860 | 5bf89c7 |
| claude/vanta-labs-connection-6wicam | 9ed80a0 |
| claude/vercel-migration-5jinmh | 188ab69 |
| claude/website-editing-gqujtb | f3329b2 |
| vercel-agent/launch-hardening | e69a83e |

**Pull requests at baseline:** #1–#15, all closed/merged. Latest merged: #15
(favicon set), #14 (non-payment launch hardening, opened by vercel[bot]).

**Open PRs:** none.

No third-party changes recorded yet — this is the starting line.

---

## Change log

_(New entries appended here, newest first, as changes are detected.)_

### 2026-07-30 — PR #23 merged to `main` (Claude, at the owner's request)

**PR #23** (`0acfa5e`): membership economics guardrail — permanent Monte
Carlo test (~10k member-months/tier through the real pricing engine, owner
economics: $31 COGS, $15 ship cost, 8% processing, zero protection revenue).
All tiers profitable on average (Essential $175.84/mo → Black $149.68/mo);
assertions block any future tier change that turns unprofitable. Plus luxe
tier-card polish (serif names/pricing, gold chips/checks, emoji-stripped
benefits).

**Tracking baseline for third-party review now moves to `0acfa5e`.**

### 2026-07-30 — PR #22 merged to `main` (Claude, at the owner's request)

**PR #22** (`b7c4777`): membership program overhaul — dollar-based member
pricing on every product surface (cards/PDP/cart), honest cart upsell that
only shows when joining pays for itself, redesigned membership landing
(club positioning, Best For personas, Most Popular/Best Value, annual
"2 months free"), LIVE cart-connected savings calculator, dashboard
lifetime-savings panel. $1/7-day trial messaging removed per owner
("Join today · Cancel anytime · Benefits start immediately").

**Owner admin steps pending:** untick per-tier "intro offer" in
Admin → Membership so billing matches the no-trial messaging.

**Tracking baseline for third-party review now moves to `b7c4777`.**

### 2026-07-30 — PRs #20 + #21 merged to `main` (Claude, at the owner's request)

**PR #20** (`7406e98`): coupon promo banner restyled to black-glass gold with
sheen; NEW private/unlisted coupons (Admin → Coupons checkbox; valid at
checkout, never advertised; migration coupon-private-flag.sql).

**PR #21** (`1ba269d`): one-click replacement shipments — Admin order page
'Send replacement' creates a linked $0 order (reason + note, per-item
selection), flows through the 3PL pipeline, decrements stock, audit-logs the
claim, emails the customer (migration replacement-orders.sql). Also fixed a
pre-existing silent no-op in the webhook's fallback inventory decrement
(snake_case/camelCase key mismatch).

**Owner Supabase steps pending at time of entry:** run
coupon-private-flag.sql and replacement-orders.sql.

**Tracking baseline for third-party review now moves to `1ba269d`.**

### 2026-07-29 — PRs #18 + #19 merged to `main` (Claude, at the owner's request)

**PR #18** (`01869b2`): cart overhaul — mobile checkout bug fixed (CTA was
pushed off-screen by a non-scrolling drawer footer; now sticky + safe-area
padded), quantity/remove controls in drawer AND checkout summary, tappable
"Buy N more → X% off" bundle nudges, protection at 4% (percent hidden,
"(Recommended)"), Service Fee default 3%, dead sales-tax hint row removed,
and a real shipping bug fix: blank Control Center fields resolved to $0
(free shipping for everyone) — blank now falls back to $15/$250 defaults;
same blank-guard added to referral/profit/bulk-savings settings.

**PR #19** (`6ad6105`): mobile compaction pass (86svh hero, tighter
sections/cards/header, side-by-side card buttons, instant taps, smooth
scroll) + promo banners restyled from green to champagne gold.

**Tracking baseline for third-party review now moves to `6ad6105`.**

### 2026-07-29 — PR #17 merged to `main` (Claude, at the owner's request)

**New `main` HEAD:** `9861957` (merge of PR #17). Owner-directed changes:
1. Shipping Protection repriced to **3% of merchandise subtotal** and **added
   by default** (visible pre-checked line, one untick removes it).
   Reconciliation window now per-order.
2. **5% card processing fee enabled by default** (owner accepted the
   card-network surcharge-cap caveat; tunable in Admin → Payments → Settings).
3. **Control Center tab** added to the admin nav (/admin#control-editor).

Owner also unchecked FL in Sales Tax settings — store currently collects **no
sales tax anywhere** (dashboard setting, not code).

**Tracking baseline for third-party review now moves to `9861957`.**

### 2026-07-29 — PR #16 merged to `main` (Claude, at the owner's request)

**New `main` HEAD:** `bbbb51b` (merge of PR #16). Not third-party work — these
are the changes the owner asked Claude for in this session:

1. **Dynamic address-based sales tax** (replaces the flat 8% rate):
   - Tax resolved from the shipping address; collected only for admin-
     configured nexus states at destination-state combined rates.
   - New shared engine `website/src/lib/sales-tax.ts` + server seam
     `tax-provider.ts` (TaxJar/Avalara-ready), live recalculation at checkout,
     per-order `tax_amount`/`tax_rate_percent`/`tax_state` recordkeeping.
   - Admin: Control Center → Sales Tax (nexus checkboxes), orders Tax column,
     order-detail Charges card, by-state report + CSV export on the Business
     Dashboard, System Status warning when unconfigured.
   - Migration to run once in Supabase: `website/src/lib/sql/dynamic-sales-tax.sql`.
2. **Homepage hero**: removed the "View Certificates of Analysis" button
   (COA library remains in the nav); vial video hardened to autoplay/loop with
   no play-pause affordance (iOS Low Power Mode remains an OS-level exception).
3. `CHANGE-TRACKING.md` baseline (this file).

Verified before merge: 318 tests, clean build/typecheck/lint.

**Owner action still pending at time of entry:** run the Supabase migration,
then check nexus state(s) in Control Center → Sales Tax (until then the store
collects no tax anywhere).

**Tracking baseline for third-party review now moves to `bbbb51b`.**
