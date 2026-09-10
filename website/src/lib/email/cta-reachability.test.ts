import { describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// A SAVED DESTINATION THE RECIPIENT CANNOT REACH IS REFUSED AT THE BOUNDARY.
//
// The store is account-only by default. An email grant opens the catalogue and
// the checkout, and deliberately NOT order history or any other account
// surface — a forwarded email must never hand a stranger somebody's addresses
// and order totals. That boundary is correct and is not what this file
// changes.
//
// What was wrong is that nothing on the WRITE path asked the question.
// `ctaPathReachesStore` existed, was tested, and was wired to nothing, so
// `/account/orders` could be — and was — stored on two live retention
// automations. `post_purchase` and `replenishment` between them produced 0
// clicks on 75 sends, and `replenishment` carried a real paid incentive (free
// shipping + 10%) into a sign-in page. Nothing in the admin said why, because
// from the admin's side the send succeeded and the click was even recorded.
//
// Origin-safety and reachability are different questions, and passing the
// first is what made the second look answered. /account/orders is perfectly
// same-origin. These tests hold both halves apart.
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));

process.env.NEXT_PUBLIC_SITE_URL ??= "https://www.vantalabsresearch.com";
process.env.UNSUBSCRIBE_SECRET ??= "test-secret-for-cta-reachability";

async function validate() {
  const { validateCampaignInput } = await import("@/lib/admin-email");
  return validateCampaignInput;
}

const base = {
  name: "Test",
  subject: "Test subject",
  headline: "Test headline",
  body: "Test body",
  segment: "all",
};

describe("campaign and automation destinations must be reachable from an email", () => {
  it("refuses /account/orders — the exact path that stranded two live automations", async () => {
    const validateCampaignInput = await validate();
    const result = validateCampaignInput({ ...base, ctaLabel: "VIEW MY ORDER", ctaPath: "/account/orders" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The message must name the page and offer somewhere that works —
      // an operator who is refused without an alternative just tries again.
      expect(result.error).toContain("/account/orders");
      expect(result.error).toContain("/products");
    }
  });

  it.each([
    ["/account", "the account root"],
    ["/account/settings", "any account surface"],
    ["/admin", "an admin surface"],
  ])("refuses %s (%s)", async (path) => {
    const validateCampaignInput = await validate();
    expect(validateCampaignInput({ ...base, ctaLabel: "GO", ctaPath: path }).ok).toBe(false);
  });

  it.each(["/products", "/research", "/products/bpc-157-10mg", "/cart", "/"])(
    "accepts %s, which a grant does open",
    async (path) => {
      const validateCampaignInput = await validate();
      expect(validateCampaignInput({ ...base, ctaLabel: "SHOP", ctaPath: path }).ok).toBe(true);
    },
  );

  it("still accepts a reachable path carrying a query string", async () => {
    const validateCampaignInput = await validate();
    expect(validateCampaignInput({ ...base, ctaLabel: "SHOP", ctaPath: "/products?sort=new" }).ok).toBe(true);
  });

  // ORIGIN-SAFETY AND REACHABILITY ARE DIFFERENT QUESTIONS. Keeping this case
  // means a future refactor cannot satisfy the reachability check by loosening
  // the origin check underneath it.
  it("still refuses an off-site destination", async () => {
    const validateCampaignInput = await validate();
    expect(validateCampaignInput({ ...base, ctaLabel: "GO", ctaPath: "https://evil.example.com/x" }).ok).toBe(false);
  });
});
