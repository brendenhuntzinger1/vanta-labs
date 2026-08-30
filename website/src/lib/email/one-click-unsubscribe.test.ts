import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// ONE-CLICK UNSUBSCRIBE (RFC 8058).
//
// Gmail and Yahoo have required bulk senders to offer it since February 2024,
// and a commercial message without List-Unsubscribe is one their filters are
// entitled to score worse. That is not abstract here: on 2026-08-29 a message
// this store sent was DELIVERED, filed as spam, had its links stripped by the
// filter, and left four customers unable to finish signing up.
//
// Two properties matter and both are easy to lose:
//   1. MARKETING mail carries the header, on every path, via the one wrapper
//      that already owns suppression and the footer link.
//   2. TRANSACTIONAL mail carries NONE of it. A receipt, a password reset and
//      an order confirmation are not marketing and must never offer to stop
//      being sent — a customer who "unsubscribes" from a receipt has broken
//      something nobody intended.
// ---------------------------------------------------------------------------

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const MARKETING = read("src/lib/email/marketing.ts");
const SEND = read("src/lib/email/send.ts");
const TYPES = read("src/lib/email/types.ts");
const UNSUB_ROUTE = read("src/app/api/unsubscribe/route.ts");
const RESEND = read("src/lib/email/providers/resend.ts");
const SENDGRID = read("src/lib/email/providers/sendgrid.ts");
const SMTP = read("src/lib/email/providers/smtp.ts");

describe("marketing mail offers one-click unsubscribe", () => {
  it("sets List-Unsubscribe", () => {
    expect(MARKETING).toContain('"List-Unsubscribe"');
  });

  it("sets List-Unsubscribe-Post, which is what makes it ONE-click", () => {
    // Without this header the URL is just another link; Gmail only renders its
    // own Unsubscribe button when the message opts into the POST form.
    expect(MARKETING).toContain('"List-Unsubscribe-Post"');
    expect(MARKETING).toContain("List-Unsubscribe=One-Click");
  });

  it("points the header at the same signed token as the footer link", () => {
    // Three entry points, one authorisation. A second token scheme is a second
    // thing to get wrong.
    expect(MARKETING).toContain("unsubscribeUrl");
    const header = MARKETING.slice(MARKETING.indexOf('"List-Unsubscribe"'));
    expect(header.slice(0, 200)).toContain("${unsubscribeUrl}");
  });

  it("sets it in the marketing wrapper, not in sendEmail", () => {
    // sendEmail carries receipts and password resets. Putting the header there
    // would offer to unsubscribe from a password reset.
    expect(SEND).not.toContain("List-Unsubscribe");
  });
});

describe("the header actually reaches the wire", () => {
  it("EmailMessage carries arbitrary headers", () => {
    expect(TYPES).toContain("headers?: Record<string, string>");
  });

  it("sendEmail forwards them", () => {
    expect(SEND).toContain("headers: input.headers");
  });

  for (const [name, src] of [["resend", RESEND], ["sendgrid", SENDGRID], ["smtp", SMTP]] as const) {
    it(`the ${name} provider forwards them`, () => {
      // A header set in the wrapper and dropped by the provider is the same as
      // no header at all, and it would look correct in every unit test that
      // stopped at sendEmail.
      expect(src, `${name} drops message.headers`).toContain("message.headers");
    });
  }
});

describe("POST /api/unsubscribe", () => {
  it("exists, because one-click is a POST", () => {
    // The header can be set all day; if the endpoint 405s, Gmail's button fails
    // and the sender looks worse than one with no header at all.
    expect(UNSUB_ROUTE).toContain("export async function POST");
  });

  it("authorises on the signed token, since a mail client sends no cookies", () => {
    const post = UNSUB_ROUTE.slice(UNSUB_ROUTE.indexOf("export async function POST"));
    expect(post).toContain("verifyUnsubscribeToken");
  });

  it("shares one suppression path with the GET", () => {
    // Two copies of "unsubscribe" is two chances for them to disagree.
    expect(UNSUB_ROUTE).toContain("async function suppress(");
    const suppressCalls = (UNSUB_ROUTE.match(/await suppress\(/g) ?? []).length;
    expect(suppressCalls).toBe(2);
  });

  it("answers a mail client plainly, not with a rendered page", () => {
    const post = UNSUB_ROUTE.slice(UNSUB_ROUTE.indexOf("export async function POST"));
    expect(post).not.toContain("htmlResponse");
    expect(post).toContain("status: ok ? 200 : 500");
  });

  it("still serves the footer link as HTML", () => {
    // Existing emails in inboxes carry the GET link and must keep working.
    const get = UNSUB_ROUTE.slice(
      UNSUB_ROUTE.indexOf("export async function GET"),
      UNSUB_ROUTE.indexOf("export async function POST"),
    );
    expect(get).toContain("htmlResponse");
  });
});
