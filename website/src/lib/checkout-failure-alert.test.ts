import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Repeated checkout failure by ONE shopper.
//
// On 2026-08-26 one shopper created three orders in sixteen minutes and paid
// for none of them. Nothing anywhere noticed: no server error (nothing errored),
// no processor event (none arrived), and no alert (none existed). The shopper
// was found days later, by hand, while looking at something else.
//
// WHAT THIS COUNTS, AND WHY IT IS NOT "FAILED PAYMENTS".
//
// Counting payment_failed rows would NOT have caught that incident — those
// three attempts produced no payment event of any kind. The signal that
// actually existed was orders created and left unpaid. So that is what this
// counts: repeated unpaid orders from one shopper in a short window, which
// covers a declined card and a silent abandonment equally.
//
// PRIVACY. The alert carries a salted-free hash prefix of the email and the
// order numbers, never the email, name, address or anything about the card.
// The hash exists only so consecutive alerts about the same shopper can be
// deduplicated and correlated; it is not reversible from the alert.
// ---------------------------------------------------------------------------

interface AlertInput {
  type: string;
  severity: string;
  message: string;
  context: Record<string, unknown>;
}
const recordSystemAlert = vi.fn(async (_input: AlertInput) => {});

/** Rows the "recent unpaid orders for this shopper" query will return. */
let recentUnpaid: Array<{ order_number: string | null; created_at: string }> = [];
/** created_at of the most recent alert of this type, or null for none. */
let lastAlertAt: string | null = null;
/** Every filter call, accumulated — .eq() is called more than once, so a
 *  last-write-wins capture silently loses the first one. */
let ordersQueryFilters: Record<string, unknown[][]> = {};
let throwOnOrdersRead = false;

function ordersQuery() {
  const q: Record<string, unknown> = {};
  const chain = (key: string) => (...args: unknown[]) => {
    (ordersQueryFilters[key] ??= []).push(args);
    return q;
  };
  q.select = chain("select");
  q.eq = chain("eq");
  q.not = chain("not");
  q.gte = chain("gte");
  q.in = chain("in");
  q.order = chain("order");
  q.limit = () => {
    if (throwOnOrdersRead) return Promise.reject(new Error("db down"));
    return Promise.resolve({ data: recentUnpaid, error: null });
  };
  return q;
}

vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "system_alerts") {
        const q: Record<string, unknown> = {};
        q.select = () => q;
        q.eq = () => q;
        q.order = () => q;
        q.limit = () => Promise.resolve({
          data: lastAlertAt ? [{ created_at: lastAlertAt }] : [],
          error: null,
        });
        return q;
      }
      if (table === "orders") return ordersQuery();
      throw new Error(`unexpected table ${table}`);
    },
  },
}));

vi.mock("@/lib/monitoring", () => ({
  recordSystemAlert: (input: AlertInput) => recordSystemAlert(input),
}));

const { reportRepeatedCheckoutFailure, shopperKey } = await import("@/lib/checkout-failure-alert");

const attempt = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    order_number: `VL-TEST${i}`,
    created_at: new Date(Date.now() - i * 60_000).toISOString(),
  }));

beforeEach(() => {
  vi.clearAllMocks();
  recentUnpaid = [];
  lastAlertAt = null;
  ordersQueryFilters = {};
  throwOnOrdersRead = false;
});

