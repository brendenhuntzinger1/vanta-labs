# Spin-to-win dose ladder — design

**Status:** approved in chat 2026-09-18; technical sections pending discovery pass.
**Supersedes nothing.** Extends `2026-09-16-spin-to-win-design.md`, which assumed one
fixed prize per wedge.

## The problem

A wheel prize today is one product at one dose. `SPIN_PRIZES` carries only a
`productSlug`, so `quoteOrder` resolves the gift to whichever dose the catalogue
marks `is_default`, and the customer has no say. Four of the thirteen product
wedges sell in several sizes:

| Product | Doses | What the wheel gives |
|---|---|---|
| GLP-1 | 5 / 10 / 20 / 30mg | 5mg |
| GLP-2 | 5 / 10 / 20 / 30mg | 5mg |
| GLP-3 | 5 / 10 / 20 / 30mg | 5mg |
| HGH GH-191 | 24iu / 36iu | 24iu |

Winning "free GLP-1" and being handed the smallest vial with no choice is a
weaker prize than it looks, and it leaves the larger sizes doing no commercial
work at all.

## The goal

Let the winner choose the dose, with a higher order minimum on each larger one,
such that **stepping up is always visibly worth it** — and the store stays
comfortably profitable on every rung.

## Why a flat multiple fails

The existing convention sets a minimum at roughly twice the gift's retail price.
Applied per dose that reads as fair and is useless: at a constant multiple `k`,
upgrading costs `k × Δretail` to gain `Δretail`, so for any `k > 1` every step up
is a losing trade and the rational customer always takes the smallest vial.

**For an upgrade to pull, the multiple must fall as the dose rises.** That is the
entire mechanism.

## The rule

    minimum(dose) = entry_minimum + (retail(dose) − retail(entry_dose)) × 0.8

- `entry_minimum` is twice the entry dose's retail, rounded to $5 — unchanged
  from today's convention, so the bottom rung keeps its current economics.
- The `0.8` step factor means each extra dollar of free product costs the
  customer 80c of extra spend. Every upgrade is a gain, by construction.
- Rounded to the nearest $5.
- HGH keeps its live $125 entry rather than the computed $130: it is already set,
  and moving it buys nothing.

## The ladder

Retail and cost are live `product_doses` values read 2026-09-18.

### GLP-1 — entry retail $44.99

| Dose | Retail | Cost | Minimum | Step costs | Step gains |
|---|---|---|---|---|---|
| 5mg | $44.99 | $3.83 | $90 | — | — |
| 10mg | $64.99 | $4.84 | $105 | +$15 | +$20 |
| 20mg | $114.99 | $7.24 | $145 | +$40 | +$50 |
| 30mg | $144.99 | $8.80 | $170 | +$25 | +$30 |

### GLP-2 — entry retail $49.99

| Dose | Retail | Cost | Minimum | Step costs | Step gains |
|---|---|---|---|---|---|
| 5mg | $49.99 | $4.38 | $100 | — | — |
| 10mg | $69.99 | $6.13 | $115 | +$15 | +$20 |
| 20mg | $119.99 | $9.63 | $155 | +$40 | +$50 |
| 30mg | $144.99 | $12.80 | $175 | +$20 | +$25 |

### GLP-3 — entry retail $49.99

| Dose | Retail | Cost | Minimum | Step costs | Step gains |
|---|---|---|---|---|---|
| 5mg | $49.99 | $6.32 | $100 | — | — |
| 10mg | $69.99 | $10.47 | $115 | +$15 | +$20 |
| 20mg | $119.99 | $15.21 | $155 | +$40 | +$50 |
| 30mg | $169.99 | $18.75 | $195 | +$40 | +$50 |

### HGH GH-191 — entry retail $64.99

| Dose | Retail | Cost | Minimum | Step costs | Step gains |
|---|---|---|---|---|---|
| 24iu | $64.99 | $12.00 | $125 | — | — |
| 36iu | $84.99 | $16.34 | $140 | +$15 | +$20 |

All fourteen rungs satisfy `step cost <= step gain`.

## Profitability

Stress tested against the worst case the catalogue permits: the customer spends
the entire minimum on Cagrilintide, the lowest-margin product at 72.7%, and takes
the largest free vial.

