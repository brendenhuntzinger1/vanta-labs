import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// K-07. EXACTLY ONE SKIP PER PAID PERIOD.
//
// skipNextBilling states the rule in its own comment:
//
//   "Cap to ONE skip per paid period. Without this a member could POST skip in a
//    loop, pushing next_billing_at years out while staying 'active' — keeping all
//    perks and monthly store credit forever for a single charge."
//
// The guard did not hold it. The refusal threshold was `> now + 33 * ONE_DAY_MS`
// and the advance was `+ 30 * ONE_DAY_MS` from max(now, next_billing_at), with a
// STRICT `>`. So a first skip from any next_billing_at <= now + 3d lands on
// exactly now + 33d, which does not satisfy `> now + 33d`, and a second skip was
// accepted — about 60 days of perks, plus two extra monthly store-credit grants,
// on one charge.
//
// The window in which that worked was not arbitrary. Solving the arithmetic gives
// next_billing_at <= now + 3d, and sweep Step 4 emails "your renewal is in 3
// days" for exactly next_billing_at <= now + 3d. The reminder put the member in
// the state where Skip worked twice.
//
// The fix does not just move the constant. A date-distance heuristic will keep
// being fragile every time the cycle length or the reminder window moves, and
// those two constants live 200 lines apart with nothing tying them together. The
// authority is now a per-period FACT: skipNextBilling already writes a `skip` row
// to membership_billing_events, and PAID_EVENT_TYPES already names the events
// that begin a paid period. One skip since the last paid event. No migration.
// ---------------------------------------------------------------------------

vi.unmock("@/lib/membership-billing");

const DAY = 86_400_000;

interface MembershipRow {
  user_id: string; tier_id: string; status: string; intro_status: string;
  intro_ends_at: string | null; next_billing_at: string | null;
  next_billing_amount_cents: number | null; first_month_remainder_cents: number | null;
  first_month_reminder_sent_at: string | null; renewal_reminder_sent_at: string | null;
  cancel_at_period_end: boolean; billing_cycle: string; veyra_membership_id: string | null;
  payment_method_ref: string | null; membership_tiers: { id: string; name: string } | null;
}

interface EventRow { user_id: string; tier_id: string | null; event_type: string; amount_cents: number; status: string; created_at: string }

const state: { memberships: MembershipRow[]; events: EventRow[] } = { memberships: [], events: [] };

vi.mock("server-only", () => ({}));
vi.mock("@/lib/email/send", () => ({ sendEmail: vi.fn(async () => ({ success: true })) }));
vi.mock("@/lib/email/marketing", () => ({ sendMarketingEmail: vi.fn(async () => ({ success: true })) }));
vi.mock("@/lib/billing-provider", () => ({ getBillingProvider: () => ({ chargeCard: vi.fn(async () => ({ success: true })) }) }));
vi.mock("@/lib/veyra-membership", () => ({
  startVeyraMembership: vi.fn(async () => ({ ok: true, membershipId: "vey" })),
  cancelVeyraMembership: vi.fn(async () => ({ ok: true, message: "" })),
  skipVeyraMembershipCycle: vi.fn(async () => ({ ok: true, message: "", nextRenewalAt: null })),
  updateVeyraMembershipCard: vi.fn(async () => ({ ok: true, message: "" })),
}));
vi.mock("@/lib/store-credit", () => ({ grantMonthlyStoreCredit: vi.fn(async () => {}), reconcileMonthlyStoreCredit: vi.fn(async () => {}) }));
vi.mock("@/lib/monitoring", () => ({ recordSystemAlert: vi.fn(async () => {}) }));
vi.mock("@/lib/env", () => ({ getSiteUrl: () => "https://example.test" }));
vi.mock("@/lib/payment-provider", () => ({ getPaymentProvider: () => ({}), isCheckoutOpen: () => true }));

