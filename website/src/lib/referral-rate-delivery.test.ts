import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// THE RATE HAS TO REACH THE BROWSER, NOT JUST EXIST IN THE DATABASE.
//
// referral-customer-incident.test.ts asserts the arithmetic, and it passed
// while the real cart was wrong — because the resolvers were never the problem.
// resolveAmbassadorCustomerDiscount(15, 10) has always returned 15. The defect
// was that nothing ever handed the cart the 15.
//
// validate_referral_code returned valid / referral_code / ambassador_id /
// ambassador_name and nothing else, so the cart had exactly one number
// available — the program-wide default from /api/catalog/promotions — and used
// it for everybody. A 15% ambassador's customers were offered 10%.
//
// This file tests the DELIVERY. It drives the real validateReferralCodeClient
// against a mocked Supabase and asserts the rate arrives, because a test that
// only exercises the maths cannot fail when the plumbing breaks.
// ---------------------------------------------------------------------------

const rpc = vi.fn();
const state = {
  rpcData: null as unknown,
  rpcError: null as unknown,
  tableRow: null as unknown,
};

vi.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: (...args: unknown[]) => {
      rpc(...args);
      return Promise.resolve({ data: state.rpcData, error: state.rpcError });
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: state.tableRow, error: null }),
        }),
      }),
    }),
  },
}));

const { validateReferralCodeClient } = await import("@/lib/referral-client");

beforeEach(() => {
  state.rpcData = null;
  state.rpcError = null;
  state.tableRow = null;
  rpc.mockClear();
});

describe("what the browser is told about a code", () => {
  it("carries the ambassador's own customer discount", async () => {
    state.rpcData = {
      valid: true,
      referral_code: "MIZZY",
      ambassador_id: "amb-1",
      ambassador_name: "Jaeley Reynolds",
      customer_discount_percent: 15,
    };

    const result = await validateReferralCodeClient("mizzy");

    expect(result).not.toBeNull();
    expect(result!.customerDiscountPercent).toBe(15);
    expect(result!.referralCode).toBe("MIZZY");
  });

  /**
   * numeric(5,2) arrives as a string over PostgREST. Passed through RAW so the
   * caller resolves it — coercing here is how a correct rate turns into 0.
   */
  it("passes a numeric string through untouched", async () => {
    state.rpcData = { valid: true, referral_code: "SMOKE", ambassador_id: "a", ambassador_name: "S", customer_discount_percent: "15.00" };
    const result = await validateReferralCodeClient("SMOKE");
    expect(result!.customerDiscountPercent).toBe("15.00");
  });

  /**
   * null means "no override, inherit the program rate" — a real state for
   * ELOA, FLAVIAROSSETTI and ZAIN in production. It must NOT become 0, which
   * would hand every inheriting ambassador a 0% customer discount.
   */
  it("keeps null as null rather than collapsing it to zero", async () => {
    state.rpcData = { valid: true, referral_code: "ZAIN", ambassador_id: "a", ambassador_name: "Z", customer_discount_percent: null };
    const result = await validateReferralCodeClient("ZAIN");
    expect(result!.customerDiscountPercent).toBeNull();
    expect(result!.customerDiscountPercent).not.toBe(0);
  });

  it("still returns nothing for an unknown or unapproved code", async () => {
    state.rpcData = { valid: false };
    expect(await validateReferralCodeClient("NOPE")).toBeNull();
  });

  it("normalises case and whitespace before asking", async () => {
    state.rpcData = { valid: true, referral_code: "MIZZY", ambassador_id: "a", ambassador_name: "J", customer_discount_percent: 15 };
    await validateReferralCodeClient("  mizzy  ");
    expect(rpc).toHaveBeenCalledWith("validate_referral_code", { input_code: "MIZZY" });
  });

  it("never asks the database for an empty code", async () => {
    expect(await validateReferralCodeClient("   ")).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("commission stays out of the browser", () => {
  /**
   * The customer's own discount is theirs to see. The ambassador's PAY is not.
   * The privacy fix that removed commission from this path must survive the
   * addition of the discount.
   */
  it("drops commission even when the RPC hands it over", async () => {
    state.rpcData = {
      valid: true,
      referral_code: "MIZZY",
      ambassador_id: "amb-1",
      ambassador_name: "Jaeley Reynolds",
      customer_discount_percent: 15,
      commission_percent: 15,
      commission_amount: 999,
    };

    const result = await validateReferralCodeClient("MIZZY");

    expect(result).not.toHaveProperty("commissionPercent");
    expect(result).not.toHaveProperty("commission_percent");
    expect(JSON.stringify(result)).not.toContain("999");
    expect(JSON.stringify(result).toLowerCase()).not.toContain("commission");
  });

  it("returns only the four fields the cart needs", async () => {
    state.rpcData = { valid: true, referral_code: "MIZZY", ambassador_id: "amb-1", ambassador_name: "J", customer_discount_percent: 15 };
    const result = await validateReferralCodeClient("MIZZY");
    expect(Object.keys(result!).sort()).toEqual([
      "ambassadorId", "ambassadorName", "customerDiscountPercent", "referralCode",
    ]);
  });
});

describe("the legacy fallback, for a database without the RPC", () => {
  /** Only fires when the function is genuinely missing, never on a real error. */
  it("inherits the program rate rather than guessing one", async () => {
    state.rpcError = { code: "PGRST202", message: "Could not find the function" };
    state.tableRow = { id: "amb-1", name: "Jaeley", referral_code: "MIZZY", status: "approved" };

    const result = await validateReferralCodeClient("MIZZY");

    expect(result!.customerDiscountPercent).toBeNull();
    expect(result!.referralCode).toBe("MIZZY");
  });

  it("rethrows a real database error instead of falling back", async () => {
    state.rpcError = { code: "42501", message: "permission denied" };
    await expect(validateReferralCodeClient("MIZZY")).rejects.toBeTruthy();
  });

  it("refuses an unapproved ambassador on the fallback path too", async () => {
    state.rpcError = { code: "PGRST202", message: "Could not find the function" };
    state.tableRow = { id: "amb-1", name: "J", referral_code: "MIZZY", status: "pending" };
    expect(await validateReferralCodeClient("MIZZY")).toBeNull();
  });
});
