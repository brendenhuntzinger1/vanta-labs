import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { selectAutomationTargets, EVENT_GRACE_DAYS, type AutomationKey } from "@/lib/email/automations";
import { AUTOMATION_QUIET_MS } from "@/lib/email/frequency";
import { PRODUCTION_DELAYS } from "@/lib/email/automation-sequence.test";

// ---------------------------------------------------------------------------
// THE EXACT DAY THE CUT FALLS, PROVED ONE DAY EITHER SIDE.
//
// automation-sequence.test.ts replays ONE customer through the whole ladder and
// asserts the calendar. That proves the sequence. It cannot prove the boundary,
// because a single customer walking forward in time passes through every day —
// an off-by-one that fired a day early would still produce a "day 30" line in
// the calendar, one row lower.
//
// So this puts THREE customers in front of ONE sweep: one a day short, one
// exactly on the threshold, one a day past. Then it names, by address, who is
// selected and who is not. An off-by-one cannot survive that, in either
// direction — firing early puts the day-29 customer in the list, firing late
// drops the day-30 one.
//
// TWO THINGS THE REPLAY DOES NOT DO, AND THEY ARE THE REASON THIS FILE EXISTS.
//
//   1. It never passes `ladderPredecessor`. runAutomationSweep passes it for
//      winback_60 whenever winback_30 is enabled — which is production's
//      configuration today, both enabled — so the replay asserts the day-50
//      mail under a rule the real sweep does not use. It happens to agree,
//      because 50 - 40 is exactly the ten days the gate demands. That is a
//      coincidence of the current delays, not a property, and if the operator
//      moved win-back 2 to day 45 the replay would still pass while production
//      held the message back five days.
//
//   2. It has one customer, so it cannot express "this person yes, that person
//      no" at all.
//
// Ages are exact multiples of a day against a fixed `now`, so the threshold
// case lands on `at === cutoff` rather than near it. That is the semantic under
// test: "30 days after the order" includes the thirtieth day.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-06-15T12:00:00Z");
const at = (ageDays: number) => NOW - ageDays * DAY;

/** One address per age, so the answer names who rather than how many. */
const who = (ageDays: number) => `age-${ageDays}@example.test`;

type Case = {
  key: AutomationKey;
  /** Ages to place a customer at. */
  ages: number[];
  /** Which of those ages must be selected. */
  expect: number[];
  /** Win-back 2 only: when win-back 1 reached each episode, in days ago. */
  predecessorSentDaysAgo?: number | null;
  /** Suppress the ladder gate entirely (predecessor disabled). */
  noPredecessor?: boolean;
};

/**
 * Run one sweep of one automation over a population of one customer per age.
 *
 * Every customer is consented, has never been mailed, and — for the flows that
 * need one — has exactly one paid order at their age. Nothing else varies, so a
 * difference in the result is a difference in the threshold and nothing else.
 */
function select(c: Case): string[] {
  const isWelcome = c.key === "welcome_intro" || c.key === "welcome_no_purchase";
  const delayDays = PRODUCTION_DELAYS[c.key];

  const consented = new Set(c.ages.map(who));
  const subscribedAt = new Map<string, number>();
  const paidOrders: Array<{ email: string; orderId: string; at: number }> = [];

  for (const age of c.ages) {
    if (isWelcome) subscribedAt.set(who(age), at(age));
    else paidOrders.push({ email: who(age), orderId: `order-${age}`, at: at(age) });
  }

  // Win-back 2's gate, built the way runAutomationSweep builds it: keyed by the
  // EPISODE reference (`email:lastOrderAt`), not by address.
  let ladderPredecessor: { sentAt: Map<string, number>; delayDays: number } | null = null;
  if (c.key === "winback_60" && !c.noPredecessor) {
    const sentAt = new Map<string, number>();
    if (c.predecessorSentDaysAgo !== null && c.predecessorSentDaysAgo !== undefined) {
      for (const age of c.ages) sentAt.set(`${who(age)}:${at(age)}`, at(c.predecessorSentDaysAgo));
    }
    ladderPredecessor = { sentAt, delayDays: PRODUCTION_DELAYS.winback_30 };
  }

  return selectAutomationTargets({
    key: c.key,
    delayDays,
    consented,
    accounts: new Set(),
    accountCreatedAt: new Map(),
    subscribedAt,
    paidOrders,
    alreadySent: new Set(),
    lastMarketingSentAt: new Map(),
    quietMs: AUTOMATION_QUIET_MS,
    ladderPredecessor,
    now: NOW,
    limit: 100,
  })
    .map((t) => t.email)
    .sort();
}

