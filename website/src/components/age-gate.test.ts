import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AGE_ATTESTATION_TEXT,
  AGE_GATE_STORAGE_KEY,
  RESEARCH_USE_ATTESTATION_TEXT,
} from "@/lib/attestation-text";
import { PUBLIC_EXACT } from "@/lib/access-policy";

// ---------------------------------------------------------------------------
// THE FRONT DOOR ASKS AGAIN.
//
// The wall used to do this by accident: every unauthenticated request answered
// 307, so a stranger never reached the home page. Opening "/" was right — with
// it closed, Twilio's toll-free verification could not validate the business
// website and this store's SMS programme was refused on that basis — but it
// left a research-peptide storefront's marketing in front of anyone, with
// nothing asked. Reported by the owner: "my home page is before my age gate".
//
// The gate is therefore CLIENT-SIDE. The server must still render and serve
// the whole page, or the fix re-creates the failure that opening "/" repaired.
// ---------------------------------------------------------------------------

const SRC = join(process.cwd(), "src");
const GATE = readFileSync(join(SRC, "components", "age-gate.tsx"), "utf8");
const HOME = readFileSync(join(SRC, "app", "page.tsx"), "utf8");

describe("it is mounted on the page that needed it", () => {
  it("the home page renders the gate", () => {
    expect(HOME).toContain('from "@/components/age-gate"');
    expect(HOME).toContain("<AgeGate />");
  });

  it("and the home page is still public, which is the whole constraint", () => {
    // If this ever flips back, the gate is redundant AND the SMS programme is
    // broken again. The two facts belong in one assertion.
    expect(PUBLIC_EXACT.has("/")).toBe(true);
  });

  it("is a client component, so the server still serves the page to a reviewer", () => {
    expect(GATE.startsWith('"use client"')).toBe(true);
    // A server-side gate would answer a stranger with an interstitial, which
    // is what Twilio rejected. The page must render whole and be covered after.
    expect(HOME, "the gate must not gate the RENDER").not.toMatch(/if \(!attested\)\s*return/);
  });
});

describe("what it asks", () => {
  it("the two statements, from the one place they are written", () => {
    expect(GATE).toContain("AGE_ATTESTATION_TEXT");
    expect(GATE).toContain("RESEARCH_USE_ATTESTATION_TEXT");
    // Retyped copies are two different representations in the record.
    expect(GATE).not.toContain(AGE_ATTESTATION_TEXT);
    expect(GATE).not.toContain(RESEARCH_USE_ATTESTATION_TEXT.slice(0, 40));
  });

  it("nothing is pre-ticked", () => {
    expect(GATE).toContain("useState(false)");
    expect(GATE).not.toContain("defaultChecked");
    expect(GATE).not.toMatch(/useState\(true\)/);
  });

  it("cannot be entered until both are ticked", () => {
    expect(GATE).toContain("disabled={!age || !research}");
    expect(GATE).toContain("if (!age || !research) return;");
  });

  it("offers a way to say no", () => {
    expect(GATE).toContain('data-testid="age-gate-decline"');
    expect(GATE).toContain("You cannot enter this site.");
  });
});

describe("how it behaves while it is up", () => {
  it("remembers the answer only after it is given", () => {
    const enter = GATE.slice(GATE.indexOf("const enter = useCallback"));
    const write = enter.indexOf(`setItem(AGE_GATE_STORAGE_KEY`);
    const guard = enter.indexOf("if (!age || !research) return;");
    expect(guard).toBeGreaterThan(-1);
    expect(write, "the answer is stored before it is given").toBeGreaterThan(guard);
  });

  it("fails to the ASKING side when storage is unreadable", () => {
    // Private mode, or blocked storage. One extra tap is the cheap error; the
    // other one shows this to somebody who never said they were 21.
    const reader = GATE.slice(GATE.indexOf("const readAttestation"));
    expect(reader.slice(0, 400)).toContain("return false;");
  });

  it("says ATTESTED on the server, so the page is served whole", () => {
    // The server has no localStorage to read. Guessing "not attested" would put
    // an interstitial in the HTML for Googlebot and for the carrier reviewer —
    // which is the failure opening "/" was meant to repair.
    expect(GATE).toContain("const attestedOnServer = () => true;");
    expect(GATE).toContain("useSyncExternalStore(subscribeToAttestation, readAttestation, attestedOnServer)");
  });

  it("stops the page behind it scrolling", () => {
    expect(GATE).toContain('document.body.style.overflow = "hidden"');
  });

  it("keeps focus inside, since it claims aria-modal", () => {
    // aria-modal tells assistive technology the rest of the page is hidden.
    // Without a trap that is untrue and a keyboard user tabs straight past it.
    expect(GATE).toContain('aria-modal="true"');
    expect(GATE).toContain('event.key !== "Tab"');
  });

  it("does not treat Escape as consent", () => {
    expect(GATE).not.toMatch(/key === "Escape"[^}]*setOpen\(false\)/);
  });
});

describe("the storage key", () => {
  it("is the shared constant, not a literal typed twice", () => {
    expect(GATE).toContain("AGE_GATE_STORAGE_KEY");
    expect(GATE).not.toContain(`"${AGE_GATE_STORAGE_KEY}"`);
  });
});
