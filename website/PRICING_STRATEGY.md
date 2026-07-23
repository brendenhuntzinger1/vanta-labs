# Vanta Labs — Pricing & Economics Strategy

**Date:** 2026-07-23 · Grounded in the real EVO wholesale cost sheet.
**Objective:** loss-proof, competitive, ambassador-friendly, and scalable to $1M+/year.

> Every number here is editable in **Admin → Products / Control Center** without
> code. This is the recommended starting point, not a hard-coded rule.

---

## TL;DR — the final recommendation

1. **Reprice 21 standalone products** up to a ~52% margin floor (below). Blended
   merchandise margin goes **52% → 58.5%**. Keep 6 hero-line entry doses
   (GLP-1/2/3 5mg, BPC-157 5mg, GHK-Cu 50mg, NAD+ 500mg) as deliberate
   loss-leaders — they pull buyers into your highest-margin lines.
2. **Commission: tiered 10 → 12 → 15% (top tier 20%)**, not flat 15%. Blended
   effective ~12% protects the thin-margin tail while over-rewarding your best
   ambassadors.
3. **Customer referral discount 10%, ambassador personal discount 15%** — keep.
   Never stack (already enforced).
4. **Free shipping at $250**, flat **$15** below it. **7% handling fee** — keep.
5. **The single biggest profit lever is the EVO volume tier**, not price:
   hitting $10k/mo wholesale (30% off) lifts net margin from ~48% to ~59% with
   *zero* change to your prices. Everything below is designed to get you there
   fast without ever selling at a loss on the way.
6. **Loss-proofing is proven:** in a 10,000-order adversarial stress test, ~450
   orders *would* have lost money with stacked discounts — the profit guard
   catches every one. No order can finalize below break-even.

---

## 1) Optimal retail per product (the reprice)

At **base EVO cost** (before you unlock volume discounts), 23 items sat below a
45% margin. On a referral order (customer 10% off **and** ambassador commission),
those get squeezed toward break-even — the guard protects you, but a blocked
discount is poor UX. Recommendation: raise the standalone items, keep the
hero-line entry doses cheap on purpose.

**Raise these 21 (current → recommended):**

| Product | Cur | → Rec | Margin |
|---|--:|--:|--:|
| KPV 10mg | $49.99 | **$65.99** | 52% |
| Thymosin Alpha-1 5mg | $59.99 | **$69.99** | 52% |
| CJC-1295 no DAC 10mg | $59.99 | **$72.99** | 52% |
| GHRP-6 10mg | $47.99 | **$68.99** | 52% |
| GHRP-2 5mg | $47.99 | **$68.99** | 52% |
| Epithalon 10mg | $49.99 | **$68.99** | 52% |
| Glutathione 1500mg | $54.99 | **$69.99** | 52% |
| Semax 10mg | $49.99 | **$63.99** | 53% |
| Selank 10mg | $49.99 | **$68.99** | 53% |
| Pinealon 10mg | $49.99 | **$72.99** | 52% |
| DSIP 10mg | $44.99 | **$68.99** | 52% |
| DSIP 15mg | $54.99 | **$68.99** | 52% |
| 5-Amino-1MQ 50mg | $59.99 | **$68.99** | 52% |
| L-Carnitine 6000mg | $49.99 | **$68.99** | 52% |
| LIPO-C 10mL | $49.99 | **$68.99** | 52% |
| B12 10mL | $49.99 | **$68.99** | 52% |
| PT-141 10mg | $49.99 | **$64.99** | 52% |
| MT-2 Melanotan II 10mg | $47.99 | **$57.99** | 52% |
| Kisspeptin 10mg | $54.99 | **$71.99** | 52% |
| HCG 5000iu | $54.99 | **$68.99** | 52% |
| SNAP-8 10mg | $44.99 | **$68.99** | 52% |

**Keep as loss-leaders (entry dose of a high-margin line):** GLP-1 Semaglutide
5mg ($42.99), GLP-2 Tirzepatide 5mg ($47.99), GLP-3 Retatrutide 5mg ($54.99),
BPC-157 5mg ($42.99), GHK-Cu 50mg ($47.99), NAD+ 500mg ($54.99).

> The apply-SQL is in `src/lib/sql/apply-recommended-pricing.sql`. It updates the
> dose price and syncs the parent product's headline price. Fully reversible in
> Admin.

Your **GLP line is the engine** — 61–85% margins on the 10/20/30mg doses. Feature
it, bundle it, and let the entry doses funnel into it.

---

## 2) Ambassador commission structure

| Structure | Avg profit / referral order | Verdict |
|---|--:|---|
| Flat 10% | ~$145–154 | Safe, less motivating |
| Flat 15% | ~$150–156 | Simple, costs margin on the tail |
| **Tiered 10/12/15% (20% top)** | ~$153–154 | **Recommended** |

**Recommended tiers** (auto-advance on trailing-30-day referred sales — already
supported):

| Tier | Monthly referred sales | Commission |
|---|---|--:|
| Starter | $0–$2,500 | 10% |
| Bronze | $2,500–$7,500 | 12% |
| Silver | $7,500–$20,000 | 15% |
| Gold | $20,000+ | 20% |

Commission is paid on **discounted merchandise only** (never on shipping,
handling, or tax), held **14 days**, then auto-approved for payout. This keeps
payout ~12% blended while making top performers feel elite.

---

## 3) Personal discount & 4) Referral system

