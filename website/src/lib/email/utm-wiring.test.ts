import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SITE = "https://vantalabsresearch.com";
process.env.NEXT_PUBLIC_SITE_URL = SITE;

const R = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const CAMPAIGN_CLICK = R("src/app/api/email/click/route.ts");
const AUTOMATION_CLICK = R("src/app/api/email/automation-click/route.ts");
const CART_RECOVERY_CLICK = R("src/app/api/email/track/click/route.ts");

// ---------------------------------------------------------------------------
// Tagging is only worth anything if EVERY redirect out of a tracking route
// carries it. A route that resolves its destination correctly and then forgets
// to tag it is indistinguishable, in the analytics, from having no tagging at
// all — so the wiring is asserted at the source level, the same way
// reputation-separation.test.ts asserts which send path a template travels.
// ---------------------------------------------------------------------------

describe("click routes tag the destination they redirect to", () => {
  it("the campaign click route applies campaign tagging", () => {
    expect(CAMPAIGN_CLICK).toContain("utmForCampaign");
  });

  it("the automation click route applies automation tagging", () => {
    expect(AUTOMATION_CLICK).toContain("utmForAutomation");
  });

  it("the cart-recovery click route applies cart-recovery tagging", () => {
    expect(CART_RECOVERY_CLICK).toContain("utmForCartRecovery");
  });

  // The stage is only in the tag if it is actually read back from the row the
  // click belongs to. Selecting only `abandoned_cart_id` would tag every
  // recovery click identically and lose the "which email worked" answer.
  it("the cart-recovery route reads the stage it tags with", () => {
    expect(CART_RECOVERY_CLICK).toMatch(/select\([^)]*stage/);
  });
});

// ---------------------------------------------------------------------------
// THE ORDERING HAZARD, PINNED BEHAVIOURALLY.
//
// destinationForVisitor rewrites a signed-out visitor's gated /account
// destination to /products, and in doing so it sets `url.search = ""`. Tag
// before that runs and every UTM is silently wiped — for exactly the half of
// the list that is guest buyers, which is the half where the reporting gap
// hurts most. The tag must therefore be applied AFTER the visitor swap.
//
// This is a real composition bug, not a hypothetical: the swap's own comment
// says it clears the query string on purpose.
// ---------------------------------------------------------------------------

describe("tagging survives the signed-out visitor swap", () => {
  it("tagging after the swap keeps the parameters", async () => {
    const { destinationForVisitor } = await import("@/lib/email/automation-links");
    const { utmForAutomation } = await import("@/lib/email/utm");

    const landed = destinationForVisitor(`${SITE}/account/orders`, false);
    const tagged = new URL(utmForAutomation(landed, "winback_30"));

    expect(tagged.pathname).toBe("/products");
    expect(tagged.searchParams.get("utm_campaign")).toBe("winback_30");
    expect(tagged.searchParams.get("utm_medium")).toBe("automation");
  });

  it("tagging before the swap would lose them — which is why order matters", async () => {
    const { destinationForVisitor } = await import("@/lib/email/automation-links");
    const { utmForAutomation } = await import("@/lib/email/utm");

    const taggedFirst = utmForAutomation(`${SITE}/account/orders`, "winback_30");
    const thenSwapped = new URL(destinationForVisitor(taggedFirst, false));

    expect(thenSwapped.searchParams.has("utm_campaign")).toBe(false);
  });

  it("a signed-in visitor keeps both the gated destination and the tags", async () => {
    const { destinationForVisitor } = await import("@/lib/email/automation-links");
    const { utmForAutomation } = await import("@/lib/email/utm");

    const landed = destinationForVisitor(`${SITE}/account/orders`, true);
    const tagged = new URL(utmForAutomation(landed, "winback_30"));

    expect(tagged.pathname).toBe("/account/orders");
    expect(tagged.searchParams.get("utm_campaign")).toBe("winback_30");
  });
});
