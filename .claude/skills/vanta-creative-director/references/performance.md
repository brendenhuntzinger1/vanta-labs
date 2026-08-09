# Performance loop

## Where the numbers come from

Two halves that must be joined before any of this is meaningful:

**Platform-side** (not yet connected — see `platform-eligibility.md`): spend, impressions, CPM, video views, 2s/6s views, completion rate, clicks, CTR, CPC, frequency.

**Site-side** (live now): `website_analytics_events` carries `page_view`, `add_to_cart`, `begin_checkout`, `purchase`, `refund` with UTM and visitor/session identity. `order_attribution` joins a click to the order it produced, holding first touch, last touch, `ttclid`/`fbclid`/`gclid`, landing path, and the visitor/session keys — with `orders` supplying real revenue.

Revenue and profit come from `orders` / `order_items`. **Read them; never recompute them.** The commerce system owns those numbers.

## Two rules about attribution honesty

**An order with no attribution row is unattributed, not organic.** Those are different facts. Never fold unattributed revenue into a campaign to improve a number, and never present measured ROAS as total ROAS — capture sits behind cookie consent, so measured performance is a floor. Say "at least" when you mean at least.

**The system never credits an ad without evidence.** A visitor arriving from tiktok.com with no click ID and no campaign tag is organic. If you find yourself wanting to count it, that impulse is exactly what the attribution layer was built to refuse.

## When is the data enough?

Two errors cost about the same, and a rule that only guards against one of them is not a rule.

- **Acting on noise.** Killing an ad on 40 impressions, then re-learning the same thing next month. A recommendation from a thin sample is noise wearing a suit.
- **Refusing to act on a settled question.** Letting a hook that is provably broken keep spending because a round-number impression floor has not been reached. A threshold is a proxy for power; when you can measure the power directly, the proxy stops being the authority.

So the rule is **either/or, applied per metric — and deliberately asymmetric**:

> A metric is actionable when it is independently statistically decisive, **or** when the conventional threshold below is met *and no benchmark exists to test against*.

The asymmetry is the point, and it is easy to get backwards. The statistical test can license action **earlier** than the threshold. The threshold on its own can never license a kill when you have a benchmark and the test says UNRESOLVED — that direction is how you end up killing on noise with a round number for cover. Zero purchases from 50 clicks meets the old "kill for poor conversion" row and is still nowhere near decisive; the test wins that argument.

### Power is per metric and never transfers

An ad is not one sample. It is a chain of shrinking denominators: impressions → clicks → carts → purchases. Each metric sits on its own denominator, and they differ by orders of magnitude on the same ad at the same moment.

Take an ad at 1,900 impressions, 13 clicks, 0 purchases:

- **CTR** rests on 1,900 observations. 0.7% against a 2.1% benchmark gives a 95% interval of roughly 0.4%–1.2% — nowhere near 2.1%. The hook is decisively worse. That is actionable **today**, and a 2,000-impression floor that says otherwise is arithmetic superstition.
- **Conversion rate** rests on 13 observations. Zero purchases from 13 clicks is entirely consistent with a healthy 5% conversion rate; the 95% interval runs from 0% to about 23%. You know essentially nothing.

Both are true simultaneously. **Certainty does not travel between metrics.** A decisive CTR finding says nothing about conversion rate, add-to-cart rate, CPA or ROAS — those live on the click denominator, not the impression denominator. The reverse holds equally.

Two obligations follow, and they are the whole point:

1. When you report a metric as decided, name in the same breath which metrics remain **unresolved** on that ad. A verdict without its blind spots reads as a verdict on the whole ad.
2. Never let a small conversion sample be described as bad conversion. "Zero purchases" is an observation; "it doesn't convert" is a claim, and at n=13 it is a fabricated one. Say **UNRESOLVED**.

### Where the benchmark comes from

The benchmark decides the verdict, so an unsourced benchmark is a way to manufacture any answer you want. The same 13-clicks-from-1,900 reads DECISIVE_WORSE against 2.1% and UNRESOLVED against 0.8%. A legitimate benchmark is one of exactly three things:

1. **The account's own trailing rate** for the same metric and placement, over a window that predates the data you are testing.
2. **A figure the operator supplied** — quote it back to them.
3. **A documented platform or category median**, cited.

Never derive a benchmark from the ad under test, and never treat another single ad's observed rate as a fixed known truth — that is a point estimate with its own uncertainty, and using it as a benchmark understates the error badly. **To compare two ads, use `--vs`**, which tests the difference properly. `decisive.py` requires `--benchmark-source` and echoes it in the output for exactly this reason: state the provenance in your answer alongside the verdict.

### Run the arithmetic, don't estimate it

`scripts/decisive.py` tests **proportions** — CTR, add-to-cart rate, conversion rate, view rate — one metric at a time, and prints what that metric cannot tell you. Use it rather than eyeballing; the whole failure mode here is confident-sounding statistics that were never actually computed.

The verdict is the Wilson score interval excluding the benchmark, **confirmed** by an exact binomial p below alpha. Both must agree or the answer is UNRESOLVED. The script also enforces two things the arithmetic alone will not: at least five expected events before a question is considered answerable, and a minimum *material* gap, because a real 0.05-point CTR difference on a million impressions is `DECISIVE_BUT_IMMATERIAL` — true, and not worth anyone's attention.

**CPA and ROAS are ratios of money, not proportions.** The tool refuses them by name. Judge those on the conversion-count rows in the fallback table.