const expected = (ages: number[]) => ages.map(who).sort();

// ---------------------------------------------------------------------------
// THE THREE BOUNDARIES THE OWNER NAMED: day 30, day 40, day 50.
// ---------------------------------------------------------------------------
describe("the day the automation is due, one day either side", () => {
  it("replenishment (day 30): 29 waits, 30 and 31 go", () => {
    expect(select({ key: "replenishment", ages: [29, 30, 31], expect: [30, 31] }))
      .toEqual(expected([30, 31]));
  });

  it("win-back 1 (day 40): 39 waits, 40 and 41 go", () => {
    expect(select({ key: "winback_30", ages: [39, 40, 41], expect: [40, 41] }))
      .toEqual(expected([40, 41]));
  });

  it("win-back 2 (day 50): 49 waits, 50 and 51 go — once win-back 1 has been sent", () => {
    // Win-back 1 reached this episode ten days ago, which is exactly the
    // ladder's spacing (50 − 40), so the gate is open and only the day
    // threshold decides.
    expect(select({ key: "winback_60", ages: [49, 50, 51], expect: [50, 51], predecessorSentDaysAgo: 10 }))
      .toEqual(expected([50, 51]));
  });
});

// ---------------------------------------------------------------------------
// THE REST OF THE LADDER, ON THE SAME PRINCIPLE.
// ---------------------------------------------------------------------------
describe("the earlier steps have exact boundaries too", () => {
  it("welcome intro (day 1): the day they subscribe is too early", () => {
    expect(select({ key: "welcome_intro", ages: [0, 1, 2], expect: [1, 2] })).toEqual(expected([1, 2]));
  });

  it("welcome offer (day 3): 2 waits, 3 and 4 go", () => {
    expect(select({ key: "welcome_no_purchase", ages: [2, 3, 4], expect: [3, 4] })).toEqual(expected([3, 4]));
  });

  it("first-order follow-up (day 14): 13 waits, 14 and 15 go", () => {
    expect(select({ key: "post_purchase", ages: [13, 14, 15], expect: [14, 15] })).toEqual(expected([14, 15]));
  });
});

// ---------------------------------------------------------------------------
// THE OTHER END OF THE WINDOW.
//
// EVENT_GRACE_DAYS exists so that switching an automation on does not mail
// every customer whose order is older than the delay. It is a real boundary and
// it is invisible in a forward replay, because a replayed customer passes
// through the window on the correct day and never tests its far edge.
// ---------------------------------------------------------------------------
describe("event-keyed flows stop looking back after the grace window", () => {
  it("replenishment covers day 30 through day 44, and nothing older", () => {
    const last = PRODUCTION_DELAYS.replenishment + EVENT_GRACE_DAYS; // 44
    expect(select({ key: "replenishment", ages: [last - 1, last, last + 1], expect: [last - 1, last] }))
      .toEqual(expected([last - 1, last]));
  });

  it("the first-order follow-up does the same, at its own delay", () => {
    const last = PRODUCTION_DELAYS.post_purchase + EVENT_GRACE_DAYS; // 28
    expect(select({ key: "post_purchase", ages: [last, last + 1], expect: [last] })).toEqual(expected([last]));
  });

  it("but a win-back has no far edge: a 400-day lapse is still a lapse", () => {
    // Deliberate asymmetry, stated in automation-catalog.ts. "It has been a
    // while" is true of a 400-day gap in a way "time to restock?" is not.
    expect(select({ key: "winback_30", ages: [400], expect: [400] })).toEqual(expected([400]));
  });
});

