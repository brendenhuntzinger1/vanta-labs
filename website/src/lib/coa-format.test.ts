import { describe, expect, it } from "vitest";
import {
  buildCoaStoragePath,
  coaFileKindFromMime,
  coaSearchHaystack,
  coaStrengthKey,
  compareCoaDocuments,
  compareCoaDocumentsByStrength,
  formatCoaFileSize,
  formatCoaPurity,
  formatCoaTestDate,
  formatCoaTextResult,
  listCoaStrengths,
  matchesCoaSearch,
  normalizeCoaDateInput,
  normalizeCoaStatus,
  normalizeCoaText,
  parseCoaStrengthValue,
  sniffCoaFileType,
  slugifyCoaSegment,
} from "@/lib/coa-format";
import type { PublicCoaDocument } from "@/lib/coa-types";

function bytes(...values: number[]): Uint8Array {
  // Pad to 12 so the WEBP check has something to read; sniffing rejects
  // anything shorter than a full magic-number window.
  const out = new Uint8Array(16);
  out.set(values);
  return out;
}

describe("normalizeCoaStatus", () => {
  it("keeps the three real states", () => {
    expect(normalizeCoaStatus("published")).toBe("published");
    expect(normalizeCoaStatus("draft")).toBe("draft");
    expect(normalizeCoaStatus("archived")).toBe("archived");
  });

  // A typo'd or hostile status must never resolve to "published" — that is the
  // one value that puts a document in front of customers.
  it("falls back to draft for anything unrecognised", () => {
    expect(normalizeCoaStatus("live")).toBe("draft");
    expect(normalizeCoaStatus("PUBLISHED ")).toBe("published");
    expect(normalizeCoaStatus(null)).toBe("draft");
    expect(normalizeCoaStatus(undefined)).toBe("draft");
    expect(normalizeCoaStatus(42)).toBe("draft");
  });
});

describe("sniffCoaFileType", () => {
  it("recognises the four accepted document formats", () => {
    expect(sniffCoaFileType(bytes(0x25, 0x50, 0x44, 0x46))).toBe("application/pdf");
    expect(sniffCoaFileType(bytes(0x89, 0x50, 0x4e, 0x47))).toBe("image/png");
    expect(sniffCoaFileType(bytes(0xff, 0xd8, 0xff))).toBe("image/jpeg");
    const webp = bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50);
    expect(sniffCoaFileType(webp)).toBe("image/webp");
  });

  // The declared Content-Type on a multipart upload is attacker-controlled, and
  // it decides how the object is served back. Bytes are the only honest source.
  it("rejects content that merely claims to be a document", () => {
    const html = new TextEncoder().encode("<html><script>alert(1)</script>");
    expect(sniffCoaFileType(html)).toBeNull();
    const svg = new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'>");
    expect(sniffCoaFileType(svg)).toBeNull();
  });

  it("rejects a file too short to identify", () => {
    expect(sniffCoaFileType(new Uint8Array([0x25, 0x50]))).toBeNull();
    expect(sniffCoaFileType(new Uint8Array())).toBeNull();
  });
});

describe("coaFileKindFromMime", () => {
  it("maps documents to how they should be rendered", () => {
    expect(coaFileKindFromMime("application/pdf")).toBe("pdf");
    expect(coaFileKindFromMime("image/png")).toBe("image");
    expect(coaFileKindFromMime("image/jpg")).toBe("image");
    expect(coaFileKindFromMime("IMAGE/JPEG")).toBe("image");
  });

  it("returns null for anything else", () => {
    expect(coaFileKindFromMime("text/html")).toBeNull();
    expect(coaFileKindFromMime(null)).toBeNull();
  });
});

