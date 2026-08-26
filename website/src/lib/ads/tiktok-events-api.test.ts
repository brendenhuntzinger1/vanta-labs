import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertNoSecret,
  buildEventsApiPayload,
  credentialStatus,
  describeResult,
  EVENTS_API_URL,
  eventTime,
  sendServerEvents,
  type ServerEvent,
} from "./tiktok-events-api";

const OCCURRED = new Date("2026-08-09T12:00:00Z");
const TOKEN = "super-secret-token-value-abc123";

const purchase: ServerEvent = {
  event: "Purchase",
  eventId: "purchase-ord-123",
  occurredAt: OCCURRED,
  user: { email: "  Jo@Example.COM ", ttclid: "TTCLID123", ip: "203.0.113.9", userAgent: "Mozilla/5.0" },
  properties: {
    contents: [{ content_id: "bpc-157", content_type: "product", content_name: "BPC-157", quantity: 2, price: 42.99 }],
    currency: "USD",
    value: 85.98,
    order_id: "ord-123",
  },
};

beforeEach(() => {
  process.env.TIKTOK_EVENTS_API_ACCESS_TOKEN = TOKEN;
  // sendServerEvents now refuses to send from any non-production environment
  // (audit K-16 — the pixel id falls back to the live production account, so a
  // preview, a local run or CI would report real conversions into it). These
  // tests exercise the DELIVERY path, so they must present the one environment
  // where delivery is permitted. Without this they assert against a gate that
  // did not exist when they were written.
  //
  // The gate itself is covered by ads-environment.test.ts and
  // ads-environment-enforcement.test.ts; nothing here re-tests it.
  vi.stubEnv("VERCEL_ENV", "production");
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("CI", "");
});
afterEach(() => {
  delete process.env.TIKTOK_EVENTS_API_ACCESS_TOKEN;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("payload shape", () => {
  it("uses the v1.3 top-level fields", () => {
    const payload = buildEventsApiPayload([purchase]);
    expect(payload.event_source).toBe("web");
    expect(payload.event_source_id).toBeTruthy();
    expect(Array.isArray(payload.data)).toBe(true);
    expect(payload).not.toHaveProperty("test_event_code");
  });

  it("carries the event id unchanged so the browser event dedups against it", () => {
    expect(buildEventsApiPayload([purchase]).data[0].event_id).toBe("purchase-ord-123");
  });

  it("sends event_time in the configured format", () => {
    const value = buildEventsApiPayload([purchase]).data[0].event_time;
    expect(value).toBe(eventTime(OCCURRED));
    expect(typeof value).toBe("number");
    expect(value).toBe(Math.floor(OCCURRED.getTime() / 1000));
  });

  it("hashes identifiers and normalises them first", () => {
    const user = buildEventsApiPayload([purchase]).data[0].user;
    expect(user.email).toMatch(/^[a-f0-9]{64}$/);
    expect(user.email).not.toContain("@");
    // Same address, different casing and padding, must hash identically or the
    // match silently fails.
    const other = buildEventsApiPayload([{ ...purchase, user: { email: "jo@example.com" } }]).data[0].user;
    expect(other.email).toBe(user.email);
  });

  it("leaves click id, ip and user agent unhashed — TikTok expects them raw", () => {
    const user = buildEventsApiPayload([purchase]).data[0].user;
    expect(user.ttclid).toBe("TTCLID123");
    expect(user.ip).toBe("203.0.113.9");
    expect(user.user_agent).toBe("Mozilla/5.0");
  });

  it("omits identifiers we do not have rather than hashing an empty string", () => {
    const user = buildEventsApiPayload([{ ...purchase, user: { email: null, ttclid: null, phone: "" } }]).data[0].user;
    expect(user).not.toHaveProperty("email");
    expect(user).not.toHaveProperty("ttclid");
    expect(user).not.toHaveProperty("phone");
  });

  it("rejects a malformed email rather than hashing rubbish", () => {
    const user = buildEventsApiPayload([{ ...purchase, user: { email: "not-an-email" } }]).data[0].user;
    expect(user).not.toHaveProperty("email");
  });

  it("carries the order id so a conversion is traceable to real revenue", () => {
    expect(buildEventsApiPayload([purchase]).data[0].properties.order_id).toBe("ord-123");
    expect(buildEventsApiPayload([purchase]).data[0].properties.value).toBe(85.98);
  });

  it("includes test_event_code only when testing", () => {
    const payload = buildEventsApiPayload([purchase], { testEventCode: "TEST123" }) as Record<string, unknown>;
    expect(payload.test_event_code).toBe("TEST123");
  });
});

describe("delivery", () => {
  const mockFetch = (body: unknown, status = 200) =>
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));

  it("reports delivered only when TikTok returns code 0", async () => {
    mockFetch({ code: 0, message: "OK", request_id: "req-1" });
    const outcome = await sendServerEvents([purchase]);
    expect(outcome.delivered).toBe(true);
    expect(outcome.tiktokCode).toBe(0);
    expect(outcome.requestId).toBe("req-1");
  });

  it("does NOT report delivered on HTTP 200 with a TikTok error code", async () => {
    // This is the trap: TikTok returns 200 with an error in the body, so a
    // status-only check would report success on a rejected payload.
    mockFetch({ code: 40001, message: "param error: event_time", request_id: "req-2" });
    const outcome = await sendServerEvents([purchase]);
    expect(outcome.delivered).toBe(false);
    expect(outcome.tiktokCode).toBe(40001);
    expect(describeResult(outcome)).toMatch(/REJECTED/);
    expect(describeResult(outcome)).toMatch(/event_time/);
  });

  it("does not report delivered on a non-2xx", async () => {
    mockFetch({ code: 40100, message: "auth error" }, 401);
    expect((await sendServerEvents([purchase])).delivered).toBe(false);
  });

  it("never throws when the network fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNRESET"); }));
    const outcome = await sendServerEvents([purchase]);
    expect(outcome.delivered).toBe(false);
    expect(outcome.transportError).toMatch(/ECONNRESET/);
  });

  it("handles a non-JSON response without crashing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>gateway</html>", { status: 502 })));
    const outcome = await sendServerEvents([purchase]);
    expect(outcome.delivered).toBe(false);
    expect(outcome.transportError).toMatch(/not JSON/);
  });

  it("refuses to send with no token, and says so without inventing success", async () => {
    delete process.env.TIKTOK_EVENTS_API_ACCESS_TOKEN;
    const outcome = await sendServerEvents([purchase]);
    expect(outcome.delivered).toBe(false);
    expect(outcome.transportError).toMatch(/ACCESS_TOKEN is not set/);
  });

  it("sends the token only in the Access-Token header, to the right URL", async () => {
    const spy = vi.fn(async () => new Response(JSON.stringify({ code: 0 }), { status: 200 }));
    vi.stubGlobal("fetch", spy);
    await sendServerEvents([purchase]);
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(EVENTS_API_URL);
    expect((init.headers as Record<string, string>)["Access-Token"]).toBe(TOKEN);
    // The token must never appear in the body.
    expect(String(init.body)).not.toContain(TOKEN);
  });
});

describe("secret hygiene", () => {
  it("keeps the token out of every diagnostic string", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ code: 40001, message: "bad" }), { status: 200 })));
    const outcome = await sendServerEvents([purchase]);
    const text = describeResult(outcome);
    expect(text).not.toContain(TOKEN);
    expect(JSON.stringify(outcome)).not.toContain(TOKEN);
    expect(() => assertNoSecret(text)).not.toThrow();
  });

  it("refuses to emit text that does contain the token", () => {
    expect(() => assertNoSecret(`leaked ${TOKEN}`)).toThrow(/refusing to emit/);
  });

  it("keeps the token out of the built payload", () => {
    expect(JSON.stringify(buildEventsApiPayload([purchase]))).not.toContain(TOKEN);
  });

  it("reports credential status without revealing the value", () => {
    expect(credentialStatus().configured).toBe(true);
    const missing = credentialStatus({ ...process.env, TIKTOK_EVENTS_API_ACCESS_TOKEN: "" });
    expect(missing.configured).toBe(false);
    expect(missing.missing).toContain("TIKTOK_EVENTS_API_ACCESS_TOKEN");
    expect(JSON.stringify(missing)).not.toContain(TOKEN);
  });
});