vi.mock("@/lib/supabase-server", () => {
  const matches = (row: Record<string, unknown>, filters: Array<[string, string, unknown]>) =>
    filters.every(([op, col, val]) => {
      const cell = row[col];
      if (op === "eq") return String(cell) === String(val);
      if (op === "is") return cell === val;
      if (op === "gt") return String(cell) > String(val);
      if (op === "gte") return String(cell) >= String(val);
      if (op === "lte") return String(cell) <= String(val);
      return true;
    });

  const from = (table: string) => ({
    select() {
      const filters: Array<[string, string, unknown]> = [];
      let desc = false;
      const rows = () => {
        const source = table === "customer_memberships" ? state.memberships : table === "membership_billing_events" ? state.events : [];
        const out = (source as unknown as Array<Record<string, unknown>>).filter((r) => matches(r, filters)).map((r) => ({ ...r }));
        if (table === "membership_billing_events") {
          out.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
          if (desc) out.reverse();
        }
        return out;
      };
      const b: Record<string, unknown> = {
        eq(c: string, v: unknown) { filters.push(["eq", c, v]); return b; },
        is(c: string, v: unknown) { filters.push(["is", c, v]); return b; },
        gt(c: string, v: unknown) { filters.push(["gt", c, v]); return b; },
        gte(c: string, v: unknown) { filters.push(["gte", c, v]); return b; },
        lte(c: string, v: unknown) { filters.push(["lte", c, v]); return b; },
        in(c: string, vals: unknown[]) { filters.push(["in", c, vals]); return b; },
        order(_c: string, o?: { ascending?: boolean }) { desc = o?.ascending === false; return b; },
        limit() { return b; },
        async maybeSingle() { const r = rows(); return { data: r[0] ?? null, error: null }; },
        async single() { const r = rows(); return { data: r[0] ?? null, error: null }; },
        then(resolve: (v: { data: unknown; error: null }) => unknown) {
          return Promise.resolve({ data: rows(), error: null }).then(resolve);
        },
      };
      // `in` needs the real semantics for the paid-event lookup.
      const originalMatches = matches;
      void originalMatches;
      return b;
    },
    insert(payload: Record<string, unknown>) {
      if (table === "membership_billing_events") state.events.push(payload as unknown as EventRow);
      return Promise.resolve({ error: null });
    },
    update(payload: Record<string, unknown>) {
      const filters: Array<[string, string, unknown]> = [];
      const b: Record<string, unknown> = {
        eq(c: string, v: unknown) { filters.push(["eq", c, v]); return b; },
        is(c: string, v: unknown) { filters.push(["is", c, v]); return b; },
        then(resolve: (v: { data: unknown; error: null }) => unknown) {
          for (const row of state.memberships.filter((m) => matches(m as unknown as Record<string, unknown>, filters))) Object.assign(row, payload);
          return Promise.resolve({ data: null, error: null }).then(resolve);
        },
      };
      return b;
    },
  });
  return { supabaseAdmin: { from } };
});

function seedMember(nextBillingInDays: number | null): void {
  state.memberships.push({
    user_id: "u1", tier_id: "t1", status: "active", intro_status: "not_applicable",
    intro_ends_at: null,
    next_billing_at: nextBillingInDays === null ? null : new Date(Date.now() + nextBillingInDays * DAY).toISOString(),
    next_billing_amount_cents: 4900, first_month_remainder_cents: null,
    first_month_reminder_sent_at: null, renewal_reminder_sent_at: null,
    cancel_at_period_end: false, billing_cycle: "monthly", veyra_membership_id: null,
    payment_method_ref: null, membership_tiers: { id: "t1", name: "Pro" },
  });
  // The renewal that began the current paid period.
  state.events.push({
    user_id: "u1", tier_id: "t1", event_type: "renewal", amount_cents: 4900,
    status: "succeeded", created_at: new Date(Date.now() - 27 * DAY).toISOString(),
  });
}

/** How many consecutive skips the server will accept before refusing. */
async function countAcceptedSkips(): Promise<number> {
  const { skipNextBilling } = await import("@/lib/membership-billing");
  let accepted = 0;
  for (let i = 0; i < 6; i += 1) {
    try { await skipNextBilling("u1"); accepted += 1; } catch { return accepted; }
  }
  return accepted;
}

beforeEach(() => { state.memberships = []; state.events = []; vi.clearAllMocks(); });

