import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildFbc,
  buildMetaConversionPayload,
  describeMetaResult,
  metaCredentialStatus,
} from "@/lib/ads/meta-conversions";
import { buildMetaPurchase } from "@/lib/ads/meta-events";

// ---------------------------------------------------------------------------
// The payload shape is the entire risk here. Outbound calls to
// graph.facebook.com cannot be made from the build environment, so the
// structure is asserted against Meta's Conversions API reference. A wrong
// field name does not error — Meta answers 200 with events_received and the
// match quality silently drops — so the exact names are pinned below.
// ---------------------------------------------------------------------------

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

const purchase = buildMetaPurchase(
  {
    orderId: "order-123",
    isPaid: true,
    amountPaid: 189.98,
    items: [{ slug: "bpc-157", productName: "BPC-157", quantity: 2, unitPrice: 94.99 }],
  },
  { categories: ["Peptides"] },
)!;

const occurredAt = new Date("2026-09-14T12:00:00.000Z");

describe("the envelope matches Meta's Conversions API reference", () => {
  const payload = buildMetaConversionPayload({
    event: purchase,
    user: {},
    occurredAt,
    eventSourceUrl: "https://www.vantalabs.co/order-confirmation/order-123",
  }) as { data: Array<Record<string, unknown>>; test_event_code?: string };
  const event = payload.data[0];

  it("nests events under data as an array", () => {
    expect(Array.isArray(payload.data)).toBe(true);
    expect(payload.data).toHaveLength(1);
  });

  it("sends event_time in unix SECONDS", () => {
    expect(event.event_time).toBe(Math.floor(occurredAt.getTime() / 1000));
    expect(String(event.event_time)).toHaveLength(10);
  });

  it("names the event and carries the pixel's own event_id for deduplication", () => {
    expect(event.event_name).toBe("Purchase");
    expect(event.event_id).toBe("purchase-order-123");
    expect(event.event_id).toBe(purchase.eventId);
  });

  it("declares the action source as website, lowercase", () => {
    expect(event.action_source).toBe("website");
  });

  it("carries the page the event happened on", () => {
    expect(event.event_source_url).toBe("https://www.vantalabs.co/order-confirmation/order-123");
  });

  it("sends the browser event's properties unchanged as custom_data", () => {
    expect(event.custom_data).toEqual(purchase.properties);
    expect(event.custom_data).toMatchObject({
      value: 189.98,
      currency: "USD",
      content_ids: ["bpc-157"],
      content_type: "product",
      num_items: 2,
    });
  });

  it("omits test_event_code unless one is given", () => {
    expect(payload).not.toHaveProperty("test_event_code");
    const withCode = buildMetaConversionPayload({ event: purchase, user: {}, occurredAt, testEventCode: "TEST123" });
    expect(withCode.test_event_code).toBe("TEST123");
  });
});

describe("identity is hashed, never raw", () => {
  const payload = buildMetaConversionPayload({
    event: purchase,
    user: {
      email: "  Jo@Example.COM ",
      phone: "+1 (415) 555-0100",
      externalId: "user-42",
      ipAddress: "203.0.113.9",
      userAgent: "Mozilla/5.0",
      fbp: "fb.1.1700000000000.123456",
      fbc: "fb.1.1700000000000.AbCdEf",
    },
    occurredAt,
  }) as { data: Array<{ user_data: Record<string, unknown> }> };
  const userData = payload.data[0].user_data;

  it("hashes the email with the same normalisation TikTok and Snap use", () => {
    expect(userData.em).toEqual([sha256("jo@example.com")]);
  });

  it("hashes the phone as E.164 digits without the plus", () => {
    expect(userData.ph).toEqual([sha256("14155550100")]);
  });

  it("hashes the external id", () => {
    expect(userData.external_id).toEqual([sha256("user-42")]);
  });

  it("sends IP, user agent and the pixel cookies RAW, because a hash of them matches nothing", () => {
    expect(userData.client_ip_address).toBe("203.0.113.9");
    expect(userData.client_user_agent).toBe("Mozilla/5.0");
    expect(userData.fbp).toBe("fb.1.1700000000000.123456");
    expect(userData.fbc).toBe("fb.1.1700000000000.AbCdEf");
  });

  it("contains no raw EMAIL or phone anywhere in the request", () => {
    const text = JSON.stringify(payload);
    expect(text).not.toMatch(/example\.com/i);
    expect(text).not.toContain("415");
  });

  it("sends an empty user_data object rather than inventing a key", () => {
    const bare = buildMetaConversionPayload({ event: purchase, user: {}, occurredAt }) as {
      data: Array<{ user_data: Record<string, unknown> }>;
    };
    expect(bare.data[0].user_data).toEqual({});
  });
});

describe("fbc", () => {
  it("prefers the pixel's own cookie", () => {
    expect(buildFbc({ fbc: "fb.1.1.cookie", fbclid: "param" })).toBe("fb.1.1.cookie");
  });

  it("builds the documented form from a stored fbclid", () => {
    const clickedAt = new Date("2026-09-10T00:00:00.000Z");
    expect(buildFbc({ fbclid: "IwAR0abc", clickedAt })).toBe(`fb.1.${clickedAt.getTime()}.IwAR0abc`);
  });

  it("is absent for organic traffic", () => {
    expect(buildFbc({})).toBeNull();
    expect(buildFbc({ fbc: "  ", fbclid: "" })).toBeNull();
  });
});

describe("credential status", () => {
  const original = process.env.META_CONVERSIONS_ACCESS_TOKEN;
  beforeEach(() => {
    delete process.env.META_CONVERSIONS_ACCESS_TOKEN;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.META_CONVERSIONS_ACCESS_TOKEN;
    else process.env.META_CONVERSIONS_ACCESS_TOKEN = original;
  });

  it("reports the missing variable by name", () => {
    expect(metaCredentialStatus()).toEqual({ configured: false, missing: ["META_CONVERSIONS_ACCESS_TOKEN"] });
  });

  it("is configured once the token is present", () => {
    process.env.META_CONVERSIONS_ACCESS_TOKEN = "tok";
    expect(metaCredentialStatus().configured).toBe(true);
  });
});

describe("describeMetaResult", () => {
  it("surfaces Meta's own message on a rejection, which is what names a bad field", () => {
    expect(
      describeMetaResult({
        delivered: false, httpStatus: 400, apiMessage: "Invalid parameter", transportError: null, eventsReceived: null, durationMs: 12,
      }),
    ).toBe("meta: HTTP 400 — Invalid parameter");
  });

  it("names a transport failure and a delivery plainly", () => {
    expect(
      describeMetaResult({ delivered: false, httpStatus: null, apiMessage: null, transportError: "timed out", eventsReceived: null, durationMs: 8000 }),
    ).toBe("meta: timed out");
    expect(
      describeMetaResult({ delivered: true, httpStatus: 200, apiMessage: null, transportError: null, eventsReceived: 1, durationMs: 90 }),
    ).toBe("meta: delivered in 90ms");
  });
});
