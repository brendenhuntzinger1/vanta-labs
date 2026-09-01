import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOrderPushPayload, type OrderPushInput } from "./order-push-notification";

// ---------------------------------------------------------------------------
// The order push notification — the operator's phone alert for a paid order.
//
// Two properties are worth testing and one is not. The message STRING is worth
// it: it is the entire product from the operator's point of view, it is
// assembled from six optional parts, and a wrong one is read at 2am and acted
// on. The SEND is worth it for one reason only — it must never, under any
// failure, disturb an order that has already been paid for. The HTTP shape
// (Zapier's field names) is contract, not behaviour, and is asserted once.
// ---------------------------------------------------------------------------

const base: OrderPushInput = {
  orderId: "ord_a1b2c3d4",
  orderNumber: "VL-1042",
  customerName: "Jordan Mitchell",
  total: 89,
  profit: 41.2,
  profitStatus: "estimated",
  itemCount: 3,
  items: [
    { name: "Alpha Peptide 10mg", quantity: 2 },
    { name: "Bac Water 30ml", quantity: 1 },
  ],
  placedAt: "2026-08-26T18:42:11.000Z",
  siteUrl: "https://vantalabs.com",
};

const message = (over: Partial<OrderPushInput> = {}) => buildOrderPushPayload({ ...base, ...over }).message;

describe("the notification message", () => {
  it("gives the operator the four things they asked for: who, how much, what, and when", () => {
    expect(message()).toBe(
      [
        "Jordan Mitchell — $89.00",
        "2× Alpha Peptide 10mg, 1× Bac Water 30ml",
        "profit $41.20 (est.)",
        "Aug 26, 2026, 2:42 PM ET",
      ].join("\n"),
    );
  });

  it("puts the order number in the title, where a phone shows it first", () => {
    expect(buildOrderPushPayload(base).title).toBe("New Order VL-1042");
  });

  it("marks an estimated profit so it is never mistaken for the settled figure", () => {
    // Profit is estimated until the real postage lands. Dropping "(est.)" would
    // let a number that moves later be read as final.
    expect(message({ profitStatus: "estimated" })).toContain("profit $41.20 (est.)");
    expect(message({ profitStatus: "finalized" })).toContain("profit $41.20");
    expect(message({ profitStatus: "finalized" })).not.toContain("(est.)");
  });

  it("shows a loss as a loss rather than a smaller win", () => {
    expect(message({ profit: -12.3, profitStatus: "finalized" })).toContain("profit -$12.30");
  });

  it("keeps going when profit could not be computed", () => {
    // A missing profit must not cost the operator the notification itself —
    // knowing an order came in matters more than knowing what it earned.
    const payload = buildOrderPushPayload({ ...base, profit: null, profitStatus: null });
    expect(payload.message).toBe(
      ["Jordan Mitchell — $89.00", "2× Alpha Peptide 10mg, 1× Bac Water 30ml", "Aug 26, 2026, 2:42 PM ET"].join("\n"),
    );
    expect(payload.profit).toBe("");
    expect(payload.profit_status).toBe("");
  });

  it("names the order in the body when there is no order number to put in the title", () => {
    const payload = buildOrderPushPayload({ ...base, orderNumber: null });
    expect(payload.title).toBe("New Order");
    expect(payload.message.split("\n")[0]).toBe("Order ord_a1b2c3d4");
  });
});

describe("when the order was placed", () => {
  // Vercel runs UTC. A bare toLocaleString would have told the operator an
  // evening order happened tomorrow, so the time goes through the same pinned
  // display zone every other date in the app uses.
  it("reports the time in the store's zone, not the server's", () => {
    // 18:42Z is 2:42 PM in New York, not 6:42 PM.
    expect(message()).toContain("Aug 26, 2026, 2:42 PM ET");
  });

  it("does not report a late-evening order as tomorrow", () => {
    // 02:05Z on the 15th is 9:05 PM on the 14th in New York. Getting this wrong
    // is the exact bug format-date.ts exists to prevent.
    expect(message({ placedAt: "2026-01-15T02:05:00.000Z" })).toContain("Jan 14, 2026, 9:05 PM ET");
  });

  it("still sends the machine-readable instant for a Zap to filter on", () => {
    const payload = buildOrderPushPayload(base);
    expect(payload.placed_at).toBe("2026-08-26T18:42:11.000Z");
    expect(payload.placed_at_display).toBe("Aug 26, 2026, 2:42 PM ET");
  });

  it("drops the time rather than printing a broken one", () => {
    const payload = buildOrderPushPayload({ ...base, placedAt: "not a date" });
    expect(payload.placed_at_display).toBe("");
    expect(payload.message).not.toContain("Invalid");
  });
});

