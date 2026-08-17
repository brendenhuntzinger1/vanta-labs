import { beforeAll, describe, expect, it } from "vitest";
import {
  ATTRIBUTION_WINDOW_MS,
  decodeAttributionCookie,
  encodeAttributionCookie,
  isWithinAttributionWindow,
  readCampaignCookie,
  safeCampaignDestination,
  signCampaignRecipient,
  verifyCampaignRecipient,
} from "@/lib/email/campaign-links";

beforeAll(() => {
  process.env.UNSUBSCRIBE_SECRET = "test-secret";
});

// ---------------------------------------------------------------------------
// Two things here can hurt real people rather than just skew a report:
//
//   * an open redirect on a link customers were trained to click in our email,
//   * an unsigned recipient parameter that lets anyone write clicks against an
//     address that never received the campaign.
//
// Everything else in this file is arithmetic about an attribution window.
// ---------------------------------------------------------------------------

describe("the redirect can never leave this site", () => {
  it("keeps an ordinary path", () => {
    expect(safeCampaignDestination("/products")).toMatch(/\/products$/);
    expect(safeCampaignDestination("/products/bpc-157")).toMatch(/\/products\/bpc-157$/);
  });

  it("refuses a protocol-relative path, which a naive check lets through", () => {
    // "//evil.com" starts with "/" and is treated by browsers as an absolute
    // URL to another host. This is THE case a startsWith("/") test misses.
    const destination = safeCampaignDestination("//evil.com");
    expect(destination).not.toContain("evil.com");
    expect(destination).toMatch(/\/products$/);
  });

  it("refuses absolute URLs", () => {
    for (const hostile of ["https://evil.com", "http://evil.com", "javascript:alert(1)", "data:text/html,x"]) {
      expect(safeCampaignDestination(hostile)).not.toContain("evil.com");
      expect(safeCampaignDestination(hostile)).toMatch(/\/products$/);
    }
  });

  it("strips control characters before they reach a Location header", () => {
    // CR/LF in a redirect target is response-splitting.
    const destination = safeCampaignDestination("/products\r\nSet-Cookie: admin=1");
    expect(destination).not.toContain("\r");
    expect(destination).not.toContain("\n");
  });

  it("falls back for empty or missing input rather than producing a bare origin", () => {
    expect(safeCampaignDestination(null)).toMatch(/\/products$/);
    expect(safeCampaignDestination("")).toMatch(/\/products$/);
  });
});

describe("recipient signatures", () => {
  it("verifies a signature it produced", () => {
    const token = signCampaignRecipient("camp-1", "Person@Example.com");
    expect(verifyCampaignRecipient("camp-1", "person@example.com", token)).toBe(true);
  });

  it("is bound to BOTH the campaign and the address", () => {
    const token = signCampaignRecipient("camp-1", "person@example.com");
    // Reusing another campaign's token would let one campaign's link record
    // clicks against another.
    expect(verifyCampaignRecipient("camp-2", "person@example.com", token)).toBe(false);
    expect(verifyCampaignRecipient("camp-1", "someone-else@example.com", token)).toBe(false);
  });

  it("rejects a forged or truncated token without throwing", () => {
    expect(verifyCampaignRecipient("camp-1", "person@example.com", "")).toBe(false);
    expect(verifyCampaignRecipient("camp-1", "person@example.com", "deadbeef")).toBe(false);
  });
});

describe("attribution window", () => {
  const now = Date.UTC(2026, 7, 17, 12, 0, 0);

  it("accepts a click inside the window and rejects one past it", () => {
    expect(isWithinAttributionWindow(now - 1000, now)).toBe(true);
    expect(isWithinAttributionWindow(now - ATTRIBUTION_WINDOW_MS + 1000, now)).toBe(true);
    expect(isWithinAttributionWindow(now - ATTRIBUTION_WINDOW_MS - 1000, now)).toBe(false);
  });

  it("rejects a click stamped in the future", () => {
    // A clock-skewed or hand-edited cookie shouldn't buy extra credit.
    expect(isWithinAttributionWindow(now + 60_000, now)).toBe(false);
  });

  it("round-trips through the cookie", () => {
    const value = encodeAttributionCookie("camp-1", now - 1000);
    expect(decodeAttributionCookie(value, now)).toEqual({ campaignId: "camp-1", clickedAtMs: now - 1000 });
  });

  it("enforces expiry when decoding, not only via cookie Max-Age", () => {
    // Max-Age is a request to the client; a client is free to ignore it. If
    // expiry were only enforced there, an edited cookie would extend
    // attribution indefinitely.
    const stale = encodeAttributionCookie("camp-1", now - ATTRIBUTION_WINDOW_MS - 1);
    expect(decodeAttributionCookie(stale, now)).toBeNull();
  });

  it("returns null for malformed values instead of guessing", () => {
    for (const bad of [null, undefined, "", "nonsense", "camp-1", ".", "camp-1.notanumber"]) {
      expect(decodeAttributionCookie(bad, now)).toBeNull();
    }
  });

  it("handles a campaign id containing dots", () => {
    // The separator is the LAST dot, so an id with dots still parses.
    const value = encodeAttributionCookie("a.b.c", now - 500);
    expect(decodeAttributionCookie(value, now)).toEqual({ campaignId: "a.b.c", clickedAtMs: now - 500 });
  });
});

describe("reading the cookie off a plain Request", () => {
  it("finds the value among other cookies", () => {
    const request = new Request("https://example.com", {
      headers: { cookie: "other=1; vl_campaign=camp-9.123; another=2" },
    });
    expect(readCampaignCookie(request)).toBe("camp-9.123");
  });

  it("returns null when absent, and is not fooled by a similar name", () => {
    expect(readCampaignCookie(new Request("https://example.com"))).toBeNull();
    const decoy = new Request("https://example.com", { headers: { cookie: "xvl_campaign=nope" } });
    expect(readCampaignCookie(decoy)).toBeNull();
  });
});
