import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// F-A-8 — A SAVINGS READ THAT FAILED MUST NOT RENDER AS "YOU SAVED NOTHING".
//
// getLifetimeSavings returned the same all-zero object for a customer who has
// genuinely saved nothing and for a read that errored or threw. The account
// dashboard renders its savings panel on `total > 0`, so a database that would
// not answer looked exactly like a new customer: the headline savings banner
// disappeared, and the "Lifetime saved" stat tile was quietly replaced by a
// Free shipping advert. The customer was told nothing was wrong and shown
// marketing in place of their own money.
//
// The same screen already had the right pattern two tiles over — point balance
// renders "—" over "Couldn't load right now" when its read returns null. This
// is that, for savings, and this file is the guard that it stays that way.
//
// The VALUE contract (available: false on failure, true on success) is driven
// end to end against a supabase double in points-rate-surfaces.test.ts. What is
// asserted here is the half that lives in JSX and would otherwise be guarded by
// nothing: that the page actually branches on the flag, in BOTH places, and
// does not quietly go back to keying a money panel off `total > 0` alone.
// ---------------------------------------------------------------------------

const PAGE = "src/app/account/(dashboard)/page.tsx";

function pageSource(): string {
  return readFileSync(resolve(process.cwd(), PAGE), "utf8");
}

/**
 * Comment lines stripped, because the prose above this fix — and in the page
 * itself — quotes the very expression being banned. A source assertion that
 * matches its own explanation is an assertion that cannot fail.
 */
function pageCode(): string {
  return pageSource()
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("{/*"));
    })
    .join("\n");
}

describe("F-A-8: the account dashboard distinguishes an unavailable savings read from zero", () => {
  it("renders the 'Lifetime saved' tile rather than a shipping advert when the read failed", () => {
    const code = pageCode();

    // The unavailable branch exists, keeps the customer's own label, and says
    // so in the words the sibling tile already uses.
    expect(code).toMatch(/!lifetimeSavings\.available \?/);
    expect(code).toMatch(/label="Lifetime saved" value="—"/);
    expect(code).toContain("Couldn't load right now");
  });

  it("never keys a savings surface off total alone", () => {
    // The defect, stated as source: `lifetimeSavings.total > 0` reached on its
    // own, with no availability check in front of it. Both surfaces — the
    // headline banner and the stat tile — must be guarded.
    const code = pageCode();

    for (const match of code.matchAll(/lifetimeSavings\.total > 0/g)) {
      const before = code.slice(Math.max(0, match.index - 200), match.index);
      expect(
        /lifetimeSavings\.available/.test(before),
        `\`lifetimeSavings.total > 0\` at offset ${match.index} is not guarded by an availability check`,
      ).toBe(true);
    }

    // And the guard is actually reached twice — the banner and the tile — so a
    // future edit cannot satisfy the loop above by deleting one of them.
    expect([...code.matchAll(/lifetimeSavings\.available/g)]).toHaveLength(2);
  });

  it("still shows the free-shipping tile to a customer who has genuinely saved nothing", () => {
    // The fix must not turn every new customer's tile into an error state.
    // available && total === 0 is a real answer and keeps the marketing tile.
    const code = pageCode();
    expect(code).toContain("freeShippingThreshold");
    expect(code).toMatch(/lifetimeSavings\.total > 0 \? \(\s*<StatTile label="Lifetime saved" value=\{money/);
  });
});
