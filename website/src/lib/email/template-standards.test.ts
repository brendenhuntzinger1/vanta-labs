import { describe, expect, it } from "vitest";

import * as templates from "@/lib/email/templates";
import { INPUTS, URL_ } from "@/lib/email/template-standards-inputs";

// ---------------------------------------------------------------------------
// ONE BAR, APPLIED TO EVERY EMAIL THIS APP CAN SEND.
//
// On 2026-08-29 a signup confirmation was DELIVERED — Resend said so — and
// still failed, because Gmail classified it as spam and spam messages have
// their links stripped. The recipient opened an email with nothing to click
// and reported, accurately, that "the email doesn't have a link".
//
// The message that did that was a bare <h2>, one sentence and a naked <a>. The
// order confirmations, on the same domain through the same Resend account,
// landed every time — because they are branded, carry a real button, and ship
// a plain-text alternative. The difference was never deliverability. It was the
// message.
//
// So this file walks EVERY exported template, renders it with representative
// input, and holds it to the bar the working emails already met. A new template
// that skips renderLayout, forgets its text part, or interpolates an undefined
// into the body fails here rather than in somebody's spam folder.
//
// Adding a template means adding it to INPUTS below. That is deliberate: the
// list not compiling is how you find out you have written an email nobody
// checked.
// ---------------------------------------------------------------------------

// The fixture table lives in template-standards-inputs.ts so the render sweep
// and this suite cannot drift: a template added to one is added to both. This
// file is still what FAILS when a template is missing from it.


type Rendered = { subject: string; html: string; text?: string };

const ALL: Array<readonly [string, (input: unknown) => Rendered]> = Object.entries(
  templates as unknown as Record<string, unknown>,
)
  .filter(([name, fn]) => name.endsWith("Template") && typeof fn === "function")
  .map(([name, fn]) => [name, fn as (input: unknown) => Rendered] as const);

/** Absolute http(s) URLs appearing in a rendered body. */
function urlsIn(text: string): string[] {
  const found = text.match(/https?:\/\/[^\s"'<>)]+/g) ?? [];
  // mailto: and the support address are not CTAs; tracking pixels are not links.
  return [...new Set(found.map((u) => u.replace(/&amp;/g, "&")))];
}

describe("every email template", () => {
  it("has one covering the whole exported surface", () => {
    // A template with no entry in INPUTS is one nobody has checked. Failing
    // here is the point: it is how a new email gets noticed before it ships.
    const uncovered = ALL.map(([name]) => name).filter((name) => !(name in INPUTS));
    expect(uncovered, `templates missing from INPUTS: ${uncovered.join(", ")}`).toEqual([]);
    expect(ALL.length).toBeGreaterThan(40);
  });

  for (const [name, render] of ALL) {
    describe(name, () => {
      const out = render(INPUTS[name]);

      it("has a subject", () => {
        expect(out.subject.trim().length).toBeGreaterThan(0);
      });

      it("ships a plain-text alternative", () => {
        // An HTML-only message is a documented spam signal, and it is the last
        // thing a recipient has when a filter strips the markup.
        expect(out.text, `${name} has no text part`).toBeTruthy();
        expect(String(out.text).trim().length).toBeGreaterThan(0);
      });

      it("is branded, so it does not read as phishing", () => {
        expect(out.html).toContain("Vanta Labs");
        // renderLayout's dark shell. The message that got filtered had none of
        // it; every message that landed had all of it.
        expect(out.html, `${name} does not go through renderLayout`).toContain("background:#050505");
      });

      it("renders no undefined, NaN or [object Object]", () => {
        for (const body of [out.html, String(out.text ?? "")]) {
          expect(body).not.toContain("undefined");
          expect(body).not.toContain("NaN");
          expect(body).not.toContain("[object Object]");
        }
      });

      it("repeats every link in the plain-text part", () => {
        // Gmail strips anchors from anything it files as spam. The text part is
        // the copy that survives that, and it is the only reason a filtered
        // message is still actionable.
        const htmlUrls = urlsIn(out.html).filter((u) => !u.startsWith("mailto:"));
        const textBody = String(out.text ?? "");
        for (const url of htmlUrls) {
          expect(textBody, `${name}: ${url} is in the HTML but not the text part`).toContain(url);
        }
      });

      it("renders any CTA as a real button rather than a naked anchor", () => {
        // The single difference a recipient sees between the confirmation that
        // got ignored and the order email that got clicked.
        const hasCta = out.html.includes("<a href");
        if (!hasCta) return;
        const anchors = out.html.match(/<a href="[^"]*"[^>]*>/g) ?? [];
        const styled = anchors.filter((a) => a.includes("border-radius:999px"));
        const mailtoOnly = anchors.every((a) => a.includes("mailto:"));
        expect(
          styled.length > 0 || mailtoOnly,
          `${name} has anchors but none is a styled CTA: ${anchors.slice(0, 2).join(" ")}`,
        ).toBe(true);
      });
    });
  }
});
