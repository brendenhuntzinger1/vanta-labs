import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const coa = read("src/lib/coa.ts");
const types = read("src/lib/coa-types.ts");

// ---------------------------------------------------------------------------
// THE COMPOUND IS NAMED ON THE CERTIFICATE, AND NOWHERE THE CERTIFICATE ISN'T.
//
// This catalogue lists GLP-1, GLP-2 and GLP-3 and puts the compound identity on
// the Certificate of Analysis, which is the document whose entire job is to
// establish identity. Semaglutide, tirzepatide and retatrutide appear on those
// PDFs and in the filenames they download as.
//
// What the stored filename must NOT do is travel to the browser. It used to:
// toPublicDocument copied file_name into the public shape, Next serialised that
// into the RSC payload of every product page and the COA library, and nothing
// rendered it. Measured on production 2026-09-05 before the change —
// /products/glp-1 carried four occurrences of "Semaglutide" in its HTML and
// zero in its rendered text, even with the COA panel opened.
//
// That is the worst of both: invisible to the customer it would inform, and
// perfectly legible to anything reading the source. The fix is not to hide the
// compound — the certificate still names it — but to stop publishing it to
// machines only.
// ---------------------------------------------------------------------------

describe("the public COA shape carries no stored filename", () => {
  it("toPublicDocument does not copy file_name", () => {
    const fn = coa.slice(coa.indexOf("function toPublicDocument"), coa.indexOf("async function fetchPublishedCoaRows"));
    const code = fn.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");
    expect(code).not.toContain("fileName:");
    expect(code).not.toContain("row.file_name");
  });

  it("PublicCoaDocument has no fileName field, so it cannot return by accident", () => {
    const shape = types.slice(types.indexOf("identityResult: string | null;"), types.indexOf("};", types.indexOf("identityResult: string | null;")));
    const code = shape.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");
    expect(code).not.toContain("fileName");
    // The fields that DO belong to a public certificate summary stay.
    expect(code).toContain("hasFile");
    expect(code).toContain("fileKind");
  });
});

describe("the certificate itself still names the compound", () => {
  it("the download keeps the real stored filename", () => {
    // This is the half that must NOT change. A customer opening the COA gets
    // Semaglutide_Vanta184290_COA.pdf, which is how identity is disclosed here.
    const dl = coa.slice(coa.indexOf("const fileName = row.file_name"));
    expect(dl.slice(0, 900)).toContain("row.file_name");
    expect(dl.slice(0, 900)).toContain("download: fileName");
  });

  it("the admin shape still carries filenames, because admin lists files by name", () => {
    const adminShape = types.slice(types.indexOf("status: CoaStatus;"));
    expect(adminShape.slice(0, 400)).toContain("fileName");
  });
});
