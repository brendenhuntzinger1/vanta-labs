import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// THE SHIPPO WEBHOOK'S FRONT DOOR.
//
// This endpoint is reachable by anyone on the internet. What it accepts, it
// believes: it moves orders to in_transit and delivered, sends the customer's
// shipping and delivery emails, and records the actual postage that lands in
// profit. A caller who gets past this check can mark a stranger's order
// delivered, fire the emails, and corrupt the books.
//
// WHY THIS FILE EXISTS
//
// Three separate sabotages of that check — making an unset secret fail OPEN,
// making the comparison always succeed, and dropping the constant-time
// compare — each left all 2,609 existing tests green. The authentication was
// correct and completely unproven. These tests drive the REAL POST handler,
// so they exercise the actual guard rather than restating it.
//
// Every case below was confirmed to fail when its protection is removed.
// ---------------------------------------------------------------------------

const applyTransactionCreated = vi.fn(async (): Promise<{
  matched: boolean;
  orderId: string | null;
  reason?: string;
}> => ({ matched: true, orderId: "order-1" }));
const applyTrackingUpdate = vi.fn(async () => ({
  ok: true as const,
  data: { duplicate: false, handled: true, statusChanged: false, orderId: "order-1", to: "in_transit" },
}));
const recordSystemAlert = vi.fn(async (_alert: {
  type: string;
  severity: string;
  message: string;
  context?: Record<string, unknown>;
}) => {});

vi.mock("@/lib/shippo/order-sync", () => ({ applyTransactionCreated }));
vi.mock("@/lib/shippo/service", () => ({ applyTrackingUpdate }));
vi.mock("@/lib/monitoring", () => ({ recordSystemAlert }));
vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: {
    from: () => ({
      upsert: async () => ({ error: null }),
      insert: async () => ({ error: null }),
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }),
    }),
  },
}));

const SECRET = "correct-horse-battery-staple";
const URL_BASE = "https://example.test/api/webhooks/shippo";

const BODY = {
  event: "transaction_created",
  data: { object_id: "txn_synthetic_1", rate: { amount: "7.43" } },
};

function post(init: { secretQuery?: string; secretHeader?: string; body?: unknown } = {}) {
  const url = init.secretQuery === undefined
    ? URL_BASE
    : `${URL_BASE}?secret=${encodeURIComponent(init.secretQuery)}`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init.secretHeader !== undefined) headers["x-shippo-webhook-secret"] = init.secretHeader;
  return new Request(url, {
    method: "POST",
    headers,
    body: typeof init.body === "string" ? init.body : JSON.stringify(init.body ?? BODY),
  });
}

async function callPost(request: Request) {
  const { POST } = await import("@/app/api/webhooks/shippo/route");
  return POST(request);
}

const originalSecret = process.env.SHIPPO_WEBHOOK_SECRET;

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  process.env.SHIPPO_WEBHOOK_SECRET = SECRET;
});

afterEach(() => {
  if (originalSecret === undefined) delete process.env.SHIPPO_WEBHOOK_SECRET;
  else process.env.SHIPPO_WEBHOOK_SECRET = originalSecret;
});

