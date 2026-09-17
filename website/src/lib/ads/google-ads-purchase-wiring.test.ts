import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Where the Google Ads purchase conversion sits in the page, asserted against
 * the source because none of it shows up in a unit test of either module.
 *
 * Two invariants, and they pull in opposite directions:
 *
 * 1. It must ride the SAME server-confirmed paid gate as the other four
 *    platforms. There is exactly one place on the confirmation page that
 *    decides a purchase happened, and a fifth network must not add a second
 *    opinion about it — least of all one that could report a conversion for an
 *    order the backend never marked paid.
 *
 * 2. It must NOT sit behind the cookie banner, unlike TikTok, Snap and Reddit.
 *    The Google tag is installed ungated by a documented decision (see
 *    google-ads-tag.tsx) with Consent Mode doing the privacy work instead: every
 *    storage signal starts denied, so a declining visitor's conversion goes out
 *    as a cookieless ping with no identifier. Moving this call below the consent
 *    return would silently drop every conversion from a visitor who declined,
 *    while the tag that page loads carries on reporting their page views — the
 *    worst of both, and invisible in the ad account.
 */

const ROUTE = readFileSync(
  join(process.cwd(), "src/app/api/ads/purchase-event/[orderId]/route.ts"),
  "utf8",
);
const COMPONENT = readFileSync(join(process.cwd(), "src/components/tiktok-purchase-event.tsx"), "utf8");

describe("the conversion is built from the one paid gate", () => {
  it("is built by the route, not decided in the browser", () => {
    expect(ROUTE).toMatch(/buildGoogleAdsPurchase\(paidOrder\)/);
  });

  it("is returned to the page alongside the other platforms' events", () => {
    expect(ROUTE).toMatch(/googleAdsPurchase/);
    const body = ROUTE.slice(ROUTE.lastIndexOf("return NextResponse.json("));
    expect(body).toMatch(/googleAdsPurchase/);
  });

  it("is reported by the inspect branch too, so a test order can be read back", () => {
    // ?inspect=1 answers "what would this order report?" without reporting it.
    // A platform missing from that answer is one nobody can check before a real
    // sale depends on it.
    const inspect = ROUTE.slice(ROUTE.indexOf("if (inspect)"), ROUTE.indexOf("let serverDelivery"));
    expect(inspect).toMatch(/googleAdsPurchase/);
  });

  it("makes no server-side send and claims no ledger row for Google", () => {
    // Reporting to Google from the server is the Google Ads API — OAuth, a
    // developer token, a gclid-keyed upload — not a call that belongs beside
    // these. A claim without a send would be a permanent row blocking a
    // conversion that never happened.
    expect(ROUTE).not.toMatch(/claimSend\("google/);
    expect(ROUTE).not.toMatch(/recordSend\("google/);
  });
});

describe("the browser leg fires for every purchaser, not only those who accepted", () => {
  it("emits through the shared helper rather than a hand-rolled gtag call", () => {
    expect(COMPONENT).toMatch(/emitGoogleAdsConversion\(/);
  });

  it("fires BEFORE the consent return, exactly like Meta", () => {
    const googleAt = COMPONENT.indexOf("emitGoogleAdsConversion(");
    const consentReturnAt = COMPONENT.indexOf("if (!consented) return;");
    expect(googleAt).toBeGreaterThan(-1);
    expect(consentReturnAt).toBeGreaterThan(-1);
    expect(
      googleAt,
      "the Google Ads conversion moved behind the cookie banner; Consent Mode is what gates it, not the banner",
    ).toBeLessThan(consentReturnAt);
  });

  it("fires only on the server's paid answer, after the not-paid bail-out", () => {
    const paidBailAt = COMPONENT.indexOf("if (!body?.event) return;");
    expect(paidBailAt).toBeGreaterThan(-1);
    expect(COMPONENT.indexOf("emitGoogleAdsConversion(")).toBeGreaterThan(paidBailAt);
  });

  it("calls gtag optionally, so a blocked or absent tag is a no-op", () => {
    // The tag is not rendered outside production at all, so window.gtag is
    // undefined on every preview deployment and local run.
    expect(COMPONENT).toMatch(/window\.gtag\?\./);
  });
});
