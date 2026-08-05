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

### 2026-08-05 (later, revised) — `variant` now means the dose, per the contract

Confirmed root cause of the warehouse report (order 127902: "print vial label"
offered for MOTS-C, not for GLP-1 5mg). It is a straight violation of our own
integration spec, `docs/3PL-INTEGRATION-REQUIREMENTS.md` §5: *"Our `sku` is the
product slug (e.g. `glp-1`) and `variant` is the dose (e.g. `5mg`). Inventory
callbacks must match on the same pair."* The code sent `product_doses.id` — a
UUID — as `variant`.

Two consequences, both real:
1. **Vial labels.** A label is per-strength, so the partner needs the dose to
   choose a template and got a UUID instead. MOTS-C has no dose, so its slug
   identified the vial and printed. Affects every dosed product.
2. **Inventory sync, silently broken.** A partner following the spec sends
   `variant: "5mg"`; the handler ran `.eq("id", "5mg")` against a uuid column —
   a Postgres type error whose result was discarded unchecked. Dose-level stock
   never updated for any dosed product, so a sold-out dose could keep selling.
   This is the exact failure an earlier fix claimed to have closed.

Fixed both directions. Outbound `variant` is the dose label; the internal id
moves to `variant_id`; `variant_sku` and `batch_number` added for the label
itself; an unresolvable dose falls back to the raw suffix rather than null
(null would read as "no strengths", which is how a wrong vial gets picked).
Inbound matches on label or slug suffix (case/space-insensitive) with UUIDs
still accepted, compared in JS rather than in the query, and an unmatched dose
is logged and skipped instead of written product-wide.

**Still to confirm (not code):** Steph re-checking a dosed order after deploy,
and whether per-dose SKUs are populated in Admin → Products.

873 tests (was 865), tsc and lint clean, production build succeeds.

### 2026-08-05 (superseded by the entry above) — vial-label identity, first pass

Warehouse report (order 127902, a Vanta Labs reship): "print vial label" was
offered for the MOTS-C line but not for GLP-1 5mg.

Cause on our side: a vial label is per-strength, but a dosed line was sent as
base slug (`glp-1`) plus this store's internal `product_doses.id` UUID — which
matches nothing in the 3PL's catalogue, leaving a label template nothing to key
on. A single-dose product like MOTS-C has no variant, so its plain slug
identifies the vial and its label prints. `product_doses.sku` already existed in
our schema and was never transmitted.

Line items now also carry `variant_sku`, `variant_label` / `dose`, and
`batch_number`, ADDED alongside the untouched `sku`/`variant` so the inbound
inventory-sync contract is unchanged. Dose lookup is best-effort: a failure
transmits the order with the identifiers it always had rather than stranding it.

**Still to confirm with the 3PL:** which field their label template reads, and
whether the per-dose SKUs are actually populated in Admin → Products (a blank
one sends `variant_sku: null` and changes nothing). It remains possible the
label template is simply missing on their side for that SKU.

871 tests (was 865), tsc and lint clean, production build succeeds.

### 2026-08-05 — pre-launch checklist pass (Claude, at the owner's request)

Three code gaps from the owner's pre-launch list, plus an honest status writeup
of the rest. Full item-by-item detail:
`website/docs/PRE-LAUNCH-CHECKLIST-STATUS.md`.

1. **Volume-based product cost discount** (was not implemented at all):
   $5,000 → 20% off per-vial cost, $10,000 → 30%. Built to the terms printed on
   the EVO wholesale sheet (June 16, 2026): *"Tier set each month from the prior
   month's total product purchases."* That is **prior month**, not month-to-date,
   and **product purchases** (per-vial spend with EVO, shipping excluded), not
   retail sales revenue — the owner's brief said "sales", and at ~$30/vial the
   two differ by the whole retail margin, so measuring revenue would have granted
   tiers never earned under the sheet. Rate is fixed for the whole month; first
   month is 0% (no prior month). The resolved cost is frozen onto each order and
   fed to BOTH the recorded COGS and the checkout profit floor, so the guard and
   the books can't disagree. Fails to 0% (full cost) if the total can't be read.
   Editable in Control Center → Volume Cost Discount. Migration:
   `volume-cost-discount.sql` (audit column only; the discount works without it).
   **Open with EVO:** whether "purchases" is measured pre- or post-discount, and
   that the sheet's own 30-day validity has lapsed.
2. **Shipment confirmation gated on movement, not paperwork**: a label event can
   no longer produce a "shipped" signal or email, even when the 3PL reports a
   label purchase as `status: "shipped"`. Labelled orders read "Being prepared".
   Shipment progress is now monotonic, so a late webhook can't reverse a shipped
   order or re-fire the email.
3. **Sender identity forced to Vanta Labs**: the From line was unguarded free
   text (template bodies were already swept). The display name is now always
   rewritten to "Vanta Labs"; a From address belonging to another company blocks
   sending entirely rather than mis-branding it, and Admin → Status names the
   offending address.

Verified: 859 tests (was 817), tsc clean, lint clean, production build succeeds.

**Not actioned, deliberately:** the fulfilment checks (owner asked for Stephan's
team, not Claude), the end-to-end test order (needs real money/label/package),
and the 40-product COA order (a commercial decision, no code involved).

**Could not verify:** this session has no access to the live Vanta Supabase
project (permission denied), so the stuck orders and the payment processor's
live state could not be inspected. Diagnosis path is in §3 of the status doc.

### 2026-07-30 — PR #26 merged to `main` (Claude, at the owner's request)

**PR #26** (`b51b2a4`): membership page fully redesigned to the site's brand
language — matte black + hairline borders + serif type with ONE deep muted
emerald accent; all gold removed; watch-style hairline badges; unified glass
chips (store credit = the only emerald tint); site-standard vl2 buttons;
monochrome calculator with a single emerald verdict; Elite bulk panel
de-golded to a matte lab panel. Visual only — functionality untouched.

**Tracking baseline for third-party review now moves to `b51b2a4`.**

### 2026-07-30 — PR #25 merged to `main` (Claude, at the owner's request)

**PR #25** (`a45e65c`): membership tier cards brightened — luminous champagne
treatment (glowing card borders/halos, gold-gradient badges + CTAs, champagne
member-pricing chips, emerald store-credit chips, emerald checks) plus a
"Free account included — track your savings" line under CTAs for signed-out
visitors (account requirement already enforced by the login redirect).

**Tracking baseline for third-party review now moves to `a45e65c`.**

### 2026-07-30 — PR #24 merged to `main` (Claude, at the owner's request)

**PR #24** (`a753d1f`): $1/7-day trial removed from the billing signup path
(full period charged immediately; activation strictly gated on a successful
charge — failed/no-processor charges record past_due = no benefits);
duplicate-charge protection hardened (date-scoped idempotency keys + no-op
guard); Admin → Membership gains a Members roster (name, email, exact tier,
billing cycle, status, join date, next billing, store credit); membership
tier cards recolored to monochrome glass + champagne (#e8d9b5).

**Tracking baseline for third-party review now moves to `a753d1f`.**

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
