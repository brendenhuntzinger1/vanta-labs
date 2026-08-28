import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The /vault shortcut is fixed to the bottom-right corner and rendered LAST in
// the document. At z-40 it tied with every full-width fixed bottom bar in the
// app and, being last, painted on top of them — swallowing taps on the
// bottom-right of each one. On /account (mobile) that corner is the "More"
// tab, which is the only way to reach Sign out, Addresses, Notifications,
// Settings, Support and Wishlist: all six were untappable on a phone. On
// /checkout it covered the corner of the pay button.
//
// These pin the invariant: the staff shortcut stacks BELOW the customer-facing
// bottom bars, never level with or above them.
//
// That ordering is no longer the primary defence — z-index only orders within
// one stacking context, and .vl2-lab-page's `isolation: isolate` trapped the
// product bar's z-50 inside the page, letting the shortcut win anyway (see
// staff-shortcut-never-steals-a-tap.test.ts, which covers the presence-based
// rule that replaced it). It is still the FALLBACK for Safari <15.4 and
// Chrome <105, which ignore :has(), so it must not regress.
const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");

const BOTTOM_BARS: Array<[string, string]> = [
  ["src/components/account-dashboard-nav.tsx", "account bottom nav"],
  ["src/components/product-detail-client.tsx", "product sticky CTA"],
  ["src/app/checkout/page.tsx", "checkout sticky CTA"],
];

function zOf(source: string, after: string) {
  const idx = source.indexOf(after);
  const window = source.slice(idx, idx + 400);
  const m = window.match(/\bz-(\d+)\b/);
  return m ? Number(m[1]) : null;
}

describe("fixed bottom-bar stacking on mobile", () => {
  const layout = read("src/app/layout.tsx");
  const vaultZ = zOf(layout, 'href="/vault"');

  it("gives the vault shortcut a z-index at all", () => {
    expect(vaultZ).not.toBeNull();
  });

  it.each(BOTTOM_BARS)("keeps the vault shortcut below the %s", (file) => {
    // Anchored on vl-cta-bar: the marker carried by exactly these three
    // full-width bars, and the hook the presence-based rule uses. The old
    // anchor was the literal "vl-bottom-bar fixed", which broke the moment a
    // class was inserted between the two words.
    const barZ = zOf(read(file), "vl-cta-bar");
    expect(barZ).not.toBeNull();
    expect(vaultZ as number).toBeLessThan(barZ as number);
  });

  it("still marks the shortcut vl-bottom-bar so the consent banner moves it", () => {
    // Without this class the link stays under the cookie banner, which is the
    // original reason it was given the class.
    const idx = layout.indexOf('href="/vault"');
    expect(layout.slice(idx, idx + 400)).toContain("vl-bottom-bar");
  });
});
