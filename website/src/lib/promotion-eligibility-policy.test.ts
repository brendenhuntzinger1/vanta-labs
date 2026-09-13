import { describe, expect, it } from "vitest";
import {
  ELIGIBILITY_ANONYMOUS_LIMIT,
  ELIGIBILITY_PROBE_IP_CEILING,
  ELIGIBILITY_PROBE_LIMIT,
  ELIGIBILITY_SELF_LIMIT,
  ELIGIBILITY_WINDOW_SECONDS,
  eligibilityBudgets,
  isSelfEligibilityQuery,
  normalizeEligibilityEmail,
  type EligibilityIdentity,
} from "@/lib/promotion-eligibility-policy";

const SHOPPER = "shopper@example.test";
const user: EligibilityIdentity = { kind: "user", userId: "user-1", email: SHOPPER };
const otherUser: EligibilityIdentity = { kind: "user", userId: "user-2", email: "second@example.test" };
const grant: EligibilityIdentity = { kind: "grant", cartId: "cart-9" };
const anonymous: EligibilityIdentity = { kind: "anonymous" };

const names = (identity: EligibilityIdentity, email: string, ip: string | null = "203.0.113.7") =>
  eligibilityBudgets(identity, email, ip).map((b) => b.bucket);

describe("asking about your own address is not an oracle", () => {
  it("is recognised regardless of case and surrounding space", () => {
    expect(isSelfEligibilityQuery(user, SHOPPER)).toBe(true);
    expect(isSelfEligibilityQuery({ ...user, email: "  SHOPPER@Example.TEST " }, SHOPPER)).toBe(true);
  });

  it("an empty email is self, because the route answers it without a lookup", () => {
    expect(isSelfEligibilityQuery(anonymous, "")).toBe(true);
    expect(isSelfEligibilityQuery(user, "")).toBe(true);
  });

  it("spends only a generous per-ACCOUNT budget, and no per-IP budget at all", () => {
    const budgets = eligibilityBudgets(user, SHOPPER, "203.0.113.7");
    expect(budgets).toEqual([{
      bucket: "promo-eligibility:self:user-1",
      limit: ELIGIBILITY_SELF_LIMIT,
      windowSeconds: ELIGIBILITY_WINDOW_SECONDS,
    }]);
    // THE CGNAT PROPERTY: nothing a stranger on the same address does can
    // appear in this customer's bucket name.
    expect(budgets.some((b) => b.bucket.includes("203.0.113.7"))).toBe(false);
  });

  it("two customers behind ONE address never share a bucket", () => {
    expect(names(user, SHOPPER, "198.51.100.4"))
      .not.toEqual(names(otherUser, "second@example.test", "198.51.100.4"));
  });

  it("is sized so an ordinary browse cannot reach it", () => {
    // The measured failure was the 10th page view. One lookup per page view,
    // across several tabs, still has to fit.
    expect(ELIGIBILITY_SELF_LIMIT).toBeGreaterThanOrEqual(100);
  });
});

describe("asking about somebody else's address is the oracle, and stays tight", () => {
  it("spends a per-account budget AND a per-host ceiling", () => {
    expect(eligibilityBudgets(user, "victim@example.test", "203.0.113.7")).toEqual([
      {
        bucket: "promo-eligibility:probe:user-1",
        limit: ELIGIBILITY_PROBE_LIMIT,
        windowSeconds: ELIGIBILITY_WINDOW_SECONDS,
      },
      {
        bucket: "promo-eligibility:probe-ip:203.0.113.7",
        limit: ELIGIBILITY_PROBE_IP_CEILING,
        windowSeconds: ELIGIBILITY_WINDOW_SECONDS,
      },
    ]);
  });

  it("keeps the probe budget well under the self budget", () => {
    expect(ELIGIBILITY_PROBE_LIMIT).toBeLessThan(ELIGIBILITY_SELF_LIMIT / 4);
  });

  it("caps enumeration from one host even when the attacker cycles accounts", () => {
    // Same host, different accounts: the account bucket moves, the host ceiling
    // does not, so it is the ceiling that bounds a mass probe.
    const a = eligibilityBudgets(user, "victim@example.test", "203.0.113.7");
    const b = eligibilityBudgets(otherUser, "victim@example.test", "203.0.113.7");
    expect(a[0].bucket).not.toBe(b[0].bucket);
    expect(a[1].bucket).toBe(b[1].bucket);
  });

  it("the ceiling is still far above any real shopper's third-party typing", () => {
    expect(ELIGIBILITY_PROBE_IP_CEILING).toBeGreaterThan(ELIGIBILITY_PROBE_LIMIT);
  });
});

describe("a guest holding a signed recovery grant", () => {
  it("is keyed on the cart the grant names, not the host", () => {
    expect(eligibilityBudgets(grant, SHOPPER, "203.0.113.7")).toEqual([{
      bucket: "promo-eligibility:grant:cart-9",
      limit: 30,
      windowSeconds: ELIGIBILITY_WINDOW_SECONDS,
    }]);
  });

  it("two grant holders behind one carrier NAT do not share a budget", () => {
    expect(names(grant, SHOPPER, "100.64.0.1"))
      .not.toEqual(names({ kind: "grant", cartId: "cart-10" }, SHOPPER, "100.64.0.1"));
  });
});

describe("no session and no grant keeps AUTH-4's original budget exactly", () => {
  it("is ten per ten minutes, on the bucket name AUTH-4 used", () => {
    expect(eligibilityBudgets(anonymous, SHOPPER, "203.0.113.7")).toEqual([{
      bucket: "promo-eligibility:203.0.113.7",
      limit: ELIGIBILITY_ANONYMOUS_LIMIT,
      windowSeconds: ELIGIBILITY_WINDOW_SECONDS,
    }]);
    expect(ELIGIBILITY_ANONYMOUS_LIMIT).toBe(10);
    expect(ELIGIBILITY_WINDOW_SECONDS).toBe(600);
  });

  it("an absent IP still lands in a bucket rather than an unkeyed one", () => {
    expect(names(anonymous, SHOPPER, null)).toEqual(["promo-eligibility:unknown"]);
  });
});

describe("normalizeEligibilityEmail", () => {
  it("matches how the exhaustion lookup keys an address", () => {
    expect(normalizeEligibilityEmail("  Person@Example.TEST ")).toBe("person@example.test");
    expect(normalizeEligibilityEmail("nope")).toBe("");
    expect(normalizeEligibilityEmail(null)).toBe("");
    expect(normalizeEligibilityEmail({})).toBe("");
  });

  it("means a differently-cased spelling of one address is ONE probe, not two", () => {
    const a = normalizeEligibilityEmail("Victim@Example.test");
    const b = normalizeEligibilityEmail("victim@example.test");
    expect(a).toBe(b);
    expect(isSelfEligibilityQuery({ kind: "user", userId: "u", email: a }, b)).toBe(true);
  });
});