describe("buildCoaStoragePath", () => {
  it("produces a readable, navigable object key", () => {
    expect(
      buildCoaStoragePath({
        productSlug: "bpc-157",
        batchNumber: "VL-BPC-0826",
        uniqueId: "abc123",
        mime: "application/pdf",
      }),
    ).toBe("bpc-157/vl-bpc-0826/abc123.pdf");
  });

  // Batch numbers are typed by hand. A slash or a `..` in one must not be able
  // to steer the upload out of its folder.
  it("strips path separators and traversal out of every segment", () => {
    const path = buildCoaStoragePath({
      productSlug: "../../etc",
      batchNumber: "a/../../b",
      uniqueId: "id",
      mime: "image/png",
    });
    expect(path).toBe("etc/a-b/id.png");
    expect(path).not.toContain("..");
    expect(path.split("/")).toHaveLength(3);
  });

  it("falls back rather than producing an empty segment", () => {
    expect(buildCoaStoragePath({ productSlug: "", batchNumber: "***", uniqueId: "", mime: "image/jpeg" }))
      .toBe("product/batch/file.jpg");
  });
});

describe("slugifyCoaSegment", () => {
  it("lowercases, hyphenates, and caps length", () => {
    expect(slugifyCoaSegment("  Batch 0826 A  ", "x")).toBe("batch-0826-a");
    expect(slugifyCoaSegment("!!!", "fallback")).toBe("fallback");
    expect(slugifyCoaSegment("a".repeat(200), "x")).toHaveLength(60);
  });
});

describe("formatCoaPurity", () => {
  it("adds the unit to a bare number so results read consistently", () => {
    expect(formatCoaPurity("99.2")).toBe("99.2%");
    expect(formatCoaPurity("99.2%")).toBe("99.2%");
    expect(formatCoaPurity("≥99%")).toBe("≥99%");
  });

  // THE RULE THIS FILE EXISTS FOR: an operator placeholder is not a result.
  // Rendering "Pending" in a Purity slot makes the page look like it is
  // reporting a measurement it does not have.
  it.each(["", "  ", "N/A", "n/a", "none", "pending", "TBD", "unknown", "--"])(
    "treats %s as no documented purity",
    (value) => {
      expect(formatCoaPurity(value)).toBeNull();
    },
  );

  it("treats missing values as no documented purity", () => {
    expect(formatCoaPurity(null)).toBeNull();
    expect(formatCoaPurity(undefined)).toBeNull();
  });
});

describe("formatCoaTextResult", () => {
  it("keeps a real identity result and drops placeholders", () => {
    expect(formatCoaTextResult("Conforms — MS")).toBe("Conforms — MS");
    expect(formatCoaTextResult("pending")).toBeNull();
    expect(formatCoaTextResult("   ")).toBeNull();
  });
});

describe("formatCoaTestDate", () => {
  // `new Date("2026-08-04")` is midnight UTC, which renders as Aug 3 for every
  // viewer west of Greenwich. A testing date that reads a day early is a
  // documentation error, so the value is parsed as a calendar date.
  it("renders the stored calendar date, not a UTC instant", () => {
    expect(formatCoaTestDate("2026-08-04")).toBe("Aug 4, 2026");
    expect(formatCoaTestDate("2026-01-01")).toBe("Jan 1, 2026");
    expect(formatCoaTestDate("2026-12-31T00:00:00Z")).toBe("Dec 31, 2026");
  });

  it("returns null rather than an Invalid Date string", () => {
    expect(formatCoaTestDate("")).toBeNull();
    expect(formatCoaTestDate(null)).toBeNull();
    expect(formatCoaTestDate("March 2024")).toBeNull();
    expect(formatCoaTestDate("04/08/2026")).toBeNull();
  });
});

describe("normalizeCoaDateInput", () => {
  it("keeps only the date portion the column stores", () => {
    expect(normalizeCoaDateInput("2026-08-04")).toBe("2026-08-04");
    expect(normalizeCoaDateInput("2026-08-04T10:00:00Z")).toBe("2026-08-04");
    expect(normalizeCoaDateInput("")).toBeNull();
    expect(normalizeCoaDateInput("not a date")).toBeNull();
  });
});

