import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// I-03. Three public POST endpoints derive their rate-limit key from the
// LEFTMOST token of `x-forwarded-for`. The same codebase already states, in
// admin-auth.ts:60-71, that this token is attacker-controlled:
//
//   "x-forwarded-for is only a last resort -- a client can PREPEND spoofed
//    entries to it, so its leftmost token is attacker-controlled and must
//    never be the primary lockout key."
//
// Both cannot be right. This suite pins the behaviour that follows from the
// codebase's own stated rule: when the hosting proxy has supplied a trusted
// header, a client-supplied x-forwarded-for must not be able to move the
// bucket. If the bucket moves, the limit is not a limit.
//
// What each accepted submission costs:
//   contact    2 outbound emails (team notification + auto-reply to an
//              attacker-supplied address -- a mail reflection vector)
//   wholesale  1 outbound email
//   back-in-stock  1 row insert
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));

const buckets: string[] = [];

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: async (bucket: string) => {
    buckets.push(bucket);
    return { allowed: true, retryAfterSeconds: 0 };
  },
}));

vi.mock("@/lib/admin-control", () => ({
  getBusinessSettings: async () => ({ supportEmail: "support@vanta.test", businessName: "Vanta" }),
}));

vi.mock("@/lib/email/send", () => ({ sendEmail: async () => ({ success: true }) }));

vi.mock("@/lib/email/templates", () => ({
  contactFormNotificationTemplate: () => ({ subject: "s", html: "h", text: "t" }),
  contactFormAutoReplyTemplate: () => ({ subject: "s", html: "h", text: "t" }),
  wholesaleInquiryNotificationTemplate: () => ({ subject: "s", html: "h", text: "t" }),
}));

vi.mock("@/lib/back-in-stock", () => ({
  requestBackInStock: async () => ({ ok: true }),
}));

/** A request as it arrives at the function behind a proxy that set the trusted header. */
function proxied(url: string, body: unknown, forgedForwardedFor: string) {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // What the edge itself sets. The client cannot overwrite these.
      "x-vercel-forwarded-for": "198.51.100.20",
      "x-real-ip": "198.51.100.20",
      // What the client prepended.
      "x-forwarded-for": `${forgedForwardedFor}, 198.51.100.20`,
    },
    body: JSON.stringify(body),
  });
}

const contactBody = {
  firstName: "Ada", lastName: "Lovelace", email: "ada@example.test",
  subject: "Question", message: "Hello there", startedAt: 0,
};

const wholesaleBody = {
  firstName: "Ada", lastName: "Lovelace", email: "ada@example.test",
  message: "Bulk enquiry", startedAt: 0,
};

beforeEach(() => {
  buckets.length = 0;
});

describe("I-03 — a forged x-forwarded-for must not move the rate-limit bucket", () => {
  it("contact: same real client, ten forged headers, one bucket", async () => {
    const { POST } = await import("@/app/api/contact/route");
    for (let i = 0; i < 10; i += 1) {
      await POST(proxied("https://vanta.test/api/contact", contactBody, `203.0.113.${i}`));
    }

    expect(buckets).toHaveLength(10);
    expect(new Set(buckets).size).toBe(1);
    // And the one bucket is keyed on the IP the proxy vouched for.
    expect(buckets[0]).toBe("contact:198.51.100.20");
  });

  it("wholesale: same real client, ten forged headers, one bucket", async () => {
    const { POST } = await import("@/app/api/wholesale/route");
    for (let i = 0; i < 10; i += 1) {
      await POST(proxied("https://vanta.test/api/wholesale", wholesaleBody, `203.0.113.${i}`));
    }

    expect(new Set(buckets).size).toBe(1);
    expect(buckets[0]).toBe("wholesale:198.51.100.20");
  });

  it("back-in-stock: same real client, ten forged headers, one bucket", async () => {
    const { POST } = await import("@/app/api/catalog/back-in-stock/route");
    for (let i = 0; i < 10; i += 1) {
      await POST(proxied("https://vanta.test/api/catalog/back-in-stock",
        { productSlug: "selank", email: "ada@example.test" }, `203.0.113.${i}`));
    }

    expect(new Set(buckets).size).toBe(1);
    expect(buckets[0]).toBe("back-in-stock:198.51.100.20");
  });

  it("two genuinely different clients still get two buckets", async () => {
    // The limit must still SEPARATE real clients -- a fix that keys everyone
    // into one bucket would pass the tests above and break the site.
    const { POST } = await import("@/app/api/contact/route");
    for (const ip of ["198.51.100.20", "198.51.100.77"]) {
      await POST(new Request("https://vanta.test/api/contact", {
        method: "POST",
        headers: { "content-type": "application/json", "x-vercel-forwarded-for": ip },
        body: JSON.stringify(contactBody),
      }));
    }

    expect(new Set(buckets).size).toBe(2);
  });

  it("falls back to x-forwarded-for when no trusted header exists at all", async () => {
    // Local dev and any host that does not set x-real-ip. Something is better
    // than keying every visitor into one shared bucket.
    const { POST } = await import("@/app/api/contact/route");
    await POST(new Request("https://vanta.test/api/contact", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9, 10.0.0.1" },
      body: JSON.stringify(contactBody),
    }));

    expect(buckets[0]).toBe("contact:203.0.113.9");
  });
});