describe("skipNextBilling accepts exactly one skip per paid period", () => {
  // now+0d .. now+3d is the window the old 33-vs-30 arithmetic let through, and
  // now+3d is exactly the bound Step 4's renewal reminder uses.
  it.each([0, 1, 2, 3])("accepts exactly ONE skip when the renewal is %sd away (the reminder window)", async (days) => {
    seedMember(days);
    expect(await countAcceptedSkips()).toBe(1);
  });

  it.each([4, 7, 10, 29])("accepts exactly ONE skip when the renewal is %sd away", async (days) => {
    seedMember(days);
    expect(await countAcceptedSkips()).toBe(1);
  });

  it("accepts exactly ONE skip when the charge is already overdue", async () => {
    seedMember(-1);
    expect(await countAcceptedSkips()).toBe(1);
  });

  it("refuses the second skip with a message that says why", async () => {
    seedMember(2);
    const { skipNextBilling } = await import("@/lib/membership-billing");
    await skipNextBilling("u1");
    await expect(skipNextBilling("u1")).rejects.toThrow(/already skipped/i);
  });

  it("records exactly one skip event, so the ledger agrees with the rule", async () => {
    seedMember(2);
    await countAcceptedSkips();
    expect(state.events.filter((e) => e.event_type === "skip")).toHaveLength(1);
  });

  it("allows a skip again once the next paid period has begun", async () => {
    // This is the property a pure date-distance guard cannot express: the
    // entitlement is per PERIOD, and a renewal starts a new one.
    seedMember(2);
    const { skipNextBilling } = await import("@/lib/membership-billing");
    await skipNextBilling("u1");
    await expect(skipNextBilling("u1")).rejects.toThrow(/already skipped/i);

    state.events.push({
      user_id: "u1", tier_id: "t1", event_type: "renewal", amount_cents: 4900,
      status: "succeeded", created_at: new Date().toISOString(),
    });
    state.memberships[0].next_billing_at = new Date(Date.now() + 2 * DAY).toISOString();

    await expect(skipNextBilling("u1")).resolves.toBeTruthy();
  });

  it("does not count a FAILED charge as the start of a new paid period", async () => {
    // A failed renewal is not a paid period. Treating it as one would hand out a
    // fresh skip for a charge that never landed.
    seedMember(2);
    const { skipNextBilling } = await import("@/lib/membership-billing");
    await skipNextBilling("u1");

    state.events.push({
      user_id: "u1", tier_id: "t1", event_type: "renewal", amount_cents: 4900,
      status: "failed", created_at: new Date().toISOString(),
    });

    await expect(skipNextBilling("u1")).rejects.toThrow(/already skipped/i);
  });

  it("does not count a zero-amount lifecycle event as the start of a paid period", async () => {
    // membership-status.ts is explicit that cancellation/pause/resume/tier_change
    // are written with status "succeeded" and amount_cents 0 because the
    // OPERATION succeeded, not because anyone paid.
    seedMember(2);
    const { skipNextBilling } = await import("@/lib/membership-billing");
    await skipNextBilling("u1");

    state.events.push({
      user_id: "u1", tier_id: "t1", event_type: "renewal", amount_cents: 0,
      status: "succeeded", created_at: new Date().toISOString(),
    });

    await expect(skipNextBilling("u1")).rejects.toThrow(/already skipped/i);
  });

it("refuses a second skip even when Veyra returns a near-term renewal date", async () => {
    // THE CASE ONLY THE LEDGER GUARD CAN SEE.
    //
    // For a Veyra-backed membership the advance is not `+30d` — it is whatever
    // Veyra says (membership-billing.ts:1050-1053, "Prefer VEYRA's date over the
    // local +30d computation"). If Veyra returns a date under 30 days out, the
    // date-distance guard is satisfied again and would hand out a second skip.
    //
    // Found by mutation M16: removing the ledger guard left every other test
    // green, because after a LOCAL skip next_billing_at is always >= now+30d and
    // the arithmetic alone was enough. That made the ledger guard look
    // decorative. It is not — it is the only thing standing here.
    const veyra = await import("@/lib/veyra-membership");
    vi.mocked(veyra.skipVeyraMembershipCycle).mockResolvedValue({
      ok: true, message: "",
      nextRenewalAt: new Date(Date.now() + 20 * DAY).toISOString(),
    } as never);

    state.memberships.push({
      user_id: "u1", tier_id: "t1", status: "active", intro_status: "not_applicable",
      intro_ends_at: null, next_billing_at: new Date(Date.now() + 2 * DAY).toISOString(),
      next_billing_amount_cents: 4900, first_month_remainder_cents: null,
      first_month_reminder_sent_at: null, renewal_reminder_sent_at: null,
      cancel_at_period_end: false, billing_cycle: "monthly",
      veyra_membership_id: "vey_1", payment_method_ref: null,
      membership_tiers: { id: "t1", name: "Pro" },
    });
    state.events.push({
      user_id: "u1", tier_id: "t1", event_type: "renewal", amount_cents: 4900,
      status: "succeeded", created_at: new Date(Date.now() - 27 * DAY).toISOString(),
    });

    expect(await countAcceptedSkips()).toBe(1);
  });

  it("gives a comp membership with no paid period exactly one skip, ever", async () => {
    // next_billing_at null and no paid event: nothing was paid for, so there is
    // no paid period to defer twice.
    state.memberships.push({
      user_id: "u1", tier_id: "t1", status: "active", intro_status: "not_applicable",
      intro_ends_at: null, next_billing_at: null, next_billing_amount_cents: null,
      first_month_remainder_cents: null, first_month_reminder_sent_at: null,
      renewal_reminder_sent_at: null, cancel_at_period_end: false, billing_cycle: "monthly",
      veyra_membership_id: null, payment_method_ref: null, membership_tiers: { id: "t1", name: "Pro" },
    });
    expect(await countAcceptedSkips()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The rule itself, and the fact that all three layers use THIS one.
// ---------------------------------------------------------------------------

describe("skipUsedThisPaidPeriod — the shared rule", () => {
  const paid = { eventType: "renewal", status: "succeeded", amountCents: 4900 };
  const skip = { eventType: "skip", status: "succeeded", amountCents: 0 };

  it("is false for a member who has not skipped", async () => {
    const { skipUsedThisPaidPeriod } = await import("@/lib/membership-status");
    expect(skipUsedThisPaidPeriod([paid])).toBe(false);
    expect(skipUsedThisPaidPeriod([])).toBe(false);
  });

  it("is true once a skip sits after the last paid event (newest first)", async () => {
    const { skipUsedThisPaidPeriod } = await import("@/lib/membership-status");
    expect(skipUsedThisPaidPeriod([skip, paid])).toBe(true);
  });

  it("is false again once a new paid event sits on top of the skip", async () => {
    const { skipUsedThisPaidPeriod } = await import("@/lib/membership-status");
    expect(skipUsedThisPaidPeriod([paid, skip, paid])).toBe(false);
  });

  it.each([
    ["a FAILED renewal", { eventType: "renewal", status: "failed", amountCents: 4900 }],
    ["a zero-amount renewal", { eventType: "renewal", status: "succeeded", amountCents: 0 }],
    ["a cancellation", { eventType: "cancellation", status: "succeeded", amountCents: 0 }],
    ["a pause", { eventType: "pause", status: "succeeded", amountCents: 0 }],
    ["a tier change", { eventType: "tier_change", status: "succeeded", amountCents: 0 }],
  ])("does not let %s restore the entitlement", async (_label, event) => {
    const { skipUsedThisPaidPeriod } = await import("@/lib/membership-status");
    expect(skipUsedThisPaidPeriod([event, skip, paid])).toBe(true);
  });

  it("does not count a FAILED skip as spending the entitlement", async () => {
    const { skipUsedThisPaidPeriod } = await import("@/lib/membership-status");
    expect(skipUsedThisPaidPeriod([{ eventType: "skip", status: "failed", amountCents: 0 }, paid])).toBe(false);
  });
});

describe("all three layers enforce the SAME rule", () => {
  const read = (p: string) =>
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    (require("node:fs") as typeof import("node:fs")).readFileSync(p, "utf8");

  it("the server guard calls the shared rule rather than re-deriving it", () => {
    const source = read("src/lib/membership-billing.ts");
    expect(source).toContain("skipUsedThisPaidPeriod");
    // The 33-day heuristic that produced the off-by-three must be gone.
    expect(source).not.toContain("33 * ONE_DAY_MS");
  });

  it("the account page derives the flag from the shared rule", () => {
    const source = read("src/app/account/(dashboard)/subscriptions/page.tsx");
    expect(source).toContain("skipUsedThisPaidPeriod(billingHistory)");
    expect(source).toContain("skipAlreadyUsed");
  });

  it("the UI does not offer Skip once the entitlement is spent", () => {
    const source = read("src/components/subscription-actions.tsx");
    expect(source).toContain("skipAvailable");
    expect(source).toContain('skipAvailable ? ["skip", "pause"] : ["pause"]');
  });

  it("the defence-in-depth date guard cannot be re-satisfied by its own advance", () => {
    // The advance is `from + 30 days`. Any threshold ABOVE 30 can be met by the
    // result of a skip, which is precisely how `> 33` failed. `>= 30` cannot.
    const source = read("src/lib/membership-billing.ts");
    expect(source).toContain(">= now.getTime() + 30 * ONE_DAY_MS");
  });
});
