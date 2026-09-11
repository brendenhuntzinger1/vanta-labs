import { describe, expect, it } from "vitest";
import {
  classifyEngagement,
  HUMAN_CLICK_MIN_DELAY_MS,
  HUMAN_OPEN_MIN_DELAY_MS,
  summarizeSendEngagement,
} from "@/lib/email/engagement-classification";

const SENT = Date.parse("2026-09-10T17:45:15.000Z");
const GMAIL_PROXY = "Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)";

describe("classifyEngagement", () => {
  // Measured 2026-09-11 on real recovery sends: opens at 8, 10, 11, 14 and 39
  // seconds after the send, then nothing under five minutes. The fast ones are
  // Apple Mail Privacy Protection and corporate scanners fetching on delivery.
  it("calls an open inside the threshold a prefetch, whatever fetched it", () => {
    const at = SENT + 14_000;
    expect(classifyEngagement({ kind: "opened", at, sentAt: SENT, userAgent: GMAIL_PROXY })).toEqual({ human: false, reason: "too_soon" });
  });

  it("calls a Gmail-proxied open after the threshold human", () => {
    const at = SENT + HUMAN_OPEN_MIN_DELAY_MS + 1;
    expect(classifyEngagement({ kind: "opened", at, sentAt: SENT, userAgent: GMAIL_PROXY })).toEqual({ human: true, reason: "ok" });
  });

  it("calls a click from a known link scanner not human, however late", () => {
    const at = SENT + 3 * 3_600_000;
    expect(classifyEngagement({ kind: "clicked", at, sentAt: SENT, userAgent: "Mozilla/5.0 (compatible; Barracuda Sentinel)" })).toEqual({ human: false, reason: "scanner" });
  });

  it("calls a click inside its own, shorter threshold too soon", () => {
    expect(classifyEngagement({ kind: "clicked", at: SENT + HUMAN_CLICK_MIN_DELAY_MS - 1, sentAt: SENT, userAgent: "Mozilla/5.0 (iPhone)" })).toEqual({ human: false, reason: "too_soon" });
    expect(classifyEngagement({ kind: "clicked", at: SENT + HUMAN_CLICK_MIN_DELAY_MS + 1, sentAt: SENT, userAgent: "Mozilla/5.0 (iPhone)" })).toEqual({ human: true, reason: "ok" });
  });

  it("cannot judge an event whose send time is unknown, and says so rather than guessing human", () => {
    expect(classifyEngagement({ kind: "opened", at: SENT + 999_999, sentAt: null, userAgent: GMAIL_PROXY })).toEqual({ human: false, reason: "unknown_send_time" });
  });

  it("treats a missing user agent as a client, not a scanner", () => {
    expect(classifyEngagement({ kind: "opened", at: SENT + HUMAN_OPEN_MIN_DELAY_MS + 1, sentAt: SENT, userAgent: null })).toEqual({ human: true, reason: "ok" });
  });
});

describe("summarizeSendEngagement", () => {
  it("reports any and human counts per send, first touch only", () => {
    const sends = [
      { key: "cart_recovery_t30m|cart-1", sentAt: SENT },
      { key: "cart_recovery_t30m|cart-2", sentAt: SENT },
    ];
    const events = [
      { key: "cart_recovery_t30m|cart-1", kind: "opened" as const, at: SENT + 8_000, userAgent: GMAIL_PROXY },
      { key: "cart_recovery_t30m|cart-1", kind: "opened" as const, at: SENT + 900_000, userAgent: GMAIL_PROXY },
      { key: "cart_recovery_t30m|cart-1", kind: "clicked" as const, at: SENT + 901_000, userAgent: "Mozilla/5.0 (iPhone)" },
      { key: "cart_recovery_t30m|cart-2", kind: "opened" as const, at: SENT + 10_000, userAgent: "Mozilla/5.0" },
    ];
    const summary = summarizeSendEngagement(sends, events);
    expect(summary.get("cart_recovery_t30m|cart-1")).toEqual({ openedAny: true, openedHuman: true, clickedAny: true, clickedHuman: true });
    expect(summary.get("cart_recovery_t30m|cart-2")).toEqual({ openedAny: true, openedHuman: false, clickedAny: false, clickedHuman: false });
  });

  it("ignores an event for a send it was not given", () => {
    const summary = summarizeSendEngagement([{ key: "a|1", sentAt: SENT }], [{ key: "b|2", kind: "opened", at: SENT + 999_999, userAgent: null }]);
    expect(summary.get("a|1")).toEqual({ openedAny: false, openedHuman: false, clickedAny: false, clickedHuman: false });
    expect(summary.has("b|2")).toBe(false);
  });
});
