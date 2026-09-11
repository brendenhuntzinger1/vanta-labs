# Vanta Labs — ground truth measured from production, 2026-09-11
(read-only queries, Supabase project mlpimwgkwuqpsvsrlpqv)

## Scale — the number that reframes the whole SMS question
| Metric | Value |
|---|---|
| Paid orders, all time | **15** (2026-08-02 → 2026-09-10, ~5.5 weeks) |
| Distinct paying customers | **10** |
| Orders, all statuses | 44 (5 pending_payment) |
| Auth users | 143 |
| Marketing subscribers (email) | **79**, none unsubscribed |
| Email suppressions | 3 |
| Abandoned carts | 44 total, **17 still open** |

Total paid subtotal ≈ $1,979; total collected ≈ $1,710.

## Discounting — already deep BEFORE any SMS offer
| Metric | Value |
|---|---|
| Avg subtotal | $131.93 |
| Avg amount paid | $114.03 |
| Avg discount | $29.93 |
| **Discount as share of subtotal** | **22.7%** |
| Orders carrying a discount | 7 of 15 (47%) |
| with referral / coupon / bulk / store credit | 1 / 3 / 0 / 0 |

## Margin — two contradictory figures in the codebase; resolved
- `PRICING_STRATEGY.md` (2026-07-23, EVO wholesale cost sheet): blended merchandise
  margin 52% → 58.5% after reprice.
- `cart-recovery-tiers.ts`: "0.163 ... this store's 83.7% blended margin".
- **Measured now:** default doses, revenue-weighted COGS = **0.1883 → 81.2% margin**
  at list price. 39 of 46 default doses carry a cost; the 7 without also have
  price 0, so they bias nothing.
- The two figures are NOT in conflict: `products.product_cost_cents` holds inherited
  EvoLabs numbers that `quote-order.ts` measures at 1.4–6.8x TRUE landed cost and
  refuses to price from. Dose-level costs are the corrected ones. 81% is real at
  LIST price.
- BUT the profit guard prices at `WORST_CASE_UNIT_COST_DEFAULT = $33/unit` when a
  SKU has no cost on file, and `PROCESSING_FEE_DEFAULT_PERCENT = 8`. Two cost
  models coexist. The margin shown on the give-away screen is the optimistic one.
- Postage is a REAL cost on every order (store ships free sitewide when that flag
  is on); fallback average $7.93/shipment. Fixed cost → hits small carts hardest.

## Phone data already in the database — the TCPA trap
| Source | Rows with a phone |
|---|---|
| `orders.phone` | 39 rows, **16 distinct numbers** |
| `ambassadors.phone` | 21 |
| `customer_preferences.phone` | 0 |
| `partners.phone` | (column exists) |

~35 distinct numbers exist today. **Every one was collected for shipping/contact,
none carries marketing consent.** Texting them is the single most likely way this
programme generates liability. Must be an enforced suppression rule, not a note.

## Existing lifecycle machinery (do not rebuild)
- Cron: `/api/cron/sweep` every 30 min; `/api/cron/lifecycle` at :05,:20,:35,:50.
- 7 priority-ordered email automations (`automation-catalog.ts`), 4-stage cart
  recovery, browse abandonment, campaigns + A/B, segments.
- `claimMarketingSend()` + `MARKETING_QUIET_MS` (24h) quiet family — the existing
  cross-message choke point.
- Discount competition: ONE discount wins, greatest savings, shared by
  `discount-resolution.ts` (cart) and `profit-engine.resolveCustomerDiscount`
  (server); parity enforced by `cart-server-discount-parity.test.ts`.
- Commission accrues on the **discounted** subtotal (`profit-engine.ts:351`) and is
  separate from the customer discount — so a referral that LOSES the discount
  contest still costs commission.
- `customer-offers.ts`: per-customer one-time offers, sha256-hashed bearer tokens.
- 677 test files. Age gate 21+, research-use-only positioning throughout.

## Implication held for the strategy doc
A2P 10DLC is still pending, so nothing can send. That is the right window to build
the consent/verification/orchestration spine — the part that is legally dangerous
to retrofit — and the wrong moment to hard-code a permanent 15% discount into a
store already giving away 22.7% of subtotal to 10 customers.
