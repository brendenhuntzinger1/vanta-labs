import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// EMAIL-12 — BULK "MARK SHIPPED" MUST NOT DROP A REFUSED SHIPPING NOTICE.
//
// The single-order route and the Shippo webhook both queue a shipping notice
// the provider refuses, because the status has already advanced and no later
// carrier scan will regenerate the message. The bulk action counted successes
// and discarded failures: no queue row, no log line, no alert — the admin saw
// only a lower "notified" count, and those customers never got their notice.
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ getSiteUrl: () => "https://www.vantalabsresearch.com" }));

const orders = [
  { order_id: "order-a", order_number: "VL-A001", customer_email: "a@example.test", customer_name: "Ada", fulfillment_status: "packed", tracking_number: "1Z-A" },
  { order_id: "order-b", order_number: "VL-B001", customer_email: "b@example.test", customer_name: "Bo", fulfillment_status: "packed", tracking_number: null },
];

vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({
        in: async (_column: string, ids: string[]) => ({ data: orders.filter((o) => ids.includes(o.order_id)), error: null }),
      }),
    }),
  },
}));

vi.mock("@/lib/shippo/service", () => ({
  setOrderFulfillmentStatus: async ({ orderId }: { orderId: string }) => ({ ok: true, data: { from: "packed", to: "shipped" }, orderId }),
}));

const refuse = new Set<string>();
const sent: Array<{ to: string; subject: string }> = [];
vi.mock("@/lib/email/send", () => ({
  sendEmail: async (message: { to: string; subject: string }) => {
    if (refuse.has(message.to)) return { success: false, error: "Resend API error (503): unavailable" };
    sent.push({ to: message.to, subject: message.subject });
    return { success: true };
  },
}));

const enqueued: Array<{ message: { to: string; subject: string; html: string; text: string }; error?: string }> = [];
vi.mock("@/lib/email/retry-queue", () => ({
  enqueueFailedEmail: async (message: { to: string; subject: string; html: string; text: string }, error?: string) => {
    enqueued.push({ message, error });
  },
}));

beforeEach(() => {
  refuse.clear();
  sent.length = 0;
  enqueued.length = 0;
});

describe("bulk mark shipped", () => {
  it("queues a refused shipping notice for the retry sweep, exactly like the single-order path", async () => {
    const { bulkUpdateAdminOrders } = await import("@/lib/admin-orders");
    refuse.add("b@example.test");

    const outcome = await bulkUpdateAdminOrders({ orderIds: ["order-a", "order-b"], action: "mark_shipped", actor: "ops" });

    expect(outcome.updated).toBe(2);
    expect(outcome.notified).toBe(1);
    expect(sent.map((s) => s.to)).toEqual(["a@example.test"]);
    // The refusal is not lost: the rendered notice is in the queue with its reason.
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].message.to).toBe("b@example.test");
    expect(enqueued[0].message.subject).toContain("VL-B001");
    expect(enqueued[0].message.html).toContain("Shipped");
    expect(enqueued[0].error).toContain("503");
  });

  it("queues nothing when every notice went out", async () => {
    const { bulkUpdateAdminOrders } = await import("@/lib/admin-orders");

    const outcome = await bulkUpdateAdminOrders({ orderIds: ["order-a", "order-b"], action: "mark_shipped", actor: "ops" });

    expect(outcome.notified).toBe(2);
    expect(enqueued).toHaveLength(0);
  });
});
