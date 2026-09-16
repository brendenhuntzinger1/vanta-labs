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
const CART_RECOVERY = readFileSync(join(process.cwd(), "src/lib/cart-recovery.ts"), "utf8");

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

  // ONE RECOVERY CODE PER ADDRESS PER 30 DAYS, WHICHEVER LADDER MINTS IT. The
  // parity claim above is only true if the shared loader can SEE this sweep's
  // codes: it read coupons by source "cart_recovery" alone, so an address
  // minted a VLCART code by this sweep could be minted a SAVE code by the
  // in-house ladder a week later, and vice versa. The cooldown read now names
  // both sources, so the two owners cannot disagree about what an address
  // has already been given.
  it("the shared cooldown read sees both ladders' recovery codes", () => {
    const loader = executable(CART_RECOVERY).slice(executable(CART_RECOVERY).indexOf("export async function loadRecoveryContext("));
    expect(loader).toMatch(/from\("coupons"\)\s*\.select\("assigned_email, created_at"\)\s*\.in\("source", \["cart_recovery", "omnisend_recovery"\]\)/);
    expect(loader).not.toContain('.eq("source", "cart_recovery")');
  });
});

// CONSENT BEFORE MONEY. Omnisend's automations send at threshold
// email: subscribed (spec §6), so a contact who is nonSubscribed or
// unsubscribed never receives the message this incentive is minted for. The
// sweep read no consent, and minted a code and a gift — a coupons row and a
// customer_offers row that spend the 30-day cooldowns — for an inbox that
// would never see them. The facts are collected first, and only a
// `subscribed` address is claimed; an unsubscribed one is counted and left
// UNCLAIMED, so a later tick inside the window mints if they subscribe.
describe("only a subscribed address is claimed or minted", () => {
  it("collects the contact facts and requires email consent subscribed before the claim, counting the rest", () => {
    expect(offers).toMatch(/import \{[^}]*\bcollectContactFacts\b[^}]*\} from "@\/lib\/marketing\/omnisend\/contacts";/);
    const facts = mint.indexOf("const facts = await collectContactFacts(email);");
    const gate = mint.indexOf('if (!facts || facts.emailConsent.status !== "subscribed") {');
    const claim = mint.indexOf('await ledger.claimSend("recovery offer"');
    expect(facts).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(facts);
    expect(claim).toBeGreaterThan(gate);
    const skip = mint.slice(gate, mint.indexOf("}", gate));
    expect(skip).toContain("result.unsubscribed += 1;");
    expect(skip).toContain("continue;");
    expect(skip).not.toContain("claimSend");
    expect(skip).not.toContain("ensureContactCode");
    expect(offers).toContain("unsubscribed: number;");
    expect(offers).toContain("unsubscribed: 0");
  });

  it("never widens consent: the status is read, compared to the literal, and nothing here writes a consent store", () => {
    expect(mint).not.toContain('status: "subscribed"');
    expect(offers).not.toContain("marketing_subscribers");
    expect(offers).not.toContain("email_suppressions");
    expect(offers).not.toContain("customer_preferences");
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
    const claim = mint.indexOf('await ledger.claimSend("recovery offer", `${cartId}:recovery offer`, { failClosed: true })');
    const plan = mint.indexOf("const plan = planStageOffer({");
    const record = mint.indexOf('await ledger.recordSend("recovery offer", `${cartId}:recovery offer`, accepted');
    const release = mint.indexOf('await ledger.releaseSend("recovery offer");');
    expect(claim).toBeGreaterThan(-1);
    expect(plan).toBeGreaterThan(claim);
    expect(record).toBeGreaterThan(plan);
    expect(release).toBeGreaterThan(record);
    expect(mint).toContain("const ledger = omnisendLedger(cartId);");
  });

  // A MINT FAILS CLOSED. The ledger's default is the event contract — any
  // insert failure other than a duplicate key answers "claimed", because a
  // lost event costs a flow and a duplicate costs nothing Omnisend cannot
  // dedup. There is no dedup for money: with omnisend_events_sent missing or
  // the insert refused, a fail-open claim let every 30-minute tick re-plan
  // and re-mint a code and a gift for every qualifying cart. So the plan
  // claim, and only the plan claim, asks for the closed direction.
  it("takes the plan claim fail-CLOSED, so an unreachable ledger mints nothing", () => {
    expect(mint).toContain("{ failClosed: true }");
    // Exactly one claimSend in the sweep, and it is the closed one.
    expect(mint.split("claimSend(").length - 1).toBe(1);
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

  // THE GIFT IS NAMED ON EVERY PUSH, NEVER LEFT TO CHANCE. contact-payload.ts
  // omits the vl_recovery_gift* properties when recoveryGift is undefined and
  // clears them when it is null, so a push that says nothing about the gift
  // leaves whatever an earlier cart wrote. This sweep is the one writer of
  // the gift, and it always says: the planned gift when there is one, null
  // (clear) when the plan carries none, so a stale gift from an earlier cart
  // can never show in a later cart's final email.
  it("passes recoveryGift explicitly on every push: the planned gift, or null to clear, never undefined", () => {
    expect(mint).toContain("let recoveryGift: RecoveryGiftFacts | null = null;");
    expect(mint).not.toMatch(/recoveryGift: RecoveryGiftFacts \| null \| undefined/);
    expect(mint).not.toMatch(/recoveryGift\s*=\s*undefined/);
    // The one push the sweep makes carries it by name.
    expect(mint.split("upsertOmnisendContact(").length - 1).toBe(1);
    expect(mint).toContain("{ link, codes, recoveryGift }");
  });

  // THE EVENT COMES FIRST, AND A REFUSED EVENT STOPS THE CART. The catch-up
  // `added product to cart` was sent fire-and-forget AFTER the claim, so a
  // cart whose event Omnisend refused was claimed and minted anyway — an
  // incentive for a shopper who never entered the flow the incentive is
  // for — and the refusal was never retried. Now: a cart with no DELIVERED
  // cart event has one sent (and awaited) before anything is claimed; if it
  // is not delivered the cart is left for the next tick, unclaimed and
  // unminted; only a delivered event, now or earlier, is followed by money.
  it("sends and awaits the catch-up event before the claim, and skips the cart when it is not delivered", () => {
    const known = mint.indexOf("if (!(await cartEventKnown(cartId))) {");
    const send = mint.indexOf("const sentEvent = await sendCartEventOnce({");
    const refused = mint.indexOf("if (!sentEvent) {");
    const claim = mint.indexOf('await ledger.claimSend("recovery offer"');
    expect(known).toBeGreaterThan(-1);
    expect(send).toBeGreaterThan(known);
    expect(refused).toBeGreaterThan(send);
    expect(claim).toBeGreaterThan(refused);
    const skip = mint.slice(refused, mint.indexOf("}", refused));
    expect(skip).toContain("continue;");
    expect(mint).toContain('name: "added product to cart"');
    expect(mint).toContain('campaign: "abandoned-cart"');
    // Only the event that landed counts as sent.
    expect(mint).toMatch(/if \(!sentEvent\) \{[\s\S]*?continue;[\s\S]*?\}\s*result\.events \+= 1;/);
  });

  it("asks the ledger for a DELIVERED cart event, and retries an undelivered one per debounce window rather than never", () => {
    const known = offers.slice(offers.indexOf("async function cartEventKnown("), offers.indexOf("export async function mintOmnisendCartOffers("));
    expect(known).toMatch(/\.eq\("event_name", "added product to cart"\)\s*\.eq\("delivered", true\)/);
    // Fails OPEN (true) so a ledger outage does not restart a flow; the
    // fail-closed claim that follows then mints nothing.
    expect(known).toMatch(/if \(error\) return true;/);
    expect(mint).toContain("debounceMs: CART_EVENT_DEBOUNCE_MS");
    expect(mint).not.toContain("debounceMs: null");
    expect(offers).toMatch(/import \{[^}]*\bCART_EVENT_DEBOUNCE_MS\b[^}]*\} from "@\/lib\/marketing\/omnisend\/cart-plan";/);
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
