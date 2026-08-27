import { describe, expect, it } from "vitest";
import { selectProbeOrder } from "@/lib/shipping-cost-repair";

// THE RETRY TIER'S OWN STARVATION CLASS.
//
// selectProbeOrder spends most of the budget on candidates never probed, and
// gives a bounded leftover slice to rows already known to have failed. That
// slice is taken from a ROTATING offset, and the rotation is the only thing
// stopping the v1 bug reappearing one level down: with more known-failing rows
// than spare budget, a fixed offset retries the same head rows for ever and a
// row further back -- a QUEUED transaction that has since settled, or a
// transient outage that has ended -- is never tried again.
//
// The module documents that property. Nothing asserted it: freezing the offset
// to 0 left the whole suite green. These tests fail if the rotation is frozen.
const rows = (n: number, prefix: string) =>
  Array.from({ length: n }, (_, i) => ({ order_id: `${prefix}-${String(i).padStart(3, "0")}` }));

describe("selectProbeOrder — the retry tier rotates", () => {
  it("reaches every deferred row within ceil(tier / slice) ticks", () => {
    const candidates = rows(40, "stuck");
    const deferred = new Set(candidates.map((r) => r.order_id));
    const limit = 8;                       // slice = ceil(8/4) = 2
    const slice = Math.ceil(limit / 4);
    const ticksNeeded = Math.ceil(candidates.length / slice);

    const seen = new Set<string>();
    for (let tick = 0; tick < ticksNeeded; tick++) {
      for (const row of selectProbeOrder(candidates, deferred, limit, tick)) seen.add(row.order_id);
    }

    // Every deferred row got a retry within the documented bound.
    expect(seen.size).toBe(candidates.length);
  });

  it("does not hand the same rows to consecutive ticks", () => {
    const candidates = rows(40, "stuck");
    const deferred = new Set(candidates.map((r) => r.order_id));

    const t0 = selectProbeOrder(candidates, deferred, 8, 0).map((r) => r.order_id);
    const t1 = selectProbeOrder(candidates, deferred, 8, 1).map((r) => r.order_id);

    expect(t0.length).toBeGreaterThan(0);
    expect(t1).not.toEqual(t0);
    expect(t0.some((id) => t1.includes(id))).toBe(false);
  });

  it("still walks the tier when it is smaller than one slice", () => {
    const candidates = rows(2, "stuck");
    const deferred = new Set(candidates.map((r) => r.order_id));

    const seen = new Set<string>();
    for (let tick = 0; tick < 4; tick++) {
      for (const row of selectProbeOrder(candidates, deferred, 8, tick)) seen.add(row.order_id);
    }
    expect(seen.size).toBe(2);
  });

  // Fresh candidates must never lose budget to the rotation.
  it("never lets the retry slice displace a never-probed row", () => {
    const fresh = rows(8, "fresh");
    const stuck = rows(40, "stuck");
    const deferred = new Set(stuck.map((r) => r.order_id));

    for (let tick = 0; tick < 6; tick++) {
      const picked = selectProbeOrder([...stuck, ...fresh], deferred, 8, tick).map((r) => r.order_id);
      expect(picked.filter((id) => id.startsWith("fresh-")).length).toBe(8);
    }
  });
});