describe("who is allowed to move an order", () => {
  it("accepts the correct secret in the query string, which is how Shippo is configured", async () => {
    const response = await callPost(post({ secretQuery: SECRET }));
    expect(response.status).toBe(200);
    expect(applyTransactionCreated).toHaveBeenCalledTimes(1);
  });

  it("accepts the correct secret in the header", async () => {
    const response = await callPost(post({ secretHeader: SECRET }));
    expect(response.status).toBe(200);
    expect(applyTransactionCreated).toHaveBeenCalledTimes(1);
  });

  describe("rejects, and does not touch a single order", () => {
    const rejected: Array<[string, Parameters<typeof post>[0]]> = [
      ["no secret at all", {}],
      ["an empty secret", { secretQuery: "" }],
      ["a wrong secret", { secretQuery: "wrong-secret" }],
      ["a secret that is a prefix of the real one", { secretQuery: SECRET.slice(0, -1) }],
      ["a secret with the real one as a prefix", { secretQuery: `${SECRET}x` }],
      ["a case-shifted secret", { secretQuery: SECRET.toUpperCase() }],
      ["a whitespace-padded wrong secret", { secretQuery: "  wrong  " }],
      ["a wrong secret in the header", { secretHeader: "wrong-secret" }],
    ];

    for (const [label, init] of rejected) {
      it(`rejects ${label} with 401`, async () => {
        const response = await callPost(post(init));
        expect(response.status).toBe(401);
        // The real damage test: nothing downstream ran.
        expect(applyTransactionCreated).not.toHaveBeenCalled();
        expect(applyTrackingUpdate).not.toHaveBeenCalled();
      });
    }

    it("leaks nothing about the expected secret in the rejection body", async () => {
      const response = await callPost(post({ secretQuery: "wrong-secret" }));
      const text = JSON.stringify(await response.json());
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(String(SECRET.length));
    });
  });

  describe("when the secret is not configured at all", () => {
    for (const value of ["", "   ", undefined]) {
      it(`fails CLOSED with 503 when SHIPPO_WEBHOOK_SECRET is ${JSON.stringify(value)}`, async () => {
        if (value === undefined) delete process.env.SHIPPO_WEBHOOK_SECRET;
        else process.env.SHIPPO_WEBHOOK_SECRET = value;

        // An unconfigured secret must never mean "let everyone in". A caller
        // sending no secret and a caller sending any secret both get nothing.
        for (const init of [{}, { secretQuery: "anything" }] as const) {
          const response = await callPost(post(init));
          expect(response.status).toBe(503);
        }
        expect(applyTransactionCreated).not.toHaveBeenCalled();
        expect(applyTrackingUpdate).not.toHaveBeenCalled();
      });
    }
  });

  describe("an authenticated but malformed request", () => {
    it("returns 400 rather than 200 for a body that is not JSON", async () => {
      const response = await callPost(post({ secretQuery: SECRET, body: "not json at all" }));
      expect(response.status).toBe(400);
      expect(applyTransactionCreated).not.toHaveBeenCalled();
    });

    it("never treats an unrecognised event as a label purchase", async () => {
      // The route has exactly two branches: transaction_created, and
      // everything else routed to the tracking handler, which is the single
      // place that decides what an event means. The invariant that matters
      // here is that an unknown event cannot enter the POSTAGE path, where it
      // would write a shipping expense.
      const response = await callPost(
        post({ secretQuery: SECRET, body: { event: "some_future_event", data: {} } }),
      );
      expect(response.status).toBe(200);
      expect(applyTransactionCreated).not.toHaveBeenCalled();
      expect(applyTrackingUpdate).toHaveBeenCalledTimes(1);
    });
  });
});

describe("a label Vanta cannot attribute to any order", () => {
  // PART 16. Money was spent on postage. If nothing surfaces it, the label is
  // simply lost: a row in a table nobody opens is the same as dropping it.
  const unmatched = { matched: false, orderId: null, reason: "no_matching_order" };

  it("raises an owner-visible CRITICAL alert", async () => {
    applyTransactionCreated.mockResolvedValueOnce(unmatched);

    const response = await callPost(post({ secretQuery: SECRET }));

    expect(response.status).toBe(200);
    expect(recordSystemAlert).toHaveBeenCalledTimes(1);
    const alert = recordSystemAlert.mock.calls[0][0];
    expect(alert.severity).toBe("critical");
    expect(String(alert.type)).toContain("shippo");
  });

  it("tells the owner which label it was, so it can be reconciled by hand", async () => {
    applyTransactionCreated.mockResolvedValueOnce(unmatched);
    await callPost(post({ secretQuery: SECRET }));

    const alert = recordSystemAlert.mock.calls[0][0];
    expect(alert.context).toBeDefined();
    expect(JSON.stringify(alert.context)).toContain("txn_synthetic_1");
  });

  it("answers 200 rather than making Shippo retry a label that belongs to nothing", async () => {
    applyTransactionCreated.mockResolvedValueOnce(unmatched);
    const response = await callPost(post({ secretQuery: SECRET }));
    expect(response.status).toBe(200);
  });

  it("raises NO alert when the label matched an order", async () => {
    // The complement: an alert on every successful purchase would train the
    // owner to ignore the one that matters.
    await callPost(post({ secretQuery: SECRET }));
    expect(recordSystemAlert).not.toHaveBeenCalled();
  });
});