describe("it alerts only on a genuinely repeated failure", () => {
  it("stays silent on a first unpaid order", async () => {
    recentUnpaid = attempt(1);
    await reportRepeatedCheckoutFailure("shopper@example.test");
    expect(recordSystemAlert).not.toHaveBeenCalled();
  });

  it("stays silent on a second", async () => {
    // Two is a retry. Everyone does it and nothing is wrong.
    recentUnpaid = attempt(2);
    await reportRepeatedCheckoutFailure("shopper@example.test");
    expect(recordSystemAlert).not.toHaveBeenCalled();
  });

  it("alerts on the third within the window", async () => {
    // Three is the incident.
    recentUnpaid = attempt(3);
    await reportRepeatedCheckoutFailure("shopper@example.test");
    expect(recordSystemAlert).toHaveBeenCalledTimes(1);
    expect(recordSystemAlert).toHaveBeenCalledWith(
      expect.objectContaining({ type: "checkout_repeated_failure", severity: "warning" }),
    );
  });

  it("counts only UNPAID orders, and only recent ones", async () => {
    recentUnpaid = attempt(3);
    await reportRepeatedCheckoutFailure("shopper@example.test");
    // pending_payment only — a paid or refunded order is not a failed attempt.
    expect(ordersQueryFilters.eq).toContainEqual(["payment_status", "pending_payment"]);
    // ...and scoped to this one shopper, not the whole store.
    expect(ordersQueryFilters.eq).toContainEqual(["customer_email", "shopper@example.test"]);
    // Bounded by a time window, not "ever".
    expect(ordersQueryFilters.gte?.[0]?.[0]).toBe("created_at");
  });
});

describe("the alert carries nothing sensitive", () => {
  it("names no email, no address and nothing about the card", async () => {
    recentUnpaid = attempt(3);
    await reportRepeatedCheckoutFailure("Lily.Caroline+tag@icloud.example");

    const payload = recordSystemAlert.mock.calls[0][0];
    const blob = JSON.stringify(payload).toLowerCase();

    expect(blob).not.toContain("lily.caroline");
    expect(blob).not.toContain("icloud.example");
    expect(blob).not.toContain("@");
    // Card DATA, not the word "card" — the message says "a card being
    // repeatedly declined", which is the useful part of it. What must never
    // appear is a value: a PAN-length digit run, an expiry, or a CVC.
    expect(blob).not.toMatch(/\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}/);
    expect(blob).not.toMatch(/\b(cvv|cvc|pan|expiry|exp_month|exp_year)\b/);
    // Nor any shipping identity.
    for (const forbidden of ["address", "postal", "fullname", "customer_name"]) {
      expect(blob).not.toContain(forbidden);
    }
  });

  it("carries a stable non-reversible shopper key so alerts can be correlated", async () => {
    recentUnpaid = attempt(3);
    await reportRepeatedCheckoutFailure("shopper@example.test");
    const { context } = recordSystemAlert.mock.calls[0][0];

    const key = String(context.shopper);
    expect(key).toMatch(/^[0-9a-f]{12}$/);
    // Same input, same key; different input, different key.
    expect(shopperKey("shopper@example.test")).toBe(key);
    expect(shopperKey("someone-else@example.test")).not.toBe(key);
  });

  it("treats the email case- and whitespace-insensitively", async () => {
    // Otherwise "A@x" and "a@x " look like two different shoppers and neither
    // ever reaches the threshold.
    expect(shopperKey("  Shopper@Example.test ")).toBe(shopperKey("shopper@example.test"));
  });
});

describe("the alert does not spam", () => {
  it("stays quiet when the same shopper alerted recently", async () => {
    recentUnpaid = attempt(4);
    lastAlertAt = new Date(Date.now() - 10 * 60_000).toISOString(); // 10 min ago
    await reportRepeatedCheckoutFailure("shopper@example.test");
    expect(recordSystemAlert).not.toHaveBeenCalled();
  });

  it("alerts again once the throttle window has passed", async () => {
    recentUnpaid = attempt(4);
    lastAlertAt = new Date(Date.now() - 7 * 60 * 60_000).toISOString(); // 7h ago
    await reportRepeatedCheckoutFailure("shopper@example.test");
    expect(recordSystemAlert).toHaveBeenCalledTimes(1);
  });
});

describe("it can never break a checkout", () => {
  it("never throws when the database read fails", async () => {
    throwOnOrdersRead = true;
    await expect(reportRepeatedCheckoutFailure("shopper@example.test")).resolves.toBeUndefined();
    expect(recordSystemAlert).not.toHaveBeenCalled();
  });

  it("never throws on a missing or malformed email", async () => {
    for (const value of ["", "   ", null, undefined]) {
      await expect(
        reportRepeatedCheckoutFailure(value as unknown as string),
      ).resolves.toBeUndefined();
    }
    expect(recordSystemAlert).not.toHaveBeenCalled();
  });
});
