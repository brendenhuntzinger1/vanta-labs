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
// With RESEND_WEBHOOK_SIGNING_SECRET set, a Resend delivery must now carry a
// valid Svix signature over its own body, inside a five-minute window. Unsigned
// deliveries still pass, because SendGrid sends none and this endpoint serves
// both — which is exactly why the URL secret stays as well.
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

  it("still accepts an UNSIGNED delivery, because SendGrid sends none", async () => {
    const response = await post(BODY);
    expect(response.status).toBe(200);
    expect(applied).toHaveLength(1);
  });
});

describe("without a signing secret configured", () => {
  it("behaves exactly as before: the URL secret alone is accepted", async () => {
    const response = await post(BODY);
    expect(response.status).toBe(200);
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
