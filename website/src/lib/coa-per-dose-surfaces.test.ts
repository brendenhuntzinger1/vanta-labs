import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const library = read("src/app/coa-library/coa-library-client.tsx");
const admin = read("src/app/admin/coa/page.tsx");

describe("the public viewer walks a product's certificates dose by dose", () => {
  it("orders the documents by dose rather than by upload date", () => {
    expect(library).toContain("sort(compareCoaDocumentsByStrength)");
  });

  it("offers one pill per documented dose and previous/next across the set", () => {
    expect(library).toContain('aria-label="Dose"');
    expect(library).toContain('aria-label="Previous certificate"');
    expect(library).toContain('aria-label="Next certificate"');
  });

  it("heads the viewer with the dose of the certificate on screen, not the product default", () => {
    // A 5mg report under a "10mg" heading is a documentation error.
    expect(library).toContain("const activeStrength = activeDocument.strength ?? product.strength;");
    expect(library).toContain("{activeStrength ? <span");
  });

  it("lists the documented doses on the card", () => {
    expect(library).toContain('aria-label="Documented doses"');
  });
});

describe("admin can add one picture per dose in a single pass", () => {
  it("starts a draft row for every dose of the chosen product", () => {
    expect(admin).toContain("+ Add by dose");
    expect(admin).toContain("product.strengths.map((dose) => ({ ...emptyDraft(), productId, productDoseId: dose.id, strength: dose.label }))");
  });

  it("lets a picture be attached to a row after the row exists", () => {
    // Before this a file could only arrive by drag-and-drop, which created the
    // row; a row started from a product had nowhere to take one.
    expect(admin).toContain("onAttachFile(draft.key, file)");
    expect(admin).toContain("Add picture or PDF");
  });

  it("runs a late-attached picture through the same downscale as a dropped one", () => {
    const start = admin.indexOf("const attachDraftFile");
    const body = admin.slice(start, admin.indexOf("const saveDrafts"));
    expect(body).toContain("prepareCoaFile(file)");
  });

  it("cannot save an empty by-dose panel", () => {
    expect(admin).toContain("disabled={saving || incomplete || drafts.length === 0}");
  });
});
