#!/usr/bin/env python3
"""Self-test for the Creative Director's two executable pieces.

Covers the things that would fail silently and expensively:

  * `decisive.py` arithmetic, including the case the benchmark caught — a hook
    that is provably broken at 1,900 impressions while the conversion rate on
    the same ad is genuinely unknowable.
  * The four guards added after adversarial review, each of which has a named
    regression case below: interval-and-exact-p agreement, minimum expected
    events, materiality, and multiplicity correction. Every one of these was a
    real defect in the first draft that produced a confident wrong answer.
  * Registry isolation — that a test run cannot write into the real creative
    history. This has already gone wrong once; a regression here quietly
    poisons the ledger with fixture concepts that a future session then reads
    as angles somebody actually proposed.

Run:  python3 tests/selftest.py
Exit: 0 all passed, 1 otherwise.
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent.parent
DECISIVE = SKILL_DIR / "scripts" / "decisive.py"
REGISTRY = SKILL_DIR / "scripts" / "registry.py"
PRODUCTION_LEDGER = SKILL_DIR / "creative-history.json"

SRC = "--benchmark-source"
ACCOUNT = "account trailing 30d rate"

FAILURES: list[str] = []
PASSES = 0


def check(label: str, condition: bool, detail: str = "") -> None:
    global PASSES
    if condition:
        PASSES += 1
        print(f"  PASS  {label}")
    else:
        FAILURES.append(f"{label}{' — ' + detail if detail else ''}")
        print(f"  FAIL  {label}{' — ' + detail if detail else ''}")


def run_decisive(*args: str) -> dict:
    proc = subprocess.run(
        [sys.executable, str(DECISIVE), *args],
        capture_output=True, text=True, check=False,
    )
    if proc.returncode != 0:
        raise AssertionError(f"decisive.py failed: {proc.stderr.strip()}")
    return json.loads(proc.stdout)


def refuses(*args: str) -> tuple[bool, str]:
    proc = subprocess.run([sys.executable, str(DECISIVE), *args],
                          capture_output=True, text=True, check=False)
    return proc.returncode != 0, (proc.stderr or proc.stdout).strip()[:160]


def test_per_metric_independence() -> None:
    """The benchmark case: one ad, two denominators, two different verdicts."""
    print("\nPer-metric power (the iteration-2 correction)")

    ctr = run_decisive("--metric", "ctr", "--successes", "13", "--trials", "1900",
                       "--benchmark", "0.021", SRC, ACCOUNT)
    check("CTR at 13/1900 vs 2.1% is DECISIVE_WORSE",
          ctr["verdict"] == "DECISIVE_WORSE", f"got {ctr['verdict']}")
    check("CTR interval excludes the benchmark",
          ctr["confidence_interval"][1] < 0.021, str(ctr["confidence_interval"][1]))
    check("CTR upper bound is ~1.17%",
          abs(ctr["confidence_interval"][1] - 0.01167) < 0.0002,
          str(ctr["confidence_interval"][1]))
    check("A decisive CTR result names conversion as a blind spot",
          any("conversion" in s for s in ctr["does_not_tell_you"]))
    check("The benchmark's source is echoed back",
          ctr["benchmark_source"] == ACCOUNT)

    cvr = run_decisive("--metric", "cvr", "--successes", "0", "--trials", "13",
                       "--benchmark", "0.05", SRC, "store sitewide CVR")
    check("CVR at 0/13 vs 5% is UNRESOLVED",
          cvr["verdict"] == "UNRESOLVED", f"got {cvr['verdict']}")
    check("CVR interval reaches ~23%, so zero purchases proves nothing",
          abs(cvr["confidence_interval"][1] - 0.22810) < 0.0005,
          str(cvr["confidence_interval"][1]))
    check("It reports UNRESOLVED, not 'bad conversion'",
          "UNRESOLVED" in cvr["recommendation"])
    check("It names underpowering as the specific reason",
          any("underpowered" in r for r in cvr["unresolved_because"]),
          str(cvr.get("unresolved_because")))
    check("It projects 87 more clicks to settle CVR",
          cvr["additional_trials_needed"] == 87, str(cvr.get("additional_trials_needed")))
    check("The projection discloses the rate it assumed",
          cvr["assumed_true_rate_for_projection"] == 0.0 and "assumes" in cvr["projection_note"])

    check("Same ad, opposite verdicts — certainty did not transfer",
          ctr["verdict"] != cvr["verdict"])


def test_interval_and_p_must_agree() -> None:
    """Regression: the interval alone called 1-of-3 a decisive win."""
    print("\nInterval and exact p must agree (blocking defect #3)")

    for label, args in [
        ("1 conversion from 3 clicks is UNRESOLVED",
         ["--metric", "cvr", "--successes", "1", "--trials", "3", "--benchmark", "0.02"]),
        ("3 conversions from 20 clicks is UNRESOLVED",
         ["--metric", "cvr", "--successes", "3", "--trials", "20", "--benchmark", "0.05"]),
        ("1 click from 8 impressions is UNRESOLVED",
         ["--metric", "ctr", "--successes", "1", "--trials", "8", "--benchmark", "0.021"]),
        ("1 of 1 is UNRESOLVED",
         ["--metric", "cvr", "--successes", "1", "--trials", "1", "--benchmark", "0.02"]),
        ("0 of 75 vs 5% is UNRESOLVED (only 3.75 expected events)",
         ["--metric", "cvr", "--successes", "0", "--trials", "75", "--benchmark", "0.05"]),
        ("30 of 1000 vs 2.1% is UNRESOLVED (exact p = 0.059)",
         ["--metric", "ctr", "--successes", "30", "--trials", "1000", "--benchmark", "0.021"]),
    ]:
        r = run_decisive(*args, SRC, ACCOUNT)
        check(label, r["verdict"] == "UNRESOLVED", f"got {r['verdict']}")

    print("  ... sweeping for any DECISIVE verdict with exact p above alpha")
    violations = []
    for benchmark in (0.021, 0.05):
        for trials in (3, 8, 20, 50, 75, 100, 300, 1000):
            for successes in range(0, min(trials, 40) + 1):
                r = run_decisive("--metric", "cvr", "--successes", str(successes),
                                 "--trials", str(trials), "--benchmark", str(benchmark),
                                 SRC, ACCOUNT)
                if r["verdict"].startswith("DECISIVE") and r["exact_two_sided_p"] >= r["alpha_used"]:
                    violations.append(f"{successes}/{trials}@{benchmark} p={r['exact_two_sided_p']}")
    check("No DECISIVE verdict anywhere in the sweep has exact p >= alpha",
          not violations, f"{len(violations)} violations, e.g. {violations[:3]}")


def test_materiality() -> None:
    """Regression: a real but worthless gap read as a reason to act."""
    print("\nDecisive is not the same as important (review finding #11)")

    tiny = run_decisive("--metric", "ctr", "--successes", "20500", "--trials", "1000000",
                        "--benchmark", "0.021", SRC, ACCOUNT)
    check("A 0.05-point CTR gap on 1M impressions is DECISIVE_BUT_IMMATERIAL",
          tiny["verdict"] == "DECISIVE_BUT_IMMATERIAL", f"got {tiny['verdict']}")
    check("It says not to act on it", "not worth" in tiny["recommendation"].lower()
          or "leave it alone" in tiny["recommendation"].lower())

    big = run_decisive("--metric", "ctr", "--successes", "13", "--trials", "1900",
                       "--benchmark", "0.021", SRC, ACCOUNT)
    check("A 67% relative gap is still material",
          big["verdict"] == "DECISIVE_WORSE" and big["relative_gap_vs_benchmark"] > 0.6,
          str(big.get("relative_gap_vs_benchmark")))

    off = run_decisive("--metric", "ctr", "--successes", "20500", "--trials", "1000000",
                       "--benchmark", "0.021", "--min-effect", "0", SRC, ACCOUNT)
    check("--min-effect 0 restores the purely statistical verdict",
          off["verdict"] == "DECISIVE_WORSE", f"got {off['verdict']}")


def test_multiplicity() -> None:
    """Regression: daily peeking turned a 5% error rate into 23%."""
    print("\nRepeated looks and multiple tests tighten alpha (blocking defect #2)")

    single = run_decisive("--metric", "ctr", "--successes", "100", "--trials", "10000",
                          "--benchmark", "0.0125", SRC, ACCOUNT)
    many = run_decisive("--metric", "ctr", "--successes", "100", "--trials", "10000",
                        "--benchmark", "0.0125", "--looks", "14", SRC, ACCOUNT)
    # alpha_used is rounded to 5dp in the JSON, so compare at that resolution.
    check("14 looks tightens alpha to 0.05/14",
          many["alpha_used"] == round(0.05 / 14, 5), str(many["alpha_used"]))
    check("A borderline result that fires at one look does not fire at fourteen",
          single["verdict"].startswith("DECISIVE") and many["verdict"] == "UNRESOLVED",
          f"{single['verdict']} then {many['verdict']}")

    strong = run_decisive("--metric", "ctr", "--successes", "13", "--trials", "1900",
                          "--benchmark", "0.021", "--looks", "14", SRC, ACCOUNT)
    check("A genuinely decisive result survives the correction",
          strong["verdict"] == "DECISIVE_WORSE", f"got {strong['verdict']}")

    swept = run_decisive("--metric", "ctr", "--successes", "13", "--trials", "1900",
                         "--benchmark", "0.021", "--tests-run", "60", SRC, ACCOUNT)
    check("--tests-run also tightens alpha",
          swept["alpha_used"] == round(0.05 / 60, 5), str(swept["alpha_used"]))
    check("Single-look output still warns about undeclared peeking",
          "peeking" in single["multiplicity_note"])


def test_head_to_head() -> None:
    """Regression: overlapping per-arm intervals were treated as a null result."""
    print("\nHead-to-head uses the interval of the difference (blocking defect #1)")

    real = run_decisive("--metric", "ctr", "--successes", "100", "--trials", "1000",
                        "--vs", "130", "1000")
    check("10% vs 13% on 1,000 each is a decisive difference",
          real["verdict"] == "DECISIVE_DIFFERENCE", f"got {real['verdict']}")
    check("The difference interval excludes zero",
          real["difference_confidence_interval"][1] < 0)
    check("It no longer claims overlapping arm intervals mean 'not settled'",
          "overlap" not in real["reads"].lower())
    check("The basis names the Newcombe difference interval",
          "difference" in real["verdict_basis"].lower())

    tie = run_decisive("--metric", "ctr", "--successes", "21", "--trials", "1000",
                       "--vs", "21", "1000")
    check("Identical creatives are UNRESOLVED against each other",
          tie["verdict"] == "UNRESOLVED", f"got {tie['verdict']}")
    check("A tie's difference interval contains zero",
          tie["difference_confidence_interval"][0] < 0 < tie["difference_confidence_interval"][1])

    lopsided = run_decisive("--metric", "ctr", "--successes", "13", "--trials", "1900",
                            "--vs", "900", "42000")
    check("0.68% vs 2.14% is a decisive difference",
          lopsided["verdict"] == "DECISIVE_DIFFERENCE", f"got {lopsided['verdict']}")

    trivial = run_decisive("--metric", "ctr", "--successes", "20500", "--trials", "1000000",
                           "--vs", "21000", "1000000")
    check("A real but trivial head-to-head gap is DECISIVE_BUT_IMMATERIAL",
          trivial["verdict"] == "DECISIVE_BUT_IMMATERIAL", f"got {trivial['verdict']}")


def test_head_to_head_small_samples() -> None:
    """Regression: --vs had none of the guards the benchmark path enforced."""
    print("\nHead-to-head enforces the same gates as the benchmark path")

    for label, args in [
        ("2 of 2 vs 0 of 2", ["--metric", "ctr", "--successes", "2", "--trials", "2", "--vs", "0", "2"]),
        ("5 of 10 vs 10 of 50 (Fisher p=0.10)", ["--metric", "ctr", "--successes", "5", "--trials", "10", "--vs", "10", "50"]),
        ("4 of 20 vs 10 of 20 (Fisher p=0.096)", ["--metric", "ctr", "--successes", "4", "--trials", "20", "--vs", "10", "20"]),
        ("1 of 1 vs 0 of 1000", ["--metric", "ctr", "--successes", "1", "--trials", "1", "--vs", "0", "1000"]),
    ]:
        r = run_decisive(*args)
        check(f"{label} is UNRESOLVED", r["verdict"] == "UNRESOLVED", f"got {r['verdict']}")
        if r["verdict"] == "UNRESOLVED":
            check(f"  ... and says why", bool(r.get("unresolved_because")))

    print("  ... sweeping --vs for DECISIVE verdicts Fisher would refuse")
    violations = []
    for a_n in (10, 20, 30, 50, 100):
        for b_n in (10, 30, 50, 200):
            for a_s in range(0, a_n + 1, max(1, a_n // 6)):
                for b_s in range(0, b_n + 1, max(1, b_n // 6)):
                    r = run_decisive("--metric", "ctr", "--successes", str(a_s),
                                     "--trials", str(a_n), "--vs", str(b_s), str(b_n))
                    if r["verdict"].startswith("DECISIVE") and r["fisher_exact_p"] >= r["alpha_used"]:
                        violations.append(f"{a_s}/{a_n} vs {b_s}/{b_n} fisher={r['fisher_exact_p']}")
    check("No DECISIVE head-to-head has Fisher p >= alpha",
          not violations, f"{len(violations)} violations, e.g. {violations[:3]}")

    print("  ... checking argument order does not change the verdict")
    asym = []
    for a_s, a_n, b_s, b_n in [(145, 2000, 181, 2000), (100, 1000, 130, 1000),
                               (200, 5000, 260, 5000), (50, 500, 75, 500)]:
        fwd = run_decisive("--metric", "ctr", "--successes", str(a_s), "--trials", str(a_n),
                           "--vs", str(b_s), str(b_n))
        rev = run_decisive("--metric", "ctr", "--successes", str(b_s), "--trials", str(b_n),
                           "--vs", str(a_s), str(a_n))
        if fwd["verdict"] != rev["verdict"] or fwd["relative_gap"] != rev["relative_gap"]:
            asym.append(f"{a_s}/{a_n} vs {b_s}/{b_n}: {fwd['verdict']}/{fwd['relative_gap']} != {rev['verdict']}/{rev['relative_gap']}")
    check("Swapping A and B leaves the verdict and the gap unchanged",
          not asym, "; ".join(asym))


def test_projection_is_honest() -> None:
    """Regression: the projection promised data that did not resolve anything."""
    print("\nThe projection uses the same gate stack as the verdict")

    bad = []
    for succ, trials, bm in [(15, 500, 0.021), (5, 1000, 0.021), (0, 13, 0.05),
                             (1, 200, 0.021), (30, 500, 0.05)]:
        r = run_decisive("--metric", "ctr", "--successes", str(succ), "--trials", str(trials),
                         "--benchmark", str(bm), SRC, ACCOUNT)
        if r["verdict"] != "UNRESOLVED":
            continue
        need = r.get("trials_needed_at_assumed_rate")
        check(f"{succ}/{trials} vs {bm}: never promises 0 more trials",
              r.get("additional_trials_needed", 1) >= 1, str(r.get("additional_trials_needed")))
        if need is None:
            continue
        rate = r["assumed_true_rate_for_projection"]
        after = run_decisive("--metric", "ctr", "--successes", str(round(rate * need)),
                             "--trials", str(need), "--benchmark", str(bm), SRC, ACCOUNT)
        if not after["verdict"].startswith("DECISIVE") or after["verdict"] == "DECISIVE_BUT_IMMATERIAL":
            bad.append(f"{succ}/{trials}@{bm} -> promised n={need} still {after['verdict']}")
    check("Collecting the projected sample actually produces a decisive verdict",
          not bad, "; ".join(bad))

    immaterial = run_decisive("--metric", "ctr", "--successes", "210", "--trials", "10000",
                              "--benchmark", "0.02", SRC, ACCOUNT)
    check("A sub-material gap is not given a 'keep spending' number",
          immaterial["trials_needed_at_assumed_rate"] is None
          and "will not settle" in immaterial["projection_note"],
          str(immaterial.get("trials_needed_at_assumed_rate")))


def test_reported_confidence_is_truthful() -> None:
    print("\nThe stated confidence level matches the alpha actually used")
    for looks in (1, 14, 60):
        r = run_decisive("--metric", "ctr", "--successes", "13", "--trials", "1900",
                         "--benchmark", "0.021", "--looks", str(looks), SRC, ACCOUNT)
        check(f"--looks {looks}: reads never claims 100% confidence",
              "100% likely" not in r["reads"], r["reads"][:90])
        check(f"--looks {looks}: confidence_level equals 1 - alpha",
              abs(r["confidence_level"] - (1 - r["alpha_used"])) < 1e-4,
              f"{r['confidence_level']} vs {1 - r['alpha_used']}")
    h = run_decisive("--metric", "ctr", "--successes", "100", "--trials", "1000",
                     "--vs", "130", "1000", "--looks", "14")
    check("Head-to-head reads does not hardcode 95%",
          "95% interval" not in h["reads"], h["reads"][-80:])


def test_still_refuses_noise() -> None:
    """The original protection must survive the new flexibility."""
    print("\nSmall samples are still refused")

    for label, args in [
        ("0 clicks from 40 impressions", ["--metric", "ctr", "--successes", "0", "--trials", "40", "--benchmark", "0.021"]),
        ("0 purchases from 3 clicks", ["--metric", "cvr", "--successes", "0", "--trials", "3", "--benchmark", "0.05"]),
        ("a rate sitting exactly on benchmark", ["--metric", "ctr", "--successes", "210", "--trials", "10000", "--benchmark", "0.021"]),
        ("0 purchases from 50 clicks (the old table said kill here)",
         ["--metric", "cvr", "--successes", "0", "--trials", "50", "--benchmark", "0.05"]),
    ]:
        r = run_decisive(*args, SRC, ACCOUNT)
        check(f"{label} is UNRESOLVED", r["verdict"] == "UNRESOLVED", f"got {r['verdict']}")

    better = run_decisive("--metric", "ctr", "--successes", "500", "--trials", "10000",
                          "--benchmark", "0.021", SRC, ACCOUNT)
    check("5% on 10,000 impressions is DECISIVE_BETTER",
          better["verdict"] == "DECISIVE_BETTER", f"got {better['verdict']}")

    small = run_decisive("--metric", "ctr", "--successes", "1", "--trials", "100",
                         "--benchmark", "0.021", SRC, ACCOUNT)
    large = run_decisive("--metric", "ctr", "--successes", "100", "--trials", "10000",
                         "--benchmark", "0.021", SRC, ACCOUNT)
    check("Same 1% rate: undecided at n=100, decided at n=10,000",
          small["verdict"] == "UNRESOLVED" and large["verdict"] == "DECISIVE_WORSE",
          f"{small['verdict']} / {large['verdict']}")


def test_input_guards() -> None:
    print("\nInput guards")
    cases = [
        ("rejects successes > trials", ["--metric", "ctr", "--successes", "5", "--trials", "3", "--benchmark", "0.1", SRC, ACCOUNT]),
        ("rejects zero trials", ["--metric", "ctr", "--successes", "0", "--trials", "0", "--benchmark", "0.1", SRC, ACCOUNT]),
        ("rejects a benchmark given as a percentage", ["--metric", "ctr", "--successes", "1", "--trials", "10", "--benchmark", "2.1", SRC, ACCOUNT]),
        ("requires a benchmark or a comparison", ["--metric", "ctr", "--successes", "1", "--trials", "10"]),
        ("requires a benchmark source", ["--metric", "ctr", "--successes", "13", "--trials", "1900", "--benchmark", "0.021"]),
        ("rejects an impossible --vs arm", ["--metric", "ctr", "--successes", "13", "--trials", "1900", "--vs", "5", "3"]),
        ("rejects a negative --vs numerator", ["--metric", "ctr", "--successes", "13", "--trials", "1900", "--vs", "-5", "100"]),
        ("rejects a --vs arm with no denominator", ["--metric", "ctr", "--successes", "13", "--trials", "1900", "--vs", "0", "0"]),
        ("rejects ROAS as not a proportion", ["--metric", "roas", "--successes", "420", "--trials", "890", "--benchmark", "0.99", SRC, ACCOUNT]),
        ("rejects CPA as not a proportion", ["--metric", "cpa", "--successes", "3", "--trials", "890", "--benchmark", "0.1", SRC, ACCOUNT]),
        ("rejects an unknown metric label", ["--metric", "vibes", "--successes", "3", "--trials", "10", "--benchmark", "0.1", SRC, ACCOUNT]),
        ("rejects an absurd multiplicity", ["--metric", "ctr", "--successes", "13", "--trials", "1900", "--benchmark", "0.021", "--looks", "1000000000000000", SRC, ACCOUNT]),
        ("refuses --vs together with --benchmark", ["--metric", "ctr", "--successes", "100", "--trials", "1000", "--vs", "130", "1000", "--benchmark", "0.021", SRC, ACCOUNT]),
        ("rejects looks below 1", ["--metric", "ctr", "--successes", "1", "--trials", "10", "--benchmark", "0.1", "--looks", "0", SRC, ACCOUNT]),
    ]
    for label, args in cases:
        refused, msg = refuses(*args)
        check(label, refused, f"exited 0 — {msg}")

    ok = run_decisive("--metric", "vibes", "--successes", "300", "--trials", "1000",
                      "--benchmark", "0.1", "--allow-custom-metric", SRC, ACCOUNT)
    check("--allow-custom-metric permits a genuine proportion",
          ok["verdict"] == "DECISIVE_BETTER", f"got {ok['verdict']}")
    check("An unknown metric still gets a blind-spot warning",
          ok["does_not_tell_you"] and "denominator" in ok["does_not_tell_you"][0])


def test_registry_isolation() -> None:
    """A test run must not be able to touch the real ledger."""
    print("\nRegistry isolation")

    check("Production ledger exists", PRODUCTION_LEDGER.exists())
    before_hash = hashlib.sha256(PRODUCTION_LEDGER.read_bytes()).hexdigest()
    before = json.loads(PRODUCTION_LEDGER.read_text())
    check("Production ledger is clean (no concepts)",
          before.get("concepts") == [], f"holds {len(before.get('concepts', []))} concepts")

    with tempfile.TemporaryDirectory() as tmp:
        sandbox = Path(tmp) / "sandbox-history.json"
        concept = Path(tmp) / "concept.json"
        concept.write_text(json.dumps({
            "concept_id": "selftest-001",
            "archetype": "documentation",
            "hook": "selftest fixture — must never reach production history",
        }))

        env = {**os.environ, "VANTA_CREATIVE_REGISTRY": str(sandbox)}
        proc = subprocess.run(
            [sys.executable, str(REGISTRY), "add", "--file", str(concept)],
            capture_output=True, text=True, env=env, check=False,
        )
        check("registry.py add succeeds under VANTA_CREATIVE_REGISTRY",
              proc.returncode == 0, proc.stderr.strip())
        check("The sandbox ledger was created", sandbox.exists())
        if sandbox.exists():
            written = json.loads(sandbox.read_text())
            check("The fixture landed in the sandbox",
                  [c["concept_id"] for c in written["concepts"]] == ["selftest-001"])

        check("Production ledger is byte-identical after a sandboxed write",
              hashlib.sha256(PRODUCTION_LEDGER.read_bytes()).hexdigest() == before_hash)

        # A read command must also honour the override, or a test run would
        # report on real history while writing to a sandbox — worse than either.
        proc = subprocess.run(
            [sys.executable, str(REGISTRY), "report"],
            capture_output=True, text=True, env=env, check=False,
        )
        check("Reads honour the override too",
              json.loads(proc.stdout)["total_concepts"] == 1)

    # Without the override, the default path must be the production ledger —
    # isolation that only works when someone remembers a flag is not isolation,
    # so this asserts the default is the file we actually track in git.
    proc = subprocess.run(
        [sys.executable, str(REGISTRY), "report"],
        capture_output=True, text=True,
        env={k: v for k, v in os.environ.items() if k != "VANTA_CREATIVE_REGISTRY"},
        check=False,
    )
    default_report = json.loads(proc.stdout)
    check("Default path reads the production ledger and it is empty",
          default_report["total_concepts"] == 0, f"found {default_report['total_concepts']}")
    check("Production ledger still unchanged at end of run",
          hashlib.sha256(PRODUCTION_LEDGER.read_bytes()).hexdigest() == before_hash)


def main() -> int:
    print("Vanta Creative Director — self-test")
    test_per_metric_independence()
    test_interval_and_p_must_agree()
    test_materiality()
    test_multiplicity()
    test_head_to_head()
    test_head_to_head_small_samples()
    test_projection_is_honest()
    test_reported_confidence_is_truthful()
    test_still_refuses_noise()
    test_input_guards()
    test_registry_isolation()

    print(f"\n{PASSES} passed, {len(FAILURES)} failed")
    for f in FAILURES:
        print(f"  - {f}")
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main())
