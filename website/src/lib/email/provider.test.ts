// Proves the email delivery layer works end to end WITHOUT needing live
// credentials: provider selection, the readiness gate, graceful failure when
// unconfigured (callers must never throw), and the real HTTP send path for
// Resend and SendGrid (fetch mocked so we assert the exact request shape and
// the success/error mapping). SMTP's transport is nodemailer and is exercised
// only for its "not configured" guard here.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// "server-only" is a bundler guard that throws when a server module is pulled
// into a client bundle. In the vitest node environment there's no such split,
// so stub it to a no-op (hoisted above the imports below).
vi.mock("server-only", () => ({}));

import { ResendEmailProvider } from "@/lib/email/providers/resend";
import { SendgridEmailProvider } from "@/lib/email/providers/sendgrid";
import { SmtpEmailProvider } from "@/lib/email/providers/smtp";
import { NoopEmailProvider } from "@/lib/email/providers/noop";
import { emailConfigIsReady, type EmailRuntimeConfig } from "@/lib/email/settings";

const MESSAGE = {
  to: "customer@example.com",
  subject: "Your Vanta Labs order",
  html: "<p>Thanks for your order.</p>",
  text: "Thanks for your order.",
  replyTo: "support@vantalabsresearch.com",
};

function baseConfig(overrides: Partial<EmailRuntimeConfig> = {}): EmailRuntimeConfig {
  return {
    enabled: true,
    provider: "resend",
    from: "orders@vantalabsresearch.com",
    smtp: { host: "", port: 587, secure: false, user: "", password: "" },
    resend: { apiKey: "" },
    sendgrid: { apiKey: "" },
    ...overrides,
  };
}

describe("email readiness gate (emailConfigIsReady)", () => {
  it("is not ready when disabled, even with full credentials", () => {
    expect(emailConfigIsReady(baseConfig({ enabled: false, resend: { apiKey: "re_live" } }))).toBe(false);
  });
  it("is not ready without a from address", () => {
    expect(emailConfigIsReady(baseConfig({ from: "", resend: { apiKey: "re_live" } }))).toBe(false);
  });
  it("resend: ready only with an api key", () => {
    expect(emailConfigIsReady(baseConfig({ provider: "resend", resend: { apiKey: "" } }))).toBe(false);
    expect(emailConfigIsReady(baseConfig({ provider: "resend", resend: { apiKey: "re_live" } }))).toBe(true);
  });
  it("sendgrid: ready only with an api key", () => {
    expect(emailConfigIsReady(baseConfig({ provider: "sendgrid", sendgrid: { apiKey: "" } }))).toBe(false);
    expect(emailConfigIsReady(baseConfig({ provider: "sendgrid", sendgrid: { apiKey: "SG.live" } }))).toBe(true);
  });
  it("smtp: ready only with host + user + password", () => {
    expect(emailConfigIsReady(baseConfig({ provider: "smtp", smtp: { host: "smtp.x.com", port: 587, secure: false, user: "u", password: "" } }))).toBe(false);
    expect(emailConfigIsReady(baseConfig({ provider: "smtp", smtp: { host: "smtp.x.com", port: 587, secure: false, user: "u", password: "p" } }))).toBe(true);
  });
});

describe("providers never throw when unconfigured (callers must not fail)", () => {
  it("resend returns a graceful failure with no key", async () => {
    const r = await new ResendEmailProvider({ apiKey: "", from: "" }).send(MESSAGE);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/not configured/i);
  });
  it("sendgrid returns a graceful failure with no key", async () => {
    const r = await new SendgridEmailProvider({ apiKey: "", from: "" }).send(MESSAGE);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/not configured/i);
  });
  it("smtp returns a graceful failure with no host", async () => {
    const r = await new SmtpEmailProvider({ host: "", port: 587, secure: false, user: "", password: "", from: "" }).send(MESSAGE);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/not configured/i);
  });
  it("noop never claims to have sent", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await new NoopEmailProvider().send(MESSAGE);
    expect(r.success).toBe(false);
  });
});

