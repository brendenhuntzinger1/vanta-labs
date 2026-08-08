import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resolvePaymentProviderName, isMockPaymentMode } from "@/lib/payment-provider";

// ===========================================================================
// FAKE PAYMENTS MUST BE UNREACHABLE IN PRODUCTION, NOT MERELY DISCOURAGED.
//
// /api/checkout/mock-pay signs a webhook event and runs it through the REAL
// payment pipeline: it marks an order paid, decrements inventory, accrues
// ambassador commission and sends a confirmation email -- without money.
//
// The guard used to read:
//
//   NODE_ENV === "production" && ALLOW_MOCK_PAYMENTS !== "true"
//
// so one mistyped Vercel variable re-opened a free-order endpoint. A control
// whose failure mode is silent, total and financial should not be a single
// string comparison against an env var somebody can set by accident.
//
// Production is now unconditional in three independent places: provider
// resolution, the route, and the simulated checkout page.
// ===========================================================================

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_ALLOW = process.env.ALLOW_MOCK_PAYMENTS;

function setNodeEnv(value: string | undefined) {
  // NODE_ENV is readonly in the Node types, but process.env only accepts plain
  // enumerable string properties -- defineProperty is rejected outright.
  const env = process.env as Record<string, string | undefined>;
  if (value === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = value;
}

afterEach(() => {
  setNodeEnv(ORIGINAL_NODE_ENV);
  if (ORIGINAL_ALLOW === undefined) delete process.env.ALLOW_MOCK_PAYMENTS;
  else process.env.ALLOW_MOCK_PAYMENTS = ORIGINAL_ALLOW;
});

describe("production refuses the mock gateway", () => {
  it("throws for PAYMENT_PROVIDER=mock", () => {
    setNodeEnv("production");
    expect(() => resolvePaymentProviderName("mock")).toThrow(/forbidden in production/i);
  });

  it("throws for PAYMENT_PROVIDER=test", () => {
    setNodeEnv("production");
    expect(() => resolvePaymentProviderName("test")).toThrow(/forbidden in production/i);
  });

  // The regression this file exists for. Previously this combination returned
  // "mock" and opened the endpoint.
  it("throws even when ALLOW_MOCK_PAYMENTS=true", () => {
    setNodeEnv("production");
    process.env.ALLOW_MOCK_PAYMENTS = "true";
    expect(() => resolvePaymentProviderName("mock")).toThrow(/forbidden in production/i);
  });

  it("throws for every truthy spelling of the old opt-in", () => {
    setNodeEnv("production");
    for (const value of ["true", "TRUE", "1", "yes", "on"]) {
      process.env.ALLOW_MOCK_PAYMENTS = value;
      expect(() => resolvePaymentProviderName("mock")).toThrow(/forbidden in production/i);
    }
  });

  // isMockPaymentMode is what the route and page gate on, so it must inherit
  // the refusal rather than swallowing it into a boolean.
  it("does not let isMockPaymentMode quietly report true", () => {
    setNodeEnv("production");
    process.env.ALLOW_MOCK_PAYMENTS = "true";
    expect(() => isMockPaymentMode("mock")).toThrow(/forbidden in production/i);
  });
});

describe("a correctly configured production store is unaffected", () => {
  it("resolves live without throwing", () => {
    setNodeEnv("production");
    expect(resolvePaymentProviderName("live")).toBe("live");
    expect(isMockPaymentMode("live")).toBe(false);
  });

  // A missing variable must not become mock. Defaulting the other way would be
  // the same vulnerability arrived at from the opposite direction.
  it("treats a missing provider as live, never mock", () => {
    setNodeEnv("production");
    expect(resolvePaymentProviderName(undefined)).toBe("live");
    expect(resolvePaymentProviderName("")).toBe("live");
  });
});

describe("development still works", () => {
  it("allows the mock gateway outside production", () => {
    setNodeEnv("development");
    expect(resolvePaymentProviderName("mock")).toBe("mock");
    expect(isMockPaymentMode("mock")).toBe(true);
  });

  it("needs no opt-in variable to do so", () => {
    setNodeEnv("development");
    delete process.env.ALLOW_MOCK_PAYMENTS;
    expect(resolvePaymentProviderName("test")).toBe("mock");
  });
});

describe("the endpoint and page refuse independently", () => {
  const route = readFileSync(join(process.cwd(), "src/app/api/checkout/mock-pay/route.ts"), "utf8");
  const page = readFileSync(join(process.cwd(), "src/app/pay/mock/[orderId]/page.tsx"), "utf8");
  const provider = readFileSync(join(process.cwd(), "src/lib/payment-provider.ts"), "utf8");
  const billing = readFileSync(join(process.cwd(), "src/lib/billing-provider.ts"), "utf8");

  it("the route 404s in production before reading the body", () => {
    expect(route).toContain('if (process.env.NODE_ENV === "production") {');
    const guard = route.indexOf('process.env.NODE_ENV === "production"');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(route.indexOf("await request.json()"));
  });

  it("the simulated checkout page 404s in production", () => {
    expect(page).toContain('process.env.NODE_ENV === "production" || !isMockPaymentMode()');
  });

  // Both money lanes. The recurring lane grants memberships, which is the same
  // class of loss as a free order.
  it("neither lane keeps the env-var opt-in", () => {
    expect(provider).not.toContain('process.env.ALLOW_MOCK_PAYMENTS !== "true"');
    expect(billing).not.toContain('process.env.ALLOW_MOCK_PAYMENTS !== "true"');
  });

  it("the recurring billing lane refuses production unconditionally", () => {
    expect(billing).toContain('if (process.env.NODE_ENV === "production") {');
    expect(billing).toContain("would activate memberships without charging");
  });
});