describe("what was bought", () => {
  it("lists each line as quantity and product name", () => {
    expect(buildOrderPushPayload(base).items).toBe("2× Alpha Peptide 10mg, 1× Bac Water 30ml");
  });

  it("keeps a long order readable instead of flooding the lock screen", () => {
    // Pushover truncates a long message, and a truncated one can lose the
    // profit line below it. Cap the list and say how many were left out.
    const many = Array.from({ length: 9 }, (_, i) => ({ name: `Product ${i + 1}`, quantity: 1 }));
    const payload = buildOrderPushPayload({ ...base, items: many, itemCount: 9 });
    expect(payload.items).toBe("1× Product 1, 1× Product 2, 1× Product 3, 1× Product 4, +5 more");
  });

  it("shortens a product name that would otherwise dominate the alert", () => {
    const payload = buildOrderPushPayload({
      ...base,
      items: [{ name: "A".repeat(60), quantity: 1 }],
    });
    expect(payload.items).toBe(`1× ${"A".repeat(39)}…`);
  });

  it("skips a line with no product name rather than printing 'undefined'", () => {
    const payload = buildOrderPushPayload({
      ...base,
      items: [{ name: null, quantity: 2 }, { name: "  ", quantity: 1 }, { name: "Real Product", quantity: 1 }],
    });
    expect(payload.items).toBe("1× Real Product");
  });

  it("omits the items line entirely when nothing is known about the contents", () => {
    const payload = buildOrderPushPayload({ ...base, items: [] });
    expect(payload.items).toBe("");
    expect(payload.message).toBe(
      ["Jordan Mitchell — $89.00", "profit $41.20 (est.)", "Aug 26, 2026, 2:42 PM ET"].join("\n"),
    );
  });
});

describe("how much of the customer is sent to Zapier and Pushover", () => {
  it("sends the customer's full name, as the operator asked", () => {
    expect(buildOrderPushPayload(base).customer).toBe("Jordan Mitchell");
  });

  it("keeps every part of a longer name instead of guessing which one is the surname", () => {
    // The old redaction turned "Private Lillian Hanze" into "Private H." — it
    // took "Private" for a given name and initialled the wrong word.
    expect(buildOrderPushPayload({ ...base, customerName: "Private Lillian Hanze" }).customer).toBe(
      "Private Lillian Hanze",
    );
    expect(buildOrderPushPayload({ ...base, customerName: "Jordan Lee Mitchell" }).customer).toBe("Jordan Lee Mitchell");
  });

  it("does not mangle a name it does not understand", () => {
    // No title-casing, no reordering. Whatever the customer typed is what they
    // are called: title-casing turns "o'brien" into "O'Brien" and "McDonald"
    // into "Mcdonald", getting someone's own name wrong to look tidier.
    expect(buildOrderPushPayload({ ...base, customerName: "  o'brien  MCDONALD " }).customer).toBe("o'brien MCDONALD");
  });

  it("caps a pathological name rather than letting it push the order off the screen", () => {
    const payload = buildOrderPushPayload({ ...base, customerName: "Z".repeat(200) });
    expect(payload.customer).toBe(`${"Z".repeat(79)}…`);
  });

  it("omits the customer entirely when there is no name", () => {
    for (const customerName of [null, "", "   "]) {
      const payload = buildOrderPushPayload({ ...base, customerName });
      expect(payload.customer).toBe("");
      expect(payload.message.split("\n")[0]).toBe("$89.00");
    }
  });

  it("still never sends the email address or the shipping address", () => {
    // The name is now sent in full, which makes this boundary MORE important,
    // not less: contact details and location still have nowhere to live in the
    // payload, so adding one stays a deliberate decision.
    const keys = Object.keys(buildOrderPushPayload(base));
    expect(keys).not.toContain("email");
    expect(keys).not.toContain("address");
    expect(JSON.stringify(buildOrderPushPayload(base))).not.toMatch(/@/);
  });
});

