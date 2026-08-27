import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// THE MEMBERSHIP BILLING MODULE, ACTUALLY EXECUTED.
//
// vitest.setup.ts replaces @/lib/membership-billing for the entire suite with
// a two-function stub. The real module is 1,533 lines and 21 exports. Nothing
// in 2,816 tests had ever run ANY of it.
//
// The architecture that matters, established by reading the code:
//
//   Two kinds of membership live in customer_memberships.
//
//   VEYRA-OWNED  (veyra_membership_id IS NOT NULL)
//       Veyra charges the card and runs its own retry/dunning cron. Vanta's
//       sweep must never touch these rows -- not to charge, not to remind, not
//       to mark past-due. If both systems billed, every Veyra-backed member
//       would be charged twice a month.
//
//   LOCALLY BILLED (veyra_membership_id IS NULL)
//       Vanta's 30-minute sweep is the biller.
//
//   Anything that changes a Veyra-owned subscription -- cancel, card update --
//   must tell VEYRA FIRST and abort on refusal. A local-only write shows the
//   customer a change that never happened while the real charges continue.
//
// Every test below was confirmed to fail when its protection is removed.
// ---------------------------------------------------------------------------

vi.unmock("@/lib/membership-billing");

interface MembershipRow {
  user_id: string;
  tier_id: string;
  status: string;
  intro_status: string;
  intro_ends_at: string | null;
  next_billing_at: string | null;
  next_billing_amount_cents: number | null;
  first_month_remainder_cents: number | null;
  first_month_reminder_sent_at: string | null;
  renewal_reminder_sent_at: string | null;
  cancel_at_period_end: boolean;
  billing_cycle: string;
  veyra_membership_id: string | null;
  payment_method_ref: string | null;
  membership_tiers: { id: string; name: string } | null;
}

const state: {
  memberships: MembershipRow[];
  billingEvents: Array<Record<string, unknown>>;
  updates: Array<{ filters: Array<[string, string, unknown]>; payload: Record<string, unknown> }>;
  paidEventRows: Array<Record<string, unknown>>;
  // K-03: lets a test make ONE customer_memberships update fail, which is the
  // condition under which a successful charge leaves the row still due.
  failNextMembershipUpdate: boolean;
  // FIX WAVE 3: PostgREST resolves `{ data: null, error }` for a statement
  // timeout rather than throwing, and that was indistinguishable from "this
  // customer has no membership".
  failNextMembershipRead: boolean;
} = { memberships: [], billingEvents: [], updates: [], paidEventRows: [], failNextMembershipUpdate: false, failNextMembershipRead: false };

