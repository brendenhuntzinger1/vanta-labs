import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NoopEmailProvider } from "@/lib/email/providers/noop";

// ---------------------------------------------------------------------------
// WHAT A CAPTURED MESSAGE HAS TO CARRY.
//
// The capture file is how a harness reads what a customer would read. It began
// with the body, which answered "is the confirmation link in there" — the
// question that started it. It did not answer the other one: whether a
// commercial send carried List-Unsubscribe, and a receipt did not.
//
// That separation is the whole of the 2026-08-29 deliverability incident, and
// it was unobservable from a captured file: a marketing send with the header
// missing and a receipt with it wrongly present captured identically.
// ---------------------------------------------------------------------------

const captured = (dir: string) =>
  readFileSync(join(dir, "captured-emails.jsonl"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the harness capture file", () => {
  it("records the one-click unsubscribe headers a marketing send carries", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vanta-capture-"));
    vi.stubEnv("EMAIL_CAPTURE_DIR", dir);

    await new NoopEmailProvider().send({
      to: "shopper@example.test",
      subject: "20% off this week",
      html: "<p>hi</p>",
      text: "hi",
      headers: {
        "List-Unsubscribe": "<https://vantalabsresearch.com/unsubscribe?t=abc>",
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });

    const [row] = captured(dir);
    expect(row.headers).toMatchObject({
      "List-Unsubscribe": "<https://vantalabsresearch.com/unsubscribe?t=abc>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
  });

  it("shows a receipt carrying none, which is what makes the two distinguishable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vanta-capture-"));
    vi.stubEnv("EMAIL_CAPTURE_DIR", dir);

    await new NoopEmailProvider().send({
      to: "shopper@example.test",
      subject: "Order Confirmed - VL-1234",
      html: "<p>thanks</p>",
      text: "thanks",
    });

    const [row] = captured(dir);
    expect(row.headers).toEqual({});
  });

  it("still records the body, which is what the capture was built for", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vanta-capture-"));
    vi.stubEnv("EMAIL_CAPTURE_DIR", dir);

    await new NoopEmailProvider().send({
      to: "shopper@example.test",
      subject: "Confirm your Vanta Labs account",
      html: '<a href="https://vantalabsresearch.com/auth/confirm?token=t">Confirm</a>',
      text: "Confirm: https://vantalabsresearch.com/auth/confirm?token=t",
    });

    const [row] = captured(dir);
    expect(String(row.html)).toContain("/auth/confirm?token=t");
    expect(row.to).toBe("shopper@example.test");
  });

  it("writes nothing at all when no capture directory is configured", async () => {
    // The guard that keeps a file of reset links off a production disk.
    vi.stubEnv("EMAIL_CAPTURE_DIR", "");
    const result = await new NoopEmailProvider().send({
      to: "shopper@example.test", subject: "s", html: "h", text: "t",
    });
    expect(result.success).toBe(false);
  });
});