describe("the field contract Zapier maps against", () => {
  it("sends the agreed fields, with money as plain numbers", () => {
    // total/profit carry no currency symbol so a Zap can filter on them
    // numerically ("only alert above $200"). The symbols live in `message`.
    expect(buildOrderPushPayload(base)).toEqual({
      event: "new_order",
      title: "New Order VL-1042",
      message: [
        "Jordan Mitchell — $89.00",
        "2× Alpha Peptide 10mg, 1× Bac Water 30ml",
        "profit $41.20 (est.)",
        "Aug 26, 2026, 2:42 PM ET",
      ].join("\n"),
      order_number: "VL-1042",
      order_id: "ord_a1b2c3d4",
      customer: "Jordan Mitchell",
      total: "89.00",
      profit: "41.20",
      profit_status: "estimated",
      item_count: "3",
      items: "2× Alpha Peptide 10mg, 1× Bac Water 30ml",
      url: "https://vantalabs.com/admin/orders/ord_a1b2c3d4",
      placed_at: "2026-08-26T18:42:11.000Z",
      placed_at_display: "Aug 26, 2026, 2:42 PM ET",
    });
  });

  it("falls back to the order id when the order has no number yet", () => {
    const payload = buildOrderPushPayload({ ...base, orderNumber: null });
    expect(payload.order_number).toBe("");
    expect(payload.message).toContain("Order ord_a1b2c3d4");
  });

  it("sends an empty link rather than a broken one when the site url is unset", () => {
    // A preview deploy with no NEXT_PUBLIC_SITE_URL would otherwise produce
    // "undefined/admin/orders/..." as the notification's tap target.
    expect(buildOrderPushPayload({ ...base, siteUrl: null }).url).toBe("");
    expect(buildOrderPushPayload({ ...base, siteUrl: "https://vantalabs.com/" }).url).toBe(
      "https://vantalabs.com/admin/orders/ord_a1b2c3d4",
    );
  });
});

// ---------------------------------------------------------------------------
// The send path. Mocked in this suite and nowhere globally: the real Supabase
// client and the real profit engine have their own coverage, and what is under
// test here is what this module does when they, or the network, misbehave.
// ---------------------------------------------------------------------------

const orderRow = {
  order_id: "ord_a1b2c3d4",
  order_number: "VL-1042",
  customer_name: "Jordan Mitchell",
  amount_paid: 89,
  paid_at: "2026-08-26T18:42:11.000Z",
};

let dbOrder: typeof orderRow | null = orderRow;

vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: {
    from: (table: string) => ({
      select: () => ({
        eq: () =>
          table === "order_items"
            ? Promise.resolve({
                data: [
                  { product_name: "Alpha Peptide 10mg", quantity: 2 },
                  { product_name: "Bac Water 30ml", quantity: 1 },
                ],
                error: null,
              })
            : { maybeSingle: () => Promise.resolve({ data: dbOrder, error: null }) },
      }),
    }),
  },
}));

const control: Record<string, Record<string, unknown>> = {};
let controlThrows = false;
vi.mock("@/lib/admin-control", () => ({
  getControlSnapshot: async (section: string) => {
    if (controlThrows) throw new Error("settings unavailable");
    return { [section]: control[section] ?? {} };
  },
}));

let profitResult: Promise<unknown> = Promise.resolve({ profit: 41.2, profitStatus: "estimated" });
vi.mock("@/lib/admin-profit", () => ({ getOrderProfit: () => profitResult }));

const alerts: Array<{ type: string; severity: string; message: string; dedupeWindowMs?: number }> = [];
vi.mock("@/lib/monitoring", () => ({
  recordSystemAlert: async (input: { type: string; severity: string; message: string; dedupeWindowMs?: number }) => {
    alerts.push(input);
  },
}));