// ---------------------------------------------------------------------------
// THE LADDER GATE. This is the rule the replay never exercises.
// ---------------------------------------------------------------------------
describe("win-back 2 waits for win-back 1", () => {
  it("sends nobody at day 50 when win-back 1 has not gone out for that episode", () => {
    expect(select({ key: "winback_60", ages: [50, 51, 60], expect: [], predecessorSentDaysAgo: null }))
      .toEqual([]);
  });

  it("still waits nine days after win-back 1, and goes on the tenth", () => {
    const spacing = PRODUCTION_DELAYS.winback_60 - PRODUCTION_DELAYS.winback_30; // 10
    expect(select({ key: "winback_60", ages: [60], expect: [], predecessorSentDaysAgo: spacing - 1 }))
      .toEqual([]);
    expect(select({ key: "winback_60", ages: [60], expect: [60], predecessorSentDaysAgo: spacing }))
      .toEqual(expected([60]));
  });

  it("without the gate the day-50 customer would go — so the gate is what is being measured", () => {
    // The control. If this were empty too, the two assertions above would pass
    // for the wrong reason: nothing eligible rather than a gate holding it.
    expect(select({ key: "winback_60", ages: [50], expect: [50], noPredecessor: true }))
      .toEqual(expected([50]));
  });
});

