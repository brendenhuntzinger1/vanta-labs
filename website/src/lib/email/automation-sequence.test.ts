import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { AUTOMATION_KEYS, selectAutomationTargets, type AutomationKey } from "@/lib/email/automations";
import { AUTOMATION_QUIET_MS } from "@/lib/email/frequency";

// ---------------------------------------------------------------------------
// THE RETENTION LADDER, REPLAYED DAY BY DAY.
//
// The individual boundary tests in automations.test.ts prove each automation
// alone. This replays the SWEEP — every enabled automation, in priority order,
// twice a day, with the quiet period stamping the address exactly as
// runAutomationSweep does — against the delays production is configured with,
// and asserts the calendar the owner specified:
//
//   day 0 purchase → day 14 follow-up → day 30 free shipping
//                  → day 40 10% + BAC water → day 50 free GHK-Cu
//
// and that a purchase at ANY point stops the rest of that cycle and starts a
// fresh one from the new order. The audit of 2026-09-04 found production at
// 30/30/45, which produced day 30, day 31 (the quiet period pushed win-back 1
// one day) and day 45. These numbers are the contract now.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const EMAIL = "buyer@example.test";
const T0 = Date.parse("2026-01-01T12:00:00Z");

/** Production delays as configured in Admin → Email on 2026-09-04. */
export const PRODUCTION_DELAYS: Record<AutomationKey, number> = {
  welcome_intro: 1,
  welcome_no_purchase: 3,
  post_purchase: 14,
  replenishment: 30,
  winback_30: 40,
  winback_60: 50,
};

type Sent = { day: number; key: AutomationKey };

/**
 * Replay the sweep. `buyOnDays` are paid orders; `subscribedDaysBefore` puts a
 * guest opt-in that many days before day 0 (undefined = never subscribed
 * without buying, i.e. a pure buyer).
 */
function replay(input: {
  delays?: Record<AutomationKey, number>;
  enabled?: AutomationKey[];
  buyOnDays: number[];
  untilDay: number;
  subscribedOnDay?: number;
}): Sent[] {
  const delays = input.delays ?? PRODUCTION_DELAYS;
  const enabled = input.enabled ?? [...AUTOMATION_KEYS];
  const paidOrders: Array<{ email: string; orderId: string; at: number }> = [];
  const alreadySent = Object.fromEntries(AUTOMATION_KEYS.map((k) => [k, new Set<string>()])) as Record<AutomationKey, Set<string>>;
  const lastMarketingSentAt = new Map<string, number>();
  const sent: Sent[] = [];
  const buys = new Set(input.buyOnDays);
  const subscribedAt = new Map<string, number>();
  if (input.subscribedOnDay !== undefined) subscribedAt.set(EMAIL, T0 + input.subscribedOnDay * DAY);

  for (let day = 0; day <= input.untilDay; day++) {
    const dayStart = T0 + day * DAY + 1000;
    if (buys.has(day)) paidOrders.push({ email: EMAIL, orderId: `order-day${day}`, at: dayStart - 500 });
    for (const sweepOffset of [0, 12 * 60 * 60 * 1000]) {
      const now = dayStart + sweepOffset;
      for (const key of AUTOMATION_KEYS) {
        if (!enabled.includes(key)) continue;
        const targets = selectAutomationTargets({
          key,
          delayDays: delays[key],
          consented: new Set([EMAIL]),
          accounts: new Set(),
          accountCreatedAt: new Map(),
          subscribedAt,
          paidOrders,
          alreadySent: alreadySent[key],
          lastMarketingSentAt,
          quietMs: AUTOMATION_QUIET_MS,
          now,
        });
        for (const target of targets) {
          alreadySent[key].add(target.referenceId);
          lastMarketingSentAt.set(target.email, now);
          sent.push({ day, key });
        }
      }
    }
  }
  return sent;
}

const calendar = (sent: Sent[]) => sent.map((s) => `${s.day}:${s.key}`);

describe("the retention ladder with production delays", () => {
  it("a customer who buys once gets exactly day 14, 30, 40, 50", () => {
    const sent = replay({ buyOnDays: [0], untilDay: 90 });
    expect(calendar(sent)).toEqual([
      "14:post_purchase",
      "30:replenishment",
      "40:winback_30",
      "50:winback_60",
    ]);
  });

  it("never sends two gifts on consecutive days: the day-30 and day-40 mails are ten days apart", () => {
    const sent = replay({ buyOnDays: [0], untilDay: 60 });
    const reorder = sent.find((s) => s.key === "replenishment")!.day;
    const winback1 = sent.find((s) => s.key === "winback_30")!.day;
    const winback2 = sent.find((s) => s.key === "winback_60")!.day;
    expect(winback1 - reorder).toBe(10);
    expect(winback2 - winback1).toBe(10);
  });

  it("a purchase after the day-30 email stops day 40 and day 50, and restarts the ladder from the new order", () => {
    const sent = replay({ buyOnDays: [0, 32], untilDay: 95 });
    expect(calendar(sent)).toEqual([
      "14:post_purchase",
      "30:replenishment",
      // nothing on day 40 or day 50 for the old cycle
      "62:replenishment",
      "72:winback_30",
      "82:winback_60",
    ]);
  });

  it("a purchase after the day-40 email stops day 50 and restarts from the new order", () => {
    const sent = replay({ buyOnDays: [0, 42], untilDay: 100 });
    expect(calendar(sent)).toEqual([
      "14:post_purchase",
      "30:replenishment",
      "40:winback_30",
      "72:replenishment",
      "82:winback_30",
      "92:winback_60",
    ]);
  });

  it("a purchase after the day-50 email closes the cycle and starts a new one", () => {
    const sent = replay({ buyOnDays: [0, 51], untilDay: 105 });
    expect(calendar(sent)).toEqual([
      "14:post_purchase",
      "30:replenishment",
      "40:winback_30",
      "50:winback_60",
      "81:replenishment",
      "91:winback_30",
      "101:winback_60",
    ]);
  });

  it("the first-order follow-up goes once, never for a repeat order", () => {
    const sent = replay({ buyOnDays: [0, 32], untilDay: 60 });
    expect(sent.filter((s) => s.key === "post_purchase")).toHaveLength(1);
  });

  it("a subscriber who never buys gets the welcome pair and nothing from the retention ladder", () => {
    const sent = replay({ buyOnDays: [], subscribedOnDay: 0, untilDay: 60 });
    expect(calendar(sent)).toEqual(["1:welcome_intro", "3:welcome_no_purchase"]);
  });

  it("a subscriber who buys on day 2 gets the introduction but not the first-order offer", () => {
    const sent = replay({ buyOnDays: [2], subscribedOnDay: 0, untilDay: 60 });
    expect(calendar(sent)).toEqual(["1:welcome_intro", "16:post_purchase", "32:replenishment", "42:winback_30", "52:winback_60"]);
  });

  it("a purchase on the morning the day-30 mail is due wins: nothing from the old cycle goes out", () => {
    const sent = replay({ buyOnDays: [0, 30], untilDay: 70 });
    expect(calendar(sent)).toEqual(["14:post_purchase", "60:replenishment", "70:winback_30"]);
  });
});