const { sendOrderPushNotification } = await import("./order-push-notification");

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubEnv("ORDER_PUSH_WEBHOOK_URL", "https://hooks.example.com/catch/1/abc");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://vantalabs.com");
  dbOrder = orderRow;
  profitResult = Promise.resolve({ profit: 41.2, profitStatus: "estimated" });
  alerts.length = 0;
  for (const key of Object.keys(control)) delete control[key];
  controlThrows = false;
  fetchMock.mockReset().mockResolvedValue({ ok: true, status: 200 });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("sending", () => {
  it("posts the payload as JSON to the configured webhook", async () => {
    await expect(sendOrderPushNotification("ord_a1b2c3d4")).resolves.toEqual({ sent: true });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://hooks.example.com/catch/1/abc");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toMatchObject({
      event: "new_order",
      title: "New Order VL-1042",
      customer: "Jordan Mitchell",
      items: "2× Alpha Peptide 10mg, 1× Bac Water 30ml",
      item_count: "3",
      placed_at_display: "Aug 26, 2026, 2:42 PM ET",
      url: "https://vantalabs.com/admin/orders/ord_a1b2c3d4",
    });
  });

  it("reads the product names out of the order, not just the quantities", async () => {
    await sendOrderPushNotification("ord_a1b2c3d4");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).message).toContain("2× Alpha Peptide 10mg");
  });

  it("gives the request a deadline", async () => {
    // Without one, a hung webhook holds the function open until the platform
    // kills it. Asserted here as well as in third-party-timeouts.test.ts
    // because this one observes the actual call rather than the source text.
    await sendOrderPushNotification("ord_a1b2c3d4");
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("raises an alert when a paid order arrives and no webhook is configured", async () => {
    // This is the failure that hid itself. Two real orders were paid while
    // ORDER_PUSH_WEBHOOK_URL was unset; the module returned silently, so
    // nothing on /admin/status ever said the phone had stopped ringing.
    for (const value of ["", "   "]) {
      alerts.length = 0;
      vi.stubEnv("ORDER_PUSH_WEBHOOK_URL", value);
      await expect(sendOrderPushNotification("ord_a1b2c3d4")).resolves.toEqual({
        sent: false,
        reason: "not_configured",
      });
      expect(alerts[0]).toMatchObject({ type: "order_push_not_configured", severity: "warning" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("nags once a day, not once an order", async () => {
    // Without a dedupe window a busy day writes one identical alert per order
    // and buries every other alert on the status page.
    vi.stubEnv("ORDER_PUSH_WEBHOOK_URL", "");
    await sendOrderPushNotification("ord_a1b2c3d4");
    expect(alerts[0].dedupeWindowMs).toBe(24 * 60 * 60 * 1000);
  });

  it("refuses to send over http rather than putting the URL on the wire in the clear", async () => {
    vi.stubEnv("ORDER_PUSH_WEBHOOK_URL", "http://hooks.example.com/catch/1/abc");
    await expect(sendOrderPushNotification("ord_a1b2c3d4")).resolves.toEqual({
      sent: false,
      reason: "insecure_url",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(alerts[0]).toMatchObject({ type: "order_push_misconfigured", severity: "warning" });
  });
});

describe("what happens when things break", () => {
  // Every case below runs immediately after a customer has been charged and the
  // stock has moved. None of them may throw, because the caller is in the
  // middle of a paid order's side effects.

  it("survives a webhook that refuses the request", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 410 });
    await expect(sendOrderPushNotification("ord_a1b2c3d4")).resolves.toEqual({
      sent: false,
      reason: "delivery_failed",
      detail: "webhook answered 410",
    });
    expect(alerts[0]).toMatchObject({ type: "order_push_failed", severity: "warning" });
  });

  it("survives a webhook that never answers", async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }));
    const result = await sendOrderPushNotification("ord_a1b2c3d4");
    expect(result).toMatchObject({ sent: false, reason: "delivery_failed" });
  });

  it("survives DNS and TLS failures", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    await expect(sendOrderPushNotification("ord_a1b2c3d4")).resolves.toMatchObject({ reason: "delivery_failed" });
  });

  it("survives the profit engine failing, and still tells the operator about the order", async () => {
    profitResult = Promise.reject(new Error("profit settings unavailable"));
    await expect(sendOrderPushNotification("ord_a1b2c3d4")).resolves.toEqual({ sent: true });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.profit).toBe("");
    expect(body.message).toContain("Jordan Mitchell — $89.00");
    expect(body.message).not.toContain("profit");
  });

  it("sends nothing when the order cannot be found", async () => {
    dbOrder = null;
    await expect(sendOrderPushNotification("ord_missing")).resolves.toEqual({
      sent: false,
      reason: "order_not_found",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never rejects, whatever the alerting path does", async () => {
    fetchMock.mockRejectedValue(new Error("boom"));
    await expect(sendOrderPushNotification("ord_a1b2c3d4")).resolves.toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// A DEAD WEBHOOK MUST NOT COST THE OWNER AN ORDER.
//
// On 2026-09-01 a real $94.96 order was paid, the Zapier hook answered 404, and
// the only trace was a `warning` on /admin/status that nobody was looking at.
// The owner found out because an unrelated Supabase email prompted them to
// check. That is the failure these tests exist to prevent.
//
// The module's own comment argued against emailing here, and it was right about
// what it was rejecting: "emailing someone to tell them a notification failed"
// is a meta-alert, and meta-alerts are noise. So this does not send one. It
// raises a CRITICAL alert whose message IS the notification — the same text the
// phone would have shown — and the existing critical path mails it. A different
// channel for the same message, not a message about a message.
//
// Per ORDER, never deduped: two missed orders are two facts, and collapsing
// them loses one. The standing "your webhook is broken" warning keeps its daily
// dedupe, because that one genuinely is a repeating condition.
// ---------------------------------------------------------------------------

function missedAlert() {
  return alerts.find((a) => a.type === "order_notification_missed");
}

describe("an order that could not be announced still reaches the owner", () => {
  it("raises a CRITICAL alert when the webhook rejects the request", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 });
    await sendOrderPushNotification("ord_a1b2c3d4");
    expect(missedAlert()).toMatchObject({ type: "order_notification_missed", severity: "critical" });
  });

  it("carries the order itself, so the email IS the notification", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 });
    await sendOrderPushNotification("ord_a1b2c3d4");
    const message = (missedAlert() as unknown as { message: string }).message;
    // Who, how much, and which order — the same facts the push carries.
    expect(message).toContain("VL-1042");
    expect(message).toContain("Jordan Mitchell");
    expect(message).toContain("$89.00");
    // And why it had to come this way.
    expect(message).toContain("404");
  });

  it("links straight to the order in the admin", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 });
    await sendOrderPushNotification("ord_a1b2c3d4");
    const message = (missedAlert() as unknown as { message: string }).message;
    expect(message).toContain("https://vantalabs.com/admin/orders/ord_a1b2c3d4");
  });

  it("is NOT deduped — a second missed order is a second fact", async () => {
    // The exact way this fix could fail silently: a dedupe window would let
    // order 1 email and swallow every order after it.
    fetchMock.mockResolvedValue({ ok: false, status: 404 });
    await sendOrderPushNotification("ord_a1b2c3d4");
    expect(missedAlert()?.dedupeWindowMs).toBeUndefined();
  });

  it("stays quiet when push was never configured — that is a standing fault, not a lost order", async () => {
    // Deliberate. A store with no webhook has never had push and nobody is
    // waiting for it; the daily-deduped warning is the signal to go set it up.
    // Mailing per order here would be exactly the nagging that dedupe prevents.
    vi.stubEnv("ORDER_PUSH_WEBHOOK_URL", "");
    await sendOrderPushNotification("ord_a1b2c3d4");
    expect(missedAlert()).toBeUndefined();
    expect(alerts.some((a) => a.type === "order_push_not_configured")).toBe(true);
  });

  it("stays quiet on an insecure url too, for the same reason", async () => {
    vi.stubEnv("ORDER_PUSH_WEBHOOK_URL", "http://hooks.example.com/catch/1/abc");
    await sendOrderPushNotification("ord_a1b2c3d4");
    expect(missedAlert()).toBeUndefined();
    expect(alerts.some((a) => a.type === "order_push_misconfigured")).toBe(true);
  });

  it("keeps the standing config warning deduped to once a day", async () => {
    vi.stubEnv("ORDER_PUSH_WEBHOOK_URL", "");
    await sendOrderPushNotification("ord_a1b2c3d4");
    const standing = alerts.find((a) => a.type === "order_push_not_configured");
    expect(standing?.dedupeWindowMs).toBe(24 * 60 * 60 * 1000);
  });

  it("says nothing when the push actually worked", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    await sendOrderPushNotification("ord_a1b2c3d4");
    expect(missedAlert()).toBeUndefined();
  });

  it("does not fire for an order that does not exist", async () => {
    // Nothing was missed, because there was nothing to announce.
    dbOrder = null;
    await sendOrderPushNotification("ord_missing");
    expect(missedAlert()).toBeUndefined();
  });

  it("still tells the owner even when the order details cannot be read", async () => {
    // The worst case: the push failed AND the order lookup failed. The owner
    // must still learn that an order went unannounced, with its id.
    fetchMock.mockResolvedValue({ ok: false, status: 404 });
    profitResult = Promise.reject(new Error("profit unavailable"));
    await sendOrderPushNotification("ord_a1b2c3d4");
    expect(missedAlert()).toBeTruthy();
    expect((missedAlert() as unknown as { message: string }).message).toContain("ord_a1b2c3d4");
  });

  it("never rejects, whatever the alert path does", async () => {
    fetchMock.mockRejectedValue(new Error("boom"));
    await expect(sendOrderPushNotification("ord_a1b2c3d4")).resolves.toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// PUSHOVER, DIRECTLY — NO ZAPIER IN THE MIDDLE.
//
// The original design posts to an automation webhook (Zapier) which forwards to
// a push service. That middleman is what broke: the Catch Hook was deleted or
// rebuilt, it started answering 404, and a paid order went unannounced.
//
// Pushover is the actual destination, and it has a plain HTTP API. Talking to
// it directly removes an entire service from the path, and — because the
// credentials live in the Control Center rather than an environment variable —
// a broken destination can be repaired from the admin in seconds instead of
// needing a redeploy. That was the other half of the incident: the URL could
// not be changed without shipping.
//
// The webhook path is kept, unchanged, for anyone already using it.
// ---------------------------------------------------------------------------

describe("sending through Pushover directly", () => {
  beforeEach(() => {
    control.notifications = { pushover_token: "app-token", pushover_user_key: "user-key" };
  });

  it("posts the order to Pushover's API rather than a webhook", async () => {
    await expect(sendOrderPushNotification("ord_a1b2c3d4")).resolves.toEqual({ sent: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://api.pushover.net/1/messages.json");
    const body = new URLSearchParams(String((init as { body?: string }).body));
    expect(body.get("token")).toBe("app-token");
    expect(body.get("user")).toBe("user-key");
  });

  it("carries the same four facts the webhook payload carries", async () => {
    await sendOrderPushNotification("ord_a1b2c3d4");
    const body = new URLSearchParams(String((fetchMock.mock.calls[0][1] as { body?: string }).body));
    expect(body.get("title")).toContain("VL-1042");
    expect(body.get("message")).toContain("Jordan Mitchell");
    expect(body.get("message")).toContain("$89.00");
    expect(body.get("url")).toBe("https://vantalabs.com/admin/orders/ord_a1b2c3d4");
  });

  it("wins over a configured webhook, because it is the shorter path", async () => {
    vi.stubEnv("ORDER_PUSH_WEBHOOK_URL", "https://hooks.example.com/catch/1/abc");
    await sendOrderPushNotification("ord_a1b2c3d4");
    expect(String(fetchMock.mock.calls[0][0])).toContain("api.pushover.net");
  });

  it("still raises the missed-order critical when Pushover refuses", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400 });
    await sendOrderPushNotification("ord_a1b2c3d4");
    expect(alerts.find((a) => a.type === "order_notification_missed")).toMatchObject({ severity: "critical" });
  });

  it("falls back to the webhook when only one of the two keys is set", async () => {
    // A half-filled credential pair is a configuration mistake, not a
    // destination. Guessing would send to nowhere and report success.
    control.notifications = { pushover_token: "app-token" };
    vi.stubEnv("ORDER_PUSH_WEBHOOK_URL", "https://hooks.example.com/catch/1/abc");
    await sendOrderPushNotification("ord_a1b2c3d4");
    expect(String(fetchMock.mock.calls[0][0])).toContain("hooks.example.com");
  });

  it("never lets a settings read failure stop an order going out", async () => {
    controlThrows = true;
    vi.stubEnv("ORDER_PUSH_WEBHOOK_URL", "https://hooks.example.com/catch/1/abc");
    await expect(sendOrderPushNotification("ord_a1b2c3d4")).resolves.toEqual({ sent: true });
    expect(String(fetchMock.mock.calls[0][0])).toContain("hooks.example.com");
  });
});

describe("the webhook URL can be changed without a deploy", () => {
  it("prefers the Control Center URL over the environment variable", async () => {
    // The incident's second half: the dead URL lived in an env var, so fixing
    // it needed a redeploy. From the admin it is a ten-second edit.
    control.notifications = { order_push_webhook_url: "https://hooks.example.com/catch/NEW/xyz" };
    vi.stubEnv("ORDER_PUSH_WEBHOOK_URL", "https://hooks.example.com/catch/OLD/abc");
    await sendOrderPushNotification("ord_a1b2c3d4");
    expect(String(fetchMock.mock.calls[0][0])).toContain("/catch/NEW/xyz");
  });

  it("still uses the environment variable when nothing is configured in the admin", async () => {
    vi.stubEnv("ORDER_PUSH_WEBHOOK_URL", "https://hooks.example.com/catch/1/abc");
    await sendOrderPushNotification("ord_a1b2c3d4");
    expect(String(fetchMock.mock.calls[0][0])).toContain("hooks.example.com/catch/1/abc");
  });
});
