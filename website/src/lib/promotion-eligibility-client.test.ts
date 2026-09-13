import { describe, expect, it } from "vitest";
import {
  ELIGIBILITY_CACHE_TTL_MS,
  mayApplyPromotion,
  needsEligibilityLookup,
  normalizeCartEmail,
  readCachedEligibility,
  selectApplicablePromotions,
  writeCachedEligibility,
  type EligibilityAnswer,
  type PerCustomerLimited,
} from "@/lib/promotion-eligibility-client";

// ---------------------------------------------------------------------------
// THE INVARIANT THIS FILE EXISTS FOR:
//
//   the cart applies a per-customer promotion  ⟹  the server will apply it too
//
// Its contrapositive is the bug it replaces. The cart used to start from
// "nothing is exhausted" and apply everything, so a refused or failed lookup
// left it previewing a promotion quote-order was about to drop — a client total
// below the server's, and "Altered total detected" at the till.
//
// quote-order checks exhaustion when, and only when,
// `promotion.perCustomerLimit !== null && email`. Every case below is one row
// of that truth table, so the two cannot drift without a failure here.
// ---------------------------------------------------------------------------

const unlimited: PerCustomerLimited = { id: "sitewide", perCustomerLimit: null };
const oncePerCustomer: PerCustomerLimited = { id: "welcome-gift", perCustomerLimit: 1 };
const SHOPPER = "shopper@example.test";

const confirmed = (email: string, exhausted: string[] = []): EligibilityAnswer =>
  ({ email, exhaustedPromotionIds: exhausted });

describe("a promotion with no per-customer limit is never withheld", () => {
  it("applies with no email, an unconfirmed address, and a confirmed one alike", () => {
    expect(mayApplyPromotion(unlimited, "", null)).toBe(true);
    expect(mayApplyPromotion(unlimited, SHOPPER, null)).toBe(true);
    expect(mayApplyPromotion(unlimited, SHOPPER, confirmed(SHOPPER))).toBe(true);
  });

  it("an anonymous browse never needs a lookup, so the endpoint is never called", () => {
    expect(needsEligibilityLookup([unlimited, oncePerCustomer], "", null)).toBe(false);
    expect(needsEligibilityLookup([unlimited], SHOPPER, null)).toBe(false);
  });
});

describe("a per-customer promotion with no address on the order", () => {
  it("is applied, because quote-order's own `&& email` is false and it applies it too", () => {
    // This is the row that keeps an anonymous product page showing its banner.
    expect(mayApplyPromotion(oncePerCustomer, "", null)).toBe(true);
  });
});

describe("a per-customer promotion with an address the server will check", () => {
  it("is WITHHELD until an answer for that address comes back", () => {
    expect(mayApplyPromotion(oncePerCustomer, SHOPPER, null)).toBe(false);
  });

  it("is applied once confirmed not exhausted", () => {
    expect(mayApplyPromotion(oncePerCustomer, SHOPPER, confirmed(SHOPPER))).toBe(true);
  });

  it("is withheld when confirmed exhausted — the case the till would refuse", () => {
    expect(mayApplyPromotion(oncePerCustomer, SHOPPER, confirmed(SHOPPER, ["welcome-gift"]))).toBe(false);
  });

  it("is WITHHELD when the only answer held is about a DIFFERENT address", () => {
    // A shopper who signs in as someone else, or edits the checkout email: the
    // previous answer says nothing about the new address, and treating it as
    // though it did is exactly how a stale confirmation would authorise the
    // dangerous direction.
    const stale = confirmed("someone.else@example.test");
    expect(mayApplyPromotion(oncePerCustomer, SHOPPER, stale)).toBe(false);
    expect(needsEligibilityLookup([oncePerCustomer], SHOPPER, stale)).toBe(true);
  });
});

