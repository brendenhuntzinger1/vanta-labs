import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// EVERY CUSTOMER-FACING STRING CLEARS WCAG AA ON THIS SITE'S BACKGROUND.
//
// The audit's a11y sweep reported nine contrast failures. It reported nine
// because it kept four per route and printed two of them. Measured exhaustively
// in the same browser with the same maths, there were ONE HUNDRED AND
// THIRTY-ONE, across the product page, research, cart, checkout, the COA
// library, membership and every page of the account area. Checkout alone had
// twenty-nine, including "Secure checkout" at 3.15:1 and the line explaining
// the totals at 4.48:1.
//
// The cause was uniform and structural, not nine mistakes: dimmed white on a
// near-black ground. The site's quiet register ran text-white/25 through /45,
// and on backgrounds from rgb(5) to rgb(26) those land between 2.1:1 and
// 4.49:1 — every one of them under the 4.5:1 body-text floor.
//
// The arithmetic, on the LIGHTEST panel the site composites (about rgb(42),
// which is bg-white/5 over #111):
//
//     text-white/45   4.36:1   under
//     text-white/50   4.79:1   over, everywhere, with margin
//     text-zinc-500   3.60:1   under, even on pure #0a0a0a
//     text-zinc-400   6.79:1   over
//
// So /50 is the floor, and it is a floor rather than a per-element judgement:
// mapping every failing step onto one value cannot invert the hierarchy the way
// a per-tier bump would (a /45 caption lifted to /60 would have ended up
// brighter than a /55 heading beside it).
//
// This test guards the tokens rather than the pixels, because the pixels need a
// browser and this needs to fail in under a second in CI, on the commit that
// reintroduces one. The pixel check is qa-admin-and-a11y-sweep.mjs.
//
// EXEMPT, deliberately, and only these:
//   * aria-hidden decoration. /research draws a ghosted serif ordinal behind
//     each card and /wholesale a ghosted wordmark where a photo would go.
//     WCAG 1.4.3 names pure decoration as incidental; axe-core skips anything
//     out of the accessibility tree for the same reason. Both are marked.
//   * the staff shortcut in the root layout, which is deliberately almost
//     invisible to customers and is not customer copy.
//   * the admin area, which no customer reaches and which this sweep never
//     measured. Not "fine" — unmeasured, and stated as such rather than
//     quietly folded in.
// ---------------------------------------------------------------------------

const SRC = resolve(process.cwd(), "src");

/** Below 4.5:1 on this site's backgrounds. Measured, not assumed. */
const SUB_AA = [
  // White at an alpha too low to read: /45 is 4.36:1 on the lightest panel.
  /\btext-white\/(?:[1-9]|[1-3][0-9]|4[0-9])\b/,
  // Tailwind zinc-500 is 3.60:1 on #1a1a1a and 4.07:1 on #0b0b0b.
  /\btext-zinc-500\b/,
  // The accent at /60 is 3.72:1; /70 is 4.59:1 and too close to the line.
  /text-\[color:var\(--accent-gold[a-z-]*\)\]\/(?:[1-9]|[1-6][0-9]|7[0-4])\b/,
];

const EXEMPT = new Set([
  // The staff shortcut, and nothing else in the root layout.
  join(SRC, "app", "layout.tsx"),
]);

function customerFacingFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "admin" || entry === "node_modules") continue;
      customerFacingFiles(full, out);
      continue;
    }
    if (!entry.endsWith(".tsx")) continue;
    if (entry.startsWith("admin-")) continue;
    if (entry.endsWith(".test.tsx")) continue;
    if (EXEMPT.has(full)) continue;
    out.push(full);
  }
  return out;
}

/** Strip the JSX elements that carry aria-hidden, so decoration is not judged. */
function withoutDecoration(source: string): string {
  return source
    .split("\n")
    .filter((line, i, lines) => {
      if (/aria-hidden=["{]?["']?true/.test(line)) return false;
      // An attribute list wrapped across lines: the className may sit a few
      // lines below the aria-hidden that governs it.
      for (let back = 1; back <= 3 && i - back >= 0; back += 1) {
        const prior = lines[i - back];
        if (/aria-hidden=["{]?["']?true/.test(prior) && !/\/?>\s*$/.test(prior)) return false;
      }
      return true;
    })
    .join("\n");
}

describe("no customer-facing text sits below WCAG AA contrast", () => {
  const files = customerFacingFiles(SRC);

  it("finds the customer-facing components at all", () => {
    // A broken walk would make every assertion below vacuously true.
    expect(files.length).toBeGreaterThan(120);
    expect(files.some((f) => f.endsWith(join("app", "checkout", "page.tsx")))).toBe(true);
    expect(files.some((f) => f.endsWith(join("components", "cart-context.tsx")) || f.includes("cart"))).toBe(true);
  });

  it("uses no white text below text-white/50", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const body = withoutDecoration(readFileSync(file, "utf8"));
      for (const line of body.split("\n")) {
        const hit = line.match(SUB_AA[0]);
        if (hit) offenders.push(`${file.slice(SRC.length + 1)}: ${hit[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("uses no text-zinc-500, which is 3.60:1 on a dark panel", () => {
    const offenders = files
      .filter((file) => SUB_AA[1].test(readFileSync(file, "utf8")))
      .map((file) => file.slice(SRC.length + 1));
    expect(offenders).toEqual([]);
  });

  it("uses no accent-gold text below /75", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const body = withoutDecoration(readFileSync(file, "utf8"));
      for (const line of body.split("\n")) {
        const hit = line.match(SUB_AA[2]);
        if (hit) offenders.push(`${file.slice(SRC.length + 1)}: ${hit[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("declares no dim white text in the stylesheet either", () => {
    // HALF THE DEFECT LIVED OUTSIDE TAILWIND. The COA library's "Documentation
    // Pending" badge is `color: rgba(255,255,255,0.44)` in globals.css, on a
    // gradient card — 4.28:1, and invisible to every check above because there
    // is no class to grep. It was invisible to the browser sweep too until the
    // probe learned to composite gradients instead of stepping over them.
    //
    // Only `color` and `-webkit-text-fill-color` are text. border-color and
    // background at low alpha are hairlines and washes, and 1.4.3 does not
    // reach them.
    const css = readFileSync(join(SRC, "app", "globals.css"), "utf8");
    const offenders: string[] = [];
    // `border-color` ends in "color", so the property has to be anchored.
    const rule = /(?:(?<![-\w])color|-webkit-text-fill-color)\s*:\s*rgba\(\s*255\s*,\s*255\s*,\s*255\s*,\s*(0?\.\d+)\s*\)/g;
    for (const match of css.matchAll(rule)) {
      if (Number(match[1]) < 0.5) offenders.push(match[0]);
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the lab eyebrow above the floor in the stylesheet", () => {
    // .vl2-lab-eyebrow is the product page's "Frequently Asked Questions",
    // "Vial Size" and "Quantity" labels. #6b6b64 measured 3.43:1 on the panel
    // it sits on; #8a8a82 measures 5.00:1 there and keeps the warm neutral.
    const css = readFileSync(join(SRC, "app", "globals.css"), "utf8");
    expect(css).toContain("#8a8a82");
    expect(css).not.toContain("#6b6b64");
  });
});
