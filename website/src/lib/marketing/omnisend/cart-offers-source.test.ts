import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The store-minted recovery offer for Omnisend's abandoned-cart flow.
 *
 * This sweep mints money — a percentage code and a physical gift — for
 * carts Omnisend owns, and it must do so under exactly the rules the
 * in-house ladder mints under: the same band planner, the same per-address
 * cooldowns, the same shippable-gift test, the same offer helper, once per
 * cart. It mails nothing. None of that can run against a database here, so
 * the properties are pinned in source, the way the reconcile's are; the
 * decisions themselves are pure and tested in cart-plan.test.ts.
 */
const SOURCE = readFileSync(join(process.cwd(), "src/lib/marketing/omnisend/cart-offers.ts"), "utf8");

/** Source with comments removed: documenting the rule is not applying it. */
function executable(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
}

const offers = executable(SOURCE);
const mint = offers.slice(offers.indexOf("export async function mintOmnisendCartOffers("));

describe("cart-offers.ts is server-only and mails nothing", () => {
  it("imports server-only on its first line", () => {
    expect(SOURCE.split("\n")[0]).toBe('import "server-only";');
  });

  it("never imports a mail sender", () => {
    expect(offers).not.toContain("@/lib/email/marketing");
    expect(offers).not.toContain("sendMarketingEmail");
    expect(offers).not.toContain("@/lib/email/templates");
  });
});

describe("the gate comes before any database read", () => {
  it("asks the environment gate, then the ownership switch, and returns skipped before the first await", () => {
    const gate = mint.indexOf("const active = omnisendActive();");
    const owner = mint.indexOf("if (!omnisendOwnsMarketing()) return");
    const firstAwait = mint.indexOf("await ");
    expect(gate).toBeGreaterThan(-1);
    expect(owner).toBeGreaterThan(gate);
    expect(firstAwait).toBeGreaterThan(owner);
    expect(mint).toContain("if (!active.active) return { ...empty(), skipped: active.reason };");
    expect(mint).toContain('skipped: "in-house ladder owns marketing"');
  });
});

describe("which carts are considered", () => {
  it("reads open carts by the shared status vocabulary, inside the offer window, and lets the pure rule decide", () => {
    expect(mint).toContain('.in("status", CART_STATUS_OPEN)');
    expect(mint).toContain("CART_OFFER_MAX_AGE_MS");
    expect(mint).toContain("cartOfferQualifies({");
    expect(mint).toContain("inHouseStages:");
    expect(mint).toContain("paidOrders: context.paidOrders.get(email) ?? []");
  });

  it("reads the in-house stages itself and fails CLOSED, so an unreadable claim table plans nothing", () => {
    const stages = offers.slice(offers.indexOf("async function inHouseStagesFor("), offers.indexOf("export async function mintOmnisendCartOffers("));
    expect(stages).toMatch(/from\("abandoned_cart_emails"\)\s*\.select\("abandoned_cart_id"\)\s*\.in\("abandoned_cart_id", cartIds\)/);
    expect(stages).toMatch(/if \(error\) \{[\s\S]*?return null;/);
    expect(mint).toContain("if (stagesByCart === null) return");
  });

  it("takes the per-address facts from the in-house sweep's own loader", () => {
    expect(offers).toMatch(/import \{[^}]*loadRecoveryContext[^}]*\} from "@\/lib\/cart-recovery";/);
    expect(offers).toMatch(/import \{[^}]*lastGiftForOtherCarts[^}]*\} from "@\/lib\/cart-recovery";/);
    expect(mint).toContain("await loadRecoveryContext(");
  });
});

