import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "crypto";

// ---------------------------------------------------------------------------
// THE SECRET AUTHENTICATED THE URL, NOT THE PAYLOAD.
//
// This endpoint can suppress any address from every marketing send, and the
// suppression a complaint writes is UNLIFTABLE by design — the customer cannot
// undo it from their account page. Its only check was a shared secret carried
// in the query string, compared in constant time. That is correct as far as it
// goes and it fails closed when unset, but the signature covers no bytes, there
// is no timestamp window and no nonce: possession of the URL alone was full
// write access to the list. One forged `email.complained` per address — and
// addresses are guessable for any customer whose email is known — silently
// removes that customer from marketing for good.
//
// The URL is obtainable from the Resend dashboard, a proxy or CDN access log,
// or a screenshot of the webhook configuration: all places a query string is
// routinely recorded.
//
// THE FIRST FIX DID NOT FIX IT, AND THESE TESTS SAID SO WITHOUT ANYONE
// NOTICING. Signature verification was added, and then applied like this:
//
//     if (verdict === "bad-signature" || verdict === "stale") return 401;
//
// `unsigned` fell through. An attacker did not have to forge a signature —
// they omitted the headers. The test below used to assert exactly that, under
// the name "still accepts an UNSIGNED delivery, because SendGrid sends none",
// so the suite was green while the hole was open. The carve-out was for a
// provider this endpoint has no verifier for and the store does not use.
//
// Now: a valid Svix signature over the raw body, inside a five-minute window,
// is REQUIRED, and the endpoint fails closed when the signing secret is
// unconfigured. The URL secret stays as a cheap first gate.
// ---------------------------------------------------------------------------

const applied = vi.hoisted(() => [] as unknown[][]);

vi.mock("server-only", () => ({}));
vi.mock("@/lib/email/delivery-events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email/delivery-events")>();
  return {
    ...actual,
    applyDeliveryEvents: async (events: unknown[]) => {
      applied.push(events);
      return { suppressed: 1, ignored: 0, engaged: 0, writeFailed: false };
    },
  };
});

const URL_SECRET = "url-secret-value";
const SIGNING_SECRET = "whsec_c2VjcmV0LWtleS1ieXRlcy1oZXJlLW9r";
const BODY = JSON.stringify({
  type: "email.complained",
  data: { to: ["victim@example.test"], email_id: "msg-1" },
});

function svixHeaders(body: string, opts: { secret?: string; id?: string; timestampMs?: number } = {}) {
  const id = opts.id ?? "msg_2h1YQ";
  const timestamp = Math.floor((opts.timestampMs ?? Date.now()) / 1000).toString();
  const key = (opts.secret ?? SIGNING_SECRET).replace(/^whsec_/, "");
  const signature = createHmac("sha256", Buffer.from(key, "base64"))
    .update(`${id}.${timestamp}.${body}`, "utf8")
    .digest("base64");
  return {
    "svix-id": id,
    "svix-timestamp": timestamp,
    "svix-signature": `v1,${signature}`,
  };
}

