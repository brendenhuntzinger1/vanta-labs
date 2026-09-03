import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// VL-13 / E-01 — CAN-SPAM's physical postal address on EVERY commercial email.
//
// campaignTemplate rendered one and the campaign sender refuses to send without
// one. Nothing else did — so the cart-recovery sequence, four emails and the
// highest-volume promotional mail this store sends, went out with an
// unsubscribe link and no postal address, and so did birthday, win-back, launch
// and back-in-stock. An opt-out is not a substitute: 15 U.S.C. § 7704 requires
// both.
//
// The address is applied by the marketing WRAPPER rather than by each template,
// so a template written tomorrow is compliant without its author knowing the
// rule — and so this can be tested once, here, for all of them.
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));

const POSTAL = "Vanta Labs LLC, 1209 Orange St, Wilmington, DE 19801";

const sent: Array<{ html: string; text: string }> = [];
vi.mock("@/lib/email/send", () => ({
  sendEmail: async (message: { html: string; text: string }) => {
    sent.push({ html: message.html, text: message.text });
    return { success: true, provider: "resend" };
  },
}));

vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }),
      insert: async () => ({ error: null }),
    }),
  },
}));

vi.mock("@/lib/env", () => ({ getSiteUrl: () => "https://vantalabsresearch.com" }));
vi.mock("@/lib/email/unsubscribe", () => ({ generateUnsubscribeToken: () => "tok" }));

const config = { value: { marketingPostalAddress: POSTAL, from: "orders@x.com", marketingFrom: "" } };
vi.mock("@/lib/email/settings", () => ({
  getEmailRuntimeConfig: async () => config.value,
  resolveMarketingFrom: () => "news@x.com",
  // Send-only marketing subdomain, replies routed to a real mailbox. Distinct
  // from resolveMarketingFrom on purpose: see marketing-reply-path.test.ts.
  resolveMarketingReplyTo: () => "orders@x.com",
}));

beforeEach(() => {
  sent.length = 0;
  config.value = { marketingPostalAddress: POSTAL, from: "orders@x.com", marketingFrom: "" };
});

async function sendCartRecovery() {
  const { sendMarketingEmail } = await import("@/lib/email/marketing");
  const { cartRecoveryT30mTemplate } = await import("@/lib/email/templates");
  const template = cartRecoveryT30mTemplate({
    name: "Ben",
    items: [{ name: "Test peptide", quantity: 1 }],
    cartValueCents: 9900,
    restoreUrl: "https://vantalabsresearch.com/cart?restore=abc",
  });
  await sendMarketingEmail({ to: "shopper@example.com", campaignType: "cart_recovery_t30m", templateKey: "cartRecoveryT30mTemplate", ...template });
  return sent[0];
}

describe("the marketing wrapper carries the CAN-SPAM postal address", () => {
  it("puts the address in a cart-recovery email — HTML and plain text alike", async () => {
    const message = await sendCartRecovery();
    expect(message.html).toContain("Wilmington, DE 19801");
    expect(message.text).toContain(POSTAL);
  });

  it("keeps the unsubscribe link — the address is an addition, not a replacement", async () => {
    const message = await sendCartRecovery();
    expect(message.html).toContain("/api/unsubscribe?email=");
    expect(message.text).toContain("Unsubscribe: https://");
  });

  it("does not print the address twice when the template already renders one", async () => {
    const { sendMarketingEmail } = await import("@/lib/email/marketing");
    const { campaignTemplate } = await import("@/lib/email/templates");
    const template = campaignTemplate({
      subject: "s", headline: "h", body: "b", ctaLabel: "Shop", ctaUrl: "https://x.test", postalAddress: POSTAL,
    });
    await sendMarketingEmail({ to: "shopper@example.com", campaignType: "campaign", templateKey: "campaignTemplate", ...template });

    const occurrences = sent[0].html.split("Wilmington, DE 19801").length - 1;
    expect(occurrences).toBe(1);
  });

  it("sends unchanged when no address is configured — this must not become a hidden send blocker", async () => {
    // Campaign sending is already gated on a configured address; cart recovery
    // is not, and quietly dropping recovery mail here would be a worse failure
    // than the one being fixed. The admin settings hint is the fix for a blank.
    config.value = { ...config.value, marketingPostalAddress: "" };
    const message = await sendCartRecovery();
    expect(message.html).toContain("/api/unsubscribe?email=");
  });
});

// ---------------------------------------------------------------------------
// THE WRAPPER'S OWN FOOTER WAS THE LAST THING HANGING OFF THE LEFT EDGE.
//
// renderLayout centres the message in a 520px card inset 32px from its border,
// and on 2026-09-02 the CTA was brought into that inset with everything else.
// This block is appended by the marketing wrapper AFTER the layout has closed —
// injected before </body>, outside the table — so the unsubscribe line, the
// CAN-SPAM postal address and the tracking pixel rendered flush against the
// left edge of the window, full width, under a neatly centred card.
//
// It is the legally required part of a commercial message. It should not look
// like it fell out of the template.
// ---------------------------------------------------------------------------

describe("the appended compliance footer sits inside the layout", () => {
  it("is centred and width-limited like the card above it", async () => {
    const { html } = await sendCartRecovery();
    const appended = html.slice(html.indexOf("You're receiving this"));
    // Walk back to the container the footer was injected into.
    const container = html.slice(0, html.indexOf("You're receiving this"));
    const lastTable = container.lastIndexOf("<table");
    expect(lastTable, "the footer is not inside any table").toBeGreaterThan(-1);
    const opening = container.slice(lastTable, container.indexOf(">", lastTable));
    expect(opening + appended).toContain("max-width:520px");
  });
});