describe("the dangerous direction is unreachable by construction", () => {
  // The server's decision, written independently of the client rule so this is
  // a comparison and not a restatement.
  const serverWillApply = (promotion: PerCustomerLimited, email: string, exhausted: string[]) =>
    promotion.perCustomerLimit === null || !email || !exhausted.includes(promotion.id);

  it("never applies a promotion the server would drop, across every state", () => {
    const promotions = [unlimited, oncePerCustomer];
    const emails = ["", SHOPPER, "other@example.test", "third@example.test"];

    // The truth on the server for this fixture: the shopper has used up the
    // welcome gift, and "other" has too; nobody else has.
    const exhaustedOnServer = (email: string) =>
      (email === SHOPPER || email === "other@example.test" ? ["welcome-gift"] : []);

    // AN ANSWER IS ALWAYS THE SERVER'S OWN, FOR THE ADDRESS IT NAMES. A
    // confirmation cannot disagree with the till about the address it is about
    // — it came from the till. What it CAN be is about a different address,
    // which is the stale case that matters and is generated here.
    const answers: Array<EligibilityAnswer | null> = [
      null,
      ...emails.filter(Boolean).map((e) => confirmed(e, exhaustedOnServer(e))),
    ];

    let applied = 0;
    for (const promotion of promotions) {
      for (const email of emails) {
        for (const answer of answers) {
          const clientApplies = mayApplyPromotion(promotion, email, answer);
          if (!clientApplies) continue;
          applied += 1;
          // The one thing that must never happen.
          expect(
            serverWillApply(promotion, email, exhaustedOnServer(email)),
            `cart applied ${promotion.id} for "${email}" with answer ${JSON.stringify(answer)}, `
            + "but quote-order would drop it — this is the 'Altered total detected' path",
          ).toBe(true);
        }
      }
    }
    // Guard against a vacuous pass: if the rule withheld everything the loop
    // above would assert nothing at all.
    expect(applied).toBeGreaterThan(0);
  });

  it("a confirmation for the WRONG address cannot authorise a promotion", () => {
    // The specific stale case the loop above covers in bulk, stated once on its
    // own: "third" has not used the gift, "shopper" has. Holding third's answer
    // must not let a shopper@ order preview it.
    const thirdPartyAnswer = confirmed("third@example.test", []);
    expect(mayApplyPromotion(oncePerCustomer, SHOPPER, thirdPartyAnswer)).toBe(false);
  });

  it("a failed lookup withholds rather than assumes — no answer means no promotion", () => {
    // 429, timeout, offline, parse error: every one of them arrives here as
    // `null`, and every one of them takes the safe branch.
    for (const failure of [null]) {
      expect(selectApplicablePromotions([unlimited, oncePerCustomer], SHOPPER, failure))
        .toEqual([unlimited]);
    }
  });
});

describe("selectApplicablePromotions", () => {
  it("keeps order and drops only what it must", () => {
    const list = [unlimited, oncePerCustomer];
    expect(selectApplicablePromotions(list, SHOPPER, confirmed(SHOPPER))).toEqual(list);
    expect(selectApplicablePromotions(list, SHOPPER, confirmed(SHOPPER, ["welcome-gift"])))
      .toEqual([unlimited]);
  });
});

describe("normalizeCartEmail matches how the server keys an address", () => {
  it("trims, lowercases, and rejects anything without an @", () => {
    expect(normalizeCartEmail("  Person@Example.TEST ")).toBe("person@example.test");
    expect(normalizeCartEmail("not-an-address")).toBe("");
    expect(normalizeCartEmail(undefined)).toBe("");
    expect(normalizeCartEmail(42)).toBe("");
  });
});

describe("the cache", () => {
  const store = (initial: string | null = null) => {
    let value = initial;
    return {
      getItem: () => value,
      setItem: (_k: string, v: string) => { value = v; },
      read: () => value,
    };
  };

  it("round-trips an answer for the same address", () => {
    const s = store();
    writeCachedEligibility(s, confirmed(SHOPPER, ["welcome-gift"]), 1_000);
    expect(readCachedEligibility(s, SHOPPER, 1_000)).toEqual(confirmed(SHOPPER, ["welcome-gift"]));
  });

  it("never answers for a different address", () => {
    const s = store();
    writeCachedEligibility(s, confirmed(SHOPPER), 1_000);
    expect(readCachedEligibility(s, "other@example.test", 1_000)).toBeNull();
  });

  it("expires, so a redemption spent in another tab cannot stay cached forever", () => {
    const s = store();
    writeCachedEligibility(s, confirmed(SHOPPER), 1_000);
    expect(readCachedEligibility(s, SHOPPER, 1_000 + ELIGIBILITY_CACHE_TTL_MS - 1)).not.toBeNull();
    expect(readCachedEligibility(s, SHOPPER, 1_000 + ELIGIBILITY_CACHE_TTL_MS + 1)).toBeNull();
  });

  it("survives junk, a throwing storage, and a hostile value without applying anything", () => {
    expect(readCachedEligibility(store("}{not json"), SHOPPER)).toBeNull();
    expect(readCachedEligibility(store('{"email":"shopper@example.test"}'), SHOPPER)).toBeNull();
    expect(readCachedEligibility(store('{"email":"shopper@example.test","exhaustedPromotionIds":"all","at":1}'), SHOPPER, 1)).toBeNull();
    const throwing = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
    };
    expect(readCachedEligibility(throwing, SHOPPER)).toBeNull();
    expect(() => writeCachedEligibility(throwing, confirmed(SHOPPER))).not.toThrow();
  });

  it("a cache miss is a withheld promotion, never an applied one", () => {
    expect(mayApplyPromotion(oncePerCustomer, SHOPPER, readCachedEligibility(store(), SHOPPER))).toBe(false);
  });
});