async function post(body: string, headers: Record<string, string> = {}) {
  const { POST } = await import("@/app/api/webhooks/email/route");
  return POST(new Request(`https://vantalabsresearch.com/api/webhooks/email?secret=${URL_SECRET}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  }));
}

beforeEach(() => {
  vi.resetModules();
  applied.length = 0;
  process.env.EMAIL_WEBHOOK_SECRET = URL_SECRET;
  delete process.env.RESEND_WEBHOOK_SIGNING_SECRET;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.EMAIL_WEBHOOK_SECRET;
  delete process.env.RESEND_WEBHOOK_SIGNING_SECRET;
});

describe("with a signing secret configured", () => {
  beforeEach(() => { process.env.RESEND_WEBHOOK_SIGNING_SECRET = SIGNING_SECRET; });

  it("accepts a correctly signed delivery", async () => {
    const response = await post(BODY, svixHeaders(BODY));
    expect(response.status).toBe(200);
    expect(applied).toHaveLength(1);
  });

  it("refuses a body that was changed after signing", async () => {
    // The whole point: the URL secret is still perfectly valid here.
    const headers = svixHeaders(BODY);
    const forged = JSON.stringify({
      type: "email.complained",
      data: { to: ["someone-else@example.test"], email_id: "msg-1" },
    });

    const response = await post(forged, headers);

    expect(response.status).toBe(401);
    expect(applied, "nothing was suppressed").toHaveLength(0);
  });

  it("refuses a hand-made request that carries only the URL secret", async () => {
    const response = await post(BODY, {
      "svix-id": "msg_x",
      "svix-timestamp": Math.floor(Date.now() / 1000).toString(),
      "svix-signature": "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    });
    expect(response.status).toBe(401);
    expect(applied).toHaveLength(0);
  });

  it("refuses a signature made with a different secret", async () => {
    const response = await post(BODY, svixHeaders(BODY, { secret: "whsec_b3RoZXItc2VjcmV0LWtleS1ieXRlcy0x" }));
    expect(response.status).toBe(401);
  });

  it("refuses a valid signature replayed hours later, so a captured delivery expires", async () => {
    const stale = Date.now() - 3 * 60 * 60 * 1000;
    const response = await post(BODY, svixHeaders(BODY, { timestampMs: stale }));
    expect(response.status).toBe(401);
  });

  it("accepts one inside the tolerance window", async () => {
    const recent = Date.now() - 60 * 1000;
    const response = await post(BODY, svixHeaders(BODY, { timestampMs: recent }));
    expect(response.status).toBe(200);
  });

  // THE CASE THE WHOLE FIX IS ABOUT. This assertion used to read `toBe(200)`.
  // Anyone holding the URL — from a CDN log, the provider dashboard, or a
  // screenshot — could suppress any customer by simply not sending headers.
  it("refuses a delivery carrying NO signature headers at all", async () => {
    const response = await post(BODY);
    expect(response.status).toBe(401);
    expect(applied, "nothing was suppressed").toHaveLength(0);
  });

  it.each([
    ["svix-id"],
    ["svix-timestamp"],
    ["svix-signature"],
  ])("refuses a delivery missing only %s", async (drop) => {
    const headers: Record<string, string> = { ...svixHeaders(BODY) };
    delete headers[drop];
    const response = await post(BODY, headers);
    expect(response.status).toBe(401);
    expect(applied).toHaveLength(0);
  });

  it("refuses a non-numeric timestamp rather than treating it as now", async () => {
    const response = await post(BODY, { ...svixHeaders(BODY), "svix-timestamp": "not-a-number" });
    expect(response.status).toBe(401);
  });

  // A signature is over BYTES. A malformed body that is correctly signed is a
  // real delivery of something we do not understand, and must be answered 200
  // so the provider stops retrying it — but a malformed body that is NOT
  // signed must never reach the parser at all.
  it("answers 200 to a correctly signed body it does not recognise", async () => {
    const odd = JSON.stringify({ hello: "world" });
    const response = await post(odd, svixHeaders(odd));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ received: 0 });
    expect(applied).toHaveLength(0);
  });

  it("answers 400 to correctly signed bytes that are not JSON", async () => {
    const junk = "not json at all {{{";
    const response = await post(junk, svixHeaders(junk));
    expect(response.status).toBe(400);
    expect(applied).toHaveLength(0);
  });

  it("refuses UNSIGNED malformed bytes before ever parsing them", async () => {
    const response = await post("not json at all {{{");
    expect(response.status).toBe(401);
  });

  // An event for an address that has never existed here is a no-op, not an
  // error: the provider must not be told to retry something that will never
  // become recognisable, and nothing is written for a stranger.
  it("accepts a signed event for an address we have never seen, and does nothing", async () => {
    const body = JSON.stringify({
      type: "email.delivered",
      data: { to: ["nobody-here@example.invalid"], email_id: "msg-unknown" },
    });
    const response = await post(body, svixHeaders(body));
    expect(response.status).toBe(200);
    // It parsed and was handed on; suppression is delivery-events.ts's decision
    // and `email.delivered` suppresses nothing.
    expect(applied).toHaveLength(1);
  });

  // Resend redelivers anything not answered 2xx, so the same event arriving
  // twice is ordinary traffic rather than an attack. Both copies are accepted
  // and neither is refused — the write itself is idempotent at the database
  // (email_delivery_events_once), which delivery-events.test.ts covers.
  it("accepts a legitimate redelivery of the same signed event", async () => {
    const headers = svixHeaders(BODY);
    const first = await post(BODY, headers);
    const second = await post(BODY, headers);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(applied, "both were handed to the idempotent writer").toHaveLength(2);
  });
});

// FAIL CLOSED, BOTH WAYS ROUND. An endpoint that can permanently suppress a
// customer must not be reachable on a half-configured deployment. 503 rather
// than 401 because it is OUR fault and it is retryable: Resend redelivers a
// 5xx, so events arriving during a misconfiguration land once it is fixed.
describe("without a signing secret configured", () => {
  it("refuses everything, even a request with the correct URL secret", async () => {
    const response = await post(BODY);
    expect(response.status).toBe(503);
    expect(applied).toHaveLength(0);
  });

  it("refuses a correctly signed delivery too, because it cannot check it", async () => {
    const response = await post(BODY, svixHeaders(BODY));
    expect(response.status).toBe(503);
  });

  it("still refuses a wrong URL secret", async () => {
    const { POST } = await import("@/app/api/webhooks/email/route");
    const response = await POST(new Request("https://vantalabsresearch.com/api/webhooks/email?secret=wrong", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: BODY,
    }));
    expect(response.status).toBe(401);
  });

  it("still fails closed when no URL secret is configured at all", async () => {
    delete process.env.EMAIL_WEBHOOK_SECRET;
    const response = await post(BODY);
    expect(response.status).toBe(503);
  });
});
