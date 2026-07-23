# Vanta Labs — Competitive Audit & Premium Build Roadmap

**Date:** 2026-07-23. Synthesized from a review of reputable research-peptide
vendors (Evo Labs Research, Koi Peptides, Limitless Life Nootropics, Amino
Asylum, Core Peptides, Swiss Chems, and others) and authoritative e-commerce UX
research (Baymard, NN/g-adjacent sources, FDA RUO guidance).

> **Guardrail (applies to the whole build):** we describe *patterns and
> principles* only. We do **not** copy any competitor's wording, category
> labels, COA layout, imagery, or code. All category names, disclaimers, and
> product copy are independently written. Nothing here makes a medical/benefit
> claim; everything is framed for laboratory research use only (RUO).

---

## The strategy in one line

Win on **trust, verifiability, and usability** — not price. The single highest-
leverage idea, which **no audited competitor fully does**, is:

> **One lot/batch data model** that powers, from a single source of truth: the
> public COA library, the product page's live purity + COA link, a QR "verify
> this vial" flow, and an in-account **"My Lots"** provenance view — with **COA
> freshness** (current / expiring / expired, from a retest date) shown as a
> first-class visual state everywhere.

Four differentiators fall out of that: (1) per-lot COAs with a chain of trust to
the independent lab; (2) freshness you can see at a glance; (3) verification-
first search (paste a lot # or CAS and land on the verify page); (4) RUO
compliance enforced in code, not just a footer.

---

## What the best competitors do well (and where they slip)

| Theme | Best-in-class pattern | Common failure we beat |
|---|---|---|
| COA library | Public, on-site, **searchable by lot # or compound**, per-batch, names the accredited lab, shows chromatogram + HPLC purity + MS identity | COAs "on request" or generic/not lot-specific (a repeated Limitless critique); self-hosted PDFs with no link back to the lab |
| Product page | Dense, scannable **spec table** (CAS, formula, MW, sequence, storage), COA link **next to the buy box**, RUO shown 3×, FAQ/shipping accordions | Wall-of-text with implied benefits; missing hard specs; COA buried; no related/recently-viewed |
| Taxonomy | **Mechanism/goal** buckets (GLP, GH-axis, cytoprotective/healing, longevity, cognitive, metabolic) + a **lab-supplies** category | Category sprawl; **benefit-named** categories that raise FDA exposure |
| Search | Instant/predictive, **products + categories** in one dropdown | Title-only matching; no synonyms; dead-end "0 results" |
| Trust | **Independent, named** third-party testing ("never self-certify"); USA fulfillment; purity guarantee tied to a number | Badge theater; RUO footer while the rest of the marketing implies human use (the FDA "totality of messaging" trap) |
| Dashboard | Orders + tracking, wallet/points, referral | Little beyond order status; opaque point math; **no purchased-lot COAs** |
| Shipping | One policy hub; processing-vs-transit; cold-chain; bounded damage/return window paired with a purity guarantee | "All sales final" with no nuance; scattered policies |
| Mobile | **Sticky add-to-cart** with price + variant; RUO travels with the CTA; responsive spec tables | Cramped/slow pages; spec tables overflow; desktop PDFs unreadable on phones |

---

## Where Vanta Labs already stands (from the code inventory)

Already solid: DB-backed products with per-variant batch/COA/purity fields; a
COA library page with search + category filter; premium product pages (batch #,
purity, COA download, molecular formula, testing lab/date, gallery, bundle
pricing, wishlist, subscribe-&-save, back-in-stock, related products, FAQ
accordion); a customer dashboard (orders, tracking, addresses, wishlist,
points/ledger, referral, reorder, ambassador stats); mobile sticky add-to-cart;
consistent trust row + RUO messaging; and broad no-code admin (products,
inventory, memberships, ambassadors, coupons, promotions, homepage/hero,
policies).

So this is **improvement work, not a rebuild.** The gaps below are what turn a
"good store" into "the most professional lab in the category."

---

## Prioritized roadmap (mapped to your feature list)

Each item notes **effort** and whether it needs staging to fully verify.

### P1 — Premium product pages (in progress)
- Add spec fields: **molecular weight, CAS number, peptide sequence** (monospace
  + copy button), **storage/handling**, reconstitution note; render as a
  grouped, scannable **Research Data** table (Identity / Physical / Handling).
- **Per-product FAQ** (admin-editable), replacing the static hardcoded list.
- **Recently viewed** rail (client-side, localStorage) + keep related-by-category.
- RUO shown at 3 touchpoints via a shared component. JSON-LD (`Product` +
  `PropertyValue`) for SEO. *Effort: M. Verifiable now (build/tests).*

### P2 — Lot/COA data model + verify flow (the differentiator)
- New `product_lots` table: `lot_id, product_slug, hplc_purity, ms_confirmed,
  tested_on, retest_by, lab_name, lab_report_url, pdf_url, chromatogram_url`.
- **COA library** upgraded to search by **lot # or compound**, per-lot pages
  (`/coa/[lot]`), freshness badge (current/expiring/expired from `retest_by`).
- **QR "verify this vial"**: `/verify/[lot]` with the lot pre-filled, showing
  purity, date, lab, chromatogram, and a deep link to the lab's own portal;
  generate the QR from the lot page. *Effort: L. Model/logic verifiable now;
  full click-through needs staging.*

### P3 — Categories as a real taxonomy
- `categories` table (slug, name, description, image, position, parent_id).
- Admin CRUD; **header nav dropdown**; per-category landing pages; faceted
  filters (purity, price, format, in-stock, **has-current-COA**).
- Names stay **mechanism-oriented, never outcome-oriented** (compliance).
  *Effort: L. Needs staging for full nav click-through.*

### P4 — Instant predictive search
- `/api/catalog/search-suggest?q=` returning grouped suggestions: **Products**
  (thumbnail, price, purity chip), **Categories**, and **COA lots / CAS**.
- Header typeahead: debounced, **keyboard-navigable** (↑/↓/Enter/Esc, ARIA
  combobox), full-screen modal on mobile, typo tolerance + alias map (BPC-157 ↔
  BPC157), deliberate **no-results** state. *Effort: M. Ranking logic testable
  now; UI needs staging to click.*

### P5 — Dashboard "My Lots" + downloadable COAs
- Tie each ordered item to its lot and surface its COA + freshness in-account;
  per-order document bundle. Add per-referral history list. *Effort: M.*

### P6 — Shipping/policy hub
- One canonical page with anchored sections (processing vs transit, carriers,
  cold-chain handling, damage/lost **claim flow**, purity guarantee,
  international) — admin-editable, reused in product-page accordions.
  *Effort: S–M.*

### P7 — Trust & compliance hardening
- A shared RUO/"not for human consumption" block on product, cart, checkout.
- A **Quality page** (methodology, lab credentials, thresholds, failed-lot
  policy, purity/replacement guarantee).
- A **content compliance check** (CI/test) that flags human-dosing verbs and
  benefit/disease terms in product + blog copy before publish — directly
  addresses the FDA "totality of messaging" risk that competitors fail.
  *Effort: M.*

### P8 — Admin no-code completeness
- Category manager (P3), **standalone COA/lot manager with PDF upload** (P2),
  a real **blog/article** table + CRUD (today only a fixed set is editable), and
  a dismissible **shipping-notice banner** entity. *Effort: M–L.*

### P9 — Mobile & performance polish
- Keep sticky bar CLS-safe (IntersectionObserver, reserved space, transform
  animation); stacked spec tables under 480px in an `overflow-x` guard;
  lazy-load chromatograms; render COA as responsive HTML with PDF as download.
  *Effort: S–M.*

---

## Compliance guardrails baked into the build (non-negotiable)

- **Mechanism-based category and product language.** No "fat loss", "muscle
  growth", "anti-aging" as outcomes; use "GLP-1 / metabolic research", "GH
  secretagogues", etc.
- **RUO + "not for human consumption"** rendered by a shared component on every
  product, cart, and checkout surface, plus the existing checkout acknowledgment.
- **No dosing/protocol/benefit/therapeutic claims** anywhere, including FAQs and
  blog. Characterize identity, purity, handling, storage — not effects.
- **Third-party testing framed as verifiable fact** (named lab, linkable
  record), never as a health claim.
- A pre-publish content check enforces the above so a future admin can't
  accidentally reintroduce risk.

---

## Execution order

Building in the P-order above, each in committed, independently-verifiable
increments (unit tests + typecheck + build green at every commit). Items whose
**logic** is verifiable in this container are proven here; items needing a live
app (nav click-through, search dropdown, QR scan) are wired + reviewed and get
their end-to-end pass the moment staging is connected (see `STAGING_SETUP.md`).
