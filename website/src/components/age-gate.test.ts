import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

// ---------------------------------------------------------------------------
// The gate is the first thing every visitor meets and the one thing on the site
// that must never be weakened.
//
// It previously REMEMBERED confirmation for 30 days, in localStorage with a
// cookie mirror. A returning visitor reached the storefront without being asked
// again, and a shared or previously-used device carried one person's
// attestation to whoever picked it up next. The owner reported reaching the
// store with no gate at all, which is exactly that behaviour working as built.
//
// Age verification is no longer persisted anywhere. These rules exist so it
// cannot quietly come back.
// ---------------------------------------------------------------------------

describe("age verification is never remembered", () => {
  const gate = read("src/components/age-gate.tsx");
  const layout = read("src/app/layout.tsx");

  it("never READS a stored answer from anywhere", () => {
    // The whole class of bypass: any read of a previous session's answer.
    expect(gate).not.toMatch(/localStorage\.getItem/);
    expect(gate).not.toMatch(/sessionStorage/);
    // The only permitted cookie reference is the removal on exit, below.
    expect(gate).not.toMatch(/document\.cookie\.split/);
    expect(gate).not.toMatch(/useSyncExternalStore/);
  });

  it("never WRITES an answer that could outlive the page", () => {
    expect(gate).not.toMatch(/localStorage\.setItem/);
    // A cookie may only be CLEARED (max-age=0), never set to a live value.
    const cookieWrites = gate.match(/document\.cookie\s*=\s*"[^"]*"/g) ?? [];
    for (const w of cookieWrites) {
      expect(w, `a cookie is being set to a live value: ${w}`).toMatch(/max-age=0/);
    }
  });

  it("the root layout no longer reads storage before paint", () => {
    // The pre-paint script existed only to read the stored answer. With nothing
    // to read it is gone, and the attribute is a server-rendered constant.
    expect(layout).not.toMatch(/localStorage\.getItem\("vanta-labs-age-verified"\)/);
    expect(layout).toMatch(/data-age-verified="false"/);
  });

  it("still clears any flag left behind by the old persisted version", () => {
    // A visitor who confirmed under the previous implementation may still be
    // carrying a 30-day token. Exiting removes it rather than leaving it to
    // expire on its own.
    expect(gate).toContain('localStorage.removeItem("vanta-labs-age-verified")');
    expect(gate).toMatch(/vl_age_verified=; path=\/; max-age=0/);
  });

  it("holds the answer only in component state for this document", () => {
    // The answer is component state plus the staff-area exemption below —
    // never a stored value.
    expect(gate).toMatch(/const isVerified = localVerified \|\| isStaffArea;/);
    expect(gate).toMatch(/useState\(false\)/);
  });
});

describe("the gate fails closed and locks the page behind it", () => {
  const css = read("src/app/globals.css");
  const layout = read("src/app/layout.tsx");
  const gate = read("src/components/age-gate.tsx");

  it("only an explicit \"true\" can hide the gate", () => {
    // Keyed off ="true", never off the ABSENCE of the attribute, so a thrown
    // error or disabled JavaScript shows the gate rather than hiding it.
    expect(css).toMatch(/html\[data-age-verified="true"\]\s*\[data-age-gate\]\s*\{\s*display:\s*none/);
    expect(css).not.toMatch(/html:not\(\[data-age-verified\]\)\s*\[data-age-gate\]/);
  });

  it("every document is served unverified", () => {
    expect(layout).toMatch(/data-age-verified="false"/);
    expect(layout).not.toMatch(/data-age-verified="true"/);
  });

  it("locks scrolling from the first paint, not from hydration", () => {
    expect(css).toMatch(/html\[data-age-verified="false"\]\s*body\s*\{\s*overflow:\s*hidden/);
  });

  it("keeps the attribute in step with React so the lock releases on accept", () => {
    expect(gate).toMatch(/setAttribute\("data-age-verified",\s*isVerified \? "true" : "false"\)/);
  });

  it("still requires all four attestations before entry", () => {
    expect(gate).toContain("const agreed = ATTESTATIONS.every((a) => confirmed[a.id]);");
    expect(gate).toMatch(/disabled=\{!agreed\}/);
    const ids = gate.match(/\{\s*id:\s*"/g) ?? [];
    expect(ids.length).toBe(4);
  });

  it("exempts the staff areas, and ONLY the staff areas", () => {
    // /admin and /vault are behind authentication and are not customer facing.
    // Since confirmation is no longer remembered for anyone, gating them would
    // mean re-attesting on every admin page load during order and inventory
    // work, for no protective benefit.
    expect(gate).toContain('const STAFF_ONLY = ["/admin", "/vault"];');
    expect(gate).toMatch(/const isVerified = localVerified \|\| isStaffArea;/);
    // Nothing a shopper can reach may appear in that list.
    for (const shopper of ["/products", "/cart", "/checkout", "/account", "/membership", "/ambassador"]) {
      expect(gate, `${shopper} must never be exempt from the gate`)
        .not.toMatch(new RegExp(`STAFF_ONLY[^\\]]*${shopper}`));
    }
  });

  it("marks the overlay so the pre-paint CSS can find it", () => {
    expect(gate).toContain('data-age-gate="true"');
  });

  it("gates the storefront but never the APIs", () => {
    // The gate is a client overlay inside the root layout's body. API routes,
    // webhooks and payment callbacks live outside React entirely and must stay
    // that way — gating them would break the processor and Shippo.
    expect(layout).toContain("<AgeGate>");
    expect(layout).not.toMatch(/AgeGate[\s\S]{0,200}\/api\//);
  });
});
