import { describe, expect, it, vi } from "vitest";

// Hoisted above the imports: several describe bodies below mint a link at
// module scope, which happens before any beforeAll would have run.
vi.hoisted(() => {
  process.env.UNSUBSCRIBE_SECRET = "test-secret-not-a-real-one";
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ getSiteUrl: () => "https://www.vantalabsresearch.com" }));

import {
  AUTOMATION_COOKIE,
  buildAutomationClickUrl,
  buildAutomationOpenUrl,
  decodeAutomationCookie,
  destinationForVisitor,
  encodeAutomationCookie,
  readAutomationCookie,
  safeAutomationDestination,
  signAutomationLink,
  verifyAutomationLink,
} from "@/lib/email/automation-links";
import { signCampaignRecipient } from "@/lib/email/campaign-links";
import { normalizeSitePathInput } from "@/lib/email/cta-path";

const SITE = "https://www.vantalabsresearch.com";

// ---------------------------------------------------------------------------
// AUTOMATIONS WERE THE ONE PART OF THE EMAIL SYSTEM NOBODY COULD MEASURE.
//
// All four retention sequences are enabled and mailing customers. They linked
// straight to their destination, so there was no click count, no conversion and
// no revenue figure for any of them — the only unattended part of the system
// was also the only unobservable one.
//
// This file pins the tracker that fixes that, and in particular the three
// properties that are easy to get subtly wrong and impossible to notice in
// production: the token namespace, the per-send binding, and the rule that the
// destination never comes from the URL.
// ---------------------------------------------------------------------------

describe("automation link signatures", () => {
  it("verifies a link it minted", () => {
    const token = signAutomationLink("winback_30", "buyer@example.test", "buyer@example.test:1700000000000");
    expect(verifyAutomationLink("winback_30", "buyer@example.test", "buyer@example.test:1700000000000", token)).toBe(true);
  });

  it("is case-insensitive about the address, the way every caller lowercases it", () => {
    const token = signAutomationLink("winback_30", "Buyer@Example.test", "ref-1");
    expect(verifyAutomationLink("winback_30", "buyer@example.test", "ref-1", token)).toBe(true);
  });

  it.each([
    ["another automation", "winback_60", "buyer@example.test", "ref-1"],
    ["another recipient", "winback_30", "someone-else@example.test", "ref-1"],
    ["another send of the same automation", "winback_30", "buyer@example.test", "ref-2"],
  ])("refuses a token minted for %s", (_name, key, email, reference) => {
    const token = signAutomationLink("winback_30", "buyer@example.test", "ref-1");
    expect(verifyAutomationLink(key, email, reference, token)).toBe(false);
  });

  it("cannot be crossed with a campaign token", () => {
    // THE `automation:` PREFIX EARNS ITS PLACE HERE. Both schemes HMAC with the
    // same secret. Without a namespace, `${id}:${email}` is the same payload on
    // both surfaces, so a campaign whose uuid equalled an automation key would
    // mint tokens that verified as automation clicks and vice versa.
    const campaignToken = signCampaignRecipient("winback_30", "buyer@example.test");
    expect(verifyAutomationLink("winback_30", "buyer@example.test", "", campaignToken)).toBe(false);
  });

  it.each([
    ["empty", ""],
    ["truncated", "abc"],
    ["wrong length", "0".repeat(31)],
    ["right length, wrong value", "0".repeat(32)],
  ])("refuses a %s token without throwing", (_name, token) => {
    expect(verifyAutomationLink("winback_30", "buyer@example.test", "ref-1", token)).toBe(false);
  });
});