describe("the plan is the in-house planner's, at stage four", () => {
  it("calls planStageOffer with the band configuration and the same context the ladder passes", () => {
    const plan = mint.slice(mint.indexOf("const plan = planStageOffer({"), mint.indexOf("});", mint.indexOf("const plan = planStageOffer({")));
    expect(plan).toContain('stage: "t72h"');
    expect(plan).toContain("cartValueCents:");
    expect(plan).toContain("lastPaidAt: context.paidOrders.get(email)?.[0]?.at ?? null");
    expect(plan).toContain("lastRecoveryCouponAt: context.lastRecoveryCouponAt.get(email) ?? null");
    expect(plan).toContain("lastRecoveryGiftAt: lastGiftForOtherCarts(context.recoveryGifts.get(email), cartId)");
    expect(plan).toContain("discountPercent: config.discountPercent");
    expect(plan).toContain("tiers,");
    expect(plan).toContain("now,");
    expect(mint).toContain("const tiers = config.tiers ?? DEFAULT_RECOVERY_TIERS;");
  });

  it("applies the ladder's own shippable-gift test and drops the gift when nothing in it can ship", () => {
    expect(offers).toMatch(/import \{[^}]*unshippableGiftSlugsFor[^}]*\} from "@\/lib\/cart-recovery";/);
    expect(mint).toContain("unshippableGiftSlugsFor(giftSlugs),");
    expect(mint).toContain("const gifts = plan.gifts.filter((item) => !unshippable.has(item.slug));");
    expect(mint).toContain("if (gifts.length > 0)");
  });
});

describe("the code and the gift are minted by the shared helpers, behind a once-per-cart claim", () => {
  it("claims the cart first, records the outcome, and releases on a thrown error", () => {
    const claim = mint.indexOf('await ledger.claimSend("recovery offer", `${cartId}:recovery offer`)');
    const plan = mint.indexOf("const plan = planStageOffer({");
    const record = mint.indexOf('await ledger.recordSend("recovery offer", `${cartId}:recovery offer`, accepted');
    const release = mint.indexOf('await ledger.releaseSend("recovery offer");');
    expect(claim).toBeGreaterThan(-1);
    expect(plan).toBeGreaterThan(claim);
    expect(record).toBeGreaterThan(plan);
    expect(release).toBeGreaterThan(record);
    expect(mint).toContain("const ledger = omnisendLedger(cartId);");
  });

  it("mints the recovery code at the band's percentage only when the plan carries one", () => {
    expect(mint).toContain("if (plan.coupon && plan.percent > 0) {");
    expect(mint).toContain('await ensureContactCode("recovery", email, { percent: plan.percent })');
  });

  it("issues the gift through the same helper the ladder's stages use, under the recovery gift key", () => {
    expect(offers).toMatch(/import \{[^}]*issueResolvedOffer[^}]*\} from "@\/lib\/offers\/customer-offers";/);
    expect(mint).toContain("recoveryGiftConfig(gifts, giftNames, 0, plan.minCartCents)");
    expect(mint).toContain("await issueResolvedOffer({ email, offerKey: RECOVERY_GIFT_OFFER_KEY, config: giftConfig, referenceId: cartId, now })");
    expect(offers).toContain("RECOVERY_GIFT_TTL_DAYS");
  });

  it("builds the claim link the in-house email builds — the tracker with the offer token — behind the contact's signed door", () => {
    expect(mint).toContain("const claimPath = `/api/email/track/click?url=${encodeURIComponent(restoreUrl(cartId))}&o=${encodeURIComponent(issued.token)}`;");
    expect(mint).toContain('link: await contactLinkFor(email, "abandoned-cart")(claimPath)');
    expect(mint).toContain("text: describeRecoveryGift(gifts, giftNames)");
    expect(mint).toContain("minCartCents: plan.minCartCents");
    expect(mint).toContain("endsAt: issued.expiresAt");
  });

  it("pushes the contact with the link, the live codes and the gift", () => {
    expect(mint).toContain("await upsertOmnisendContact(email, { link, codes, recoveryGift })");
  });

  it("sends the catch-up cart event exactly once, only for a cart Omnisend has never heard of", () => {
    expect(mint).toContain('name: "added product to cart"');
    expect(mint).toContain("debounceMs: null");
    expect(mint).toContain('campaign: "abandoned-cart"');
  });
});

describe("nothing here logs an address, a token or a code", () => {
  it("prefixes every log line and keeps identities out of it", () => {
    expect(offers).toContain('const LOG = "[omnisend/cart-offers]";');
    for (const call of offers.match(/console\.(log|error|warn)\((.|\n)*?\);/g) ?? []) {
      expect(call).toMatch(/^console\.(log|error|warn)\(LOG,/);
      expect(call).not.toMatch(/\b(email|address|phone|token|code|codes|key|link|issued)\b/);
    }
  });

  it("never throws: the whole run is caught and reported as skipped", () => {
    expect(mint).toMatch(/\} catch \(error\) \{\s*console\.error\(LOG, "sweep failed", error\);\s*return \{ \.\.\.result, skipped: "sweep failed" \};/);
  });
});
