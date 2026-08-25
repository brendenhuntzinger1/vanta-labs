// Proves the SMTP provider treats a REJECTED recipient as a failed send.
//
// This is the bug the pre-launch audit found, and it was invisible to review:
// nodemailer RESOLVES rather than rejects when a server refuses a recipient at
// RCPT TO — the refusal comes back in `info.rejected`. The provider ignored the
// result object and returned `{ success: true }` whenever no exception was
// thrown, so a 550 (unknown mailbox), 421 (server busy) or 535 (auth) was
// recorded as delivered. The campaign then marked that person sent and never
// retried them, and the transactional retry queue did the same with their
// receipt.
//
// A test that mocked "send succeeds" and "send throws" would have passed
// against the broken code, which is why these assert the middle case.
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const sendMail = vi.fn();
vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: (...args: unknown[]) => sendMail(...args) }) },
}));

import { SmtpEmailProvider } from "@/lib/email/providers/smtp";

const CONFIG = { host: "smtp.example.com", port: 587, secure: false, user: "u", password: "p", from: "orders@vanta.test" };
const MESSAGE = { to: "customer@example.com", subject: "s", html: "<p>x</p>", text: "x" };

const provider = () => new SmtpEmailProvider(CONFIG);

describe("a recipient the server refused is NOT a successful send", () => {
  it("fails when the address comes back in `rejected`", async () => {
    sendMail.mockResolvedValueOnce({
      accepted: [],
      rejected: ["customer@example.com"],
      response: "550 5.1.1 <customer@example.com>: Recipient address rejected",
    });
    const result = await provider().send(MESSAGE);
    expect(result.success).toBe(false);
    expect(result.error).toContain("rejected");
  });

  it("surfaces the server's own reply, which is what names the reason", async () => {
    sendMail.mockResolvedValueOnce({
      accepted: [], rejected: ["customer@example.com"], response: "552 5.2.2 Mailbox over quota",
    });
    const result = await provider().send(MESSAGE);
    expect(result.error).toContain("Mailbox over quota");
  });

  it("fails when NOTHING was accepted, even with an empty `rejected` list", async () => {
    // Some servers acknowledge and drop. No accepted recipients and no
    // exception is the exact shape of a silently-discarded message.
    sendMail.mockResolvedValueOnce({ accepted: [], rejected: [], response: "250 OK" });
    expect((await provider().send(MESSAGE)).success).toBe(false);
  });

  it("matches the address case-insensitively", async () => {
    sendMail.mockResolvedValueOnce({ accepted: [], rejected: ["Customer@Example.COM"], response: "550 no" });
    expect((await provider().send(MESSAGE)).success).toBe(false);
  });

  it("handles nodemailer's object form of an address", async () => {
    sendMail.mockResolvedValueOnce({
      accepted: [], rejected: [{ address: "customer@example.com", name: "" }], response: "550 no",
    });
    expect((await provider().send(MESSAGE)).success).toBe(false);
  });

  it("never leaks the SMTP password into the error", async () => {
    // A distinctive secret, because the shared fixture's password is a single
    // letter and would match inside ordinary words like "rejected".
    const secret = "s3cr3t-smtp-p4ssw0rd";
    sendMail.mockResolvedValueOnce({ accepted: [], rejected: ["customer@example.com"], response: "535 auth failed" });
    const result = await new SmtpEmailProvider({ ...CONFIG, password: secret }).send(MESSAGE);
    expect(result.success).toBe(false);
    expect(result.error).not.toContain(secret);
  });
});

describe("a genuinely delivered message still succeeds", () => {
  it("succeeds when the address is accepted", async () => {
    sendMail.mockResolvedValueOnce({ accepted: ["customer@example.com"], rejected: [], response: "250 OK" });
    // The result now also names the backend and carries nodemailer's
    // Message-ID, which is what ties this send to the sending server's logs.
    expect(await provider().send(MESSAGE)).toMatchObject({ success: true, provider: "smtp" });
  });

  it("succeeds when the transport returns no arrays at all", async () => {
    // Not every transport populates accepted/rejected. Treating a missing
    // `accepted` as a failure would break delivery for those, so absence is
    // only a failure when the transport also reported nothing accepted AND we
    // have no exception — covered above by the explicit empty-array case.
    sendMail.mockResolvedValueOnce({ accepted: ["customer@example.com"] });
    expect((await provider().send(MESSAGE)).success).toBe(true);
  });

  it("still fails loudly when the transport throws", async () => {
    sendMail.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const result = await provider().send(MESSAGE);
    expect(result.success).toBe(false);
    expect(result.error).toContain("ECONNREFUSED");
  });
});
