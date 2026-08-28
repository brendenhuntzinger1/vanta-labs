import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// P2-3: A PUBLIC ENDPOINT THAT WROTE A DATABASE ROW ON DEMAND.
//
// This route catches everything and recorded a `system_alerts` row for it. The
// first thing processPaymentWebhook does is verify the signature — so a POST
// with a wrong signature, which needs no credentials of any kind, took the same
// path and minted a row. Anything on the internet could therefore grow the
// alerts table at whatever rate it liked, and those rows are what filled the
// ten-row window on /admin/status and buried the criticals underneath.
//
// The line is the signature. Below it, the sender proved it holds
// PAYMENT_WEBHOOK_SECRET and a failure means a card event may not have settled,
// which is worth a durable alert. Above it, there is nothing to report.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  processPaymentWebhook: vi.fn(),
  recordSystemAlert: vi.fn(async () => {}),
}));

class WebhookSignatureError extends Error {
  constructor(message = "Invalid webhook signature") {
    super(message);
    this.name = "WebhookSignatureError";
  }
}

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ getRequiredEnv: () => "test-secret" }));
vi.mock("@/lib/payment-webhook", () => ({
  processPaymentWebhook: mocks.processPaymentWebhook,
  WebhookSignatureError,
}));
vi.mock("@/lib/monitoring", () => ({ recordSystemAlert: mocks.recordSystemAlert }));

async function post(body: unknown, headers: Record<string, string>) {
  const { POST } = await import("./route");
  return POST(new Request("https://vantalabsresearch.com/api/webhooks/payment", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  }));
}

const SIGNED = { "x-payment-signature": "sig", "x-event-id": "evt_1" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

describe("an unauthenticated caller", () => {
  it("cannot write a system_alerts row by sending a bad signature", async () => {
    mocks.processPaymentWebhook.mockRejectedValue(new WebhookSignatureError());

    const response = await post({ id: "evt_1" }, SIGNED);

    expect(response.status).toBe(400);
    expect(mocks.recordSystemAlert).not.toHaveBeenCalled();
  });

  it("cannot write one by sending a hundred of them", async () => {
    mocks.processPaymentWebhook.mockRejectedValue(new WebhookSignatureError());

    for (let i = 0; i < 100; i += 1) await post({ id: `evt_${i}` }, SIGNED);

    expect(mocks.recordSystemAlert).not.toHaveBeenCalled();
  });

  it("is turned away before any alert path when it sends no signature at all", async () => {
    const response = await post({ id: "evt_1" }, {});

    expect(response.status).toBe(400);
    expect(mocks.processPaymentWebhook).not.toHaveBeenCalled();
    expect(mocks.recordSystemAlert).not.toHaveBeenCalled();
  });
});

describe("a request that proved it holds the secret", () => {
  it("still raises an alert when settlement fails, because that is a real incident", async () => {
    mocks.processPaymentWebhook.mockRejectedValue(new Error("order upsert failed"));

    const response = await post({ id: "evt_1" }, SIGNED);

    expect(response.status).toBe(400);
    expect(mocks.recordSystemAlert).toHaveBeenCalledWith(
      expect.objectContaining({ type: "payment_webhook_error", severity: "warning" }),
    );
  });

  it("bounds even that alert, so a retrying provider is one row and not three hundred", async () => {
    mocks.processPaymentWebhook.mockRejectedValue(new Error("order upsert failed"));

    await post({ id: "evt_1" }, SIGNED);

    const [alert] = mocks.recordSystemAlert.mock.calls[0] as unknown as [{ dedupeWindowMs?: number }];
    expect(alert.dedupeWindowMs).toBeGreaterThan(0);
  });

  it("reports a missing server secret as a 500 without an alert", async () => {
    // Configuration missing on our side is not a settlement failure, and it was
    // already answered separately. Unchanged; asserted so it stays that way.
    mocks.processPaymentWebhook.mockRejectedValue(new Error("Missing PAYMENT_WEBHOOK_SECRET"));

    const response = await post({ id: "evt_1" }, SIGNED);

    expect(response.status).toBe(500);
    expect(mocks.recordSystemAlert).not.toHaveBeenCalled();
  });

  it("passes a good event straight through", async () => {
    mocks.processPaymentWebhook.mockResolvedValue({ eventId: "evt_1", duplicate: false });

    const response = await post({ id: "evt_1" }, SIGNED);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, eventId: "evt_1" });
    expect(mocks.recordSystemAlert).not.toHaveBeenCalled();
  });
});
