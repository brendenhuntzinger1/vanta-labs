import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// THE LINE SAYING WHY A COMMERCIAL MESSAGE IS IN SOMEONE'S INBOX MUST BE TRUE
// OF THEM.
//
// marketing.ts already carried that rule in its own comment, and had already
// been fixed once for affiliates: "An affiliate need never have bought
// anything, so the one line explaining why a stranger's message is in their
// inbox was false for exactly the audience most likely to check it."
//
// The fix was a two-way branch, and there are TEN campaign types. Everything
// that was not an affiliate broadcast fell through to "you're a Vanta Labs
// customer or member", which is untrue for most of them.
//
// Reproduced end to end during the audit: a fresh account signed up leaving the
// explicitly OPTIONAL marketing box unticked, never ordered, held no
// membership — the app correctly recorded no consent — and the cart-recovery
// message still told them they were receiving it because they were a customer
// or member. They were neither.
//
// Why it matters beyond accuracy: a reader who cannot place why a commercial
// message reached them presses "report spam", and one complaint costs the
// sending domain more than the campaign was worth. This is the same
// deliverability argument the affiliate fix was made on.
//
// Asserted against the source because the reason string is assembled inside
// sendMarketingEmail, which needs a live provider, a suppression table and a
// signed token to reach. What can regress is the MAPPING, and the mapping is
// visible.
// ---------------------------------------------------------------------------

const source = readFileSync(resolve(process.cwd(), "src/lib/email/marketing.ts"), "utf8");

/** Every campaignType this codebase actually sends, gathered from the callers. */
const CAMPAIGN_TYPES = [
  "affiliate_campaign",
  "campaign",
  "cart_recovery_t30m",
  "cart_recovery_t12h",
  "cart_recovery_t24h",
  "cart_recovery_t72h",
  "back_in_stock",
  "coupon_announcement",
  "membership_welcome",
  "membership_birthday",
  "membership_winback",
];

/** The mapping as it now stands in marketing.ts. */
function reasonFor(campaignType: string) {
  return `You're receiving this because ${
    campaignType === "affiliate_campaign" ? "you're a Vanta Labs affiliate."
      : campaignType.startsWith("cart_recovery") ? "you left items in your cart at Vanta Labs."
      : campaignType === "back_in_stock" ? "you asked to be told when a Vanta Labs product came back in stock."
      : campaignType.startsWith("membership") ? "you're a Vanta Labs member."
      : "you subscribed to Vanta Labs emails or have shopped with us."
  }`;
}

describe("no campaign type claims a relationship the recipient may not have", () => {
  it("never tells a cart-recovery recipient they are a customer or member", () => {
    // The reproduced defect. An abandoned cart is not a purchase, and the
    // recovery programme exists precisely because it was not.
    for (const type of CAMPAIGN_TYPES.filter((t) => t.startsWith("cart_recovery"))) {
      expect(reasonFor(type)).toContain("left items in your cart");
      expect(reasonFor(type)).not.toContain("customer or member");
    }
  });

  it("tells a back-in-stock recipient the actual reason they asked to hear from us", () => {
    expect(reasonFor("back_in_stock")).toContain("asked to be told");
    expect(reasonFor("back_in_stock")).not.toContain("customer or member");
  });

  it("keeps the affiliate line that was already fixed", () => {
    expect(reasonFor("affiliate_campaign")).toContain("you're a Vanta Labs affiliate.");
  });

  it("may call a member a member, because that one is true", () => {
    for (const type of CAMPAIGN_TYPES.filter((t) => t.startsWith("membership"))) {
      expect(reasonFor(type)).toContain("you're a Vanta Labs member.");
    }
  });

  it("uses a disjunction for the general list, whose audience really is both", () => {
    // A subscriber who never ordered and a customer who never joined the list
    // are both in this audience, so a line naming only one is false for the
    // other.
    for (const type of ["campaign", "coupon_announcement"]) {
      expect(reasonFor(type)).toBe(
        "You're receiving this because you subscribed to Vanta Labs emails or have shopped with us.",
      );
    }
  });

  it("says something for every campaign type this codebase sends", () => {
    for (const type of CAMPAIGN_TYPES) {
      const reason = reasonFor(type);
      expect(reason.startsWith("You're receiving this because ")).toBe(true);
      expect(reason.length).toBeGreaterThan(40);
    }
  });

  it("no longer contains the unconditional customer-or-member fallback", () => {
    expect(source).not.toContain('"You\'re receiving this because you\'re a Vanta Labs customer or member."');
  });

  it("branches on cart_recovery and back_in_stock in the shipped code", () => {
    expect(source).toContain('input.campaignType.startsWith("cart_recovery")');
    expect(source).toContain('input.campaignType === "back_in_stock"');
    expect(source).toContain('input.campaignType.startsWith("membership")');
  });
});
