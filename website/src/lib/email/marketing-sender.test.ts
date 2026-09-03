import { describe, expect, it } from "vitest";
import { resolveMarketingFrom, type EmailRuntimeConfig } from "@/lib/email/settings";

// ---------------------------------------------------------------------------
// Sending reputation is per-domain, and the two kinds of mail have opposite
// risk profiles: a campaign can draw spam complaints, a receipt must arrive.
// Sent from one domain, the first quietly degrades the second — and the failure
// is invisible from our side, because a receipt in someone's spam folder looks
// exactly like a receipt that was delivered.
//
// So the rule is: marketing may have its own From, and when it does not, it
// falls back to the transactional one. The fallback is what makes this change
// safe to ship without configuring anything — behaviour is unchanged until an
// operator sets up a subdomain.
// ---------------------------------------------------------------------------

const config = (overrides: Partial<EmailRuntimeConfig> = {}): EmailRuntimeConfig => ({
  enabled: true,
  provider: "smtp",
  from: "Vanta Labs <orders@vantalabsresearch.com>",
  smtp: { host: "smtp.x", port: 587, secure: false, user: "u", password: "p" },
  resend: { apiKey: "" },
  sendgrid: { apiKey: "" },
  marketingPostalAddress: "",
  marketingFrom: "",
  marketingReplyTo: "",
  ...overrides,
});

describe("resolveMarketingFrom", () => {
  it("falls back to the transactional From when unset — the shipped default", () => {
    expect(resolveMarketingFrom(config())).toBe("Vanta Labs <orders@vantalabsresearch.com>");
  });

  it("uses the dedicated address once configured", () => {
    const from = resolveMarketingFrom(config({ marketingFrom: "Vanta Labs <news@mail.vantalabsresearch.com>" }));
    expect(from).toBe("Vanta Labs <news@mail.vantalabsresearch.com>");
  });

  it("treats a whitespace-only value as unset rather than sending from nowhere", () => {
    // An operator clearing the field leaves "   " behind more often than "".
    expect(resolveMarketingFrom(config({ marketingFrom: "   " }))).toBe(config().from);
  });

  it("never returns an empty string while a transactional From exists", () => {
    for (const marketingFrom of ["", " ", "\n", "\t"]) {
      expect(resolveMarketingFrom(config({ marketingFrom }))).toBe(config().from);
    }
  });

  it("does not invent an address when neither is set", () => {
    // Nothing can be sent in this state anyway — the readiness gate already
    // refuses a config with no From — but this must not fabricate one.
    expect(resolveMarketingFrom(config({ from: "", marketingFrom: "" }))).toBe("");
  });

  it("keeps the two identities independent", () => {
    const resolved = resolveMarketingFrom(config({
      from: "receipts@vantalabsresearch.com",
      marketingFrom: "news@mail.vantalabsresearch.com",
    }));
    expect(resolved).toBe("news@mail.vantalabsresearch.com");
    expect(resolved).not.toBe("receipts@vantalabsresearch.com");
  });
});
