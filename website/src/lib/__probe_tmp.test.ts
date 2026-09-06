import { describe, it, expect } from "vitest";
import { requiresAccount, isPublicPath } from "@/lib/access-policy";
describe("probe", () => {
  it("gated", () => {
    expect(requiresAccount("/api/catalog/products")).toBe(true);
    expect(requiresAccount("/products")).toBe(true);
    expect(requiresAccount("/products/glp-1")).toBe(true);
    expect(requiresAccount("/coa-library")).toBe(true);
    expect(isPublicPath("/robots.txt")).toBe(true);
  });
});
