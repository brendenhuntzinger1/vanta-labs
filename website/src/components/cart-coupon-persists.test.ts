import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// AN APPLIED COUPON SURVIVES A RELOAD, LIKE THE REFERRAL CODE ALWAYS HAS.
//
// The coupon lived only in React memory. A reload, a back-navigation or a
// direct visit to /checkout dropped the discount row without a word and the
// order was created at full price — reproduced in the browser: the drawer
// showed the discount, /checkout after reload did not, amount_paid had no
// discount. The cart now persists the code beside the referral code and
// re-validates it through applyCouponCode (never trusting storage).
// ---------------------------------------------------------------------------

const SOURCE = readFileSync(join(process.cwd(), "src/components/cart-context.tsx"), "utf8");

describe("cart coupon persistence", () => {
  it("writes the coupon code into the persisted cart", () => {
    const persist = SOURCE.slice(SOURCE.indexOf("CART_STORAGE_KEY,\n        JSON.stringify("));
    expect(persist.slice(0, 200)).toContain("couponCode");
  });

  it("reads it back on hydrate and re-validates it rather than trusting it", () => {
    expect(SOURCE).toContain("parsed.couponCode");
    expect(SOURCE).toContain("pendingReapplyCouponRef.current = parsed.couponCode");
    // The reapply goes through the same validator a typed code uses.
    expect(SOURCE).toMatch(/pendingReapplyCouponRef\.current[\s\S]{0,400}applyCouponCode\(code\)/);
  });

  it("waits for the account and store config before re-applying", () => {
    const effect = SOURCE.slice(SOURCE.indexOf("const code = pendingReapplyCouponRef.current;") - 200, SOURCE.indexOf("const code = pendingReapplyCouponRef.current;"));
    expect(effect).toContain("!isHydrated || !accountChecked || !storeConfigLoaded");
  });
});