| Scenario | Lowest margin on any rung |
|---|---|
| Worst product in catalogue (72.7% margin) | **61.0%** |
| Typical product (87.4% median margin) | **75.7%** |

Worked example — a $170 order taking the free 30mg GLP-1:

    customer pays          $170.00
    COGS on the basket     -$21.42   (at median 87.4% margin)
    COGS on the free vial   -$8.80
    ---------------------------------
    gross profit           $139.78   (82.2%)

The existing "gift cost under 20% of the minimum it gates" rule is never
approached; the worst rung is HGH 36iu at 11.7%.

Model: `scripts/ladder.py` in the session scratchpad; values reproduced above.

## Customer experience

After the reveal, a multi-dose winner picks from a list. Each row shows the dose,
the minimum, and — for every rung above the first — the incremental trade, which
is the line that does the persuading:

    5mg    spend $90
    10mg   spend $105    +$15 for $20 more
    20mg   spend $145    +$40 for $50 more
    30mg   spend $170    +$25 for $30 more     BEST VALUE

Single-dose wedges and the three percentage wedges skip this step entirely.

## Decisions taken

- **Abandoning the picker defaults to the entry dose.** A won prize is never left
  unusable. The choice stays changeable until the offer expires.
- **No migration.** One unredeemed wheel offer exists and it is a percentage
  reward, unaffected.
- **Choice is stored in `customer_offers.variant_id`**, which already exists and
  which `quoteOrder` already honours — the checkout path needs no change.

## Open — resolved by the discovery pass

- Exact shape of the per-dose ladder on `SpinPrize`.
- Where the picker slots into `spin/page.tsx` and what it needs from the server.
- Whether re-choosing a dose can violate any minting or idempotency invariant.
- Which other surfaces (disclosure copy, admin panel, emails) render a dose or a
  minimum and would go stale.

## Guard tests this must ship with

1. Every rung satisfies `step cost <= step gain`.
2. Every rung keeps gift cost under 20% of its minimum.
3. Every dose label in the prize table matches a real, enabled `product_doses`
   row for that slug — closing the silent-drift bug where a label is a hardcoded
   string with nothing tying it to the catalogue.
4. A single-dose wedge still mints exactly as it does today.

---

## Verification record (2026-09-18)

### Automated

| Check | Result |
|---|---|
| Full vitest suite | 11,647 passed · 11 skipped · 756 files |
| `tsc --noEmit` | clean |
| eslint (changed paths) | clean |
| `next build` | succeeds |
| Real-Postgres spin DB tests | 15/15 (4 new re-spin regressions) |
| Dose tamper matrix | 18/18 |
| Dose redemption via real `quoteOrder` | 7/7 |

### The harness E2E, and why its failures are not ours

`scripts/qa-wheel-campaign.mjs` scores **28/36** on this branch. Rather than
assume the 8 failures were pre-existing, `origin/main` (6e4793a6) was built in a
worktree and run against the same Postgres, the same seeded catalogue and the
same payment stub:

    this branch   28/36 — 8 FAILED
    origin/main   28/36 — 8 FAILED   (same steps, same `no_offer` at step 10)

Identical. The same run also printed `min=$99.00` for GLP-1 on main against
`$90.00` here, confirming the ladder is live and nothing else moved.

The 8 are a harness gap, not a regression: `readOfferStatus` returns null for
the harness's offer cookie, so the till never attaches the prize and the
redemption leg cannot complete locally. **The redemption leg is therefore
UNVERIFIED by the harness E2E** and is covered instead by
`spin-dose-redemption.test.ts`, which drives the real `quoteOrder`, and by the
real-Postgres DB tests.

The harness also needed seeding before the script could run at all: it ships six
synthetic products, none of which are wheel prizes. The nine prize products and
their 17 doses were added locally; that seed is harness-only and touches no
production data.

### Production

The cycle-close fix was applied to production as
`customer_offer_close_cycle_spares_spin_prizes` and verified by reading the
deployed body back: spin excluded, reserve guard intact, advisory lock intact.
Six spin rows, unchanged — 0 cycle-closed, 2 live, 0 redeemed.