```bash
# The hook: is 13 clicks from 1,900 impressions really below the account's 2.1%?
python3 scripts/decisive.py --metric ctr --successes 13 --trials 1900 \
  --benchmark 0.021 --benchmark-source "account trailing 30d CTR, all TikTok placements"
#   → DECISIVE_WORSE, 67% relative gap. Act on the hook.

# The same ad's conversion: 0 purchases from those 13 clicks, 5% store CVR
python3 scripts/decisive.py --metric cvr --successes 0 --trials 13 \
  --benchmark 0.05 --benchmark-source "store sitewide CVR, trailing 90d"
#   → UNRESOLVED. Underpowered — 0.65 expected events. Needs ~87 more clicks.

# Two creatives head to head — the right tool for ad-vs-ad
python3 scripts/decisive.py --metric ctr --successes 13 --trials 1900 --vs 900 42000
```

### Repeated looks and multiple metrics

Both inflate false positives, and both are normal in this workflow, so neither can be ignored.

**Peeking.** Checking the same ad every day and acting on the first significant result is not a 5% error rate — simulated at the true rate exactly equal to benchmark, daily checks over two weeks fire falsely about **23%** of the time. If you have evaluated this ad before, pass `--looks N`.

**Sweeping.** Running six metrics across ten ads is sixty tests; about three will look decisive by chance alone. Pass `--tests-run N`.

Either flag tightens alpha accordingly. Declaring them honestly will sometimes turn a verdict you liked into UNRESOLVED — that is the flag working, not the flag being wrong.

### Conventional thresholds — the fallback

Use these **only when you have no benchmark to test against**. They are the point at which a question becomes worth checking, not proof that it has been answered — and where a benchmark does exist, the arithmetic above overrides them in both directions.

| Decision | Earliest worth checking | Denominator that actually governs it |
|---|---|---|
| Kill for weak hook | ≥ 2,000 impressions and ≥ 3 days | impressions |
| Kill for poor conversion | ≥ 100 clicks and ≥ 3 days | clicks |
| Declare a winner | ≥ 3× target CPA in spend, ≥ 5 conversions | conversions |
| Recommend scaling | ≥ 7 days stable, ≥ 10 conversions | conversions |
| Declare fatigue | ≥ 7 days, CTR down ≥ 30% from that ad's own peak | impressions, over time |

The third column is the part that matters. If someone quotes a threshold against the wrong denominator — "we have 41,000 impressions so conversion is proven" — that is the error this whole section exists to catch. (The conversion row says 100 rather than the traditional 50 because 50 clicks cannot separate 0% from a 5% target: five expected events is the floor at which the question is answerable at all.)

Where no metric is decided and no threshold is met, the state is `LEARNING` and the recommendation is "keep going". Say the data is thin rather than manufacturing a verdict from it.

## States

A state is assigned from the metrics that are actually **decided**, and it always carries the unresolved ones with it. Report it in this shape, every time:

```
PARTIALLY_DECIDED (decided: ctr — DECISIVE_WORSE; unresolved: cvr, cpa, roas)
```

Do not average a decided metric and an open one into a single vague verdict. `UNRESOLVED` is the word for an open metric in prose, and it is what `decisive.py` prints — the two vocabularies are deliberately the same.

| State | Meaning | Action |
|---|---|---|
| `LEARNING` | Nothing decided yet — no metric decisive, no threshold met | Let it run |
| `PARTIALLY_DECIDED` | At least one metric decisive, others still open | Act on the decided metric only; name the open ones |
| `WATCH` | Two or more metrics decided and pointing different ways | Hold, re-read in 48h — and declare the extra look |
| `WINNER` | Beats target CPA/ROAS on a decided metric | Recommend more budget |
| `SCALE_CANDIDATE` | Winner, stable ≥ 7 days | Recommend a step increase, then re-measure |
| `FATIGUING` | CTR decaying at flat spend | Rotate creative, keep the audience |
| `UNDERPERFORMING` | Misses target on a decided metric | Recommend pause + diagnose |
| `INELIGIBLE` | Rejected or policy-risky | Withdraw, do not resubmit variants of it |

Every state change is a **recommendation**. This system does not pause, scale, launch or spend.

## Diagnose before prescribing

The most valuable thing here is separating a creative problem from a funnel problem. They look identical in ROAS and have opposite fixes — replacing creative when the landing page is the issue burns budget and teaches nothing.

**Every row below assumes both named metrics are decided on their own denominators.** If either is UNRESOLVED the row does not apply — report the decided metric and name the open one. Reading "good CTR, low add-to-cart" off 13 clicks is the fabrication this file spent a whole section forbidding.

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

Name the metric, not the ad — "loser" is the averaged whole-ad verdict this file exists to stop you producing.

- **Winner** → iterate the *variable*, not the concept. Same body, three new hooks. Never rebuild a winner from scratch.
- **One metric decided, others open** — the common case → act on the decided metric alone. Retire a decisively weak hook; say plainly that conversion, CPA and ROAS remain UNRESOLVED, and how much more data would settle them.
- **Decisive CTR, decisively weak conversion** → the hook works and something after the click does not. Keep the hook, rebuild the body or fix the page — the diagnosis table tells you which.
- **Decisively weak CTR** → retire the hook. Log it. Do not re-propose it in three weeks with different words.
- **Whole archetype failing across concepts** → stop testing inside it; the format is wrong for this brand or audience. Remember this is many tests — pass `--tests-run` before believing the pattern.
- **Nothing decided** → say so, and say what data would settle it.

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
