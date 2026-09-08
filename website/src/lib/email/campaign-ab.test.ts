import { describe, expect, it } from "vitest";
import {
  campaignVariantFor,
  splitTestAudience,
  decideWinner,
  CAMPAIGN_VARIANTS,
  MIN_ARM_SAMPLE,
} from "@/lib/email/campaign-ab";

// ---------------------------------------------------------------------------
// CAMPAIGN A/B TESTING.
//
// The cart-recovery experiment (cart-recovery-experiments.ts) splits a
// sequence two ways and leaves it running. A broadcast campaign wants the other
// shape: mail a SLICE of the list both ways, wait, then send whichever won to
// everybody who has not been mailed yet. The holdout is the whole point — it is
// what makes the test worth running rather than just a coin toss over the
// entire list.
//
// The part everybody gets wrong is the decision, not the split. "B got 12
// clicks and A got 9" is not a result on 200 recipients; declaring it one and
// mailing the remaining 20,000 on that basis is worse than not testing, because
// it carries the authority of an experiment. decideWinner is therefore allowed
// to answer "not yet" and is expected to, often.
// ---------------------------------------------------------------------------

describe("variant assignment", () => {
  it("is deterministic for the same campaign and recipient", () => {
    const first = campaignVariantFor("camp-1", "buyer@x.test");
    const second = campaignVariantFor("camp-1", "buyer@x.test");
    expect(first).toBe(second);
  });

  // A recipient who lands in arm A of every campaign forever is a systematically
  // under-tested customer, and the arms stop being comparable populations.
  it("re-draws per campaign rather than fixing a recipient to one arm for life", () => {
    const recipients = Array.from({ length: 200 }, (_, i) => `person${i}@x.test`);
    const inA1 = recipients.filter((email) => campaignVariantFor("camp-1", email) === "a");
    const inA2 = recipients.filter((email) => campaignVariantFor("camp-2", email) === "a");
    expect(inA1).not.toEqual(inA2);
  });

  it("splits roughly evenly over a realistic list", () => {
    const recipients = Array.from({ length: 2000 }, (_, i) => `person${i}@x.test`);
    const inA = recipients.filter((email) => campaignVariantFor("camp-1", email) === "a").length;
    // Within 10 points of even. A hash that skews harder than this is not a
    // coin toss and would bias every result the system reports.
    expect(inA).toBeGreaterThan(800);
    expect(inA).toBeLessThan(1200);
  });

  it("falls to the control arm when the address is unusable", () => {
    expect(campaignVariantFor("camp-1", "")).toBe("a");
    expect(campaignVariantFor("camp-1", null)).toBe("a");
  });

  it("offers exactly two arms", () => {
    expect(CAMPAIGN_VARIANTS).toEqual(["a", "b"]);
  });
});