describe("the reference is what makes each send its own cohort", () => {
  it("gives a customer won back twice two different links", () => {
    // A win-back reference is `${email}:${lastOrderAt}`, so a customer who
    // returns, buys and lapses again starts a new episode with its own key. If
    // the signature ignored the reference, one link would verify forever and
    // every win-back that person ever received would collapse into one bucket.
    const first = buildAutomationClickUrl("winback_30", "buyer@example.test", "buyer@example.test:1700000000000");
    const second = buildAutomationClickUrl("winback_30", "buyer@example.test", "buyer@example.test:1800000000000");
    expect(first).not.toEqual(second);
  });
});

describe("the tracked URLs point at our own routes", () => {
  const click = buildAutomationClickUrl("post_purchase", "buyer@example.test", "VL-1001");
  const open = buildAutomationOpenUrl("post_purchase", "buyer@example.test", "VL-1001");

  it("builds a click URL carrying key, address, reference and signature", () => {
    const url = new URL(click);
    expect(url.origin).toBe(SITE);
    expect(url.pathname).toBe("/api/email/automation-click");
    expect(url.searchParams.get("k")).toBe("post_purchase");
    expect(url.searchParams.get("e")).toBe("buyer@example.test");
    expect(url.searchParams.get("r")).toBe("VL-1001");
    expect(url.searchParams.get("t")).toHaveLength(32);
  });

  it("builds an open pixel URL on the same scheme", () => {
    const url = new URL(open);
    expect(url.pathname).toBe("/api/email/automation-open");
    expect(url.searchParams.get("t")).toBe(new URL(click).searchParams.get("t"));
  });

  it("carries NO destination, so there is nothing to redirect-inject", () => {
    // The whole security property of a tracking redirect in one assertion: the
    // link says who and which, never where. The destination is read from the
    // automation row on the way out.
    for (const param of ["url", "u", "to", "redirect", "next", "d"]) {
      expect(new URL(click).searchParams.get(param)).toBeNull();
    }
  });
});

describe("the destination can never leave this site", () => {
  it.each([
    ["protocol-relative", "//evil.com"],
    ["backslash authority", "/\\evil.com"],
    ["mixed slash authority", "/\\/evil.com"],
    ["absolute off-site", "https://evil.com/pwned"],
    ["bare word", "evil.com"],
    ["blank", ""],
    ["null", null],
  ])("sends %s to the catalog instead", (_name, path) => {
    expect(safeAutomationDestination(path)).toBe(`${SITE}/products`);
  });

  it("passes a real site path through", () => {
    expect(safeAutomationDestination("/products/bpc-157")).toBe(`${SITE}/products/bpc-157`);
  });
});

describe("a guest is never sent from an email into a login wall", () => {
  // The reorder reminder's button points at /account/orders. Two of the four
  // buyers on the marketing list have no account, so the click landed them on
  // the login page with nothing to do. The gift cookie was already armed by
  // then, so the fix is only the landing page: a signed-out visitor bound for
  // a gated account page goes to the catalogue instead. Nothing about
  // authentication changes — the account pages still require a session.
  it("sends a signed-out visitor bound for the account area to the catalogue", () => {
    expect(destinationForVisitor(`${SITE}/account/orders`, false)).toBe(`${SITE}/products`);
    expect(destinationForVisitor(`${SITE}/account`, false)).toBe(`${SITE}/products`);
    expect(destinationForVisitor(`${SITE}/account/rewards?tab=points`, false)).toBe(`${SITE}/products`);
  });

  it("keeps the account destination for a signed-in customer", () => {
    expect(destinationForVisitor(`${SITE}/account/orders`, true)).toBe(`${SITE}/account/orders`);
  });

  it("leaves the public account pages alone, signed in or not", () => {
    for (const path of ["/account/login", "/account/forgot-password", "/account/reset-password"]) {
      expect(destinationForVisitor(`${SITE}${path}`, false)).toBe(`${SITE}${path}`);
    }
  });

  it("does not touch destinations outside the account area", () => {
    expect(destinationForVisitor(`${SITE}/products/bpc-157`, false)).toBe(`${SITE}/products/bpc-157`);
    expect(destinationForVisitor(`${SITE}/accounting-faq`, false)).toBe(`${SITE}/accounting-faq`);
  });

  it("falls back to the destination it was given when it cannot parse it", () => {
    expect(destinationForVisitor("not a url", false)).toBe("not a url");
  });
});

