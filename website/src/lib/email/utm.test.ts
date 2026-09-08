import { describe, expect, it } from "vitest";
import { withUtm, utmForCampaign, utmForAutomation, utmForCartRecovery } from "@/lib/email/utm";

const SITE = "https://vantalabsresearch.com";

// The same-origin guard below resolves "ours" from the configured site URL, the
// way safeCampaignDestination already does. getSiteUrl() reads the variable on
// every call, so setting it here is enough — no module-load ordering to worry
// about.
process.env.NEXT_PUBLIC_SITE_URL = SITE;

// ---------------------------------------------------------------------------
// Email revenue was invisible in analytics because every click landed on a bare
// path. GA4 files an untagged visit from a mail client under `direct`, so the
// channel that produced the order got no credit for it — and the in-house
// attribution (which IS correct) disagreed with the analytics dashboard with no
// way to reconcile them.
//
// These tests pin the tagging down at the one place it belongs: on the way OUT
// of the click route, applied to an already-resolved same-origin destination.
// ---------------------------------------------------------------------------

describe("withUtm", () => {
  it("adds the standard three parameters to a bare destination", () => {
    const tagged = withUtm(`${SITE}/products`, {
      source: "email",
      medium: "campaign",
      campaign: "spring-restock",
    });

    const url = new URL(tagged);
    expect(url.searchParams.get("utm_source")).toBe("email");
    expect(url.searchParams.get("utm_medium")).toBe("campaign");
    expect(url.searchParams.get("utm_campaign")).toBe("spring-restock");
  });

  it("keeps the path, existing query and hash intact", () => {
    const tagged = withUtm(`${SITE}/products?sort=price#grid`, {
      source: "email",
      medium: "campaign",
      campaign: "abc",
    });

    const url = new URL(tagged);
    expect(url.pathname).toBe("/products");
    expect(url.searchParams.get("sort")).toBe("price");
    expect(url.hash).toBe("#grid");
  });

  it("carries content and term only when supplied", () => {
    const withContent = new URL(
      withUtm(`${SITE}/products`, {
        source: "email",
        medium: "automation",
        campaign: "winback_30",
        content: "cta-button",
      }),
    );
    expect(withContent.searchParams.get("utm_content")).toBe("cta-button");

    const without = new URL(
      withUtm(`${SITE}/products`, { source: "email", medium: "automation", campaign: "winback_30" }),
    );
    expect(without.searchParams.has("utm_content")).toBe(false);
    expect(without.searchParams.has("utm_term")).toBe(false);
  });

  // THE OPERATOR'S OWN TAGGING WINS. A campaign whose stored cta_path already
  // carries utm_campaign was tagged deliberately — usually to line an email up
  // with a paid campaign already running under that name. Overwriting it would
  // silently split one campaign's reporting across two names.
  it("never overwrites a utm parameter the stored path already carries", () => {
    const tagged = withUtm(`${SITE}/products?utm_campaign=paid-spring&utm_source=newsletter`, {
      source: "email",
      medium: "campaign",
      campaign: "spring-restock",
    });

    const url = new URL(tagged);
    expect(url.searchParams.get("utm_campaign")).toBe("paid-spring");
    expect(url.searchParams.get("utm_source")).toBe("newsletter");
    // The one it did not carry is still filled in.
    expect(url.searchParams.get("utm_medium")).toBe("campaign");
  });

  it("emits each parameter exactly once", () => {
    const tagged = withUtm(`${SITE}/products?utm_source=newsletter`, {
      source: "email",
      medium: "campaign",
      campaign: "abc",
    });
    expect(tagged.match(/utm_source=/g)).toHaveLength(1);
  });

  // DEFENCE IN DEPTH. Destinations reaching this function are already resolved
  // to this origin by safeCampaignDestination, but tagging is not the place to
  // rely on that: a campaign id appended to a third-party URL would leak our
  // internal identifiers into someone else's analytics.
  it("leaves an off-site URL completely untouched", () => {
    const offsite = "https://evil.example.com/landing";
    expect(withUtm(offsite, { source: "email", medium: "campaign", campaign: "abc" })).toBe(offsite);
  });

  it("returns unparseable input untouched rather than throwing", () => {
    expect(withUtm("not a url", { source: "email", medium: "campaign", campaign: "abc" })).toBe("not a url");
    expect(withUtm("", { source: "email", medium: "campaign", campaign: "abc" })).toBe("");
  });

  it("omits a parameter whose value is blank rather than writing an empty one", () => {
    const url = new URL(withUtm(`${SITE}/products`, { source: "email", medium: "campaign", campaign: "  " }));
    expect(url.searchParams.has("utm_campaign")).toBe(false);
    expect(url.searchParams.get("utm_source")).toBe("email");
  });
});

// ---------------------------------------------------------------------------
// The three families each get one builder so the medium strings are written
// once. A typo'd medium does not fail anything at runtime — it just quietly
// splits a channel in two on the analytics side, which is exactly the class of
// bug a constant prevents.
// ---------------------------------------------------------------------------

describe("per-family builders", () => {
  it("tags a campaign with its own id", () => {
    const url = new URL(utmForCampaign(`${SITE}/products`, "camp-123"));
    expect(url.searchParams.get("utm_source")).toBe("email");
    expect(url.searchParams.get("utm_medium")).toBe("campaign");
    expect(url.searchParams.get("utm_campaign")).toBe("camp-123");
  });

  it("tags an automation with its stable key", () => {
    const url = new URL(utmForAutomation(`${SITE}/products`, "winback_30"));
    expect(url.searchParams.get("utm_medium")).toBe("automation");
    expect(url.searchParams.get("utm_campaign")).toBe("winback_30");
  });

  // The stage is the column the sweep already writes (t30m | t12h | t24h |
  // t72h), so the tag reads the same in GA4 as it does in the database — no
  // second numbering scheme to keep in step with the first.
  it("tags cart recovery with its stage so the sends stay distinguishable", () => {
    const url = new URL(utmForCartRecovery(`${SITE}/cart`, "t24h"));
    expect(url.searchParams.get("utm_medium")).toBe("cart_recovery");
    expect(url.searchParams.get("utm_campaign")).toBe("cart_recovery");
    expect(url.searchParams.get("utm_content")).toBe("t24h");
  });

  it("still tags the channel when the stage could not be read", () => {
    const url = new URL(utmForCartRecovery(`${SITE}/cart`, null));
    expect(url.searchParams.get("utm_medium")).toBe("cart_recovery");
    expect(url.searchParams.has("utm_content")).toBe(false);
  });
});
