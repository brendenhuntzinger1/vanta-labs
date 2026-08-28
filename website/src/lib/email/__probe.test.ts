import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const sent: Array<{ html: string; text: string }> = [];
vi.mock("@/lib/email/send", () => ({
  sendEmail: async (m: { html: string; text: string }) => { sent.push({ html: m.html, text: m.text }); return { success: true, provider: "resend" }; },
}));
vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }), insert: async () => ({ error: null }) }) },
}));
vi.mock("@/lib/env", () => ({ getSiteUrl: () => "https://vantalabsresearch.com" }));
vi.mock("@/lib/email/unsubscribe", () => ({ generateUnsubscribeToken: () => "tok" }));
const config = { value: { marketingPostalAddress: "", from: "o@x.com", marketingFrom: "" } };
vi.mock("@/lib/email/settings", () => ({
  getEmailRuntimeConfig: async () => config.value,
  resolveMarketingFrom: () => "news@x.com",
}));

beforeEach(() => { sent.length = 0; });

async function run(addr: string) {
  config.value = { ...config.value, marketingPostalAddress: addr };
  const { sendMarketingEmail } = await import("@/lib/email/marketing");
  const { campaignTemplate } = await import("@/lib/email/templates");
  const t = campaignTemplate({ subject: "s", headline: "h", body: "b", ctaLabel: "Shop", ctaUrl: "https://x.test", postalAddress: addr });
  await sendMarketingEmail({ to: "a@b.com", campaignType: "campaign", templateKey: "campaignTemplate", ...t });
  return sent[sent.length - 1];
}

function countHtml(html: string, addr: string) {
  const esc = addr.trim().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/\n/g, "<br/>");
  return html.split(esc).length - 1;
}
function countText(text: string, addr: string) { return text.split(addr.trim()).length - 1; }

const CASES: Record<string, string> = {
  plain: "Vanta Labs LLC, 1209 Orange St, Wilmington, DE 19801",
  multiline_LF: "Vanta Labs LLC\n1209 Orange St\nWilmington, DE 19801",
  multiline_CRLF: "Vanta Labs LLC\r\n1209 Orange St\r\nWilmington, DE 19801",
  trailing_ws: "Vanta Labs LLC, 1209 Orange St  \n",
  leading_ws: "\n  Vanta Labs LLC, 1209 Orange St",
  ampersand: "Smith & Sons LLC, 1 Main St",
  angle: "Vanta <Labs> LLC, 1 Main St",
  quote: 'Vanta "Labs" LLC, 1 Main St',
  entity: "Smith &amp; Sons, 1 Main St",
};

describe("probe", () => {
  for (const [name, addr] of Object.entries(CASES)) {
    it(name, async () => {
      const m = await run(addr);
      const fs = await import("node:fs");
      fs.appendFileSync("/tmp/probe.txt", `${name} HTML=${countHtml(m.html, addr)} TEXT=${countText(m.text, addr)} tail=${JSON.stringify(m.text.slice(-160))}\n`);
    });
  }
});
