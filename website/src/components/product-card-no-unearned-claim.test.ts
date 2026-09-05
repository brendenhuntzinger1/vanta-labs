import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// A product card may only claim a lot is verified when a COA says so. The
// dose-label slot used to fall back to the literal text "Verified lot" for
// any product without dose rows — with zero COA records in the database.
describe("product card", () => {
  it("never prints 'Verified lot' as a fallback label", () => {
    const source = readFileSync(join(process.cwd(), "src/components/product-card.tsx"), "utf8");
    expect(source).not.toContain('?? "Verified lot"');
    expect(source).not.toMatch(/>\s*Verified lot\s*</);
  });
});
