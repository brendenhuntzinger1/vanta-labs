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
// the cURL sample Reddit's own Events Manager produced for this pixel:
//
//   POST /api/v3/pixels/<pixel_id>/conversion_events
//   { "data": { "events": [ { event_at, action_source, type: { tracking_type } } ] } }
//
// A wrong field name does not error. It produces a 2xx and a conversion that
// never appears, which is the most expensive kind of quiet failure in ad tech.
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
      data: { events: Array<{ event_metadata: Record<string, unknown> }> };
    };
    expect(payload.data.events[0].event_metadata.conversion_id).toBe("order-123");
    expect(purchase.properties.conversionId).toBe("order-123");
  });

  it("reports the money as value_decimal with the currency", () => {
    const payload = buildRedditConversionPayload({ event: purchase, user: {}, occurredAt }) as {
      data: { events: Array<{ event_metadata: Record<string, unknown> }> };
    };
    expect(payload.data.events[0].event_metadata).toMatchObject({
      currency: "USD",
      value_decimal: 189.98,
      item_count: 2,
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

  it("hashes the external id and the ip", () => {
    expect(event.user.external_id).toBe(sha256("user-1"));
    expect(event.user.ip_address).toBe(sha256("203.0.113.9"));
  });

  it("passes the user agent through, since it is not an identifier on its own", () => {
    expect(event.user.user_agent).toBe("Mozilla/5.0");
  });

  it("carries a click id when there is one", () => {
    expect(event.click_id).toBe("rdt_cid_abc");
  });

  it("contains no raw address anywhere in the request", () => {
    const serialised = JSON.stringify(payload);
    expect(serialised).not.toContain("@");
    expect(serialised).not.toContain("Jo.Smith");
    expect(serialised).not.toContain("203.0.113.9");
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
