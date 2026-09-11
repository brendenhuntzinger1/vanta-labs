import { describe, expect, it } from "vitest";

import {
  isE164,
  isRefusedLineType,
  maskPhone,
  normalisePhone,
  phoneDigits,
} from "@/lib/sms/phone";

// ---------------------------------------------------------------------------
// `sms_subscribers.phone_e164` IS A PRIMARY KEY, so the cost of a second
// spelling is not a formatting nit: it is the same person holding two consent
// states, and eventually one of them saying STOP while the other keeps sending.
//
// Invariant 2 in the M1 matrix depends on this module being the only place a
// number becomes canonical, so these tests are deliberately exhaustive about
// the shapes a human types and paranoid about the ones that look valid.
// ---------------------------------------------------------------------------

describe("normalisePhone — the shapes people actually type", () => {
  const CANONICAL = "+18135551234";

  it.each([
    ["8135551234", "bare ten digits"],
    ["18135551234", "leading country code"],
    ["+18135551234", "already canonical"],
    ["(813) 555-1234", "parenthesised"],
    ["813-555-1234", "hyphenated"],
    ["813.555.1234", "dotted"],
    ["813 555 1234", "spaced"],
    ["+1 (813) 555-1234", "fully decorated"],
    ["  +1-813-555-1234  ", "surrounded by whitespace"],
    ["1 (813) 555.1234", "mixed separators"],
  ])("normalises %s (%s)", (input) => {
    const result = normalisePhone(input);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.e164).toBe(CANONICAL);
  });

  it("every accepted spelling collapses to ONE key", () => {
    const spellings = ["8135551234", "18135551234", "+1 (813) 555-1234", "813.555.1234"];
    const keys = new Set(
      spellings.map((s) => {
        const r = normalisePhone(s);
        return r.ok ? r.e164 : `rejected:${s}`;
      }),
    );
    expect(keys.size).toBe(1);
  });
});

describe("normalisePhone — refusals, each with a reason", () => {
  it.each([
    ["", "empty"],
    ["   ", "empty"],
    ["abc", "empty"],
    ["555", "too_short"],
    ["813555123", "too_short"],
  ])("refuses %o as %s", (input, reason) => {
    const result = normalisePhone(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe(reason);
  });

  it("refuses an 11-digit number that does not start with 1 — two distinct ones exist in this store's own contact data", () => {
    // Measured 2026-09-11: two distinct such numbers across orders/ambassadors/
    // partners. They are suppressed under their raw digits by the M0 migration
    // rather than coerced into a US number that belongs to someone else.
    const result = normalisePhone("81355512345");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("not_nanp");
      // The digits survive, because a number we cannot parse still has to be
      // suppressible.
      expect(result.digits).toBe("81355512345");
    }
  });

  it("refuses more digits than any NANP number has", () => {
    const result = normalisePhone("+44 20 7946 0958");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_nanp");
  });
});

describe("normalisePhone — shapes that look valid and are not", () => {
  it.each([
    ["0135551234", "area code starting 0"],
    ["1135551234", "area code starting 1"],
    ["8130551234", "exchange starting 0"],
    ["8131551234", "exchange starting 1"],
    ["8139115551", "N11 exchange"],
    ["9115551234", "N11 area code"],
  ])("refuses %s (%s)", (input) => {
    const result = normalisePhone(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_nanp");
  });

  it("refuses the reserved and unassignable 555 blocks — including the app placeholder", () => {
    // This is not pedantry. `PHONE_LOGIN_ENABLED`'s own placeholder in
    // account-auth-form.tsx is +1 813 555 0000, and a test number reaching a
    // real send path is exactly the accident this range exists to prevent.
    const result = normalisePhone("+1 813 555 0000");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_nanp");
  });

  it("allows 555 numbers OUTSIDE the reserved block", () => {
    // Only the 555-00xx and 555-01xx blocks are refused; 555-1234 is an
    // ordinary assignable number and must keep working.
    expect(normalisePhone("8135551234").ok).toBe(true);
  });
});

describe("isE164 — asserts stored keys never drifted", () => {
  it("accepts only the canonical form", () => {
    expect(isE164("+18135551234")).toBe(true);
  });

  it.each([
    "8135551234",
    "18135551234",
    "+1 813 555 1234",
    "+18135551234 ",
    "+441234567890",
    "+11135551234",
    "+18135550000",
    null,
    undefined,
    "",
  ])("rejects %o", (value) => {
    expect(isE164(value as string)).toBe(false);
  });
});

describe("maskPhone — a phone number is PII, including in our own logs", () => {
  it("masks the middle, keeps the last four", () => {
    expect(maskPhone("+18135554417")).toBe("+1 813 ••• 4417");
  });

  it("masks an unnormalised number without throwing", () => {
    expect(maskPhone("81355512345")).toContain("•••");
  });

  it("never returns the full number for anything", () => {
    for (const input of ["+18135554417", "8135554417", "18135554417"]) {
      expect(maskPhone(input)).not.toContain("5554417");
    }
  });

  it("survives junk", () => {
    expect(maskPhone(null)).toBe("•••");
    expect(maskPhone("")).toBe("•••");
    expect(maskPhone("12")).toBe("•••");
  });
});

describe("phoneDigits — the suppression key for an unparseable number", () => {
  it("keeps only digits", () => {
    expect(phoneDigits("+1 (813) 555-1234")).toBe("18135551234");
  });

  it("is stable across spellings of the same unparseable number", () => {
    expect(phoneDigits("+81 3555 12345")).toBe(phoneDigits("81355512345"));
  });
});

describe("isRefusedLineType — VOIP is the economics of gift farming", () => {
  it.each(["voip", "VOIP", "landline", "nonFixedVoip", "fixedVoip"])("refuses %s", (value) => {
    expect(isRefusedLineType(value)).toBe(true);
  });

  it("allows mobile", () => {
    expect(isRefusedLineType("mobile")).toBe(false);
  });

  it("treats an unknown line type as allowed — Lookup may not answer, and a\n     missing answer must not block a real customer", () => {
    expect(isRefusedLineType(null)).toBe(false);
    expect(isRefusedLineType(undefined)).toBe(false);
    expect(isRefusedLineType("")).toBe(false);
  });
});