describe("normalizeCoaText", () => {
  it("collapses whitespace and caps length", () => {
    expect(normalizeCoaText("  VL   BPC  0826 ")).toBe("VL BPC 0826");
    expect(normalizeCoaText(null)).toBe("");
    expect(normalizeCoaText("a".repeat(300), 10)).toHaveLength(10);
  });
});

describe("formatCoaFileSize", () => {
  it("reports a size an operator can act on", () => {
    expect(formatCoaFileSize(900)).toBe("900 B");
    expect(formatCoaFileSize(2048)).toBe("2 KB");
    expect(formatCoaFileSize(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it("returns null when there is no size to report", () => {
    expect(formatCoaFileSize(0)).toBeNull();
    expect(formatCoaFileSize(null)).toBeNull();
    expect(formatCoaFileSize(Number.NaN)).toBeNull();
  });
});

const doc = (overrides: Partial<PublicCoaDocument>): PublicCoaDocument => ({
  id: "1",
  batchNumber: "VL-BPC-0826",
  lotNumber: null,
  strength: "10mg",
  labName: "Janoshik",
  testDate: "2026-08-04",
  purity: "99.2%",
  identityResult: null,
  fileKind: "pdf",
  hasFile: true,
  ...overrides,
});

describe("coaSearchHaystack / matchesCoaSearch", () => {
  const haystack = coaSearchHaystack({
    name: "BPC-157",
    category: "Research Peptides",
    slug: "bpc-157",
    strength: "10mg",
    documents: [doc({}), doc({ id: "2", batchNumber: "VL-BPC-0926", lotNumber: "L-441" })],
  });

  it("finds a product by name, batch, lot, lab, or strength", () => {
    expect(matchesCoaSearch(haystack, "bpc")).toBe(true);
    expect(matchesCoaSearch(haystack, "0926")).toBe(true);
    expect(matchesCoaSearch(haystack, "L-441")).toBe(true);
    expect(matchesCoaSearch(haystack, "janoshik")).toBe(true);
    expect(matchesCoaSearch(haystack, "10MG")).toBe(true);
  });

  // Terms are ANDed, so a second word narrows instead of widening — otherwise
  // "bpc 0826" would match every batch of every product containing "bpc".
  it("requires every term to match", () => {
    expect(matchesCoaSearch(haystack, "bpc 0826")).toBe(true);
    expect(matchesCoaSearch(haystack, "bpc 9999")).toBe(false);
  });

  it("treats an empty query as matching everything", () => {
    expect(matchesCoaSearch(haystack, "")).toBe(true);
    expect(matchesCoaSearch(haystack, "   ")).toBe(true);
  });
});

describe("compareCoaDocuments", () => {
  it("puts the newest batch first", () => {
    const sorted = [
      doc({ id: "old", batchNumber: "A", testDate: "2026-01-01" }),
      doc({ id: "new", batchNumber: "B", testDate: "2026-08-04" }),
    ].sort(compareCoaDocuments);
    expect(sorted.map((item) => item.id)).toEqual(["new", "old"]);
  });

  // An undated record is the least trustworthy thing in the list; it must never
  // outrank a batch that carries a real testing date.
  it("sorts undated records last, then by batch number", () => {
    const sorted = [
      doc({ id: "undated-b", batchNumber: "B", testDate: null }),
      doc({ id: "dated", batchNumber: "C", testDate: "2026-01-01" }),
      doc({ id: "undated-a", batchNumber: "A", testDate: null }),
    ].sort(compareCoaDocuments);
    expect(sorted.map((item) => item.id)).toEqual(["dated", "undated-a", "undated-b"]);
  });
});

describe("parseCoaStrengthValue", () => {
  it("reads the number out of a dose label, in milligrams", () => {
    expect(parseCoaStrengthValue("5mg")).toBe(5);
    expect(parseCoaStrengthValue("2.5 mg")).toBe(2.5);
    expect(parseCoaStrengthValue("10 MG")).toBe(10);
  });

  it("scales micrograms and grams so mixed units still order by dose", () => {
    expect(parseCoaStrengthValue("500mcg")).toBe(0.5);
    expect(parseCoaStrengthValue("250µg")).toBe(0.25);
    expect(parseCoaStrengthValue("1g")).toBe(1000);
  });

  it("returns null when the label carries no number", () => {
    expect(parseCoaStrengthValue("")).toBeNull();
    expect(parseCoaStrengthValue(null)).toBeNull();
    expect(parseCoaStrengthValue("Standard")).toBeNull();
  });
});

describe("compareCoaDocumentsByStrength", () => {
  it("walks the doses from lowest to highest, by value rather than by text", () => {
    // "10mg" sorts before "5mg" as a string; a reader stepping through the
    // doses expects 2.5 → 5 → 10, the order the product's own selector uses.
    const sorted = [
      doc({ id: "ten", strength: "10mg", batchNumber: "A" }),
      doc({ id: "five", strength: "5mg", batchNumber: "B" }),
      doc({ id: "two-five", strength: "2.5mg", batchNumber: "C" }),
    ].sort(compareCoaDocumentsByStrength);
    expect(sorted.map((item) => item.id)).toEqual(["two-five", "five", "ten"]);
  });

  it("keeps the newest batch first within one dose", () => {
    const sorted = [
      doc({ id: "five-old", strength: "5mg", batchNumber: "A", testDate: "2026-01-01" }),
      doc({ id: "ten", strength: "10mg", batchNumber: "B", testDate: "2026-08-01" }),
      doc({ id: "five-new", strength: "5mg", batchNumber: "C", testDate: "2026-07-01" }),
    ].sort(compareCoaDocumentsByStrength);
    expect(sorted.map((item) => item.id)).toEqual(["five-new", "five-old", "ten"]);
  });

  it("treats the same dose written differently as one dose", () => {
    const sorted = [
      doc({ id: "b", strength: "5 mg", batchNumber: "B", testDate: "2026-01-01" }),
      doc({ id: "a", strength: "5mg", batchNumber: "A", testDate: "2026-02-01" }),
    ].sort(compareCoaDocumentsByStrength);
    expect(sorted.map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("sends records with no dose to the end, newest first", () => {
    const sorted = [
      doc({ id: "none-old", strength: null, batchNumber: "A", testDate: "2026-01-01" }),
      doc({ id: "none-new", strength: null, batchNumber: "B", testDate: "2026-06-01" }),
      doc({ id: "ten", strength: "10mg", batchNumber: "C", testDate: "2025-01-01" }),
    ].sort(compareCoaDocumentsByStrength);
    expect(sorted.map((item) => item.id)).toEqual(["ten", "none-new", "none-old"]);
  });
});

describe("listCoaStrengths", () => {
  it("lists each documented dose once, in dose order", () => {
    const strengths = listCoaStrengths([
      doc({ id: "1", strength: "10mg" }),
      doc({ id: "2", strength: "5mg" }),
      doc({ id: "3", strength: "5 mg" }),
      doc({ id: "4", strength: null }),
      doc({ id: "5", strength: "15mg" }),
    ]);
    expect(strengths).toEqual(["5mg", "10mg", "15mg"]);
  });

  it("is empty when no record names a dose", () => {
    expect(listCoaStrengths([doc({ id: "1", strength: null })])).toEqual([]);
  });
});

describe("coaStrengthKey", () => {
  it("collapses spacing and case so grouping matches what a reader means", () => {
    expect(coaStrengthKey("5 mg")).toBe(coaStrengthKey("5MG"));
    expect(coaStrengthKey(null)).toBe("");
  });
});
