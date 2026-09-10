import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { getPolicy, POLICY_SLUGS } from "@/lib/legal-content";

// ---------------------------------------------------------------------------
// THE TERMS THE STORE DECLINES A RETURN ON MUST BE LEGIBLE.
//
// components/legal-page.tsx handled exactly one construct — a "## " heading —
// while the policy bodies have always used three. Measured across the six
// policies: 4 bullet lines and 18 lines carrying "**bold**". All of them
// rendered as literal asterisks and hyphens, and the bullets collapsed into one
// run-on paragraph, because a "\n" inside a block is not a line break in HTML.
//
// The document that makes this matter is Return & Refund. Its eligibility
// conditions — the 14-day window, "unused and unopened", "original factory
// cap/seal, fully intact" — are a four-item list, and they are precisely the
// terms the store relies on when it DECLINES a return. Shipping has the same
// problem. Those are two of the documents a cautious buyer reads before paying,
// and one of the two a customer must affirmatively accept.
//
// A heading block also swallowed whatever followed it in the same block, so
// "## Standard returns" plus its lead-in sentence rendered BOTH inside the
// <h2> — losing the sentence that introduces the list.
//
// These tests pin BOTH ends: that the content really does use the constructs
// (so the renderer is not being asked to support something hypothetical), and
// that the renderer handles them. Fixing this by rewriting the policy text to
// avoid Markdown would be wrong — the policies are admin-editable and the next
// edit would bring it straight back.
// ---------------------------------------------------------------------------

const source = readFileSync(resolve(process.cwd(), "src/components/legal-page.tsx"), "utf8");

describe("the policies really do use the markup", () => {
  it("the refund policy states its eligibility conditions as a list", async () => {
    const policy = await getPolicy("refund");
    const bullets = policy.body.split("\n").filter((line) => line.trim().startsWith("- "));
    expect(bullets.length).toBeGreaterThanOrEqual(4);
    // The conditions a declined return turns on.
    expect(policy.body).toContain("14 days of delivery");
    expect(policy.body).toContain("original factory cap/seal");
  });

  it("bold spans appear across the policy set, not just in one document", async () => {
    const withBold: string[] = [];
    for (const slug of POLICY_SLUGS) {
      const policy = await getPolicy(slug);
      if (/\*\*.+?\*\*/.test(policy.body)) withBold.push(slug);
    }
    expect(withBold.length).toBeGreaterThanOrEqual(2);
  });

  it("at least one heading shares its block with the line beneath it", async () => {
    // The shape that used to be swallowed into the <h2>.
    const policy = await getPolicy("refund");
    const blocks = policy.body.split(/\n\s*\n/);
    const headingWithBody = blocks.filter((b) => b.trim().startsWith("## ") && b.trim().split("\n").length > 1);
    expect(headingWithBody.length).toBeGreaterThan(0);
  });
});

describe("the renderer handles every construct the content uses", () => {
  it("renders a bullet block as a real list", () => {
    expect(source).toContain('lines.every((line) => line.startsWith("- "))');
    expect(source).toContain("<ul");
    expect(source).toContain("<li");
  });

  it("renders bold spans as <strong> rather than printing asterisks", () => {
    expect(source).toContain("function renderInline");
    expect(source).toContain("<strong");
  });

  it("gives a heading only its own line and renders the rest as content", () => {
    expect(source).toContain("const [heading, ...rest] = lines;");
    expect(source).toContain("renderBlock(rest.join");
    // The old form rendered the WHOLE block as the heading.
    expect(source).not.toContain("{block.slice(3).trim()}");
  });

  it("still renders everything as text, never as raw HTML", () => {
    // The security property the original comment relied on, kept intact.
    //
    // Matched as the JSX PROP rather than as the bare word: the file's own
    // header explains that it deliberately does not use it, and a substring
    // search cannot tell an explanation from a usage. The first draft of this
    // assertion failed on the comment, which is a test reporting on prose.
    expect(source).not.toMatch(/dangerouslySetInnerHTML\s*=/);
  });
});
