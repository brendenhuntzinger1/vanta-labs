import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRedditConversionPayload, describeRedditResult, redditCredentialStatus } from "@/lib/ads/reddit-conversions";
import { buildRedditPurchase } from "@/lib/ads/reddit-events";

// ---------------------------------------------------------------------------
// The payload shape is the entire risk here.
//
// This is the one integration in the stack that could not be verified against
// the real endpoint from the build environment — outbound calls to
// ads-api.reddit.com are blocked there — so the structure is asserted against
// the templates Reddit's own Events Manager produced for THIS pixel.
//
// That mattered: the first version of this module used `event_metadata` and
// `value_decimal`, both taken from third-party write-ups of the v2 API. The
// console's own "Add parameters" screen shows `metadata` and `value`. A wrong
// field name does not error — Reddit answers 2xx and the conversion simply
// never appears, which is the most expensive kind of quiet failure in ad tech,
// so the exact names are pinned below.
// ---------------------------------------------------------------------------

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

const purchase = buildRedditPurchase({
  orderId: "order-123",
  total: 189.98,
  itemCount: 2,
  items: [{ slug: "bpc-157", variantId: "dose-1", name: "BPC-157", category: "Peptides" }],
})!;

const occurredAt = new Date("2026-08-15T12:00:00.000Z");

describe("the envelope matches Reddit's own sample", () => {
  const payload = buildRedditConversionPayload({ event: purchase, user: {}, occurredAt }) as {
    data: { events: Array<Record<string, unknown>> };
  };
  const event = payload.data.events[0];

  it("nests events under data.events", () => {
    expect(Array.isArray(payload.data.events)).toBe(true);
    expect(payload.data.events).toHaveLength(1);
  });

  it("sends event_at in MILLISECONDS", () => {
    // Seconds would land in 1970 and be dropped as older than seven days —
    // silently, with a 2xx.
    expect(event.event_at).toBe(occurredAt.getTime());
    expect(String(event.event_at)).toHaveLength(13);
  });

  it("names the event under type.tracking_type", () => {
    expect(event.type).toEqual({ tracking_type: "Purchase" });
  });

  it("declares the action source", () => {
    expect(event.action_source).toBe("website");
  });
});

describe("deduplication against the browser pixel", () => {
  it("carries the SAME conversion id the pixel sends", () => {
    // The pixel puts the order id in conversionId; this must match exactly or
    // Reddit counts the sale twice.
    const payload = buildRedditConversionPayload({ event: purchase, user: {}, occurredAt }) as {
      data: { events: Array<{ metadata: Record<string, unknown> }> };
    };
    expect(payload.data.events[0].metadata.conversion_id).toBe("order-123");
    expect(purchase.properties.conversionId).toBe("order-123");
  });

  it("uses the console's field names: metadata + value, NOT event_metadata + value_decimal", () => {
    // The exact pair that was wrong. Both spellings look plausible and only one
    // is read; the other is dropped in silence.
    const payload = buildRedditConversionPayload({ event: purchase, user: {}, occurredAt }) as {
      data: { events: Array<Record<string, unknown>> };
    };
    const event = payload.data.events[0];
    expect(event).toHaveProperty("metadata");
    expect(event).not.toHaveProperty("event_metadata");
    expect(event.metadata).toMatchObject({ currency: "USD", value: 189.98, item_count: 2 });
    expect(event.metadata).not.toHaveProperty("value_decimal");
  });

  it("names products with id / name / category, as the template does", () => {
    const payload = buildRedditConversionPayload({ event: purchase, user: {}, occurredAt }) as {
      data: { events: Array<{ metadata: { products?: Array<Record<string, unknown>> } }> };
    };
    expect(payload.data.events[0].metadata.products?.[0]).toEqual({
      id: "bpc-157::dose-1", name: "BPC-157", category: "Peptides",
    });
  });
});

describe("identity is hashed, never raw", () => {
  const payload = buildRedditConversionPayload({
    event: purchase,
    occurredAt,
    user: {
      email: "Jo.Smith+shop@Gmail.com",
      externalId: "user-1",
      ipAddress: "203.0.113.9",
      userAgent: "Mozilla/5.0",
      clickId: "rdt_cid_abc",
    },
  }) as { data: { events: Array<{ user: Record<string, unknown>; click_id?: string }> } };
  const event = payload.data.events[0];

  it("hashes the email with REDDIT's canonicalisation", () => {
    // Dots stripped, +tag dropped — not the naive lowercase hash.
    expect(event.user.email).toBe(sha256("josmith@gmail.com"));
    expect(event.user.email).not.toBe(sha256("jo.smith+shop@gmail.com"));
  });

  it("hashes the external id", () => {
    expect(event.user.external_id).toBe(sha256("user-1"));
  });

  it("sends the IP and user agent RAW, because a hash of them matches nothing", () => {
    // Reddit compares an IP against ones it observed itself. A digest would be
    // sent for no benefit at all — data shared, no attribution gained.
    expect(event.user.ip_address).toBe("203.0.113.9");
    expect(event.user.ip_address).not.toBe(sha256("203.0.113.9"));
    expect(event.user.user_agent).toBe("Mozilla/5.0");
  });

  it("carries a click id when there is one", () => {
    expect(event.click_id).toBe("rdt_cid_abc");
  });

  it("contains no raw EMAIL anywhere in the request", () => {
    // The address is the identifier that must never leave in the clear. The IP
    // is a separate decision, made above and disclosed in the cookie policy.
    const serialised = JSON.stringify(payload);
    expect(serialised).not.toContain("@");
    expect(serialised).not.toContain("Jo.Smith");
  });

  it("omits the user object entirely rather than sending an empty one", () => {
    const anonymous = buildRedditConversionPayload({ event: purchase, user: {}, occurredAt }) as {
      data: { events: Array<Record<string, unknown>> };
    };
    expect(anonymous.data.events[0]).not.toHaveProperty("user");
    expect(anonymous.data.events[0]).not.toHaveProperty("click_id");
  });
});

describe("credential status", () => {
  const original = process.env.REDDIT_CONVERSIONS_ACCESS_TOKEN;
  beforeEach(() => { delete process.env.REDDIT_CONVERSIONS_ACCESS_TOKEN; });
  afterEach(() => {
    if (original === undefined) delete process.env.REDDIT_CONVERSIONS_ACCESS_TOKEN;
    else process.env.REDDIT_CONVERSIONS_ACCESS_TOKEN = original;
  });

  it("reports the missing variable by name", () => {
    const status = redditCredentialStatus();
    expect(status.configured).toBe(false);
    expect(status.missing).toContain("REDDIT_CONVERSIONS_ACCESS_TOKEN");
  });

  it("is configured once the token is present", () => {
    process.env.REDDIT_CONVERSIONS_ACCESS_TOKEN = "token";
    expect(redditCredentialStatus().configured).toBe(true);
  });
});

describe("describeRedditResult", () => {
  it("surfaces Reddit's own message on a rejection, which is what names a bad field", () => {
    const line = describeRedditResult({
      delivered: false, httpStatus: 400, apiMessage: '{"error":"unknown field foo"}',
      transportError: null, durationMs: 12,
    });
    expect(line).toContain("400");
    expect(line).toContain("unknown field foo");
  });

  it("never leaks a token", () => {
    const line = describeRedditResult({
      delivered: true, httpStatus: 200, apiMessage: null, transportError: null, durationMs: 30,
    });
    expect(line).not.toMatch(/bearer|token/i);
  });
});
