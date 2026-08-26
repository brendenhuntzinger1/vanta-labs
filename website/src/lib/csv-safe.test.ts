import { describe, expect, it } from "vitest";
import { csvSafeCell } from "@/lib/csv-safe";

// ---------------------------------------------------------------------------
// I-08. Eight separate CSV escapers exist in this codebase. Four neutralise
// spreadsheet formula injection and four only quote:
//
//   GUARDED   api/admin/orders/export/route.ts:7   csvEscape
//             lib/admin-customers.ts:160           csvEscape
//             lib/admin-membership.ts:697          csvEscape
//             lib/inventory-ledger.ts:180          csvCell   (already exported)
//
//   UNGUARDED api/admin/partners/export-payouts/route.ts:6         escapeCsv
//             api/admin/partners/export-payout-history/route.ts:6  escapeCsv
//             api/admin/tax/export/route.ts:6                      csvEscape
//             lib/admin-products-csv.ts:24                         csvEscape
//
// The guarded ones say exactly why, e.g. admin-customers.ts:162-164:
//   "Neutralize spreadsheet formula injection from attacker-controlled cells
//    (customer name/email) -- a leading = + - @ / tab / CR would run as a
//    formula in Excel/Sheets. Prefix a single quote."
//
// Wrapping a cell in double quotes does NOT stop this. Excel strips the
// surrounding quotes while parsing the field and then evaluates a leading '='.
// Quoting defends against delimiter injection, which is a different bug.
// ---------------------------------------------------------------------------

const FORMULA_LEADS = ["=", "+", "-", "@", "\t", "\r"];

describe("csvSafeCell", () => {
  it.each(FORMULA_LEADS)("neutralises a cell beginning with %j", (lead) => {
    const cell = csvSafeCell(`${lead}HYPERLINK("http://evil.test","clickme")`);

    // The guard is a leading apostrophe, which Excel treats as "this is text".
    expect(cell.replace(/^"/, "").startsWith("'")).toBe(true);
  });

  it("neutralises the classic command payload", () => {
    expect(csvSafeCell(`=cmd|'/c calc'!A1`).replace(/^"/, "").startsWith("'")).toBe(true);
  });

  it("leaves ordinary values completely untouched", () => {
    expect(csvSafeCell("Ada Lovelace")).toBe("Ada Lovelace");
    expect(csvSafeCell("ada@example.test")).toBe("ada@example.test");
    expect(csvSafeCell("BRUTUS")).toBe("BRUTUS");
    expect(csvSafeCell(42)).toBe("42");
    expect(csvSafeCell(null)).toBe("");
    expect(csvSafeCell(undefined)).toBe("");
  });

  it("does not mangle a negative number, which legitimately starts with '-'", () => {
    // Guarded, because a cell is text by the time it reaches here and a
    // reversed-commission column is written with .toFixed(2) as a NUMBER by the
    // caller. What must not happen is silent corruption: the value has to
    // survive readably.
    expect(csvSafeCell("-12.50")).toContain("-12.50");
  });

  it("still escapes quotes, commas and newlines", () => {
    expect(csvSafeCell('Ada "Ada" Lovelace')).toBe('"Ada ""Ada"" Lovelace"');
    expect(csvSafeCell("Lovelace, Ada")).toBe('"Lovelace, Ada"');
    expect(csvSafeCell("line1\nline2")).toBe('"line1\nline2"');
  });

  it("quotes AND guards when a cell needs both", () => {
    const cell = csvSafeCell('=SUM(A1),"x"');

    expect(cell.startsWith('"')).toBe(true);
    expect(cell).toContain("'=SUM");
    expect(cell).toContain('""x""');
  });

  it("matches the behaviour of the escapers that already got this right", () => {
    // Byte-for-byte with api/admin/orders/export/route.ts:7 and
    // lib/admin-customers.ts:160, so adopting it changes no existing output.
    const reference = (value: unknown) => {
      let text = String(value ?? "");
      if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
      if (/[",\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
      return text;
    };

    for (const sample of ["Ada", "=cmd|x", "a,b", 'q"q', "", "-1", "@at", "\ttab", null, undefined, 7]) {
      expect(csvSafeCell(sample)).toBe(reference(sample));
    }
  });
});