describe("splitting the audience", () => {
  // 20% of 5,000 is a 1,000-recipient slice — 500 per arm, comfortably over the
  // 300 decideWinner needs. The sizes here are deliberately consistent with
  // that floor; see the refusal test below for what happens when they are not.
  const recipients = Array.from({ length: 5000 }, (_, i) => `person${i}@x.test`);

  it("puts the test fraction in the arms and the rest in the holdout", () => {
    const split = splitTestAudience({ campaignId: "camp-1", recipients, testFraction: 0.2 });

    expect(split.a.length + split.b.length).toBe(1000);
    expect(split.holdout).toHaveLength(4000);
  });

  // THE INTERACTION THAT MATTERS. A slice too small to ever reach a conclusion
  // is not a cheap experiment, it is a wasted one: 200 people get a subject
  // chosen by coin toss, the test cannot resolve, and the remaining 800 get the
  // control anyway. Strictly worse than sending everyone the control once.
  it("refuses a split whose arms could never reach a conclusion", () => {
    const thousand = Array.from({ length: 1000 }, (_, i) => `person${i}@x.test`);
    const split = splitTestAudience({ campaignId: "camp-1", recipients: thousand, testFraction: 0.2 });

    expect(split.testable).toBe(false);
    expect(split.holdout).toHaveLength(1000);
  });

  it("never puts one recipient in two places", () => {
    const split = splitTestAudience({ campaignId: "camp-1", recipients, testFraction: 0.3 });
    const all = [...split.a, ...split.b, ...split.holdout];

    expect(new Set(all).size).toBe(all.length);
    expect(new Set(all)).toEqual(new Set(recipients));
  });

  it("is stable across calls, so a resumed send does not reshuffle the arms", () => {
    const first = splitTestAudience({ campaignId: "camp-1", recipients, testFraction: 0.2 });
    const second = splitTestAudience({ campaignId: "camp-1", recipients, testFraction: 0.2 });

    expect(second.a).toEqual(first.a);
    expect(second.b).toEqual(first.b);
    expect(second.holdout).toEqual(first.holdout);
  });

  // A LIST TOO SMALL TO TEST IS NOT TESTED. Splitting 40 people three ways
  // produces two arms that cannot answer anything and a holdout that is barely
  // worth sending to — so the whole list goes out as one send instead.
  it("refuses to split a list too small to learn anything from", () => {
    const tiny = Array.from({ length: 40 }, (_, i) => `person${i}@x.test`);
    const split = splitTestAudience({ campaignId: "camp-1", recipients: tiny, testFraction: 0.2 });

    expect(split.testable).toBe(false);
    expect(split.a).toHaveLength(0);
    expect(split.b).toHaveLength(0);
    expect(split.holdout).toEqual(tiny);
  });

  it("clamps an absurd test fraction rather than trusting it", () => {
    expect(splitTestAudience({ campaignId: "c", recipients, testFraction: 5 }).holdout.length).toBeGreaterThan(0);
    expect(splitTestAudience({ campaignId: "c", recipients, testFraction: -1 }).testable).toBe(false);
  });
});

describe("deciding a winner", () => {
  it("declares no winner before either arm has a usable sample", () => {
    const decision = decideWinner({
      a: { sent: 10, clicked: 1 },
      b: { sent: 10, clicked: 4 },
    });

    expect(decision.winner).toBeNull();
    expect(decision.confident).toBe(false);
    expect(decision.reason).toMatch(/sample/i);
  });

  // The headline case: a difference that LOOKS decisive and is not.
  it("declares no winner on a difference that is within noise", () => {
    const decision = decideWinner({
      a: { sent: 500, clicked: 20 },
      b: { sent: 500, clicked: 26 },
    });

    expect(decision.winner).toBeNull();
    expect(decision.confident).toBe(false);
  });

  it("declares a winner when the gap is large enough to be real", () => {
    const decision = decideWinner({
      a: { sent: 2000, clicked: 40 },
      b: { sent: 2000, clicked: 140 },
    });

    expect(decision.winner).toBe("b");
    expect(decision.confident).toBe(true);
  });

  it("can pick A as well as B", () => {
    const decision = decideWinner({
      a: { sent: 2000, clicked: 140 },
      b: { sent: 2000, clicked: 40 },
    });

    expect(decision.winner).toBe("a");
  });

  it("reports the rates it decided on", () => {
    const decision = decideWinner({
      a: { sent: 1000, clicked: 50 },
      b: { sent: 1000, clicked: 100 },
    });

    expect(decision.rateA).toBeCloseTo(0.05, 5);
    expect(decision.rateB).toBeCloseTo(0.1, 5);
  });

  it("declares no winner when the arms are identical", () => {
    const decision = decideWinner({ a: { sent: 5000, clicked: 250 }, b: { sent: 5000, clicked: 250 } });
    expect(decision.winner).toBeNull();
  });

  it("survives an empty arm without dividing by zero", () => {
    const decision = decideWinner({ a: { sent: 0, clicked: 0 }, b: { sent: 0, clicked: 0 } });
    expect(decision.winner).toBeNull();
    expect(Number.isFinite(decision.rateA)).toBe(true);
  });

  // The minimum is stated as a constant so the admin can show it: "needs 300
  // per arm, has 180" is actionable, "no winner yet" is not.
  it("exposes the minimum sample it requires", () => {
    expect(MIN_ARM_SAMPLE).toBeGreaterThan(0);
  });
});
