import { describe, expect, it } from "vitest";

import { acceptableSmsPhone } from "@/lib/sms-consent-text";
import { normalizeE164 } from "@/lib/marketing/omnisend/contact-payload";

// ---------------------------------------------------------------------------
// WHAT THE FIELD CAN AND CANNOT ESTABLISH.
//
// It can reject a number the North American Numbering Plan could never assign.
// It cannot tell a real stranger's number from the subscriber's own — only a
// confirmation the handset answers does that, and this store does not send one
// yet. These cases pin the half that is actually decidable, and the file says
// plainly which half that is so nobody later reads a passing suite as proof of
// ownership.
//
// The rules encoded are NANPA's, not heuristics: an area code's first digit is
// 2-9, neither an area code nor an exchange may be N11, 555 was never assigned
// as an area code, and 555-01XX is the range reserved for fiction.
// ---------------------------------------------------------------------------

describe("numbers a person could actually be texted at", () => {
  it("accepts an ordinary mobile, however it is punctuated", () => {
    for (const written of [
      "4155551234",
      "(415) 555-1234",
      "415-555-1234",
      "415.555.1234",
      "+1 415 555 1234",
      "14155551234",
    ]) {
      expect(acceptableSmsPhone(written), `${written} was refused`).not.toBeNull();
    }
  });

  it("keeps the formatting the person typed", () => {
    // The wire format is normalizeE164's job; this one is a gate, not a
    // rewriter, and the surfaces echo the value back into the field.
    expect(acceptableSmsPhone("(415) 555-1234")).toBe("(415) 555-1234");
  });

  it("leaves another country's plan to its own rules", () => {
    // +44 7911 123456 is a real UK mobile shape and none of the NANP rules
    // below apply to it. Encoding every plan here would be a worse lie than
    // encoding one.
    expect(acceptableSmsPhone("+44 7911 123456")).not.toBeNull();
  });
});

describe("numbers that cannot exist", () => {
  it("refuses an area code beginning 0 or 1", () => {
    expect(acceptableSmsPhone("1234567890")).toBeNull();
    expect(acceptableSmsPhone("0123456789")).toBeNull();
  });

  it("refuses a service code as an area code or an exchange", () => {
    expect(acceptableSmsPhone("9115551234")).toBeNull();
    expect(acceptableSmsPhone("4154111234")).toBeNull();
  });

  it("refuses 555, which was never assigned as an area code", () => {
    expect(acceptableSmsPhone("5555555555")).toBeNull();
    expect(acceptableSmsPhone("(555) 867-5309")).toBeNull();
  });

  it("still accepts the range reserved for fiction, deliberately", () => {
    // THE ONE RULE THAT WAS WRITTEN AND THEN TAKEN BACK OUT. 555-01XX is where
    // made-up numbers come from, so blocking it looks like the obvious catch —
    // and it is also where this repository's own fixtures come from, precisely
    // so a test can never dial a real person. Nine consent-path suites went
    // red on it. Somebody set on faking a number types any assignable ten
    // digits instead, so the block bought a speed bump one keystroke wide in
    // exchange for the convention that keeps real numbers out of the suite.
    expect(acceptableSmsPhone("2025550123")).not.toBeNull();
    expect(acceptableSmsPhone("512-555-0100")).not.toBeNull();
  });

  it("refuses one digit held down", () => {
    for (const junk of ["0000000000", "1111111111", "9999999999", "7777777"]) {
      expect(acceptableSmsPhone(junk), `${junk} was accepted`).toBeNull();
    }
  });

  it("still refuses what it always refused", () => {
    expect(acceptableSmsPhone("")).toBeNull();
    expect(acceptableSmsPhone(null)).toBeNull();
    expect(acceptableSmsPhone("not a number")).toBeNull();
    expect(acceptableSmsPhone("415555")).toBeNull();
    expect(acceptableSmsPhone("1234567890123456")).toBeNull();
  });
});

describe("the gate and the normaliser agree about who is North American", () => {
  it("reads a bare ten or eleven digits the same way", () => {
    // acceptableSmsPhone applies the NANP rules to exactly the inputs
    // normalizeE164 will stamp +1 onto. If the two disagreed, a number could
    // pass the gate under one plan's rules and be written to the ledger under
    // another's.
    expect(normalizeE164("4155551234")).toBe("+14155551234");
    expect(normalizeE164("14155551234")).toBe("+14155551234");
    expect(normalizeE164(acceptableSmsPhone("(415) 555-1234"))).toBe("+14155551234");
  });

  it("passes nothing to the ledger that the gate refused", () => {
    for (const junk of ["5555555555", "1234567890", "9115551234"]) {
      expect(acceptableSmsPhone(junk)).toBeNull();
    }
  });
});

describe("what this file does NOT prove", () => {
  it("cannot tell a stranger's real number from the subscriber's own", () => {
    // A valid number belonging to somebody else passes every rule above, and
    // that is the case that costs a complaint rather than a message. The
    // consent row says so: recordSmsConsent leaves `status` at the table's
    // default because claiming "verified" would be a lie told to the one
    // table a carrier would ask to see.
    expect(acceptableSmsPhone("4155551234")).not.toBeNull();
  });
});
