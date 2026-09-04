import { describe, expect, it } from "vitest";
import { isAutomationKey, selectAutomationTargets } from "@/lib/email/automations";

// ---------------------------------------------------------------------------
// The dedup key is the whole game here. Get it wrong in one direction and a
// customer receives the same message every 30 minutes forever; get it wrong in
// the other and they receive it once and never again, including after they come
// back and lapse a second time. The win-back episode key is the subtle one and
// most of this file is about it.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 7, 17, 12, 0, 0);

const base = {
  consented: new Set<string>(),
  accounts: new Set<string>(),
  accountCreatedAt: new Map<string, number>(),
  paidOrders: [] as Array<{ email: string; orderId: string; at: number }>,
  alreadySent: new Set<string>(),
  now: NOW,
};

describe("welcome_no_purchase", () => {
  it("targets account holders past the delay who have never bought", () => {
    const targets = selectAutomationTargets({
      ...base,
      key: "welcome_no_purchase",
      delayDays: 3,
      consented: new Set(["new@example.com", "fresh@example.com"]),
      accounts: new Set(["new@example.com", "fresh@example.com"]),
      accountCreatedAt: new Map([
        ["new@example.com", NOW - 5 * DAY],
        ["fresh@example.com", NOW - 1 * DAY], // too new
      ]),
    });
    expect(targets).toEqual([{ email: "new@example.com", referenceId: "new@example.com" }]);
  });

  it("keys on the email, because a person is new exactly once", () => {
    const targets = selectAutomationTargets({
      ...base,
      key: "welcome_no_purchase",
      delayDays: 3,
      consented: new Set(["new@example.com"]),
      accounts: new Set(["new@example.com"]),
      accountCreatedAt: new Map([["new@example.com", NOW - 5 * DAY]]),
      alreadySent: new Set(["new@example.com"]),
    });
    expect(targets).toEqual([]);
  });

  it("skips anyone who has already bought", () => {
    const targets = selectAutomationTargets({
      ...base,
      key: "welcome_no_purchase",
      delayDays: 3,
      consented: new Set(["buyer@example.com"]),
      accounts: new Set(["buyer@example.com"]),
      accountCreatedAt: new Map([["buyer@example.com", NOW - 30 * DAY]]),
      paidOrders: [{ email: "buyer@example.com", orderId: "o1", at: NOW - 10 * DAY }],
    });
    expect(targets).toEqual([]);
  });
});

describe("post_purchase", () => {
  it("keys on the customer's FIRST order, and on nothing after it", () => {
    // The follow-up explains the COA, storage and support. A second-time
    // buyer knows all of that; their second order is the reorder reminder's
    // job. So o2 is never a post_purchase target, sent or not.
    const targets = selectAutomationTargets({
      ...base,
      key: "post_purchase",
      delayDays: 14,
      consented: new Set(["repeat@example.com"]),
      paidOrders: [
        { email: "repeat@example.com", orderId: "o1", at: NOW - 20 * DAY },
        { email: "repeat@example.com", orderId: "o2", at: NOW - 16 * DAY },
      ],
    });
    expect(targets).toEqual([{ email: "repeat@example.com", referenceId: "o1" }]);
  });

  it("waits out the delay", () => {
    const targets = selectAutomationTargets({
      ...base,
      key: "post_purchase",
      delayDays: 14,
      consented: new Set(["recent@example.com"]),
      paidOrders: [{ email: "recent@example.com", orderId: "o1", at: NOW - 2 * DAY }],
    });
    expect(targets).toEqual([]);
  });
});

describe("win-back episodes", () => {
  const dormant = [{ email: "lapsed@example.com", orderId: "o1", at: NOW - 45 * DAY }];

  it("targets someone past the threshold", () => {
    const targets = selectAutomationTargets({
      ...base,
      key: "winback_30",
      delayDays: 30,
      consented: new Set(["lapsed@example.com"]),
      paidOrders: dormant,
    });
    expect(targets).toEqual([
      { email: "lapsed@example.com", referenceId: `lapsed@example.com:${NOW - 45 * DAY}` },
    ]);
  });

  it("does not repeat within the same dormancy episode", () => {
    const targets = selectAutomationTargets({
      ...base,
      key: "winback_30",
      delayDays: 30,
      consented: new Set(["lapsed@example.com"]),
      paidOrders: dormant,
      alreadySent: new Set([`lapsed@example.com:${NOW - 45 * DAY}`]),
    });
    expect(targets).toEqual([]);
  });

  it("becomes eligible again after they buy and lapse a SECOND time", () => {
    // This is the reason the key includes the last-order date. Keyed on the
    // address alone, this customer would be won back once in their lifetime.
    const targets = selectAutomationTargets({
      ...base,
      key: "winback_30",
      delayDays: 30,
      consented: new Set(["lapsed@example.com"]),
      paidOrders: [
        { email: "lapsed@example.com", orderId: "o1", at: NOW - 200 * DAY },
        // They came back, bought again, and have now gone quiet a second time.
        { email: "lapsed@example.com", orderId: "o2", at: NOW - 40 * DAY },
      ],
      alreadySent: new Set([`lapsed@example.com:${NOW - 200 * DAY}`]),
    });
    expect(targets).toEqual([
      { email: "lapsed@example.com", referenceId: `lapsed@example.com:${NOW - 40 * DAY}` },
    ]);
  });

  it("stops targeting someone the moment they buy again", () => {
    const targets = selectAutomationTargets({
      ...base,
      key: "winback_30",
      delayDays: 30,
      consented: new Set(["returned@example.com"]),
      paidOrders: [
        { email: "returned@example.com", orderId: "o1", at: NOW - 200 * DAY },
        { email: "returned@example.com", orderId: "o2", at: NOW - 2 * DAY },
      ],
    });
    expect(targets).toEqual([]);
  });

  it("never targets someone who has never bought", () => {
    const targets = selectAutomationTargets({
      ...base,
      key: "winback_60",
      delayDays: 60,
      consented: new Set(["never@example.com"]),
    });
    expect(targets).toEqual([]);
  });
});

