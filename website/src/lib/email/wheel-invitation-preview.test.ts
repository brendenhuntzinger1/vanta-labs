import { mkdirSync, writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { campaignTemplate } from "@/lib/email/templates";
import { SPIN_PRIZES, SPIN_TTL_DAYS } from "@/lib/spin/prize-table";
import { distinctPrizeCount } from "@/lib/spin/disclosure";

// ---------------------------------------------------------------------------
// THE WHEEL INVITATION, RENDERED BY THE CODE THAT WOULD ACTUALLY SEND IT.
//
// Not a mock-up. campaignTemplate() is the same function campaign-sender.ts
// calls per recipient, so what this writes to disk is byte-for-byte what the
// list would receive, minus the per-recipient signature in the click URL.
//
// It doubles as the guard on the one piece of copy that cannot be got wrong:
// the wheel pays out three percentage discounts and free shipping alongside
// twelve product gifts, so the word "gift" would be a false promise to a
// quarter of the people who spin. The owner's rule was explicit — "use 'gift'
// only if every outcome is a product gift" — and the assertions below hold the
// copy to it against the live prize table rather than against a memory of it.
// ---------------------------------------------------------------------------

const OUT_DIR = "/tmp/claude-0/wheel-email";

/** Every outcome that is not a product the customer receives. */
const NON_PRODUCT_KINDS = new Set(["percent", "free_shipping", "free_shipping_percent"]);

export const WHEEL_CAMPAIGN_COPY = {
  name: "Spin the Wheel — first reward",
  subject: "Spin the wheel for your reward",
  previewText: "Spin to reveal your reward. Qualifying purchase required.",
  headline: "A spin. A reward. Yours to reveal.",
  body: [
    "Your first Vanta order could come with something extra. Spin the wheel to reveal your reward, then shop and redeem it with a qualifying order.",
    `Every spin wins. Sixteen wedges, ${distinctPrizeCount()} rewards — free vials, free shipping and a discount or two. One spin per customer, and the result is saved to your account.`,
    `Your reward expires ${SPIN_TTL_DAYS * 24} hours after you spin. Every reward is redeemed against a qualifying order — the exact minimum for the reward you land on is shown before you spin, and again in your cart.`,
  ].join("\n\n"),
  ctaLabel: "Spin now",
  ctaPath: "/spin",
  heroImageUrl: "https://www.vantalabsresearch.com/images/spin-wheel-hero.png",
  heroImageAlt:
    "The Vanta Labs reward wheel: sixteen wedges including free GHK-Cu, KLOW, GLOW, Recon Water, free shipping and percentage discounts.",
};

describe("wheel invitation email", () => {
  const rendered = campaignTemplate({
    subject: WHEEL_CAMPAIGN_COPY.subject,
    previewText: WHEEL_CAMPAIGN_COPY.previewText,
    headline: WHEEL_CAMPAIGN_COPY.headline,
    body: WHEEL_CAMPAIGN_COPY.body,
    promoCode: null,
    ctaLabel: WHEEL_CAMPAIGN_COPY.ctaLabel,
    // The shape buildCampaignClickUrl produces. The real send signs this per
    // recipient; the destination and the query keys are what matter here.
    ctaUrl: "https://www.vantalabsresearch.com/api/email/click?c=CAMPAIGN_ID&e=recipient%40example.com&t=SIGNATURE",
    // Deliberately null: the wheel mints nothing at send time. The whole point
    // is that the reward is unknown until the customer spins, so there is no
    // offer to state terms for — the conditions live in the body copy above,
    // which is why the assertions below check them there.
    offerTerms: null,
    postalAddress: "Vanta Labs Research\n1234 Research Park Dr\nTampa, FL 33601",
    heroImageUrl: WHEEL_CAMPAIGN_COPY.heroImageUrl,
    heroImageAlt: WHEEL_CAMPAIGN_COPY.heroImageAlt,
  });

  it("writes the previews", () => {
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(`${OUT_DIR}/wheel-invitation.html`, rendered.html, "utf8");
    writeFileSync(`${OUT_DIR}/wheel-invitation.txt`, rendered.text, "utf8");
    expect(rendered.html.length).toBeGreaterThan(1000);
  });

  it("never calls the reward a gift, because not every outcome is one", () => {
    const nonProduct = SPIN_PRIZES.filter((prize) => NON_PRODUCT_KINDS.has(prize.reward.kind));
    // If this ever hits zero the wheel became all-product and "gift" is honest
    // again — at which point this test should be changed deliberately, not the
    // copy quietly.
    expect(nonProduct.length).toBeGreaterThan(0);

    const copy = [
      WHEEL_CAMPAIGN_COPY.subject,
      WHEEL_CAMPAIGN_COPY.previewText,
      WHEEL_CAMPAIGN_COPY.headline,
      WHEEL_CAMPAIGN_COPY.body,
      WHEEL_CAMPAIGN_COPY.heroImageAlt,
    ].join(" ").toLowerCase();
    expect(copy).not.toMatch(/\bgifts?\b/);
  });

  it("does not call the reward free in the subject, because three wedges are discounts", () => {
    // The subject is the only line most recipients read, and it cannot carry
    // the body's qualifications. 12 of the 16 wedges are a free vial and one
    // is free shipping, but the other three are a percentage off an order the
    // customer still pays for — "a free reward" over-claims for those, and the
    // word lands hardest in a subject that also says "wheel".
    const discountWedges = SPIN_PRIZES.filter((prize) => prize.reward.kind === "percent");
    expect(discountWedges.length).toBeGreaterThan(0);
    expect(WHEEL_CAMPAIGN_COPY.subject.toLowerCase()).not.toMatch(/\bfree\b/);
  });

  it("states the purchase condition and the deadline in the body", () => {
    expect(WHEEL_CAMPAIGN_COPY.body).toMatch(/qualifying order/i);
    expect(WHEEL_CAMPAIGN_COPY.body).toContain(`${SPIN_TTL_DAYS * 24} hours`);
  });

  it("never promises an unconditional free product", () => {
    // "free vials" is fine beside "redeemed against a qualifying order"; a bare
    // "yours free" with no condition in the same breath is not.
    expect(WHEEL_CAMPAIGN_COPY.body.toLowerCase()).not.toMatch(/free,? no purchase|yours free\b|ships free/);
  });

  it("links the hero and the button to the same tracked click URL", () => {
    // Both taps must reach the recipient's own wheel. The hero is rendered by
    // the image block with link:true, which uses the campaign's ctaUrl.
    const hrefs = [...rendered.html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    const clickLinks = hrefs.filter((href) => href.includes("/api/email/click"));
    expect(clickLinks.length).toBeGreaterThanOrEqual(2);
    expect(new Set(clickLinks).size).toBe(1);
  });

  it("carries the hero image and an accessible text fallback", () => {
    expect(rendered.html).toContain(WHEEL_CAMPAIGN_COPY.heroImageUrl);
    expect(rendered.text).toContain("reward wheel");
  });

  it("sends the click to /spin, which is what mints the personalised link", () => {
    // attachSpinLink only personalises an exact /spin destination.
    expect(WHEEL_CAMPAIGN_COPY.ctaPath).toBe("/spin");
  });
});
