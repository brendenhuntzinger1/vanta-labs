import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { resolveOverridePerks } from "@/lib/cart-recovery-overrides";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
/** Strip comments: the notes below quote the very strings they ban. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");

// ---------------------------------------------------------------------------
// "FREE SHIPPING / FREE SHIPPING / 2-DAY SHIPPING, ON US"
//
// The store adds "Free shipping" when the sitewide switch is on, and the
// operator typed it into the perks of every override row waiting to send. Both
// halves are reasonable; together they printed the same promise twice.
//
// THE PART WORTH REMEMBERING IS NOT THE DUPLICATE. It is that the sweep and the
// admin resend each built this list with their own copy of the same two lines.
// Fixing the sweep looked like fixing the bug, and left the resend — the button
// an operator actually presses, on the highest-value cart in the store —
// shipping the duplicate an hour before it was due to go out.
//
// So the rule is one function, and this file holds both callers to it.
// ---------------------------------------------------------------------------

describe("resolveOverridePerks", () => {
  it("says a perk once when the store and the operator both offer it", () => {
    expect(resolveOverridePerks(["Free shipping", "2-day shipping, on us"], true))
      .toEqual(["Free shipping", "2-day shipping, on us"]);
  });

  it("collapses casing and stray whitespace, which is how a human types it", () => {
    expect(resolveOverridePerks(["  free SHIPPING ", "2-day shipping, on us"], true))
      .toEqual(["Free shipping", "2-day shipping, on us"]);
  });

  // FIRST OCCURRENCE WINS, and with the switch on the store's line is first.
  // Either way the shopper reads one promise, which is the point.
  it("keeps the operator's own wording when the store adds nothing", () => {
    expect(resolveOverridePerks(["FREE SHIPPING", "2-day shipping, on us"], false))
      .toEqual(["FREE SHIPPING", "2-day shipping, on us"]);
  });

  it("adds the store's perk when the operator did not list it", () => {
    expect(resolveOverridePerks(["2-day shipping, on us"], true))
      .toEqual(["Free shipping", "2-day shipping, on us"]);
  });

  it("claims nothing about shipping when the store is not giving it", () => {
    expect(resolveOverridePerks(["2-day shipping, on us"], false))
      .toEqual(["2-day shipping, on us"]);
  });

  it("drops blanks rather than rendering an empty bullet", () => {
    expect(resolveOverridePerks(["", "   ", "2-day shipping, on us"], false))
      .toEqual(["2-day shipping, on us"]);
  });

  it("survives an empty list", () => {
    expect(resolveOverridePerks([], true)).toEqual(["Free shipping"]);
    expect(resolveOverridePerks([], false)).toEqual([]);
  });
});

describe("both senders build the list the same way", () => {
  // The sweep, and the admin Resend button. Named individually rather than
  // globbed, because the failure this prevents is a THIRD sender appearing with
  // its own copy — and a glob would quietly pass that.
  it.each([
    ["the sweep", "src/lib/cart-recovery.ts"],
    ["the admin resend", "src/lib/admin-cart-recovery.ts"],
  ])("%s calls resolveOverridePerks", (_label, path) => {
    expect(code(read(path))).toContain("resolveOverridePerks(override.perks");
  });

  it.each([
    ["the sweep", "src/lib/cart-recovery.ts"],
    ["the admin resend", "src/lib/admin-cart-recovery.ts"],
  ])("%s no longer unshifts the perk itself", (_label, path) => {
    expect(code(read(path))).not.toContain('unshift("Free shipping")');
  });
});