describe("consent and batching", () => {
  it("skips anyone not consented, even with a perfect order history", () => {
    const targets = selectAutomationTargets({
      ...base,
      key: "winback_30",
      delayDays: 30,
      consented: new Set(),
      paidOrders: [{ email: "nonconsenting@example.com", orderId: "o1", at: NOW - 90 * DAY }],
    });
    expect(targets).toEqual([]);
  });

  it("caps a run so switching an automation on can't mail the whole list at once", () => {
    const consented = new Set<string>();
    const paidOrders: Array<{ email: string; orderId: string; at: number }> = [];
    for (let index = 0; index < 200; index++) {
      const email = `person${index}@example.com`;
      consented.add(email);
      paidOrders.push({ email, orderId: `o${index}`, at: NOW - 90 * DAY });
    }
    const targets = selectAutomationTargets({
      ...base, key: "winback_30", delayDays: 30, consented, paidOrders, limit: 50,
    });
    expect(targets).toHaveLength(50);
  });
});

describe("isAutomationKey", () => {
  it("rejects anything not on the list", () => {
    expect(isAutomationKey("winback_30")).toBe(true);
    expect(isAutomationKey("winback_999")).toBe(false);
    expect(isAutomationKey(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2026-09-04: the lifecycle engine grew two flows and three rules. Each has a
// customer-visible failure if it regresses, which is why they are pinned here.
// ---------------------------------------------------------------------------

describe("welcome flows reach guest subscribers too", () => {
  it("times the welcome from a guest's opt-in, not only from account creation", () => {
    const targets = selectAutomationTargets({
      ...base,
      key: "welcome_intro",
      delayDays: 1,
      consented: new Set(["guest@example.com"]),
      subscribedAt: new Map([["guest@example.com", NOW - 2 * DAY]]),
    });
    expect(targets).toEqual([{ email: "guest@example.com", referenceId: "guest@example.com" }]);
  });

  it("does not backfill someone who subscribed months ago when the flow is switched on", () => {
    const targets = selectAutomationTargets({
      ...base,
      key: "welcome_intro",
      delayDays: 1,
      consented: new Set(["old@example.com"]),
      subscribedAt: new Map([["old@example.com", NOW - 120 * DAY]]),
    });
    expect(targets).toEqual([]);
  });
});

describe("post_purchase is for the first order", () => {
  it("does not send it again for a second order", () => {
    const targets = selectAutomationTargets({
      ...base,
      key: "post_purchase",
      delayDays: 5,
      consented: new Set(["repeat@example.com"]),
      paidOrders: [
        { email: "repeat@example.com", orderId: "o1", at: NOW - 40 * DAY },
        { email: "repeat@example.com", orderId: "o2", at: NOW - 10 * DAY },
      ],
      alreadySent: new Set(["o1"]),
    });
    expect(targets).toEqual([]);
  });

  it("does not backfill an order older than the delay plus the grace window", () => {
    const targets = selectAutomationTargets({
      ...base,
      key: "post_purchase",
      delayDays: 5,
      consented: new Set(["old@example.com"]),
      paidOrders: [{ email: "old@example.com", orderId: "o1", at: NOW - 90 * DAY }],
    });
    expect(targets).toEqual([]);
  });
});

describe("replenishment", () => {
  it("fires for the latest order once the delay has passed", () => {
    const targets = selectAutomationTargets({
      ...base,
      key: "replenishment",
      delayDays: 30,
      consented: new Set(["lab@example.com"]),
      paidOrders: [{ email: "lab@example.com", orderId: "o1", at: NOW - 32 * DAY }],
    });
    expect(targets).toEqual([{ email: "lab@example.com", referenceId: "o1" }]);
  });

  it("stops for an order the customer has already reordered after", () => {
    // The reminder for o1 is due, but o2 exists: they restocked on their own.
    const targets = selectAutomationTargets({
      ...base,
      key: "replenishment",
      delayDays: 30,
      consented: new Set(["lab@example.com"]),
      paidOrders: [
        { email: "lab@example.com", orderId: "o1", at: NOW - 32 * DAY },
        { email: "lab@example.com", orderId: "o2", at: NOW - 3 * DAY },
      ],
    });
    expect(targets).toEqual([]);
  });
});

describe("the quiet period", () => {
  it("skips someone mailed by any marketing flow in the last day, and reconsiders them later", () => {
    const input = {
      ...base,
      key: "winback_30" as const,
      delayDays: 30,
      consented: new Set(["busy@example.com"]),
      paidOrders: [{ email: "busy@example.com", orderId: "o1", at: NOW - 45 * DAY }],
    };
    const quiet = selectAutomationTargets({
      ...input,
      lastMarketingSentAt: new Map([["busy@example.com", NOW - 3 * 60 * 60 * 1000]]),
    });
    expect(quiet).toEqual([]);

    const later = selectAutomationTargets({
      ...input,
      lastMarketingSentAt: new Map([["busy@example.com", NOW - 2 * DAY]]),
    });
    expect(later).toHaveLength(1);
  });
});
