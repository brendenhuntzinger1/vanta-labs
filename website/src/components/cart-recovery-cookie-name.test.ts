import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { CART_RECOVERY_COOKIE } from "@/lib/email/cart-recovery-links";

// ---------------------------------------------------------------------------
// ONE COOKIE NAME, WRITTEN IN TWO PLACES, FOR A REASON THAT CANNOT BE REMOVED.
//
// cart-context is a client component and CART_RECOVERY_COOKIE lives beside a
// `server-only` import, so the constant cannot be imported there — the name is
// spelt out as a literal instead. That is a silent coupling: rename the cookie
// at its source and a recovered shopper quietly goes back to reading default
// shipping terms in their cart, with nothing failing anywhere.
//
// So the literal is pinned to the constant here.
// ---------------------------------------------------------------------------
describe("the recovery cookie name the cart reads", () => {
  it("matches the name the redirect actually sets", () => {
    const source = readFileSync(new URL("./cart-context.tsx", import.meta.url), "utf8");
    expect(source).toContain(`startsWith("${CART_RECOVERY_COOKIE}=")`);
  });
});
