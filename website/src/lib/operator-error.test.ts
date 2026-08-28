import { describe, expect, it } from "vitest";

import { vi } from "vitest";

vi.mock("server-only", () => ({}));

import { describeError } from "@/lib/operator-error";

// ---------------------------------------------------------------------------
// THE ALERT THAT COULD NOT SAY WHAT WENT WRONG.
//
// On 2026-08-28 the scheduled sweep raised a CRITICAL alert on the affiliate
// money path whose entire diagnostic payload was:
//
//     context: { "commission_accrual_repair": "[object Object]" }
//
// The route returns 200 even when a job rejects — that is deliberate, so one
// failing job cannot fail the whole sweep — so nothing reached the runtime
// error log either. The reason existed, was passed to the alert, and was
// destroyed on the way in by `String(reason)`.
//
// It is destroyed for the errors this codebase ACTUALLY throws: a Supabase /
// PostgREST failure is a plain `{ code, message, details, hint }` object, not
// an Error, and `String()` on a plain object is that literal text.
//
// Every case below is asserted against `String()` as well, so the test states
// what was lost rather than merely what is kept.
// ---------------------------------------------------------------------------

describe("describeError renders what an operator needs", () => {
  it("keeps every field of a PostgREST error that String() would destroy", () => {
    const postgrestError = {
      code: "42501",
      message: "permission denied for table referral_orders",
      details: null,
      hint: "grant SELECT to service_role",
    };

    const described = describeError(postgrestError);

    expect(described).toContain("42501");
    expect(described).toContain("permission denied for table referral_orders");
    expect(described).toContain("grant SELECT to service_role");

    // The regression, stated: this is what the alert used to carry.
    expect(String(postgrestError)).toBe("[object Object]");
    expect(described).not.toBe("[object Object]");
  });

  it("keeps an Error's message", () => {
    expect(describeError(new Error("connection reset"))).toBe("connection reset");
  });

  it("never returns [object Object] for an object with no recognised fields", () => {
    const odd = { unexpected: "shape" };
    expect(String(odd)).toBe("[object Object]");
    expect(describeError(odd)).toContain("unexpected");
  });

  it("survives an object JSON cannot serialise", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => describeError(circular)).not.toThrow();
    expect(describeError(circular)).not.toBe("");
  });

  it("still handles primitives and null", () => {
    expect(describeError("plain string")).toBe("plain string");
    expect(describeError(null)).toBe("null");
    expect(describeError(undefined)).toBe("undefined");
  });
});
