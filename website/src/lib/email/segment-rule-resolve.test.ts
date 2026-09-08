import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// resolveAudience, driven by a rule rather than one of the six fixed segments.
//
// The fixed segments stay exactly as they are — they are the common cases and
// they skip work a rule cannot skip. A rule is the escape hatch for everything
// else, and it must obey the same two invariants the fixed segments do:
// consent is the floor, and an unreadable instruction sends to nobody.
// ---------------------------------------------------------------------------

const NOW = Date.parse("2026-09-08T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

const store = vi.hoisted(() => ({
  preferences: [] as Array<{ user_id: string }>,
  subscribers: [] as Array<{ email: string }>,
  suppressions: [] as Array<{ email: string }>,
  orders: [] as Array<Record<string, unknown>>,
  orderItems: [] as Array<{ order_id: string; product_id: string }>,
  products: [] as Array<{ slug: string; category: string }>,
  authEmails: [] as Array<{ id: string; email: string }>,
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/supabase-server", () => {
  const table = (rows: () => Array<Record<string, unknown>>) => {
    const b: Record<string, unknown> = {
      select: () => b,
      eq: () => b,
      is: () => b,
      not: () => b,
      order: () => b,
      range: (from: number, to: number) => Promise.resolve({ data: rows().slice(from, to + 1), error: null }),
      then: (resolve: (r: unknown) => unknown) => Promise.resolve({ data: rows(), error: null }).then(resolve),
    };
    return b;
  };
  return {
    supabaseAdmin: {
      from: (name: string) => {
        if (name === "customer_preferences") return table(() => store.preferences);
        if (name === "marketing_subscribers") return table(() => store.subscribers);
        if (name === "email_suppressions") return table(() => store.suppressions);
        if (name === "orders") return table(() => store.orders);
        if (name === "order_items") return table(() => store.orderItems);
        if (name === "products") return table(() => store.products);
        throw new Error(`unexpected table ${name}`);
      },
      rpc: async () => ({ data: store.authEmails, error: null }),
      auth: { admin: { listUsers: async () => ({ data: { users: [] }, error: null }) } },
    },
  };
});

const { resolveAudience } = await import("@/lib/email/audience");

function paidOrder(email: string, at: number, amount: number, orderId: string) {
  return {
    order_id: orderId,
    customer_email: email,
    payment_status: "paid",
    order_type: "sale",
    created_at: iso(at),
    amount_paid: amount,
    refund_amount: 0,
  };
}

beforeEach(() => {
  store.preferences = [];
  store.subscribers = [];
  store.suppressions = [];
  store.orders = [];
  store.orderItems = [];
  store.products = [];
  store.authEmails = [];
});

describe("resolveAudience with a rule", () => {
  it("selects the consented contacts the rule matches", async () => {
    store.subscribers = [{ email: "whale@x.test" }, { email: "minnow@x.test" }];
    store.orders = [
      paidOrder("whale@x.test", NOW - 5 * DAY, 500, "o1"),
      paidOrder("minnow@x.test", NOW - 5 * DAY, 20, "o2"),
    ];

    const selected = await resolveAudience({
      segment: "rule",
      rule: { groups: [{ conditions: [{ junction: "and", filters: [{ field: "spendCents", operator: "moreThan", value: 10_000 }] }] }] },
      now: NOW,
    });

    expect(selected).toEqual(["whale@x.test"]);
  });

  it("combines a spend floor with a dormancy window", async () => {
    store.subscribers = [{ email: "lapsed@x.test" }, { email: "active@x.test" }];
    store.orders = [
      paidOrder("lapsed@x.test", NOW - 120 * DAY, 400, "o1"),
      paidOrder("active@x.test", NOW - 3 * DAY, 400, "o2"),
    ];

    const selected = await resolveAudience({
      segment: "rule",
      rule: { groups: [{ conditions: [
        { junction: "and", filters: [{ field: "spendCents", operator: "moreThan", value: 10_000 }] },
        { junction: "and", filters: [{ field: "lastPaidAt", operator: "notInTheLast", value: 60, unit: "days" }] },
      ] }] },
      now: NOW,
    });

    expect(selected).toEqual(["lapsed@x.test"]);
  });

  it("can filter on the category somebody bought", async () => {
    store.subscribers = [{ email: "peptide@x.test" }, { email: "glass@x.test" }];
    store.orders = [
      paidOrder("peptide@x.test", NOW - 5 * DAY, 100, "o1"),
      paidOrder("glass@x.test", NOW - 5 * DAY, 100, "o2"),
    ];
    store.products = [
      { slug: "bpc-157", category: "peptides" },
      { slug: "vial", category: "glassware" },
    ];
    store.orderItems = [
      { order_id: "o1", product_id: "bpc-157" },
      { order_id: "o2", product_id: "vial" },
    ];

    const selected = await resolveAudience({
      segment: "rule",
      rule: { groups: [{ conditions: [{ junction: "and", filters: [{ field: "category", operator: "anyOf", values: ["peptides"] }] }] }] },
      now: NOW,
    });

    expect(selected).toEqual(["peptide@x.test"]);
  });

  // A rule cannot reach past consent, and it cannot reach past suppression.
  it("never selects a suppressed address even when the rule matches it", async () => {
    store.subscribers = [{ email: "unsubscribed@x.test" }];
    store.suppressions = [{ email: "unsubscribed@x.test" }];
    store.orders = [paidOrder("unsubscribed@x.test", NOW - 5 * DAY, 900, "o1")];

    const selected = await resolveAudience({
      segment: "rule",
      rule: { groups: [{ conditions: [{ junction: "and", filters: [{ field: "email", operator: "contains", value: "@" }] }] }] },
      now: NOW,
    });

    expect(selected).toEqual([]);
  });

  it("selects nobody when the rule is missing or unusable", async () => {
    store.subscribers = [{ email: "someone@x.test" }];

    expect(await resolveAudience({ segment: "rule", now: NOW })).toEqual([]);
    expect(await resolveAudience({ segment: "rule", rule: { groups: "everyone" }, now: NOW })).toEqual([]);
  });
});