describe("the attribution cookie", () => {
  const NOW = 1_800_000_000_000;

  it("round-trips a key and a timestamp", () => {
    const value = encodeAutomationCookie("winback_60", NOW);
    expect(decodeAutomationCookie(value, NOW + 1000)).toEqual({ automationKey: "winback_60", clickedAtMs: NOW });
  });

  it("expires after the seven-day window", () => {
    const value = encodeAutomationCookie("winback_60", NOW);
    const eightDays = NOW + 8 * 24 * 60 * 60 * 1000;
    expect(decodeAutomationCookie(value, eightDays)).toBeNull();
  });

  it("refuses a future click, which is a hand-edited cookie", () => {
    const value = encodeAutomationCookie("winback_60", NOW + 60_000);
    expect(decodeAutomationCookie(value, NOW)).toBeNull();
  });

  it.each([
    ["absent", null],
    ["empty", ""],
    ["no separator", "winback_60"],
    ["no timestamp", "winback_60."],
    ["non-numeric timestamp", "winback_60.tomorrow"],
    ["leading separator", ".123"],
  ])("returns null for a %s cookie", (_name, value) => {
    expect(decodeAutomationCookie(value, NOW)).toBeNull();
  });

  it("reads its own cookie off a request and ignores the campaign one", () => {
    // Separate cookies, because an order can genuinely follow both a campaign
    // click and an automation click and neither should overwrite the other.
    const request = new Request("https://example.test", {
      headers: { cookie: `vl_campaign=some-uuid.123; ${AUTOMATION_COOKIE}=winback_30.456; other=x` },
    });
    expect(readAutomationCookie(request)).toBe("winback_30.456");
  });

  it("returns null when only the campaign cookie is present", () => {
    const request = new Request("https://example.test", { headers: { cookie: "vl_campaign=some-uuid.123" } });
    expect(readAutomationCookie(request)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// WHAT AN OPERATOR IS ALLOWED TO TYPE INTO THE DESTINATION BOX.
//
// The admin used to accept a bare path only, so pasting the address out of the
// browser — the obvious thing to do — was refused for naming the same page.
// Widening that must not widen what can be STORED, which is the point of every
// case below.
// ---------------------------------------------------------------------------

describe("normalizeSitePathInput", () => {
  it("keeps a plain site path", () => {
    expect(normalizeSitePathInput("/products", SITE)).toBe("/products");
  });

  it("folds a full same-origin URL down to its path", () => {
    expect(normalizeSitePathInput(`${SITE}/products?sort=new#top`, SITE)).toBe("/products?sort=new#top");
  });

  it("treats blank as a deliberate 'no button', not an error", () => {
    expect(normalizeSitePathInput("", SITE)).toBe("");
    expect(normalizeSitePathInput("   ", SITE)).toBe("");
    expect(normalizeSitePathInput(null, SITE)).toBe("");
  });

  it.each([
    ["off-site https", "https://evil.com/pwned"],
    ["off-site host on a lookalike path", "https://evil.com/products"],
    ["protocol-relative", "//evil.com"],
    ["backslash authority", "/\\evil.com"],
    ["javascript", "javascript:alert(1)"],
    ["data uri", "data:text/html,hi"],
    ["bare word", "products"],
    ["carriage return", "/products\r\nLocation: https://evil.com"],
  ])("refuses %s", (_name, value) => {
    expect(normalizeSitePathInput(value, SITE)).toBeNull();
  });

  it("refuses a same-path URL on a different port, which is a different origin", () => {
    expect(normalizeSitePathInput("https://www.vantalabsresearch.com:8443/products", SITE)).toBeNull();
  });
});