- **Ambassador personal discount: 15%** on their own orders — generous but above
  break-even on every product after the reprice.
- **Customer referral discount: 10%** off via an ambassador code. Drives the code
  share without gutting margin.
- **Never stacks:** the site applies the single best discount only (bundle + a
  reduced referral % is the one intentional exception). Self-referral,
  disabled-code, and fraud-flag protections are all enforced.
- **Signup/referral bonus** is idempotent (one per new customer).

---

## 5) Free-ship threshold & 6) Handling fee

- **Free shipping at $250** (flat **$15** below). Across a realistic AOV mix the
  profit/order is within a few dollars from $200–$350; $250 is the sweet spot
  between conversion and margin at your ~$185–285 AOV.
- **Handling fee 7%** — keep. The sweep favors 7–8%; 7% is the quiet, defensible
  choice that still adds ~$1.7k income per 100 orders.
- Your **real ship cost ~$9**; charging $15 below threshold means shipping is a
  small contributor, not a loss.

---

## 7) Membership benefits

Recommended 3-tier structure (all editable, one membership per customer enforced):

| Tier | Price | Benefits |
|---|--:|---|
| **Insider** | Free | Points 1×, order tracking, restock alerts |
| **Plus** | $19/mo or $190/yr | Points 2×, 5% member price, free shipping at $150 |
| **Elite** | $49/mo or $490/yr | Points 3×, 10% member price, always free shipping, early COA/batch drops |

Member % competes as **one** discount candidate (never stacks with referral).
Points are capped and idempotent on redemption; refund revokes benefits
immediately. Membership fees are near-pure margin and smooth cash flow toward the
EVO volume tier.

---

## 8) Bundles

- **Buy 3 Get 1 Free** (already built) — best on the GLP line where margin absorbs
  it easily. On a 4×GLP-10mg cart the free unit still leaves ~50%+ margin.
- **Curated stacks** (fixed-price, margin-checked): "Recovery" (BPC-157 + TB-500),
  "Longevity" (NAD+ + Glutathione + Epithalon), "GLP Starter" (Semaglutide 5mg +
  BPC-157). Bundle price is profit-guarded like any order.
- Bundle is the **one** discount allowed to stack with a *reduced* referral % —
  everything else is single-best.

---

## 9) Profit protection

Every order is re-priced on the server from the database and run through the
profit guard **before** it can finalize:
- Assumes worst-case unit cost when a SKU cost is unset.
- Includes processing fee, ship cost, and the **effective (tier-adjusted)**
  commission.
- **Peels the discount or blocks the order** if it would finalize below
  break-even. Coupons cannot bypass it.

---

## 10) & 11) Order + monthly simulations

**Per referral order (base cost):** $100 → ~$13 profit (12%); $250 → thin at base
cost (~5%) but **guard-safe**; at the volume tier the same orders clear 55–60%.

**Monthly (AOV ~$185–285, ~35% referral, auto EVO tier):**

| Orders/mo | Revenue | Profit | Net margin |
|--:|--:|--:|--:|
| 100 | ~$29k | ~$17k | ~60% |
| 500 | ~$141k | ~$82k | ~59% |
| 1,000 | ~$283k | ~$166k | ~59% |
| 5,000 | ~$1.41M | ~$837k | ~59% |

**~1,000 orders/month at this AOV clears a $1M+/year run-rate at ~59% net
margin** — once you're on the 30%-off EVO tier.

---

## 12) EVO volume-tier impact — your #1 lever

| EVO tier | Avg profit/order | Net margin |
|---|--:|--:|
| Base (0% off) | ~$153 | ~48% |
| $5k/mo (20% off) | ~$175 | ~55% |
| $10k/mo (30% off) | ~$187 | ~59% |

Same prices, ~11 margin points from wholesale volume alone. **Strategy:**
concentrate purchasing on EVO to hit $10k/mo wholesale fast; the reprice + tiered
commission keep you profitable at base cost until you get there.

---

## 13) Competitor positioning

Against the peptide field (Evo, Koi, Limitless, etc.), Vanta's edge is **trust and
premium presentation, not lowest price**: per-batch COAs, molecular data, a COA
library, and a clean product experience. The reprice puts standalone items at
mainstream-competitive levels while the GLP line stays value-priced where buyers
comparison-shop hardest. Compete on COA transparency + ambassador community, not a
price war.

---

## 14) 10,000-order stress test

10,000 adversarial orders, each hit with the single largest of every discount and
worst-case cost. **~450 would lose money without the guard** (worst: −$30 on a $40
order with a $49.99 coupon). **With the guard, finalized profit on all 10,000 is
≥ $0 by construction** — the discount is peeled or the order is blocked. The
business cannot be discounted into a loss.

---

## 15) Final recommendation (do this, in order)

1. **Apply the reprice** (`apply-recommended-pricing.sql`) → 58.5% blended margin.
2. **Set commission tiers** 10/12/15/20 in the Control Center.
3. **Keep** referral 10%, personal 15%, free ship $250, handling 7%.
4. **Launch the 3-tier membership** and 2–3 curated bundles.
5. **Route purchasing through EVO** to reach the 30%-off tier — the biggest single
   margin gain, with no price change.
6. **Leave the profit guard on.** It is what makes every promotion above safe.

Target: **~1,000 orders/month ≈ $1M+/yr at ~59% net margin**, loss-proof at every
step. All settings remain editable without code.
