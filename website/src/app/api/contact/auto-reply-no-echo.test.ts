import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// EMAIL-05 — THE CONTACT AUTO-REPLY IS NOT A RELAY.
//
// The auto-reply went to whatever address the poster typed and quoted their
// subject and up to 5,000 characters of message back, from the identity that
// carries receipts and password resets. Anyone could have arbitrary text
// delivered, Vanta-branded, to any inbox — and the resulting spam complaints
// land on the transactional domain.
//
// Driven through the real route and the real template: the owner still gets
// the message; the poster gets the store's own words and nothing of theirs
// but a name held to the shape of a name.
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }) }));
vi.mock("@/lib/admin-control", () => ({
  getBusinessSettings: async () => ({ supportEmail: "support@vanta.test", businessName: "Vanta" }),
}));

const sends: Array<{ to: string; subject: string; html: string; text: string }> = [];
/** Flipped by the SF-5 block below to make the provider refuse the notification. */
let providerUp = true;
vi.mock("@/lib/email/send", () => ({
  sendEmail: async (message: { to: string; subject: string; html: string; text: string }) => {
    if (!providerUp) return { success: false, error: "Resend API error (503): unavailable" };
    sends.push({ to: message.to, subject: message.subject, html: message.html, text: message.text });
    return { success: true };
  },
}));

const HOSTILE_SUBJECT = "URGENT: your account has been suspended";
const HOSTILE_MESSAGE = "Call +1 555 0100 now or visit http://evil.example/login to restore access.";

async function submit(overrides: Record<string, unknown> = {}) {
  const { POST } = await import("@/app/api/contact/route");
  const request = new Request("https://vanta.test/api/contact", {
    method: "POST",
    headers: { "content-type": "application/json", "x-vercel-forwarded-for": "198.51.100.5" },
    body: JSON.stringify({
      firstName: "Ada",
      lastName: "L",
      email: "victim@example.test",
      subject: HOSTILE_SUBJECT,
      message: HOSTILE_MESSAGE,
      startedAt: Date.now() - 10_000,
      ...overrides,
    }),
  });
  return POST(request);
}

beforeEach(() => { sends.length = 0; });

describe("the contact-form auto-reply", () => {
  it("carries none of the submitted subject or message, in HTML or text", async () => {
    const response = await submit();
    expect(response.status).toBe(200);
    expect(sends).toHaveLength(2);

    const autoReply = sends[1];
    expect(autoReply.to).toBe("victim@example.test");
    for (const part of [autoReply.html, autoReply.text, autoReply.subject]) {
      expect(part).not.toContain("suspended");
      expect(part).not.toContain("555 0100");
      expect(part).not.toContain("evil.example");
      expect(part).not.toContain("Your message");
    }
    // The store's own words are still there.
    expect(autoReply.text).toContain("Thanks for reaching out to Vanta Labs");
    expect(autoReply.text).toContain("Hi Ada,");
  });

  it("still delivers the full message to the support inbox", async () => {
    await submit();
    const owner = sends[0];
    expect(owner.to).toBe("support@vanta.test");
    expect(owner.text).toContain(HOSTILE_MESSAGE);
    expect(owner.subject).toContain(HOSTILE_SUBJECT);
  });

  it("holds the greeting name to the shape of a name: a phone number or a URL in it means no name at all", async () => {
    await submit({ firstName: "CALL 555-0100 NOW http://evil.example" });
    const autoReply = sends[1];
    expect(autoReply.text).not.toContain("555");
    expect(autoReply.text).not.toContain("http");
    expect(autoReply.text).not.toContain("evil.example");
    expect(autoReply.text).not.toContain("CALL");
    expect(autoReply.text).toContain("Hi there,");
  });

  it("keeps a real name, trimmed to a name's shape", async () => {
    await submit({ firstName: "Zoë O'Brien-Smith (she/her) !!!" });
    expect(sends[1].text).toContain("Hi Zoë O'Brien-Smith she,");
  });

  it("greets 'there' when nothing name-shaped survives", async () => {
    await submit({ firstName: "1234567890" });
    expect(sends[1].text).toContain("Hi there,");
  });
});

// ---------------------------------------------------------------------------
// SF-5. The support-inbox email was the ONLY sink for a contact-form message.
// When the provider refused it, the form told the customer it failed — honestly
// — and nothing anywhere held what they had written. The message is now
// preserved on the status page (a warning alert carrying the sender and the
// text) before the error is returned.
// ---------------------------------------------------------------------------
const alerts: Array<{ type: string; severity: string; message: string; context?: Record<string, unknown> }> = [];
vi.mock("@/lib/monitoring", () => ({
  recordSystemAlert: async (alert: { type: string; severity: string; message: string; context?: Record<string, unknown> }) => {
    alerts.push(alert);
  },
}));

describe("when the support notification cannot be sent", () => {
  it("preserves the sender and the message in a warning alert, then still reports the failure", async () => {
    alerts.length = 0;
    providerUp = false;
    try {
      const response = await submit({ email: "customer@example.test", orderNumber: "VL-4242" });
      expect(response.status).toBe(500);
      const body = await response.json() as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toContain("couldn't send your message");

      expect(alerts).toHaveLength(1);
      expect(alerts[0].type).toBe("contact_form_undelivered");
      expect(alerts[0].severity).toBe("warning");
      expect(alerts[0].message).toContain("customer@example.test");
      expect(alerts[0].context).toMatchObject({
        from_email: "customer@example.test",
        first_name: "Ada",
        last_name: "L",
        order_number: "VL-4242",
        subject: HOSTILE_SUBJECT,
        message: HOSTILE_MESSAGE,
      });
      // No auto-reply went out for a message the team never received.
      expect(sends).toHaveLength(0);
    } finally {
      providerUp = true;
    }
  });

  it("records nothing when the notification is delivered", async () => {
    alerts.length = 0;
    const response = await submit();
    expect(response.status).toBe(200);
    expect(alerts).toHaveLength(0);
  });
});