// ---------------------------------------------------------------------------
// WHO IS EXCLUDED, AT THE EXACT DAY THEY WOULD OTHERWISE BE DUE.
//
// Every one of these is a customer standing precisely on the threshold, so a
// rule that stopped working would show up as a send rather than as a silence.
// ---------------------------------------------------------------------------
describe("nobody ineligible is selected on the day they would be due", () => {
  const base = {
    accounts: new Set<string>(),
    accountCreatedAt: new Map<string, number>(),
    quietMs: AUTOMATION_QUIET_MS,
    now: NOW,
    limit: 100,
  };

  it("a customer who never consented is not mailed on day 30", () => {
    const targets = selectAutomationTargets({
      ...base,
      key: "replenishment",
      delayDays: 30,
      consented: new Set(),                                   // ← the only difference
      subscribedAt: new Map(),
      paidOrders: [{ email: who(30), orderId: "o", at: at(30) }],
      alreadySent: new Set(),
      lastMarketingSentAt: new Map(),
    });
    expect(targets).toEqual([]);
  });

  it("a customer already sent this episode is not sent again", () => {
    const targets = selectAutomationTargets({
      ...base,
      key: "replenishment",
      delayDays: 30,
      consented: new Set([who(30)]),
      subscribedAt: new Map(),
      paidOrders: [{ email: who(30), orderId: "o", at: at(30) }],
      alreadySent: new Set(["o"]),                            // ← the only difference
      lastMarketingSentAt: new Map(),
    });
    expect(targets).toEqual([]);
  });

  it("a customer mailed an hour ago is DEFERRED, not dropped, and says so", () => {
    const deferred: string[] = [];
    const targets = selectAutomationTargets({
      ...base,
      key: "replenishment",
      delayDays: 30,
      consented: new Set([who(30)]),
      subscribedAt: new Map(),
      paidOrders: [{ email: who(30), orderId: "o", at: at(30) }],
      alreadySent: new Set(),
      lastMarketingSentAt: new Map([[who(30), NOW - 60 * 60 * 1000]]),
      onDeferred: (t) => deferred.push(t.email),
    });
    expect(targets).toEqual([]);
    // Deferred is not the same as ineligible: nothing is consumed and the next
    // sweep reconsiders. If this list were empty the customer would have been
    // silently dropped, which is the failure the caller counts.
    expect(deferred).toEqual([who(30)]);
  });

  it("the reorder reminder ignores an order that is no longer the latest", () => {
    const email = "repeat@example.test";
    const targets = selectAutomationTargets({
      ...base,
      key: "replenishment",
      delayDays: 30,
      consented: new Set([email]),
      subscribedAt: new Map(),
      paidOrders: [
        { email, orderId: "old", at: at(30) },   // due, but superseded
        { email, orderId: "new", at: at(2) },    // they came back
      ],
      alreadySent: new Set(),
      lastMarketingSentAt: new Map(),
    });
    expect(targets).toEqual([]);
  });

  it("the first-order follow-up ignores a second order", () => {
    const email = "second@example.test";
    const targets = selectAutomationTargets({
      ...base,
      key: "post_purchase",
      delayDays: 14,
      consented: new Set([email]),
      subscribedAt: new Map(),
      paidOrders: [
        { email, orderId: "first", at: at(60) },   // first, but outside the grace window
        { email, orderId: "second", at: at(14) },  // due by age, but not their first
      ],
      alreadySent: new Set(),
      lastMarketingSentAt: new Map(),
    });
    expect(targets).toEqual([]);
  });

  it("a welcome is not sent to someone who has bought", () => {
    const email = "bought@example.test";
    const targets = selectAutomationTargets({
      ...base,
      key: "welcome_no_purchase",
      delayDays: 3,
      consented: new Set([email]),
      subscribedAt: new Map([[email, at(3)]]),
      paidOrders: [{ email, orderId: "o", at: at(1) }],
      alreadySent: new Set(),
      lastMarketingSentAt: new Map(),
    });
    expect(targets).toEqual([]);
  });

  it("a win-back is not sent to someone who has never bought", () => {
    const email = "never@example.test";
    const targets = selectAutomationTargets({
      ...base,
      key: "winback_30",
      delayDays: 40,
      consented: new Set([email]),
      subscribedAt: new Map([[email, at(400)]]),
      paidOrders: [],
      alreadySent: new Set(),
      lastMarketingSentAt: new Map(),
    });
    expect(targets).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// TWO AUTOMATIONS, ONE INBOX, ONE SWEEP.
//
// The owner's question: can a customer receive several marketing messages
// because two automations independently decide they are eligible? At day 50 a
// lapsed customer satisfies BOTH win-backs on age alone.
// ---------------------------------------------------------------------------
describe("one address cannot be taken by two automations in the same sweep", () => {
  it("win-back 1 goes and win-back 2 is held, because the first stamped the address", () => {
    const email = "lapsed@example.test";
    const paidOrders = [{ email, orderId: "o", at: at(50) }];
    const lastMarketingSentAt = new Map<string, number>();
    const common = {
      consented: new Set([email]),
      accounts: new Set<string>(),
      accountCreatedAt: new Map<string, number>(),
      subscribedAt: new Map<string, number>(),
      paidOrders,
      alreadySent: new Set<string>(),
      lastMarketingSentAt,
      quietMs: AUTOMATION_QUIET_MS,
      now: NOW,
      limit: 100,
    };

    // Priority order, exactly as the sweep runs them: win-back 1 first.
    const first = selectAutomationTargets({ ...common, key: "winback_30", delayDays: 40 });
    expect(first.map((t) => t.email)).toEqual([email]);
    // The sweep stamps the address after each send. That is what the second
    // automation then sees.
    lastMarketingSentAt.set(email, NOW);

    const second = selectAutomationTargets({
      ...common,
      key: "winback_60",
      delayDays: 50,
      ladderPredecessor: { sentAt: new Map([[`${email}:${at(50)}`, NOW]]), delayDays: 40 },
    });
    expect(second).toEqual([]);
  });
});
