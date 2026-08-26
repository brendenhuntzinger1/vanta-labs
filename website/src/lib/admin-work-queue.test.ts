import { describe, expect, it } from "vitest";

import { summarizeWorkQueue, type WorkQueueSummary } from "@/lib/admin-work-queue";

// ---------------------------------------------------------------------------
// THE NUMBER THE ADMIN NEVER SHOWED.
//
// The dashboard carried ten tiles -- paid orders, revenue 30d, net profit,
// published products, pending partners, low stock, reconciliation flags, and
// revenue today/7d/30d AGAIN inside the live-metrics block -- and not one of
// them was "how much work is waiting".
//
// Driven against the browser harness with 120 seeded orders, 60 of them in
// Needs Fulfillment, the dashboard's most prominent figure was revenue and the
// number 60 appeared nowhere on the page. The navigation carried no counts
// either, so the answer to "what do I do now" required opening Fulfillment and
// reading a queue.
//
// This turns the buckets the workstation already computes into the four
// numbers an owner needs before they have decided which screen to open. It is
// a pure reshape of getBucketCounts() output plus the open-critical alert
// count -- it must never invent a number the workstation would disagree with.
// ---------------------------------------------------------------------------

const buckets = (over: Partial<Record<string, number>> = {}) =>
  [
    { id: "ready", label: "Needs Fulfillment", description: "", operational: true, count: over.ready ?? 60 },
    { id: "in_progress", label: "In Progress", description: "", operational: true, count: over.in_progress ?? 10 },
    { id: "awaiting_carrier", label: "Awaiting Carrier", description: "", operational: true, count: over.awaiting_carrier ?? 10 },
    { id: "in_transit", label: "In Transit", description: "", operational: false, count: over.in_transit ?? 10 },
    { id: "out_for_delivery", label: "Out for Delivery", description: "", operational: false, count: over.out_for_delivery ?? 10 },
    { id: "delivered", label: "Delivered", description: "", operational: false, count: over.delivered ?? 10 },
    { id: "exceptions", label: "Exceptions", description: "", operational: true, count: over.exceptions ?? 10 },
    { id: "terminal", label: "Terminal", description: "", operational: false, count: over.terminal ?? 0 },
  ] as const;

describe("summarizeWorkQueue", () => {
  it("reports the four numbers an owner needs before choosing a screen", () => {
    const summary = summarizeWorkQueue([...buckets()], 2);

    expect(summary).toEqual<WorkQueueSummary>({
      needsFulfillment: 60,
      inProgress: 10,
      exceptions: 10,
      openCriticalAlerts: 2,
      totalActionable: 82,
    });
  });

  it("counts only work a human must act on, never carrier-side states", () => {
    // In transit, out for delivery and delivered are the carrier's problem.
    // Rolling them into the headline would tell an owner with an empty pick
    // queue that they have 30 things to do.
    const summary = summarizeWorkQueue([...buckets({ ready: 0, in_progress: 0, exceptions: 0 })], 0);

    expect(summary.totalActionable).toBe(0);
    expect(summary.needsFulfillment).toBe(0);
  });

  it("is zero across the board on a quiet store", () => {
    const quiet = [...buckets({ ready: 0, in_progress: 0, exceptions: 0, in_transit: 0, out_for_delivery: 0, delivered: 0, awaiting_carrier: 0 })];

    expect(summarizeWorkQueue(quiet, 0)).toEqual<WorkQueueSummary>({
      needsFulfillment: 0,
      inProgress: 0,
      exceptions: 0,
      openCriticalAlerts: 0,
      totalActionable: 0,
    });
  });

  it("survives a bucket list that is missing ids rather than reporting NaN", () => {
    // getBucketCounts() is the source, but a partial read must degrade to 0 --
    // a dashboard that renders "NaN orders waiting" is worse than one that
    // renders nothing.
    const summary = summarizeWorkQueue([{ id: "ready", label: "", description: "", operational: true, count: 7 }], 0);

    expect(summary.needsFulfillment).toBe(7);
    expect(summary.inProgress).toBe(0);
    expect(summary.exceptions).toBe(0);
    expect(summary.totalActionable).toBe(7);
  });

  it("treats a negative or non-numeric alert count as zero", () => {
    expect(summarizeWorkQueue([...buckets()], -3).openCriticalAlerts).toBe(0);
    expect(summarizeWorkQueue([...buckets()], Number.NaN).openCriticalAlerts).toBe(0);
  });

  it("adds exceptions and criticals into the headline, because both block shipping", () => {
    const summary = summarizeWorkQueue([...buckets({ ready: 3, in_progress: 1, exceptions: 4 })], 5);

    expect(summary.totalActionable).toBe(3 + 1 + 4 + 5);
  });
});