const { chargeCard, cancelVeyra, updateVeyraCard, sendEmail } = vi.hoisted(() => ({
  chargeCard: vi.fn(async (_input: Record<string, unknown>): Promise<{ success: boolean; chargeId?: string; error?: string }> => ({ success: true, chargeId: "ch_1" })),
  cancelVeyra: vi.fn(async (_id: string, _atPeriodEnd: boolean) => ({ ok: true as boolean, message: "" })),
  updateVeyraCard: vi.fn(async (_id: string, _ref: string) => ({ ok: true as boolean, message: "" })),
  sendEmail: vi.fn(async () => ({ success: true })),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/email/send", () => ({ sendEmail }));
vi.mock("@/lib/billing-provider", () => ({ getBillingProvider: () => ({ chargeCard }) }));
vi.mock("@/lib/veyra-membership", () => ({
  startVeyraMembership: vi.fn(async () => ({ ok: true, membershipId: "vey_new" })),
  cancelVeyraMembership: cancelVeyra,
  skipVeyraMembershipCycle: vi.fn(async () => ({ ok: true, message: "" })),
  updateVeyraMembershipCard: updateVeyraCard,
}));
vi.mock("@/lib/store-credit", () => ({
  grantMonthlyStoreCredit: vi.fn(async () => {}),
  reconcileMonthlyStoreCredit: vi.fn(async () => {}),
}));
vi.mock("@/lib/email/marketing", () => ({ sendMarketingEmail: vi.fn(async () => ({ success: true })) }));
vi.mock("@/lib/monitoring", () => ({ recordSystemAlert: vi.fn(async () => {}) }));
vi.mock("@/lib/env", () => ({ getSiteUrl: () => "https://example.test" }));
vi.mock("@/lib/payment-provider", () => ({
  getPaymentProvider: () => ({}),
  isCheckoutOpen: () => true,
}));

vi.mock("@/lib/supabase-server", () => {
  const from = (table: string) => {
    if (table === "customer_memberships") {
      return {
        select: () => {
          const filters: Array<[string, string, unknown]> = [];
          const b: Record<string, unknown> = {
            eq(c: string, v: unknown) { filters.push(["eq", c, v]); return b; },
            is(c: string, v: unknown) { filters.push(["is", c, v]); return b; },
            gt(c: string, v: unknown) { filters.push(["gt", c, v]); return b; },
            lte(c: string, v: unknown) { filters.push(["lte", c, v]); return b; },
            limit() { return b; },
            async maybeSingle() {
              if (state.failNextMembershipRead) {
                state.failNextMembershipRead = false;
                return { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } };
              }
              const found = state.memberships.find((m) => matches(m, filters));
              return { data: found ? { ...found } : null, error: null };
            },
            then(resolve: (v: { data: unknown; error: null }) => unknown) {
              const rows = state.memberships.filter((m) => matches(m, filters)).map((m) => ({ ...m }));
              return Promise.resolve({ data: rows, error: null }).then(resolve);
            },
          };
          return b;
        },
        update: (payload: Record<string, unknown>) => {
          const filters: Array<[string, string, unknown]> = [];
          const b: Record<string, unknown> = {
            eq(c: string, v: unknown) { filters.push(["eq", c, v]); return b; },
            is(c: string, v: unknown) { filters.push(["is", c, v]); return b; },
            async select() {
              if (state.failNextMembershipUpdate) {
                state.failNextMembershipUpdate = false;
                return { data: null, error: { message: "membership update failed" } };
              }
              const rows = state.memberships.filter((m) => matches(m, filters));
              state.updates.push({ filters, payload });
              for (const row of rows) Object.assign(row, payload);
              return { data: rows.map((r) => ({ user_id: r.user_id })), error: null };
            },
            then(resolve: (v: { data: unknown; error: unknown }) => unknown) {
              if (state.failNextMembershipUpdate) {
                state.failNextMembershipUpdate = false;
                return Promise.resolve({ data: null, error: { message: "membership update failed" } }).then(resolve);
              }
              const rows = state.memberships.filter((m) => matches(m, filters));
              state.updates.push({ filters, payload });
              for (const row of rows) Object.assign(row, payload);
              return Promise.resolve({ data: null, error: null }).then(resolve);
            },
          };
          return b;
        },
      };
    }
    if (table === "membership_billing_events") {
      return {
        insert: async (row: Record<string, unknown>) => {
          state.billingEvents.push(row);
          return { error: null };
        },
        select: () => {
          const filters: Array<[string, string, unknown]> = [];
          const b: Record<string, unknown> = {
            eq(c: string, v: unknown) { filters.push(["eq", c, v]); return b; },
            gt(c: string, v: unknown) { filters.push(["gt", c, v]); return b; },
            in(c: string, v: unknown[]) { filters.push(["in", c, v]); return b; },
            order() { return b; },
            then(resolve: (v: { data: unknown; error: null }) => unknown) {
              const rows = state.paidEventRows.filter((r) =>
                filters.every(([op, col, val]) => {
                  const actual = r[col];
                  if (op === "eq") return actual === val;
                  if (op === "gt") return Number(actual) > Number(val);
                  if (op === "in") return (val as unknown[]).includes(actual);
                  return true;
                }),
              );
              return Promise.resolve({ data: rows, error: null }).then(resolve);
            },
            limit() { return b; },
          };
          return b;
        },
      };
    }
    return {
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      insert: async () => ({ error: null }),
      update: () => ({ eq: async () => ({ error: null }) }),
    };
  };

  function matches(row: MembershipRow, filters: Array<[string, string, unknown]>) {
    return filters.every(([op, col, val]) => {
      const actual = (row as unknown as Record<string, unknown>)[col];
      if (op === "eq") return actual === val;
      if (op === "is") return actual === val;
      if (op === "gt") return actual !== null && String(actual) > String(val);
      if (op === "lte") return actual !== null && String(actual) <= String(val);
      return true;
    });
  }

  return {
    supabaseAdmin: {
      from,
      auth: {
        admin: {
          getUserById: async (id: string) => ({
            data: { user: { id, email: `${id}@example.test`, user_metadata: { full_name: "A Member" } } },
            error: null,
          }),
        },
      },
    },
  };
});

const DAY = 24 * 60 * 60 * 1000;

function membership(overrides: Partial<MembershipRow> = {}): MembershipRow {
  return {
    user_id: "user-1",
    tier_id: "tier-1",
    status: "trialing",
    intro_status: "active",
    intro_ends_at: new Date(Date.now() - DAY).toISOString(),
    next_billing_at: new Date(Date.now() + 30 * DAY).toISOString(),
    next_billing_amount_cents: 2900,
    first_month_remainder_cents: 1900,
    first_month_reminder_sent_at: null,
    renewal_reminder_sent_at: null,
    cancel_at_period_end: false,
    billing_cycle: "monthly",
    veyra_membership_id: null,
    payment_method_ref: "pm_old",
    membership_tiers: { id: "tier-1", name: "Vanta Plus" },
    ...overrides,
  };
}

async function mod() {
  return import("@/lib/membership-billing");
}

beforeEach(() => {
  vi.clearAllMocks();
  chargeCard.mockImplementation(async () => ({ success: true, chargeId: "ch_1" }));
  cancelVeyra.mockImplementation(async () => ({ ok: true, message: "" }));
  updateVeyraCard.mockImplementation(async () => ({ ok: true, message: "" }));
  state.memberships = [];
  state.billingEvents = [];
  state.updates = [];
  state.paidEventRows = [];
  state.failNextMembershipUpdate = false;
  state.failNextMembershipRead = false;
});

// =========================================================================
// A3 — RENEWAL: the sweep
// =========================================================================

describe("the billing sweep and who it is allowed to charge", () => {
  it("charges a locally-billed membership whose intro period has ended", async () => {
    state.memberships = [membership()];
    const { runMembershipBillingSweep } = await mod();

    const result = await runMembershipBillingSweep();

    expect(result.remainderChargesAttempted).toBe(1);
    expect(chargeCard).toHaveBeenCalledTimes(1);
  });

  it("NEVER charges a Veyra-owned membership — Veyra is already billing it", async () => {
    // The double-billing invariant. Veyra charges the card and runs its own
    // dunning cron; a second biller means two charges a month, every month.
    state.memberships = [membership({ veyra_membership_id: "vey_123" })];
    const { runMembershipBillingSweep } = await mod();

    const result = await runMembershipBillingSweep();

    expect(chargeCard).not.toHaveBeenCalled();
    expect(result.remainderChargesAttempted).toBe(0);
  });

  it("never even EMAILS a Veyra-owned membership about billing it", async () => {
    state.memberships = [
      membership({
        veyra_membership_id: "vey_123",
        intro_ends_at: new Date(Date.now() + DAY).toISOString(),
      }),
    ];
    const { runMembershipBillingSweep } = await mod();

    const result = await runMembershipBillingSweep();

    expect(result.remainderRemindersSent).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("does not charge a membership already cancelled at period end", async () => {
    // Money taken after an explicit cancellation is the worst outcome here.
    state.memberships = [membership({ cancel_at_period_end: true })];
    const { runMembershipBillingSweep } = await mod();

    await runMembershipBillingSweep();

    expect(chargeCard).not.toHaveBeenCalled();
  });

  it("does not charge before the intro period has actually ended", async () => {
    state.memberships = [membership({ intro_ends_at: new Date(Date.now() + 5 * DAY).toISOString() })];
    const { runMembershipBillingSweep } = await mod();

    await runMembershipBillingSweep();

    expect(chargeCard).not.toHaveBeenCalled();
  });

  it("sends the charge with a STABLE idempotency key", async () => {
    state.memberships = [membership()];
    const { runMembershipBillingSweep } = await mod();

    await runMembershipBillingSweep();

    const call = chargeCard.mock.calls[0][0] as { idempotencyKey?: string };
    // Without this, a sweep that runs twice (overlapping crons, a retry after a
    // timeout) charges the customer twice for one period.
    expect(call.idempotencyKey).toBeTruthy();
    expect(call.idempotencyKey).toContain("user-1");
  });

  it("uses the SAME idempotency key when the sweep runs twice", async () => {
    state.memberships = [membership()];
    const { runMembershipBillingSweep } = await mod();

    await runMembershipBillingSweep();
    const firstKey = (chargeCard.mock.calls[0][0] as { idempotencyKey?: string }).idempotencyKey;

    // Reset the row to due again, as an overlapping sweep would find it.
    state.memberships = [membership()];
    await runMembershipBillingSweep();
    const secondKey = (chargeCard.mock.calls[1][0] as { idempotencyKey?: string }).idempotencyKey;

    expect(secondKey).toBe(firstKey);
  });

  it("claims the reminder atomically, so two overlapping sweeps email once", async () => {
    state.memberships = [
      membership({ intro_ends_at: new Date(Date.now() + DAY).toISOString() }),
    ];
    const { runMembershipBillingSweep } = await mod();

    const [a, b] = await Promise.all([runMembershipBillingSweep(), runMembershipBillingSweep()]);

    expect(a.remainderRemindersSent + b.remainderRemindersSent).toBe(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("does not re-send a reminder that was already sent", async () => {
    state.memberships = [
      membership({
        intro_ends_at: new Date(Date.now() + DAY).toISOString(),
        first_month_reminder_sent_at: new Date().toISOString(),
      }),
    ];
    const { runMembershipBillingSweep } = await mod();

    const result = await runMembershipBillingSweep();

    expect(result.remainderRemindersSent).toBe(0);
  });

  it("records a billing event for the charge it made", async () => {
    state.memberships = [membership()];
    const { runMembershipBillingSweep } = await mod();

    await runMembershipBillingSweep();

    expect(state.billingEvents.length).toBeGreaterThan(0);
    expect(state.billingEvents.some((e) => e.status === "succeeded")).toBe(true);
  });

  it("records a FAILED event and does not extend access when the charge declines", async () => {
    chargeCard.mockImplementation(async () => ({ success: false, error: "card_declined" }));
    state.memberships = [membership()];
    const { runMembershipBillingSweep } = await mod();

    await runMembershipBillingSweep();

    const failed = state.billingEvents.filter((e) => e.status === "failed");
    expect(failed.length).toBeGreaterThan(0);
    // A declined charge must never buy another period.
    expect(state.memberships[0].status).not.toBe("active");
  });
});

// =========================================================================
// A1 / A2 — ACCESS REQUIRES A REAL PAYMENT
// =========================================================================

describe("whether a customer has actually paid", () => {
  it("is true only for a succeeded, non-zero, real charge type", async () => {
    state.paidEventRows = [
      { id: "e1", user_id: "user-1", status: "succeeded", amount_cents: 2900, event_type: "renewal" },
    ];
    const { hasSuccessfulPayment } = await mod();
    expect(await hasSuccessfulPayment("user-1")).toBe(true);
  });

  it("is false for a cancellation, however successful the OPERATION was", async () => {
    // Lifecycle records are written with status succeeded and amount 0. An
    // account that only ever failed to pay and then cancelled has succeeded
    // rows, and must not read as having paid.
    state.paidEventRows = [
      { id: "e1", user_id: "user-1", status: "succeeded", amount_cents: 0, event_type: "cancellation" },
    ];
    const { hasSuccessfulPayment } = await mod();
    expect(await hasSuccessfulPayment("user-1")).toBe(false);
  });

  it("is false for a non-zero CANCELLATION, which only the event-type filter can reject", async () => {
    // The amount and status filters both pass here, so this row isolates the
    // event-type allow-list. Without it, a lifecycle record reads as a payment.
    state.paidEventRows = [
      { id: "e1", user_id: "user-1", status: "succeeded", amount_cents: 2900, event_type: "cancellation" },
    ];
    const { hasSuccessfulPayment } = await mod();
    expect(await hasSuccessfulPayment("user-1")).toBe(false);
  });

  it("is false for a failed charge", async () => {
    state.paidEventRows = [
      { id: "e1", user_id: "user-1", status: "failed", amount_cents: 2900, event_type: "renewal" },
    ];
    const { hasSuccessfulPayment } = await mod();
    expect(await hasSuccessfulPayment("user-1")).toBe(false);
  });

  it("is false for a zero-amount charge", async () => {
    state.paidEventRows = [
      { id: "e1", user_id: "user-1", status: "succeeded", amount_cents: 0, event_type: "renewal" },
    ];
    const { hasSuccessfulPayment } = await mod();
    expect(await hasSuccessfulPayment("user-1")).toBe(false);
  });

  it("does not see another customer's payment", async () => {
    state.paidEventRows = [
      { id: "e1", user_id: "user-2", status: "succeeded", amount_cents: 2900, event_type: "renewal" },
    ];
    const { hasSuccessfulPayment } = await mod();
    expect(await hasSuccessfulPayment("user-1")).toBe(false);
  });
});

// =========================================================================
// A5 — CANCELLATION
// =========================================================================

describe("cancelling a membership", () => {
  it("stops auto-renewal for a paid term but leaves access to the period end", async () => {
    state.memberships = [membership({ status: "active", intro_status: "completed" })];
    const { cancelMembership } = await mod();

    const result = await cancelMembership("user-1");

    expect(state.memberships[0].cancel_at_period_end).toBe(true);
    // The customer paid for this period; access runs out.
    expect(state.memberships[0].status).toBe("active");
    expect(result.accessUntil).toBeTruthy();
  });

  it("ends a TRIAL immediately, so the remainder charge never fires", async () => {
    // Cancelling during the $1 trial must stop the first-month remainder.
    // Otherwise money is taken after an explicit cancellation.
    state.memberships = [membership({ status: "trialing" })];
    const { cancelMembership, runMembershipBillingSweep } = await mod();

    await cancelMembership("user-1");
    expect(state.memberships[0].status).toBe("cancelled");

    await runMembershipBillingSweep();
    expect(chargeCard).not.toHaveBeenCalled();
  });

  it("tells VEYRA FIRST for a Veyra-owned membership", async () => {
    state.memberships = [membership({ status: "active", veyra_membership_id: "vey_123" })];
    const { cancelMembership } = await mod();

    await cancelMembership("user-1");

    expect(cancelVeyra).toHaveBeenCalledWith("vey_123", true);
  });

  it("ABORTS and changes nothing when Veyra refuses the cancellation", async () => {
    // A local-only cancel would show the customer "cancelled" while Veyra keeps
    // charging them every month, indefinitely.
    cancelVeyra.mockImplementation(async () => ({ ok: false, message: "provider down" }));
    state.memberships = [membership({ status: "active", veyra_membership_id: "vey_123" })];
    const { cancelMembership } = await mod();

    await expect(cancelMembership("user-1")).rejects.toThrow(/couldn't cancel/i);
    expect(state.memberships[0].cancel_at_period_end).toBe(false);
  });

  it("cancels a trialing Veyra membership immediately, not at period end", async () => {
    state.memberships = [membership({ status: "trialing", veyra_membership_id: "vey_123" })];
    const { cancelMembership } = await mod();

    await cancelMembership("user-1");

    expect(cancelVeyra).toHaveBeenCalledWith("vey_123", false);
  });

  it("is safe to call twice", async () => {
    state.memberships = [membership({ status: "active" })];
    const { cancelMembership } = await mod();

    await cancelMembership("user-1");
    await expect(cancelMembership("user-1")).resolves.toBeTruthy();
    expect(state.memberships[0].cancel_at_period_end).toBe(true);
  });

  it("refuses to cancel a membership that does not exist", async () => {
    state.memberships = [];
    const { cancelMembership } = await mod();
    await expect(cancelMembership("user-nobody")).rejects.toThrow(/no paid membership/i);
  });

  it("records a cancellation billing event", async () => {
    state.memberships = [membership({ status: "active" })];
    const { cancelMembership } = await mod();

    await cancelMembership("user-1");

    const event = state.billingEvents.find((e) => e.event_type === "cancellation");
    expect(event).toBeDefined();
    // Zero amount: a cancellation is a lifecycle record, never a payment.
    expect(event?.amount_cents).toBe(0);
  });
});

// =========================================================================
// A4 / A6 — PAYMENT METHOD
// =========================================================================

describe("updating the payment method", () => {
  it("tells VEYRA FIRST and then stores the new reference", async () => {
    state.memberships = [membership({ veyra_membership_id: "vey_123" })];
    const { updatePaymentMethod } = await mod();

    await updatePaymentMethod("user-1", "pm_new");

    expect(updateVeyraCard).toHaveBeenCalledWith("vey_123", "pm_new");
    expect(state.memberships[0].payment_method_ref).toBe("pm_new");
  });

  it("ABORTS and keeps the old card when Veyra refuses", async () => {
    // The button must not claim a card change that never happened -- a past-due
    // member would keep being billed against the dead card on every retry and
    // could never recover.
    updateVeyraCard.mockImplementation(async () => ({ ok: false, message: "declined" }));
    state.memberships = [membership({ veyra_membership_id: "vey_123" })];
    const { updatePaymentMethod } = await mod();

    await expect(updatePaymentMethod("user-1", "pm_new")).rejects.toThrow(/couldn't update your card/i);
    expect(state.memberships[0].payment_method_ref).toBe("pm_old");
  });

  it("does NOT restore paid access as a side effect of a card update", async () => {
    // A past_due or cancelled member is recovered by the next charge SUCCEEDING
    // on the new card, never by the card update itself.
    state.memberships = [membership({ status: "past_due", veyra_membership_id: "vey_123" })];
    const { updatePaymentMethod } = await mod();

    await updatePaymentMethod("user-1", "pm_new");

    expect(state.memberships[0].status).toBe("past_due");
  });

  it("refuses when there is no membership to update", async () => {
    state.memberships = [];
    const { updatePaymentMethod } = await mod();
    await expect(updatePaymentMethod("user-nobody", "pm_new")).rejects.toThrow(/don't have a membership/i);
  });

  it("updates a locally-billed membership without calling Veyra", async () => {
    state.memberships = [membership({ veyra_membership_id: null })];
    const { updatePaymentMethod } = await mod();

    await updatePaymentMethod("user-1", "pm_new");

    expect(updateVeyraCard).not.toHaveBeenCalled();
    expect(state.memberships[0].payment_method_ref).toBe("pm_new");
  });
});

// =========================================================================
// K-03 — the renewal double-charge
//
// Two defects that are each survivable alone and compose into charging a
// member's card twice for one month.
//
//   1. The idempotency key was `renewal-<user>-<tier>-<today in UTC>`. It
//      identifies WHEN THE SWEEP RAN, not WHICH RENEWAL it is paying for. Two
//      attempts at the same renewal minutes apart across UTC midnight carry
//      DIFFERENT keys, so the processor's idempotency — the last thing
//      standing between a retry and a second charge — does not fire.
//
//   2. The post-charge write that advances next_billing_at was issued with no
//      error check. If it fails, the card has been charged and the schedule
//      still says the member is due, so the next sweep picks the same row up
//      again.
//
// Together: charge succeeds → schedule write fails silently → next sweep
// re-attempts → if the clock has crossed UTC midnight, a different key → the
// member is charged twice and nothing in the system says so.
//
// The fix keys idempotency to the PERIOD BEING BILLED (the row's own
// next_billing_at), which is stable no matter when or how often the sweep
// retries it, and checks the schedule write so a charge that moved money
// without advancing the schedule raises a critical alert instead of passing
// in silence.
// =========================================================================

describe("K-03 — a renewal is charged once per period, not once per sweep", () => {
  const dueRow = (overrides: Partial<MembershipRow> = {}) =>
    membership({
      status: "active",
      intro_status: "completed",
      next_billing_at: new Date(Date.now() - DAY).toISOString(),
      ...overrides,
    });

  it("keys idempotency to the period being billed, not to today's date", async () => {
    state.memberships = [dueRow({ next_billing_at: "2026-03-01T00:00:00.000Z" })];
    const { runMembershipBillingSweep } = await mod();

    await runMembershipBillingSweep();

    const key = String((chargeCard.mock.calls[0]?.[0] ?? {}).idempotencyKey ?? "");
    // The period it is paying for must appear in the key...
    expect(key).toContain("2026-03-01");
    // ...and the day the sweep happens to run must NOT, or two attempts either
    // side of UTC midnight are two different keys for one renewal.
    expect(key).not.toContain(new Date().toISOString().slice(0, 10));
  });

  it("produces the SAME key when the same renewal is retried across UTC midnight", async () => {
    // The exact double-charge window: the schedule write failed, so the row is
    // still due, and the retry lands on the NEXT UTC day.
    //
    // The clock is moved deliberately. Without that this test passes for the
    // wrong reason -- two sweeps in the same test run land on the same real
    // date, so the old date-keyed implementation would satisfy it too, and it
    // would only ever fail for a suite that happened to run at midnight.
    const { runMembershipBillingSweep } = await mod();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-03-05T23:59:30.000Z"));
      state.memberships = [dueRow({ next_billing_at: "2026-03-01T00:00:00.000Z" })];
      await runMembershipBillingSweep();
      const first = String((chargeCard.mock.calls[0]?.[0] ?? {}).idempotencyKey ?? "");

      // 90 seconds later, and a different UTC date.
      vi.setSystemTime(new Date("2026-03-06T00:01:00.000Z"));
      state.memberships = [dueRow({ next_billing_at: "2026-03-01T00:00:00.000Z" })];
      chargeCard.mockClear();
      await runMembershipBillingSweep();
      const second = String((chargeCard.mock.calls[0]?.[0] ?? {}).idempotencyKey ?? "");

      expect(first).not.toBe("");
      expect(second).toBe(first);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives two DIFFERENT periods two different keys", async () => {
    // The guard against over-correcting into a key so stable that next month's
    // legitimate renewal is deduped away and the member is never charged again.
    state.memberships = [dueRow({ next_billing_at: "2026-03-01T00:00:00.000Z" })];
    const { runMembershipBillingSweep } = await mod();
    await runMembershipBillingSweep();
    const march = String((chargeCard.mock.calls[0]?.[0] ?? {}).idempotencyKey ?? "");

    state.memberships = [dueRow({ next_billing_at: "2026-04-01T00:00:00.000Z" })];
    chargeCard.mockClear();
    await runMembershipBillingSweep();
    const april = String((chargeCard.mock.calls[0]?.[0] ?? {}).idempotencyKey ?? "");

    expect(april).not.toBe(march);
  });

  it("still gives two different members due in the same period different keys", async () => {
    // Deliberately NOT "...and two different tiers". `customer_memberships`
    // has user_id as its PRIMARY KEY, so a user holds at most one membership,
    // and a tier change goes through startMembershipSignup's upsert which
    // rewrites next_billing_at. Two tiers for one user in one period is
    // therefore unreachable, and a test asserting it would be inventing a
    // requirement rather than pinning one. See the equivalent-mutant note for
    // K-03 in the integration log.
    state.memberships = [
      dueRow({ user_id: "user-a", next_billing_at: "2026-03-01T00:00:00.000Z" }),
      dueRow({ user_id: "user-b", next_billing_at: "2026-03-01T00:00:00.000Z" }),
    ];
    const { runMembershipBillingSweep } = await mod();

    await runMembershipBillingSweep();

    const keys = chargeCard.mock.calls.map((c) => String((c[0] as Record<string, unknown>).idempotencyKey ?? ""));
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });

  it("raises a critical alert when money moved but the schedule did not advance", async () => {
    // Charge succeeds, the write that would stop the row being re-billed fails.
    // Silence here is what turns one bad write into a second charge.
    const { recordSystemAlert } = await import("@/lib/monitoring");
    state.memberships = [dueRow({ next_billing_at: "2026-03-01T00:00:00.000Z" })];
    state.failNextMembershipUpdate = true;
    const { runMembershipBillingSweep } = await mod();

    await runMembershipBillingSweep();

    expect(recordSystemAlert).toHaveBeenCalled();
    const alert = (recordSystemAlert as unknown as { mock: { calls: Array<[Record<string, unknown>]> } }).mock.calls
      .map((c) => c[0])
      .find((a) => String(a.severity) === "critical");
    expect(alert, "a charge that did not advance the schedule must be critical").toBeDefined();
    expect(JSON.stringify(alert)).toContain("user-1");
  });

  it("does not alert on the ordinary path where the schedule advances", async () => {
    const { recordSystemAlert } = await import("@/lib/monitoring");
    state.memberships = [dueRow({ next_billing_at: "2026-03-01T00:00:00.000Z" })];
    const { runMembershipBillingSweep } = await mod();

    await runMembershipBillingSweep();

    expect(recordSystemAlert).not.toHaveBeenCalled();
  });
});

// =========================================================================
// REVOKING A REFUNDED MEMBERSHIP — FIX WAVE 3.
//
// The refund lane's brand-new unsafe_effect_failed_membership_revoke alert is
// raised only from the webhook's CATCH, and this function swallowed both of its
// database errors: the read's error was discarded (so a transient failure was
// indistinguishable from "this customer has no membership" and the function
// returned normally), and the revoking UPDATE's error was discarded too (so it
// reported success having changed nothing). The one failure the alert exists
// for was the one it could not see — and the outcome is a customer who charged
// back keeping member pricing, free shipping, their points multiplier and their
// Veyra subscription indefinitely.
// =========================================================================
describe("revokeMembershipForRefund", () => {
  it("ends the membership immediately", async () => {
    state.memberships = [membership({ status: "active" })];
    const { revokeMembershipForRefund } = await mod();

    await revokeMembershipForRefund("user-1");

    expect(state.memberships[0].status).toBe("cancelled");
    expect(state.memberships[0].cancel_at_period_end).toBe(false);
  });

  it("is a quiet no-op for a customer who has no membership", async () => {
    state.memberships = [];
    const { revokeMembershipForRefund } = await mod();

    await expect(revokeMembershipForRefund("user-nobody")).resolves.toBeUndefined();
  });

  it("THROWS rather than reporting success when it cannot read the membership", async () => {
    state.memberships = [membership({ status: "active" })];
    state.failNextMembershipRead = true;
    const { revokeMembershipForRefund } = await mod();

    await expect(revokeMembershipForRefund("user-1")).rejects.toMatchObject({ code: "57014" });

    // Still active — and now the caller knows, so the alert fires.
    expect(state.memberships[0].status).toBe("active");
  });

  it("THROWS rather than reporting success when the revoking update fails", async () => {
    state.memberships = [membership({ status: "active" })];
    const { revokeMembershipForRefund } = await mod();
    state.failNextMembershipUpdate = true;

    await expect(revokeMembershipForRefund("user-1")).rejects.toBeDefined();
    expect(state.memberships[0].status).toBe("active");
  });
});