describe("Resend send path (HTTP mocked)", () => {
  const fetchMock = vi.fn();
  beforeEach(() => { vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("posts to the Resend API with auth + correct payload, maps 200 -> success", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => "" });
    const r = await new ResendEmailProvider({ apiKey: "re_live_key", from: "orders@vantalabsresearch.com" }).send(MESSAGE);
    expect(r.success).toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer re_live_key");
    const payload = JSON.parse(init.body);
    expect(payload.from).toBe("orders@vantalabsresearch.com");
    expect(payload.to).toEqual(["customer@example.com"]);
    expect(payload.subject).toBe(MESSAGE.subject);
    expect(payload.html).toBe(MESSAGE.html);
    expect(payload.reply_to).toBe(MESSAGE.replyTo);
  });

  it("maps a non-2xx response to a failure carrying the status", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 422, text: async () => "domain not verified" });
    const r = await new ResendEmailProvider({ apiKey: "re_live_key", from: "orders@vantalabsresearch.com" }).send(MESSAGE);
    expect(r.success).toBe(false);
    expect(r.error).toContain("422");
    expect(r.error).toContain("domain not verified");
  });

  it("maps a network throw to a failure (never rethrows)", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNRESET"));
    const r = await new ResendEmailProvider({ apiKey: "re_live_key", from: "orders@vantalabsresearch.com" }).send(MESSAGE);
    expect(r.success).toBe(false);
    expect(r.error).toContain("ECONNRESET");
  });
});

describe("SendGrid send path (HTTP mocked)", () => {
  const fetchMock = vi.fn();
  beforeEach(() => { vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("posts to the SendGrid API with auth + correct payload, maps 202 -> success", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 202, text: async () => "" });
    const r = await new SendgridEmailProvider({ apiKey: "SG.live_key", from: "orders@vantalabsresearch.com" }).send(MESSAGE);
    expect(r.success).toBe(true);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.sendgrid.com/v3/mail/send");
    expect(init.headers.Authorization).toBe("Bearer SG.live_key");
    const payload = JSON.parse(init.body);
    expect(payload.personalizations[0].to[0].email).toBe("customer@example.com");
    expect(payload.from.email).toBe("orders@vantalabsresearch.com");
    expect(payload.reply_to.email).toBe(MESSAGE.replyTo);
    expect(payload.content).toEqual([
      { type: "text/plain", value: MESSAGE.text },
      { type: "text/html", value: MESSAGE.html },
    ]);
  });

  it("uses the admin-configured key (not just env) — the previously-broken path", async () => {
    // Guard against a regression: before the fix SendgridEmailProvider ignored
    // its config and read only process.env, so a key pasted into the admin
    // dashboard silently failed. With env deliberately empty, the config key
    // must still be used.
    const prev = process.env.SENDGRID_API_KEY;
    delete process.env.SENDGRID_API_KEY;
    fetchMock.mockResolvedValue({ ok: true, status: 202, text: async () => "" });
    const r = await new SendgridEmailProvider({ apiKey: "SG.dashboard_key", from: "orders@vantalabsresearch.com" }).send(MESSAGE);
    expect(r.success).toBe(true);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer SG.dashboard_key");
    if (prev !== undefined) process.env.SENDGRID_API_KEY = prev;
  });
});

describe("getEmailProvider selects the right backend from runtime config", () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.doUnmock("@/lib/email/settings"); });

  async function providerFor(config: EmailRuntimeConfig) {
    vi.doMock("@/lib/email/settings", () => ({
      getEmailRuntimeConfig: async () => config,
    }));
    const { getEmailProvider } = await import("@/lib/email/provider");
    return getEmailProvider();
  }

  // Note: vi.resetModules() loads a fresh copy of the provider classes on each
  // dynamic import, so `toBeInstanceOf` (which compares class identity) would
  // fail against the statically-imported classes above. Compare by class name.
  it("returns the no-op provider when email is disabled", async () => {
    const p = await providerFor(baseConfig({ enabled: false }));
    expect(p.constructor.name).toBe("NoopEmailProvider");
  });
  it("returns Resend when configured for resend", async () => {
    const p = await providerFor(baseConfig({ provider: "resend", resend: { apiKey: "re_live" } }));
    expect(p.constructor.name).toBe("ResendEmailProvider");
  });
  it("returns SendGrid when configured for sendgrid", async () => {
    const p = await providerFor(baseConfig({ provider: "sendgrid", sendgrid: { apiKey: "SG.live" } }));
    expect(p.constructor.name).toBe("SendgridEmailProvider");
  });
  it("returns SMTP when configured for smtp", async () => {
    const p = await providerFor(baseConfig({ provider: "smtp", smtp: { host: "smtp.x.com", port: 587, secure: false, user: "u", password: "p" } }));
    expect(p.constructor.name).toBe("SmtpEmailProvider");
  });
});
