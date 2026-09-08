import { describe, expect, it } from "vitest";
import {
  pickVariant,
  RECOVERY_VARIANTS,
  recoveryVariantFor,
} from "@/lib/cart-recovery-experiments";

// ---------------------------------------------------------------------------
// AN EXPERIMENT THAT MOVES CARTS BETWEEN ARMS MEASURES NOTHING.
//
// Cart recovery's failure is a click-rate failure: 41 emails to real customers
// produced one click. That is decided at the subject line, and the honest way
// to fix it is to find out which subject gets clicked rather than to guess a
// second time.
//
// The properties below are what make the answer trustworthy. Each is cheap to
// hold and expensive to lose, and the loss is silent in every case — a
// poisoned experiment still produces a number, and the number still looks like
// a result.
// ---------------------------------------------------------------------------

describe("assignment is deterministic", () => {
  // No random draw and no stored assignment, so a retry, a concurrent sweep,
  // a redeploy or a rollback cannot move a cart between arms.
  it("gives the same cart the same variant every time it is asked", () => {
    for (const id of ["cart-1", "70c07050-1b3b-43d2-84bc-703dbb6e173f", "x"]) {
      const first = recoveryVariantFor(id);
      for (let i = 0; i < 50; i += 1) expect(recoveryVariantFor(id)).toBe(first);
    }
  });

  // Stage 1 and stage 4 must describe the same experience, or neither arm
  // describes anything a shopper actually had.
  it("does not depend on the stage, so a cart keeps one arm for its whole sequence", () => {
    // The function takes only the cart id, which is the structural guarantee.
    expect(recoveryVariantFor.length).toBe(1);
  });

  it("only ever returns a known variant", () => {
    for (let i = 0; i < 500; i += 1) {
      expect(RECOVERY_VARIANTS).toContain(recoveryVariantFor(`cart-${i}`));
    }
  });
});

describe("assignment is balanced enough to compare arms", () => {
  // Not a uniformity proof — a hash is not a random number generator. This is
  // the weaker thing that actually matters: neither arm is starved, so a real
  // difference has a chance of showing up in both.
  it("puts a realistic id space roughly down the middle", () => {
    const ids = Array.from({ length: 2000 }, (_, i) => `cart-${i}-${(i * 7919) % 104729}`);
    const a = ids.filter((id) => recoveryVariantFor(id) === "a").length;
    expect(a).toBeGreaterThan(ids.length * 0.4);
    expect(a).toBeLessThan(ids.length * 0.6);
  });

  it("splits real UUID-shaped ids too, not just sequential ones", () => {
    const ids = Array.from({ length: 400 }, (_, i) =>
      `${i.toString(16).padStart(8, "0")}-4b1c-4f8d-891a-f55344aec180`);
    const a = ids.filter((id) => recoveryVariantFor(id) === "a").length;
    expect(a).toBeGreaterThan(ids.length * 0.35);
    expect(a).toBeLessThan(ids.length * 0.65);
  });
});

describe("an unusable id falls to the control arm", () => {
  // Silently joining the treatment would be the worse failure: the experiment
  // would report a difference that included carts nobody meant to enrol.
  it.each([null, undefined, "", "   "])("%o is control", (id) => {
    expect(recoveryVariantFor(id as string | null | undefined)).toBe("a");
  });
});

describe("pickVariant", () => {
  it("returns the control for a and the treatment for b", () => {
    expect(pickVariant("a", "control", "treatment")).toBe("control");
    expect(pickVariant("b", "control", "treatment")).toBe("treatment");
  });
});
