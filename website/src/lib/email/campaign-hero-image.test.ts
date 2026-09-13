import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { campaignTemplate } from "@/lib/email/templates";

// ---------------------------------------------------------------------------
// One optional hero image above the headline, and nothing else changed.
//
// The campaign composer had no way to send artwork: campaignTemplate took
// subject/headline/body/cta and no image, and `body` is escaped on the way out
// — "body copy is text, never markup" — because it is the highest-blast-radius
// input in the admin. That escaping is not relaxed here. The hero arrives as
// its own field and renders through the block system's existing image block,
// which already decides what a usable URL is and already produces the
// plain-text twin.
//
// The first block below is the one that matters most: a campaign with no hero
// must render EXACTLY what it rendered before this field existed. Every send
// already in flight is a no-hero campaign.
// ---------------------------------------------------------------------------

const BASE = {
  subject: "Last day for Buy 2 Get 1 Free",
  previewText: "Ends tonight at 11:59pm Eastern",
  headline: "Last day for Buy 2 Get 1 Free",
  body: "Add three items to your cart and the cheapest comes off at checkout.\n\nShipping is free on every order.",
  ctaLabel: "Shop the sale",
  ctaUrl: "https://www.vantalabsresearch.com/api/email/click?c=abc",
  postalAddress: "Vanta Labs, 123 Example St, Suite 4, Denver CO 80202",
};

const HERO = "https://www.vantalabsresearch.com/images/b2g1-hero.png";
const ALT = "Buy 2 Get 1 Free plus free shipping. Ends Monday 11:59pm ET.";

const withHero = (over: Record<string, unknown> = {}) =>
  campaignTemplate({ ...BASE, heroImageUrl: HERO, heroImageAlt: ALT, ...over });

describe("a campaign with no hero image renders exactly as it did before", () => {
  const before = campaignTemplate(BASE);

  it.each([
    ["the field absent entirely", {}],
    ["an explicit null url", { heroImageUrl: null }],
    ["an empty url", { heroImageUrl: "" }],
    ["whitespace, with an alt set", { heroImageUrl: "   ", heroImageAlt: "ignored" }],
    ["an alt with no url at all", { heroImageAlt: "ignored" }],
  ])("is byte for byte identical with %s", (_label, over) => {
    const after = campaignTemplate({ ...BASE, ...over });
    expect(after.html).toBe(before.html);
    expect(after.text).toBe(before.text);
    expect(after.subject).toBe(before.subject);
  });

  it("emits no image tag", () => {
    expect(before.html).not.toContain("<img");
  });
});

describe("a campaign with a hero image", () => {
  it("renders exactly one image, pointing at the hero", () => {
    const { html } = withHero();
    expect(html.match(/<img/g)).toHaveLength(1);
    expect(html).toContain(HERO);
  });

  it("places the hero ABOVE the headline", () => {
    const { html } = withHero();
    expect(html.indexOf("<img")).toBeLessThan(html.indexOf(BASE.headline));
  });

  it("preserves the alt text", () => {
    expect(withHero().html).toContain(`alt="${ALT}"`);
  });

  it("escapes an alt that tries to break out of the attribute", () => {
    const { html } = withHero({ heroImageAlt: `" onerror="alert(1)` });
    expect(html).not.toContain(`onerror="alert(1)"`);
    expect(html).toContain("&quot;");
  });

  it("leaves the body, the button and the postal address untouched", () => {
    const { html } = withHero();
    expect(html).toContain("the cheapest comes off at checkout");
    expect(html).toContain(BASE.ctaUrl);
    expect(html).toContain("Denver CO 80202");
  });

  it("changes nothing but the hero row", () => {
    // The whole point of an additive field: strip the row it adds and the
    // document must collapse back onto the no-hero render.
    const plain = campaignTemplate(BASE).html;
    const hero = withHero().html;
    expect(hero.replace(/\n\s*<tr><td[^>]*>\s*<img[\s\S]*?<\/td><\/tr>/, "")).toBe(plain);
  });
});

describe("the plain-text twin stays clean", () => {
  it("carries the alt text and no markup", () => {
    const { text } = withHero();
    expect(text).toContain(ALT);
    expect(text).not.toContain("<img");
    expect(text).not.toContain("src=");
    expect(text).not.toContain(HERO);
  });

  it("is unchanged from the no-hero twin when the alt is empty", () => {
    // An image with no alt says nothing to a text reader, so it must not leave
    // a blank gap behind in the text part.
    expect(withHero({ heroImageAlt: "" }).text).toBe(campaignTemplate(BASE).text);
  });
});

describe("an unusable hero URL fails safely rather than half-rendering", () => {
  it.each([
    ["a javascript: url", "javascript:alert(1)"],
    ["a data: url", "data:text/html;base64,PHNjcmlwdD4="],
    ["a site-relative path", "/images/b2g1-hero.png"],
    ["a protocol-relative url", "//evil.example/x.png"],
    ["a bare hostname", "evil.example/x.png"],
  ])("drops the hero for %s and renders the rest intact", (_label, url) => {
    const { html, text } = campaignTemplate({ ...BASE, heroImageUrl: url, heroImageAlt: ALT });
    expect(html).not.toContain("<img");
    expect(html).toBe(campaignTemplate(BASE).html);
    expect(text).toBe(campaignTemplate(BASE).text);
  });
});

// ---------------------------------------------------------------------------
// Every path that renders a campaign has to read the same two columns, or the
// preview shows artwork the send does not carry — which is the failure an
// operator cannot see until after it has gone out.
// ---------------------------------------------------------------------------

const SRC = (rel: string) => readFileSync(path.resolve(__dirname, "..", "..", rel), "utf8");

describe("every render path carries the hero", () => {
  it.each([
    ["the scheduled sender", "lib/email/campaign-sender.ts"],
    ["the manual send route", "app/api/admin/email/campaigns/[campaignId]/send/route.ts"],
    ["the preview route", "app/api/admin/email/campaigns/preview/route.ts"],
  ])("%s passes heroImageUrl into the template", (_label, rel) => {
    expect(SRC(rel)).toContain("heroImageUrl");
  });

  it.each([
    ["the scheduled sender", "lib/email/campaign-sender.ts"],
    ["the manual send route", "app/api/admin/email/campaigns/[campaignId]/send/route.ts"],
  ])("%s selects the columns it needs to pass them", (_label, rel) => {
    expect(SRC(rel)).toContain("hero_image_url");
  });

  it("persists the columns when a campaign is created or edited", () => {
    expect(SRC("lib/admin-email.ts")).toContain("heroImageUrl");
  });
});
