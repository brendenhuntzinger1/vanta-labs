# Performance loop

## Where the numbers come from

Two halves that must be joined before any of this is meaningful:

**Platform-side** (not yet connected — see `platform-eligibility.md`): spend, impressions, CPM, video views, 2s/6s views, completion rate, clicks, CTR, CPC, frequency.

**Site-side** (live now): `website_analytics_events` carries `page_view`, `add_to_cart`, `begin_checkout`, `purchase`, `refund` with UTM and visitor/session identity. `order_attribution` joins a click to the order it produced, holding first touch, last touch, `ttclid`/`fbclid`/`gclid`, landing path, and the visitor/session keys — with `orders` supplying real revenue.

Revenue and profit come from `orders` / `order_items`. **Read them; never recompute them.** The commerce system owns those numbers.

## Two rules about attribution honesty

**An order with no attribution row is unattributed, not organic.** Those are different facts. Never fold unattributed revenue into a campaign to improve a number, and never present measured ROAS as total ROAS — capture sits behind cookie consent, so measured performance is a floor. Say "at least" when you mean at least.

**The system never credits an ad without evidence.** A visitor arriving from tiktok.com with no click ID and no campaign tag is organic. If you find yourself wanting to count it, that impulse is exactly what the attribution layer was built to refuse.

## Minimum data before a confident call

A recommendation from a thin sample is noise wearing a suit, and acting on it repeatedly spends real money proving nothing.

| Decision | Minimum before you commit |
|---|---|
| Kill for weak hook | ≥ 2,000 impressions **and** ≥ 3 days |
| Kill for poor conversion | ≥ 50 clicks **and** ≥ 3 days |
| Declare a winner | ≥ 3× target CPA in spend, ≥ 5 conversions |
| Recommend scaling | ≥ 7 days stable, ≥ 10 conversions |
| Declare fatigue | ≥ 7 days, CTR down ≥ 30% from that ad's own peak |

Below threshold the state is `LEARNING` and the recommendation is "keep going". Say the data is thin rather than manufacturing a verdict from it.

## States

| State | Meaning | Action |
|---|---|---|
| `LEARNING` | Under threshold | Let it run |
| `WATCH` | Enough data, mixed signal | Hold, re-read in 48h |
| `WINNER` | Beats target CPA/ROAS with a real sample | Recommend more budget |
| `SCALE_CANDIDATE` | Winner, stable ≥ 7 days | Recommend a step increase, then re-measure |
| `FATIGUING` | CTR decaying at flat spend | Rotate creative, keep the audience |
| `UNDERPERFORMING` | Misses target on a real sample | Recommend pause + diagnose |
| `INELIGIBLE` | Rejected or policy-risky | Withdraw, do not resubmit variants of it |

Every state change is a **recommendation**. This system does not pause, scale, launch or spend.

## Diagnose before prescribing

The most valuable thing here is separating a creative problem from a funnel problem. They look identical in ROAS and have opposite fixes — replacing creative when the landing page is the issue burns budget and teaches nothing.

| Signal | Read | Fix |
|---|---|---|
| Low 2s view rate | Hook failed | New first two seconds, keep the concept |
| Good views, low CTR | Attention without desire | Middle or CTA |
| Good CTR, low add-to-cart | Ad ≠ landing page | Page, offer, or intent mismatch |
| Good add-to-cart, low purchase | Checkout friction | Not a creative problem — flag it, don't rewrite the ad |
| Good conversion, high CPA | Auction, not creative | Targeting, bidding, CPM |
| Everything decaying together | Fatigue or audience exhaustion | Rotate |

When the funnel is the problem, say so plainly. A creative director who blames creative for a checkout issue costs more than one who admits the ad worked.

## What to do next

- **Winner** → iterate the *variable*, not the concept. Same body, three new hooks. Never rebuild a winner from scratch.
- **Loser with a strong hook but weak body** → keep the hook, rebuild the body.
- **Loser with a weak hook** → retire the hook. Log it. Do not re-propose it in three weeks with different words.
- **Whole archetype failing across concepts** → stop testing inside it; the format is wrong for this brand or audience.
- **Nothing conclusive** → say so, and say what data would settle it.

## Creative history

`scripts/registry.py` is the ledger. Its value is negative knowledge — the angles already proven not to work. That is the part every fresh session forgets and re-proposes.

Always run `similar` before proposing, and state what came back. If an angle is close to a retired one, either say why this attempt is materially different, or pick something else.

```bash
python3 scripts/registry.py add --file concept.json
python3 scripts/registry.py similar --hook "search your batch number"
python3 scripts/registry.py record --id vl-doc-001 --metrics metrics.json
python3 scripts/registry.py list --status retired
python3 scripts/registry.py report
```
