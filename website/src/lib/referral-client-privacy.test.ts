import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// THE ANONYMOUS READ SURFACE OF THE AMBASSADOR PROGRAMME.
//
// A referral code has to be checkable before the shopper has an account, so
// whatever answers that question is reachable by anyone. What it RETURNS is
// therefore the entire anonymous read surface of the programme.
//
// It once returned commission_percent — what Vanta pays that ambassador — to
// anyone holding the public anon key, which ships in the client bundle. It
// bought nothing: no component ever rendered it, and the commission actually
// paid is resolved server-side in quote-order.ts from the ambassadors table
// with the service role. The client only ever supplies the CODE.
//
// THE TRANSPORT MOVED, THE CONTRACT DID NOT. Validation used to go straight to
// PostgREST as the `validate_referral_code` RPC, which meant it bypassed the
// application's rate limiter and the short, human-chosen codes could be swept
// for ambassador names. It now goes through /api/catalog/referral/validate,
// which is throttled. These tests pin the payload either way: the client must
// not surface commission data even if the server starts leaking it again, and a
// valid code must still work.
// ---------------------------------------------------------------------------

const fetchMock = vi.fn();

/** Answer as the validate route would, with whatever body a test supplies. */
function respondWith(body: Record<string, unknown>, status = 200) {
  fetchMock.mockResolvedValue({ ok: status >= 200 && status < 300, status, json: async () => body });
}

const { validateReferralCodeClient } = await import("@/lib/referral-client");

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
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
   * for privacy is the ambassador's PAY, and commission stays out.
   */
  it("returns the code, the id, the name and the customer's own discount — and nothing else", async () => {
    respondWith({
      valid: true,
      referralCode: "SARAH10",
      ambassadorId: "amb-1",
      ambassadorName: "Sarah",
      customerDiscountPercent: 15,
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
    respondWith({ valid: true, referralCode: "SARAH10", ambassadorId: "amb-1", ambassadorName: "Sarah" });

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
   * Defence in depth. If the server is ever changed back — a migration replayed
   * in the wrong order, someone widening the route's select — the client must
   * still refuse to carry the figure into application state.
   */
  it("drops commission data even when the server leaks it", async () => {
    respondWith({
      valid: true,
      referralCode: "SARAH10",
      ambassadorId: "amb-1",
      ambassadorName: "Sarah",
      commissionPercent: 22.5,
      commission_percent: 22.5,
    });

    const result = await validateReferralCodeClient("SARAH10");
    const keys = allKeys(result).join(",").toLowerCase();
    expect(keys).not.toContain("commission");
    expect(JSON.stringify(result)).not.toContain("22.5");
  });

  it("tells the caller WHY a refused code was refused, so the cart can word it truthfully", async () => {
    const reasons: string[] = [];
    respondWith({ success: true, valid: false, reason: "unknown" });
    expect(await validateReferralCodeClient("NOSUCH", (reason) => reasons.push(reason))).toBeNull();
    respondWith({ success: true, valid: false, reason: "inactive" });
    expect(await validateReferralCodeClient("PAUSED", (reason) => reasons.push(reason))).toBeNull();
    // An older server payload with no reason is treated as the safer "inactive".
    respondWith({ success: true, valid: false });
    expect(await validateReferralCodeClient("OLD", (reason) => reasons.push(reason))).toBeNull();
    expect(reasons).toEqual(["unknown", "inactive", "inactive"]);
  });

  it("goes through the throttled application route, never straight at PostgREST", async () => {
    // The whole point of the move. A direct /rest/v1/rpc call bypasses the rate
    // limiter, and these codes are short enough to sweep.
    respondWith({ valid: true, referralCode: "SARAH10", ambassadorId: "amb-1", ambassadorName: "Sarah" });
    await validateReferralCodeClient("SARAH10");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("/api/catalog/referral/validate");
    expect(String(url)).not.toContain("/rest/v1/");
    expect((init as { method?: string }).method).toBe("POST");
  });

  it("refuses rather than reporting a valid code invalid when throttled", async () => {
    // Returning null on a 429 would silently strip a real ambassador's discount
    // from a real basket. It must be an error the cart can say something true
    // about, not a quiet "that code is not valid".
    respondWith({ success: false, error: "Too many referral code attempts." }, 429);
    await expect(validateReferralCodeClient("SARAH10")).rejects.toThrow(/wait a moment/i);
  });

  it("refuses rather than reporting a valid code invalid when the lookup fails", async () => {
    respondWith({ success: false }, 503);
    await expect(validateReferralCodeClient("SARAH10")).rejects.toThrow(/could not check/i);
  });

  it("an unapproved ambassador is not a valid code", async () => {
    respondWith({ valid: false });
    expect(await validateReferralCodeClient("NOPE")).toBeNull();
  });

  it("an empty code never reaches the server", async () => {
    expect(await validateReferralCodeClient("   ")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("normalises the code before sending it", async () => {
    respondWith({ valid: false });
    await validateReferralCodeClient("  sarah10 ");
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(String((init as { body?: string }).body))).toEqual({ code: "SARAH10" });
  });
});
