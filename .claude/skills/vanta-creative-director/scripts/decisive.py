#!/usr/bin/env python3
"""Is this metric decided yet? — per-metric statistical power for ad decisions.

The mistake this exists to prevent is treating an ad as one sample. It isn't.
An ad is a chain of shrinking denominators: impressions → clicks → carts →
purchases. At 1,900 impressions and 13 clicks, the click-through rate is
resting on 1,900 observations and the conversion rate is resting on 13. One of
those is decided and the other is unknowable, at the same moment, on the same
ad. A single "minimum sample" rule for the whole ad gets one of them wrong
whichever number you pick.

So: run this once per metric. It answers exactly one question — is THIS metric
separated from its benchmark by more than sampling noise, by enough to be worth
acting on — and it says loudly what it does not answer, because certainty does
not travel between metrics.

Four guards, each of which exists because the naive version of this tool gets
it wrong in a way that costs money:

  * The verdict needs BOTH a confidence interval that excludes the benchmark
    AND an exact binomial p below alpha. The interval alone calls 1-click-from-3
    a decisive win.
  * There must be enough expected events for the question to be answerable at
    all (>= 5 under the null, and >= 5 observed before anything is declared
    BETTER). Otherwise tiny numerators masquerade as findings.
  * Statistical decisiveness is not importance. A real 0.05-point CTR gap on a
    million impressions is DECISIVE_BUT_IMMATERIAL, not a reason to rotate.
  * Repeated looks and multiple metrics inflate false positives badly — testing
    daily for two weeks turns a nominal 5% error rate into ~23%. Declare them
    with --looks / --tests-run and alpha is corrected.

The reported verdict is the Wilson score test, cross-checked against the exact
binomial. Both are printed so a disagreement is visible rather than hidden.

Usage:
  decisive.py --metric ctr --successes 13 --trials 1900 \\
              --benchmark 0.021 --benchmark-source "account trailing 30d CTR"
  decisive.py --metric cvr --successes 0 --trials 13 \\
              --benchmark 0.05 --benchmark-source "store sitewide CVR"
  decisive.py --metric ctr --successes 13 --trials 1900 --vs 900 42000
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from statistics import NormalDist

# Metrics this system reasons about, and what each one is genuinely blind to.
# Stated per metric because a decisive read on one is routinely — and wrongly —
# reported as if it settled the others.
BLIND_SPOTS = {
    "ctr": [
        "conversion rate, add-to-cart rate, CPA and ROAS — all sit on the click denominator, not the impression denominator",
        "whether the landing page works",
        "whether the audience is right (a good hook shown to the wrong people still clicks)",
    ],
    "atc_rate": [
        "checkout completion and purchase rate — a smaller denominator again",
        "whether the hook is working (that is a CTR question)",
        "revenue per order",
    ],
    "cvr": [
        "whether the creative earned attention (CTR question)",
        "why it failed — pricing, page, offer and checkout friction are indistinguishable here",
        "CPA stability, which also depends on CPM and auction conditions",
    ],
    "view_rate": [
        "whether attention converted into intent — that is CTR",
        "anything downstream of the click",
    ],
    "checkout_rate": [
        "whether the creative or the audience was at fault upstream",
        "revenue per order and refund behaviour",
    ],
}

# Ratio-of-money metrics. They are not proportions, they have no binomial
# denominator, and feeding them in here produces a confident, meaningless
# interval — so refuse by name rather than let the number look official.
NOT_PROPORTIONS = {
    "roas": "revenue ÷ spend is a ratio of two continuous quantities, not successes out of trials",
    "cpa": "cost ÷ conversions is a ratio, not a proportion",
    "cpc": "cost ÷ clicks is a ratio, not a proportion",
    "cpm": "cost ÷ impressions × 1000 is a ratio, not a proportion",
    "aov": "average order value is a mean of a continuous variable",
    "revenue": "revenue is a sum, not a proportion",
    "spend": "spend is a sum, not a proportion",
    "frequency": "frequency is a mean, not a proportion",
}

BASE_ALPHA = 0.05
# Below a relative gap this size, a difference can be perfectly real and still
# not worth a decision. 20% relative is the smallest move that reliably survives
# contact with auction noise and rounding in a weekly report.
DEFAULT_MIN_EFFECT = 0.20
# np >= 5 is the standard precondition for a score test to mean anything. Below
# it the interval is arithmetic, not evidence.
MIN_EXPECTED_EVENTS = 5
MIN_OBSERVED_FOR_BETTER = 5
TRIAL_SEARCH_CEILING = 5_000_000


def z_for(alpha: float) -> float:
    return NormalDist().inv_cdf(1 - alpha / 2)


def _log_choose(n: int, k: int) -> float:
    return math.lgamma(n + 1) - math.lgamma(k + 1) - math.lgamma(n - k + 1)


def _binom_pmf(k: int, n: int, p: float) -> float:
    if p <= 0.0:
        return 1.0 if k == 0 else 0.0
    if p >= 1.0:
        return 1.0 if k == n else 0.0
    return math.exp(_log_choose(n, k) + k * math.log(p) + (n - k) * math.log1p(-p))


def exact_two_sided_p(successes: int, trials: int, p0: float) -> float:
    """Two-sided exact binomial p-value by the method of small probabilities.

    Every outcome at least as unlikely as the observed one counts toward the
    tail. Conservative relative to the score test, which is why it is used here
    as a cross-check rather than as the verdict: it will occasionally sit just
    above alpha when the interval has already cleared the benchmark, and when
    the two disagree this tool refuses rather than picks the friendlier one.
    """
    observed = _binom_pmf(successes, trials, p0)
    tol = observed * 1e-7
    total = sum(
        pmf for k in range(trials + 1)
        if (pmf := _binom_pmf(k, trials, p0)) <= observed + tol
    )
    return min(1.0, total)


def wilson_interval(successes: int, trials: int, z: float) -> tuple[float, float]:
    """Wilson score interval — behaves correctly at 0 successes, unlike Wald.

    This is the number worth quoting to a human. "Conversion is somewhere
    between 0% and 23%" communicates the actual state of knowledge in a way
    that "0% conversion" actively misrepresents.
    """
    if trials == 0:
        return (0.0, 1.0)
    p = successes / trials
    denom = 1 + z * z / trials
    centre = (p + z * z / (2 * trials)) / denom
    half = (z / denom) * math.sqrt(p * (1 - p) / trials + z * z / (4 * trials * trials))
    return (max(0.0, centre - half), min(1.0, centre + half))


def trials_to_decide(assumed_rate: float, benchmark: float, z: float) -> int | None:
    """Smallest n at which THIS tool would call it, if the rate holds.

    Answers the operator's real question — "how much longer?" — in the same
    currency as the verdict, rather than via a power formula whose assumptions
    are invisible in the output. Returns None when the assumed rate is too
    close to the benchmark for any realistic sample to separate them, which is
    itself the useful answer: stop waiting, there is nothing here.
    """
    if abs(assumed_rate - benchmark) < 1e-9:
        return None

    def decided(n: int) -> bool:
        succ = round(assumed_rate * n)
        if n * benchmark < MIN_EXPECTED_EVENTS:
            return False
        if assumed_rate > benchmark and succ < MIN_OBSERVED_FOR_BETTER:
            return False
        low, high = wilson_interval(succ, n, z)
        return high < benchmark or low > benchmark

    n = 8
    while n <= TRIAL_SEARCH_CEILING:
        if decided(n):
            lo, hi = n // 2, n
            while lo < hi:
                mid = (lo + hi) // 2
                if decided(mid):
                    hi = mid
                else:
                    lo = mid + 1
            return lo
        n *= 2
    return None


def _materiality(observed: float, benchmark: float, min_effect: float) -> tuple[bool, float]:
    if benchmark <= 0:
        return True, float("inf")
    relative = abs(observed - benchmark) / benchmark
    return relative >= min_effect, relative


def one_sample(metric: str, successes: int, trials: int, benchmark: float,
               benchmark_source: str, alpha: float, min_effect: float,
               looks: int, tests_run: int) -> dict:
    z = z_for(alpha)
    observed = successes / trials
    low, high = wilson_interval(successes, trials, z)
    p_value = exact_two_sided_p(successes, trials, benchmark)
    expected_under_null = trials * benchmark
    material, relative_gap = _materiality(observed, benchmark, min_effect)

    # Each gate names itself, so an UNRESOLVED result explains which specific
    # thing is missing rather than reading as a shrug.
    blocked: list[str] = []
    if expected_under_null < MIN_EXPECTED_EVENTS:
        blocked.append(
            f"underpowered: only {expected_under_null:.1f} events expected under the "
            f"{benchmark:.2%} benchmark; need at least {MIN_EXPECTED_EVENTS}"
        )
    if not (high < benchmark or low > benchmark):
        blocked.append("the confidence interval still contains the benchmark")
    if p_value >= alpha:
        blocked.append(f"exact binomial p = {p_value:.4f}, not below alpha = {alpha:.4f}")
    if observed > benchmark and successes < MIN_OBSERVED_FOR_BETTER:
        blocked.append(
            f"only {successes} observed events; at least {MIN_OBSERVED_FOR_BETTER} are "
            "needed before calling a rate better than benchmark"
        )

    if blocked:
        verdict, direction = "UNRESOLVED", "not distinguishable from"
    elif not material:
        verdict = "DECISIVE_BUT_IMMATERIAL"
        direction = "below" if observed < benchmark else "above"
    elif high < benchmark:
        verdict, direction = "DECISIVE_WORSE", "below"
    else:
        verdict, direction = "DECISIVE_BETTER", "above"

    out = {
        "metric": metric,
        "successes": successes,
        "trials": trials,
        "observed_rate": round(observed, 5),
        "benchmark": benchmark,
        "benchmark_source": benchmark_source,
        "confidence_interval": [round(low, 5), round(high, 5)],
        "confidence_level": round(1 - alpha, 4),
        "exact_two_sided_p": round(p_value, 6),
        "verdict": verdict,
        "verdict_basis": (
            "Wilson score interval excluding the benchmark, confirmed by an exact "
            "binomial p below alpha; both must agree or the result is UNRESOLVED"
        ),
        "alpha_used": round(alpha, 5),
        "looks": looks,
        "tests_run": tests_run,
        "relative_gap_vs_benchmark": round(relative_gap, 4) if relative_gap != float("inf") else None,
        "minimum_material_gap": min_effect,
        "reads": (
            f"{metric} is {observed:.2%} on {trials:,} trials; the true rate is "
            f"{1 - alpha:.0%} likely to be between {low:.2%} and {high:.2%}, which is "
            f"{direction} the {benchmark:.2%} benchmark ({benchmark_source})."
        ),
        "does_not_tell_you": BLIND_SPOTS.get(
            metric, ["anything about any other metric — power is per denominator"]
        ),
    }

    if looks > 1 or tests_run > 1:
        out["multiplicity_note"] = (
            f"alpha tightened from {BASE_ALPHA} to {alpha:.5f} for {looks} look(s) x "
            f"{tests_run} test(s). If you have checked this ad on earlier days without "
            "declaring those looks, the real error rate is higher than stated."
        )
    else:
        out["multiplicity_note"] = (
            "Single-look, single-test 95% rule. If this ad has already been checked on "
            "earlier data, re-run with --looks N — repeated peeking at accumulating data "
            "turns a nominal 5% error rate into roughly 23% over two weeks of daily checks."
        )

    if verdict == "UNRESOLVED":
        out["unresolved_because"] = blocked
        assumed = observed if successes > 0 else 0.0
        need = trials_to_decide(assumed, benchmark, z)
        out["assumed_true_rate_for_projection"] = round(assumed, 5)
        if need is None:
            out["trials_needed_at_assumed_rate"] = None
            out["projection_note"] = (
                f"At the observed {assumed:.2%} the gap from benchmark is too small for any "
                "realistic sample to separate. More data will not settle this; treat it as "
                "no meaningful difference rather than as a pending answer."
            )
        else:
            out["trials_needed_at_assumed_rate"] = need
            out["additional_trials_needed"] = max(0, need - trials)
            out["projection_note"] = (
                f"Projection assumes the true rate really is {assumed:.2%}. It is an estimate "
                "from the data in hand, not a measured fact — if the rate drifts, so does this."
            )
        out["recommendation"] = (
            f"Report {metric} as UNRESOLVED. Do not describe this ad as good or bad on {metric}. "
            "If another metric on the same ad is decisive, act on that one and say this one is still open."
        )
    elif verdict == "DECISIVE_BUT_IMMATERIAL":
        out["recommendation"] = (
            f"The gap is real but small — {relative_gap:.1%} relative, under the "
            f"{min_effect:.0%} worth acting on. Statistical decisiveness answers 'is it real', "
            "not 'is it worth doing something about'. Leave it alone and spend the attention elsewhere."
        )
    else:
        out["recommendation"] = (
            f"{metric} is settled on the evidence: it is {direction} benchmark by "
            f"{relative_gap:.1%} relative. This is enough to recommend action on {metric} alone. "
            "Every other metric on this ad is still governed by its own denominator — check each "
            "separately before mentioning it."
        )
    return out


def two_sample(metric: str, a: tuple[int, int], b: tuple[int, int],
               alpha: float, min_effect: float, looks: int, tests_run: int) -> dict:
    """Head-to-head between two creatives on the same metric.

    The interval that matters is the one around the DIFFERENCE, computed by
    Newcombe's square-and-add method. Checking whether two per-arm intervals
    overlap is a different and much stricter test — it fires at an effective
    alpha near 0.005, so it throws away real winners at exactly the 10%-vs-13%
    margins a creative test actually produces, and "the intervals overlap" is
    not evidence of no difference.
    """
    (a_succ, a_n), (b_succ, b_n) = a, b
    z = z_for(alpha)
    p_a, p_b = a_succ / a_n, b_succ / b_n
    a_low, a_high = wilson_interval(a_succ, a_n, z)
    b_low, b_high = wilson_interval(b_succ, b_n, z)

    diff = p_a - p_b
    d_low = diff - math.sqrt((p_a - a_low) ** 2 + (b_high - p_b) ** 2)
    d_high = diff + math.sqrt((a_high - p_a) ** 2 + (p_b - b_low) ** 2)

    pooled = (a_succ + b_succ) / (a_n + b_n)
    se = math.sqrt(pooled * (1 - pooled) * (1 / a_n + 1 / b_n)) if 0 < pooled < 1 else 0.0
    zstat = diff / se if se else 0.0
    p_value = math.erfc(abs(zstat) / math.sqrt(2))

    separated = d_low > 0 or d_high < 0
    baseline = max(p_b, 1e-12)
    relative_gap = abs(diff) / baseline
    material = relative_gap >= min_effect

    if not separated:
        verdict = "UNRESOLVED"
    elif not material:
        verdict = "DECISIVE_BUT_IMMATERIAL"
    else:
        verdict = "DECISIVE_DIFFERENCE"

    out = {
        "metric": metric,
        "a": {"successes": a_succ, "trials": a_n, "rate": round(p_a, 5),
              "confidence_interval": [round(a_low, 5), round(a_high, 5)]},
        "b": {"successes": b_succ, "trials": b_n, "rate": round(p_b, 5),
              "confidence_interval": [round(b_low, 5), round(b_high, 5)]},
        "difference_a_minus_b": round(diff, 5),
        "difference_confidence_interval": [round(d_low, 5), round(d_high, 5)],
        "confidence_level": round(1 - alpha, 4),
        "two_proportion_z": round(zstat, 3),
        "two_proportion_p": round(p_value, 6),
        "verdict": verdict,
        "verdict_basis": (
            "Newcombe confidence interval for the DIFFERENCE excluding zero. Per-arm "
            "intervals are shown for context only — overlapping per-arm intervals do NOT "
            "imply the difference is null, and are not used in this verdict."
        ),
        "alpha_used": round(alpha, 5),
        "looks": looks,
        "tests_run": tests_run,
        "relative_gap": round(relative_gap, 4),
        "reads": (
            f"A is {p_a:.2%} [{a_low:.2%}–{a_high:.2%}], B is {p_b:.2%} [{b_low:.2%}–{b_high:.2%}]. "
            f"The difference is {diff:+.2%}, 95% interval [{d_low:+.2%}, {d_high:+.2%}]"
            + ("." if separated else ", which still contains zero — not settled.")
        ),
        "does_not_tell_you": BLIND_SPOTS.get(
            metric, ["anything about any other metric — power is per denominator"]
        ),
    }
    if verdict == "DECISIVE_BUT_IMMATERIAL":
        out["recommendation"] = (
            f"The difference is real but only {relative_gap:.1%} relative, under the "
            f"{min_effect:.0%} threshold worth acting on. Do not rotate creative over this."
        )
    return out


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Per-metric statistical decisiveness for ad decisions (proportions only)")
    ap.add_argument("--metric", required=True,
                    help="ctr | atc_rate | cvr | view_rate | checkout_rate")
    ap.add_argument("--successes", type=int, required=True,
                    help="numerator (clicks for ctr, carts for atc_rate, purchases for cvr)")
    ap.add_argument("--trials", type=int, required=True,
                    help="denominator for THIS metric (impressions for ctr, clicks for cvr)")
    ap.add_argument("--benchmark", type=float,
                    help="rate to test against, as a decimal (0.021 = 2.1%%)")
    ap.add_argument("--benchmark-source", default="",
                    help="where the benchmark came from — required with --benchmark, and echoed "
                         "in the output so an invented number cannot pass as a measured one")
    ap.add_argument("--vs", nargs=2, type=int, metavar=("SUCCESSES", "TRIALS"),
                    help="compare head-to-head against another creative on the same metric")
    ap.add_argument("--looks", type=int, default=1,
                    help="how many times this ad has been evaluated on accumulating data")
    ap.add_argument("--tests-run", type=int, default=1,
                    help="how many metric/ad combinations are being tested in this session")
    ap.add_argument("--min-effect", type=float, default=DEFAULT_MIN_EFFECT,
                    help="minimum RELATIVE gap worth acting on (default 0.20 = 20%%); 0 disables")
    ap.add_argument("--allow-custom-metric", action="store_true",
                    help="permit a metric label this tool does not know; it must still be a "
                         "proportion (successes out of trials)")
    args = ap.parse_args()

    metric = args.metric.lower()
    if metric in NOT_PROPORTIONS:
        sys.exit(
            f"'{metric}' is not a proportion: {NOT_PROPORTIONS[metric]}. This tool tests "
            "successes out of trials only. Judge CPA and ROAS on the conversion-count "
            "thresholds in references/performance.md instead."
        )
    if metric not in BLIND_SPOTS and not args.allow_custom_metric:
        sys.exit(
            f"Unknown metric '{metric}'. Known: {', '.join(sorted(BLIND_SPOTS))}. "
            "If it really is a proportion, pass --allow-custom-metric."
        )

    if args.trials <= 0:
        sys.exit("--trials must be positive; a metric with no denominator is not a metric.")
    if not 0 <= args.successes <= args.trials:
        sys.exit("--successes must be between 0 and --trials.")
    if args.looks < 1 or args.tests_run < 1:
        sys.exit("--looks and --tests-run must be at least 1.")
    if not 0 <= args.min_effect < 10:
        sys.exit("--min-effect is a relative fraction, e.g. 0.20 for 20%.")

    alpha = BASE_ALPHA / (args.looks * args.tests_run)

    if args.vs:
        vs_succ, vs_trials = args.vs
        if vs_trials <= 0:
            sys.exit("--vs trials must be positive; a comparison arm with no denominator is not an arm.")
        if not 0 <= vs_succ <= vs_trials:
            sys.exit("--vs successes must be between 0 and its trials.")
        result = two_sample(metric, (args.successes, args.trials), (vs_succ, vs_trials),
                            alpha, args.min_effect, args.looks, args.tests_run)
    elif args.benchmark is not None:
        if not 0 < args.benchmark < 1:
            sys.exit("--benchmark is a decimal rate strictly between 0 and 1 (2.1% is 0.021).")
        if not args.benchmark_source.strip():
            sys.exit(
                "--benchmark-source is required. A benchmark decides the verdict, so an "
                "unsourced one is a way to manufacture any answer you like. Use the account's "
                "own trailing rate for this metric and placement, a figure the operator "
                "supplied, or a documented platform median — and never a number derived from "
                "the ad under test. To compare two ads, use --vs instead."
            )
        result = one_sample(metric, args.successes, args.trials, args.benchmark,
                            args.benchmark_source.strip(), alpha, args.min_effect,
                            args.looks, args.tests_run)
    else:
        sys.exit("Give either --benchmark (test against a target) or --vs (head-to-head).")

    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
