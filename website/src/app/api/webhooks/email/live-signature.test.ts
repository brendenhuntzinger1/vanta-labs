import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "crypto";

// ---------------------------------------------------------------------------
// THE REAL ENDPOINT SECRET, AGAINST THE REAL ROUTE.
//
// signature.test.ts proves the mechanism with a synthetic key. This proves it
// with the key Resend will actually sign with, which is the only thing that
// settles "the code path is ready for the owner to switch on".
//
// OPT-IN, and it carries no secret. Both values come from the environment, so
// nothing sensitive is ever written to this repository:
//
//     RESEND_WEBHOOK_SIGNING_SECRET=whsec_…  \
//     EMAIL_WEBHOOK_SECRET=…                 \
//     npx vitest run src/app/api/webhooks/email/live-signature.test.ts
//
// The signing secret is Resend → Webhooks → the endpoint → Signing Secret. It
// skips loudly rather than passing vacuously when either is absent — the same
// rule the database-backed suites follow.
// ---------------------------------------------------------------------------

const SIGNING = (process.env.RESEND_WEBHOOK_SIGNING_SECRET ?? "").trim();
const URL_SECRET = (process.env.EMAIL_WEBHOOK_SECRET ?? "").trim();
const describeLive = SIGNING && URL_SECRET ? describe : describe.skip;

if (!SIGNING || !URL_SECRET) {
  process.stderr.write(
    "[email-webhook] SKIPPED — set RESEND_WEBHOOK_SIGNING_SECRET and EMAIL_WEBHOOK_SECRET "
    + "to prove the live signature path. See the header of this file.\n",
  );
}

const applied = vi.hoisted(() => [] as unknown[][]);
vi.mock("server-only", () => ({}));
vi.mock("@/lib/email/delivery-events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email/delivery-events")>();
  return {
    ...actual,
    applyDeliveryEvents: async (events: unknown[]) => {
      applied.push(events);
      return { suppressed: 0, ignored: 1, engaged: 0, writeFailed: false };
    },
  };
});

const BODY = JSON.stringify({
  type: "email.delivered",
  data: { to: ["shopper@example.test"], email_id: "live-proof-1" },
});

function sign(body: string, secret: string, opts: { id?: string; timestampMs?: number } = {}) {
  const id = opts.id ?? "msg_live_proof";
  const timestamp = Math.floor((opts.timestampMs ?? Date.now()) / 1000).toString();
  const key = secret.replace(/^whsec_/, "");
  const signature = createHmac("sha256", Buffer.from(key, "base64"))
    .update(`${id}.${timestamp}.${body}`, "utf8")
    .digest("base64");
  return { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": `v1,${signature}` };
}

async function post(body: string, headers: Record<string, string>) {
  const { POST } = await import("@/app/api/webhooks/email/route");
  return POST(new Request(
    `https://www.vantalabsresearch.com/api/webhooks/email?secret=${encodeURIComponent(URL_SECRET)}`,
    { method: "POST", headers: { "content-type": "application/json", ...headers }, body },
  ));
}

beforeEach(() => {
  vi.resetModules();
  applied.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describeLive("the live Resend endpoint secret", () => {
  it("ACCEPTS a delivery signed with it", async () => {
    const response = await post(BODY, sign(BODY, SIGNING));
    expect(response.status).toBe(200);
    expect(applied, "the event reached the handler").toHaveLength(1);
  });

  it("REFUSES the same delivery with one byte of the body changed", async () => {
    // The URL secret is still perfectly valid here — that is the whole point.
    const headers = sign(BODY, SIGNING);
    const tampered = BODY.replace("shopper@example.test", "victim@example.test");

    const response = await post(tampered, headers);

    expect(response.status).toBe(401);
    expect(applied, "nothing reached the suppression path").toHaveLength(0);
  });

  it("REFUSES a signature made with a different key", async () => {
    const wrong = "whsec_" + Buffer.from("not-the-endpoint-secret-bytes").toString("base64");
    const response = await post(BODY, sign(BODY, wrong));
    expect(response.status).toBe(401);
  });

  it("REFUSES a valid signature replayed three hours later", async () => {
    const response = await post(BODY, sign(BODY, SIGNING, { timestampMs: Date.now() - 3 * 3600_000 }));
    expect(response.status).toBe(401);
  });
});
