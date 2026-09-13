import { describe, expect, it } from "vitest";
import { selectDueStage, STAGE_WINDOWS } from "@/lib/cart-recovery";
import type { CartRecoveryConfig } from "@/lib/admin-control";

// ---------------------------------------------------------------------------
// THE RECOVERY LADDER ONLY EVER GOES UP.
//
// The sequence clock is the shopper's LAST ACTIVITY, deliberately: someone
// still adding to a cart is not an abandoner. The consequence is that elapsed
// RESETS when they come back and touch the cart without buying, which re-opens
// the early windows on a sequence that has already moved past them.
//
// Usually harmless — the early stage is claimed, and a claimed stage was
// already refused. Not always. A stage the operator had switched OFF when its
// window passed was never claimed, so switching it back on is enough:
//
//   hour 0    cart abandoned, t30m switched off
//   hour 12   t12h sends       (the t30m window has closed; nothing was claimed)
//   hour 24   t24h sends
//   hour 26   operator switches t30m back on
//   hour 30   the shopper edits the cart, does not buy → the clock resets
//   hour 31   elapsed is 1h. The t30m window is open, t30m is enabled, and
//             nothing has claimed it.
//
// Before this guard, hour 31 sent "Your cart is saved" — the opening line of a
// sequence the shopper is three messages into. There is no reading of that
// which is not a mistake to the person receiving it.
// ---------------------------------------------------------------------------

const HOUR = 60 * 60 * 1000;
const ALL_ON: CartRecoveryConfig = {
  t30mEnabled: true, t12hEnabled: true, t24hEnabled: true, t72hEnabled: true,
  discountPercent: 5, couponExpirationHours: 48,
} as CartRecoveryConfig;

/** Elapsed comfortably inside a stage's own window. */
const inside = (stage: keyof typeof STAGE_WINDOWS) =>
  STAGE_WINDOWS[stage].opensAfterMs + (STAGE_WINDOWS[stage].closesAfterMs - STAGE_WINDOWS[stage].opensAfterMs) / 2;

describe("a sequence that has already moved past a stage", () => {
  it("does NOT send the opening message after the 24-hour one has gone", () => {
    // The exact case above, at the moment it used to fire.
    expect(selectDueStage(inside("t30m"), ALL_ON, new Set(["t12h", "t24h"]), 7 * HOUR + HOUR)).toBeNull();
  });

  it("does not drop back to the 12-hour message either", () => {
    expect(selectDueStage(inside("t12h"), ALL_ON, new Set(["t24h"]), 9 * HOUR)).toBeNull();
  });

  it("still refuses a stage that is simply claimed, as it always did", () => {
    expect(selectDueStage(inside("t24h"), ALL_ON, new Set(["t24h"]), 9 * HOUR)).toBeNull();
  });
});

describe("what the guard must not break", () => {
  it("sends the opening message to a cart that has had nothing", () => {
    expect(selectDueStage(inside("t30m"), ALL_ON, new Set(), null)).toBe("t30m");
  });

  it("still climbs: a cart that had the opening message gets the 12-hour one", () => {
    expect(selectDueStage(inside("t12h"), ALL_ON, new Set(["t30m"]), 9 * HOUR)).toBe("t12h");
  });

  it("still reaches the last stage from the middle of the ladder", () => {
    expect(selectDueStage(inside("t72h"), ALL_ON, new Set(["t30m", "t12h", "t24h"]), 9 * HOUR)).toBe("t72h");
  });

  it("SKIPS FORWARD legitimately: a cart first seen late starts where it is", () => {
    // Nothing claimed, so there is no earlier stage to be behind. A cart whose
    // beacon arrived at hour 30 begins at the 24-hour message rather than
    // waiting out a ladder it has already slept through.
    expect(selectDueStage(inside("t24h"), ALL_ON, new Set(), null)).toBe("t24h");
  });

  it("a re-activated cart can still receive the stages ABOVE the ones it has", () => {
    // The guard withholds this tick, not the sequence. As the reset clock runs
    // on past the 24-hour mark, the 72-hour message is due exactly as before.
    const claimed = new Set(["t12h", "t24h"]);
    expect(selectDueStage(inside("t30m"), ALL_ON, claimed, 9 * HOUR)).toBeNull();
    expect(selectDueStage(inside("t72h"), ALL_ON, claimed, 9 * HOUR)).toBe("t72h");
  });

  it("keeps the eight-hour floor ahead of everything else", () => {
    expect(selectDueStage(inside("t72h"), ALL_ON, new Set(["t24h"]), HOUR)).toBeNull();
  });
});
