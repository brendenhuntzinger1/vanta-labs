import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";


// ---------------------------------------------------------------------------
// Phase 11, bucket 3. Every assertion below fails against the code as it stood
// before this batch; each one pins a specific piece of customer-facing copy or
// webhook behaviour to the single source of truth it drifted away from.
//
// The source-level assertions (the JSX and page wiring) follow the precedent in
// handoff-invariants.test.ts: the behaviour lives inside a server component's
// data-loading or inside JSX that a node-environment suite cannot render, and a
// re-hard-coded literal is exactly the regression worth catching.
// ---------------------------------------------------------------------------

const SRC = path.resolve(__dirname, "..");
const read = (relative: string) => readFileSync(path.join(SRC, relative), "utf8");

// Three blocks lived here — CFG-10/SOT-11 (the membership FAQ reading its
// numbers off the tiers), SOT-11 (the benefit-start answer) and SOT-10 (the
// bulk-savings panel). All three drove buildFaqItems and the JSX of
// components/membership-landing.tsx, removed with the paid membership feature
// on 2026-09-12.

describe("CFG-11 — the redemption rate is quoted from POINTS_PER_DOLLAR_REDEMPTION", () => {
  const PROSE_FILES = [
    "app/account/(dashboard)/rewards/page.tsx",
    "app/account/(dashboard)/page.tsx",
    "app/account/(dashboard)/support/page.tsx",
  ];

  it.each(PROSE_FILES)("%s interpolates the constant instead of restating 100", (relative) => {
    const source = read(relative);

    expect(source).toContain("POINTS_PER_DOLLAR_REDEMPTION");
    expect(source).not.toMatch(/100 points = \$1/);
    expect(source).not.toMatch(/100 points equals \$1/);
    expect(source).not.toMatch(/>100 = \$1</);
  });
});

describe("F-A-11 — a points read that failed is not a balance of zero", () => {
  const PAGES = ["app/account/(dashboard)/rewards/page.tsx", "app/account/(dashboard)/page.tsx"];

  it.each(PAGES)("%s renders an unknown rather than a confident 0", (relative) => {
    const source = read(relative);

    expect(source).toContain("getPointsBalance(user.id).catch(() => null)");
    expect(source).not.toContain("getPointsBalance(user.id).catch(() => 0)");
    expect(source).toContain("pointsBalance === null");
  });
});

// ---------------------------------------------------------------------------
// P9-03 — the event id must come from bytes the signature covers.
// ---------------------------------------------------------------------------

const webhookMocks = vi.hoisted(() => ({ processPaymentWebhook: vi.fn() }));

class WebhookSignatureError extends Error {}

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ getRequiredEnv: () => "test-secret" }));
vi.mock("@/lib/payment-webhook", () => ({
  processPaymentWebhook: webhookMocks.processPaymentWebhook,
  WebhookSignatureError,
}));
vi.mock("@/lib/monitoring", () => ({ recordSystemAlert: vi.fn(async () => {}) }));

async function postWebhook(body: unknown, headers: Record<string, string>) {
  const { POST } = await import("@/app/api/webhooks/payment/route");
  return POST(new Request("https://vantalabsresearch.test/api/webhooks/payment", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  }));
}

const claimedEventId = () => String((webhookMocks.processPaymentWebhook.mock.calls[0] as unknown[])[3]);

describe("P9-03 — the payment webhook dedupes on the signed id", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    webhookMocks.processPaymentWebhook.mockResolvedValue({ eventId: "evt_real", duplicate: false });
  });

  it("prefers the body's id over a conflicting x-event-id header", async () => {
    // Neither signature scheme covers request headers, so a replayed delivery
    // could carry a fresh x-event-id and walk past the payment_events dedupe.
    await postWebhook(
      { id: "evt_real", type: "payment.succeeded" },
      { "x-payment-signature": "sig", "x-event-id": "attacker-chosen" },
    );

    expect(claimedEventId()).toBe("evt_real");
  });

  it("still falls back to the header when the body carries no id", async () => {
    // The internal/mock gateway sends { type, data } with no top-level id; every
    // e2e journey in this repo relies on that path.
    await postWebhook(
      { type: "payment.succeeded", data: { object: { metadata: { order_id: "o1" }, amount: 10 } } },
      { "x-payment-signature": "sig", "x-event-id": "evt-from-header" },
    );

    expect(claimedEventId()).toBe("evt-from-header");
  });

  it("still refuses a delivery that identifies itself nowhere", async () => {
    const response = await postWebhook(
      { type: "payment.succeeded" },
      { "x-payment-signature": "sig" },
    );

    expect(response.status).toBe(400);
    expect(webhookMocks.processPaymentWebhook).not.toHaveBeenCalled();
  });
});
