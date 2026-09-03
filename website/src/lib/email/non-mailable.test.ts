import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { isNonMailableAddress } from "@/lib/email/non-mailable";

const read = (rel: string) => readFileSync(path.resolve(process.cwd(), "src", rel), "utf8");

// ---------------------------------------------------------------------------
// TEST ADDRESSES MUST NOT RIDE ALONG ON A REAL CAMPAIGN.
//
// This account has genuinely sent to provider sink addresses — the 2026-09-02
// audit found delivered@resend.dev, bounced@resend.dev and complained@resend.dev
// in Resend's own log, from testing the bounce/complaint webhook. Two of the
// three are now suppressed BECAUSE they did what they are designed to do.
//
// Nothing stopped such an address entering a marketing audience in the first
// place. The audience is built from marketing_subscribers, which is written by
// the checkout opt-in — so testing checkout with a sink address puts it on the
// list, and the next campaign mails it. A send to bounced@resend.dev is a bounce
// the provider records against this domain, and a send to complained@resend.dev
// is a SPAM COMPLAINT recorded against it. Deliberately, every time.
//
// The rule is narrow on purpose: only addresses that cannot belong to a real
// customer. RFC 2606 reserves example.com/.net/.org and the .test, .invalid and
// .localhost TLDs precisely so they can never be routed, and resend.dev is the
// provider's own sink. Anything broader risks dropping a real subscriber, which
// is the worse mistake — so a plausible-but-odd address is left alone.
// ---------------------------------------------------------------------------

describe("isNonMailableAddress", () => {
  it("rejects the provider's simulator addresses", () => {
    for (const address of ["delivered@resend.dev", "bounced@resend.dev", "complained@resend.dev"]) {
      expect(isNonMailableAddress(address), address).toBe(true);
    }
  });

  it("deliberately KEEPS unroutable and fixture domains", () => {
    // This list got narrower twice while being written, and the narrowing is
    // the finding worth recording.
    //
    // RFC 2606 reserves example.com/.net/.org and the .test/.invalid/.localhost
    // TLDs so they can never route, which makes filtering them look obviously
    // right. Filtering example.com broke 31 tests; adding .test broke 4 more.
    // Every one of them was asserting correct behaviour — they are simply this
    // repo's fixture conventions. A filter that only passes once the fixtures
    // have been rewritten around it has stopped describing production.
    //
    // The costs settle it. An unroutable address on a list is INERT: it bounces
    // once and the consecutive-soft-bounce escalation retires it with nobody
    // doing anything. A provider sink is not inert — it manufactures a bounce
    // or a spam complaint against this domain on purpose, every time.
    for (const address of [
      "someone@example.com",
      "someone@example.net",
      "someone@example.org",
      "sub1@example.test",
      "someone@anything.invalid",
      "someone@anything.localhost",
    ]) {
      expect(isNonMailableAddress(address), address).toBe(false);
    }
  });

  it("is case- and whitespace-insensitive, because stored data is not tidy", () => {
    expect(isNonMailableAddress("  Bounced@Resend.Dev ")).toBe(true);
  });

  it("keeps ordinary customer addresses", () => {
    for (const address of [
      "abry.jacobi@gmail.com",
      "rosiespringer@icloud.com",
      "daquigan1@yahoo.com",
      "someone@vantalabsresearch.com",
      // A real domain that merely CONTAINS a reserved word must not be caught.
      "buyer@examples.com",
      "buyer@example.com",
      "buyer@notresend.dev.co",
      "buyer@testing-labs.com",
    ]) {
      expect(isNonMailableAddress(address), address).toBe(false);
    }
  });

  it("treats junk as non-mailable rather than throwing", () => {
    for (const junk of ["", "   ", "not-an-address", null, undefined]) {
      expect(isNonMailableAddress(junk as unknown as string)).toBe(true);
    }
  });
});

describe("both marketing audiences apply it", () => {
  it("the customer audience filters non-mailable addresses", () => {
    expect(read("lib/email/audience.ts")).toContain("isNonMailableAddress");
  });

  it("the affiliate audience filters them too", () => {
    // An affiliate list is smaller and hand-approved, but a test affiliate is
    // exactly the kind of row that gets created once and forgotten.
    expect(read("lib/email/affiliate-audience-shared.ts")).toContain("isNonMailableAddress");
  });
});
