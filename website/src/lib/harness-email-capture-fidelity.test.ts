import { describe, expect, it } from "vitest";

import { decodeWord } from "../../scripts/smtp-sink.mjs";

// ---------------------------------------------------------------------------
// THE CAPTURE MUST NOT INVENT A DEFECT THE SITE DOES NOT HAVE.
//
// scripts/smtp-sink.mjs is the harness's SMTP endpoint: every message the app
// sends while EMAIL_PROVIDER=smtp lands in captured-emails.jsonl, and that file
// is what a test — or a human auditing the email system — reads to decide
// whether a customer was told the right thing.
//
// Its header decoder got RFC 2047 wrong in two ways, and both wrote a lie into
// the capture. Measured 2026-09-10 against a real delivered message:
//
//     on the wire   =?UTF-8?Q?Delivered_=E2=80=94_order_VL-JOURNEY-178?= =?UTF-8?Q?9044828937?=
//     correct       Delivered — order VL-JOURNEY-1789044828937
//     captured      Delivered â order VL-JOURNEY-178 9044828937
//
// 1. Q-encoded bytes were turned into characters with String.fromCharCode, so
//    every byte of a multi-byte UTF-8 character became its own Latin-1 code
//    point. This is the SAME bug decodeBody documents having fixed ("BYTES,
//    THEN UTF-8") — the fix was applied to the body and never to the headers.
//
// 2. Each encoded-word was decoded in place, leaving the whitespace BETWEEN two
//    adjacent encoded-words. RFC 2047 section 6.2 requires that whitespace be
//    removed: it exists only so a long header can be folded, and it is not part
//    of the text. Nodemailer splits at 75 characters, so it lands mid-token —
//    here in the middle of an ORDER NUMBER.
//
// The second one is the dangerous half. A reader comparing the captured subject
// against the order would find the number did not match and report the site as
// sending broken receipts. It does not; the capture was breaking them. This
// project has lost whole audit rounds to exactly that class of false positive,
// which is why the decoder now has tests of its own.
// ---------------------------------------------------------------------------

describe("the SMTP sink decodes headers the way a mail client does", () => {
  it("decodes a Q-encoded UTF-8 character as UTF-8, not as Latin-1 bytes", () => {
    expect(decodeWord("=?UTF-8?Q?Delivered_=E2=80=94_order?=")).toBe("Delivered — order");
  });

  it("joins adjacent encoded-words with no space, as RFC 2047 requires", () => {
    // The exact header that exposed this, from a delivered order-delivered mail.
    expect(decodeWord("=?UTF-8?Q?Delivered_=E2=80=94_order_VL-JOURNEY-178?= =?UTF-8?Q?9044828937?=")).toBe(
      "Delivered — order VL-JOURNEY-1789044828937",
    );
  });

  it("joins adjacent encoded-words split across a folded header", () => {
    // unfold() turns the CRLF+space of a folded header into a single space
    // before this runs, so the folded case arrives here looking like the above.
    expect(decodeWord("=?UTF-8?B?VkwtMTIz?=\t=?UTF-8?B?NDU2Nzg5?=")).toBe("VL-123456789");
  });

  it("decodes B-encoded UTF-8", () => {
    expect(decodeWord("=?UTF-8?B?VmFudGEgTGFicyDigJQgcmVjZWlwdA==?=")).toBe("Vanta Labs — receipt");
  });

  it("keeps an underscore-encoded space inside one word", () => {
    expect(decodeWord("=?UTF-8?Q?Shipping_Update?=")).toBe("Shipping Update");
  });

  it("leaves an unencoded subject exactly as it is", () => {
    expect(decodeWord("Shipping Update - VL-JOURNEY-1789044828937")).toBe(
      "Shipping Update - VL-JOURNEY-1789044828937",
    );
  });

  it("keeps real whitespace between an encoded word and ordinary text", () => {
    // Only whitespace BETWEEN TWO encoded-words is a folding artifact. A space
    // separating an encoded word from a literal one is part of the header.
    expect(decodeWord("=?UTF-8?Q?Order?= confirmed")).toBe("Order confirmed");
    expect(decodeWord("Re: =?UTF-8?Q?your_order?=")).toBe("Re: your order");
  });
});
