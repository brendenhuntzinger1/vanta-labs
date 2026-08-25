import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// THE ONE RPC THE INTERNET MAY CALL.
//
// rpc-execute-lockdown.sql revoked EXECUTE from anon/authenticated on every
// SECURITY DEFINER function except validate_referral_code, which has to stay
// open because the cart checks a code before the shopper has an account. That
// makes what it RETURNS the entire anonymous read surface of the ambassador
// programme.
//
// It was returning commission_percent — what Vanta pays that ambassador —
// to anyone holding the public anon key, which ships in the client bundle.
// Referral codes are short, human-chosen and guessable, and a PostgREST RPC
// does not pass through the application's rate limiter, so they can be swept.
// One ambassador discovering another's rate is a real problem.
//
// It bought nothing. referral-client returned it, cart-context stored it on
// referralDetails, and no component ever rendered it. The commission actually
// paid is resolved server-side in quote-order.ts from the ambassadors table
// with the service role; the client only ever supplies the CODE.
//
// This file pins BOTH halves: the client must not surface commission data even
// if the database starts leaking it again, and a valid code must still work.
// ---------------------------------------------------------------------------

const rpc = vi.fn();
const from = vi.fn();

vi.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpc(...args),
    from: (...args: unknown[]) => from(...args),
  },
}));

const { validateReferralCodeClient } = await import("@/lib/referral-client");

beforeEach(() => {
  rpc.mockReset();
  from.mockReset();
});

/** Every key any caller could read off the returned object, nested included. */
function allKeys(value: unknown, path = "", acc: string[] = []): string[] {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      acc.push(path ? `${path}.${k}` : k);
      allKeys(v, path ? `${path}.${k}` : k, acc);
    }
  }
  return acc;
}

describe("what a referral lookup hands back to the browser", () => {
  /**
   * The contract widened by exactly one field, deliberately.
   *
   * It used to be code + id + name and nothing else, which read as the safest
   * possible payload and was in fact the cause of a customer-facing defect: with
   * no rate available, the cart applied the program-wide default to everyone, so
   * a 15% ambassador's customers were offered 10% while checkout charged 15%.
   *
   * customer_discount_percent is the shopper's OWN discount — they see it the
   * instant the code applies, and the server charges it. The line that matters
   * for privacy is the ambassador's PAY, and commission stays out; the two tests
   * below still enforce that, on both the RPC and the legacy fallback path.
   */
  it("returns the code, the id, the name and the customer's own discount — and nothing else", async () => {
    rpc.mockResolvedValue({
      data: {
        valid: true,
        referral_code: "SARAH10",
        ambassador_id: "amb-1",
        ambassador_name: "Sarah",
        customer_discount_percent: 15,
      },
      error: null,
    });

    const result = await validateReferralCodeClient("sarah10");
    expect(result).toEqual({
      referralCode: "SARAH10",
      ambassadorId: "amb-1",
      ambassadorName: "Sarah",
      customerDiscountPercent: 15,
    });
  });

  it("carries no rate at all when the ambassador has no override", async () => {
    rpc.mockResolvedValue({
      data: { valid: true, referral_code: "SARAH10", ambassador_id: "amb-1", ambassador_name: "Sarah" },
      error: null,
    });

    const result = await validateReferralCodeClient("sarah10");
    // null, never 0 — 0 is a real configured rate and would mean "no discount".
    expect(result).toEqual({
      referralCode: "SARAH10",
      ambassadorId: "amb-1",
      ambassadorName: "Sarah",
      customerDiscountPercent: null,
    });
  });

  /**
   * Defence in depth. If the RPC is ever changed back — a migration replayed in
   * the wrong order, someone "restoring" the old definition — the client must
   * still refuse to carry the figure into application state.
   */
  it("drops commission data even when the RPC leaks it", async () => {
    rpc.mockResolvedValue({
      data: {
        valid: true,
        referral_code: "SARAH10",
        ambassador_id: "amb-1",
        ambassador_name: "Sarah",
        commission_percent: 22.5,
      },
      error: null,
    });

    const result = await validateReferralCodeClient("SARAH10");
    const keys = allKeys(result).join(",").toLowerCase();
    expect(keys).not.toContain("commission");
    expect(JSON.stringify(result)).not.toContain("22.5");
  });

  it("the legacy table fallback does not select or return commission either", async () => {
    // The RPC is reported missing, so the client falls back to a direct read.
    rpc.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "Could not find the function" } });

    const maybeSingle = vi.fn().mockResolvedValue({
      data: { id: "amb-1", name: "Sarah", referral_code: "SARAH10", status: "approved" },
      error: null,
    });
    const eq = vi.fn(() => ({ maybeSingle }));
    const select = vi.fn((_columns: string) => ({ eq }));
    from.mockReturnValue({ select });

    const result = await validateReferralCodeClient("SARAH10");

    // The column must not even be requested — an unused column in a SELECT is
    // still a column the browser asked the database for.
    expect(select).toHaveBeenCalledTimes(1);
    expect(String(select.mock.calls[0]?.[0] ?? "")).not.toContain("commission_percent");
    expect(JSON.stringify(result).toLowerCase()).not.toContain("commission");
  });

  it("an unapproved ambassador is not a valid code", async () => {
    rpc.mockResolvedValue({ data: { valid: false }, error: null });
    expect(await validateReferralCodeClient("NOPE")).toBeNull();
  });

  it("an empty code never reaches the database", async () => {
    expect(await validateReferralCodeClient("   ")).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("normalises the code before sending it", async () => {
    rpc.mockResolvedValue({ data: { valid: false }, error: null });
    await validateReferralCodeClient("  sarah10 ");
    expect(rpc).toHaveBeenCalledWith("validate_referral_code", { input_code: "SARAH10" });
  });
});
