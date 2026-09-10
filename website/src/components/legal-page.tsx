import { SiteHeaderV2 } from "@/components/site-header-v2";

// -----------------------------------------------------------------------------
// Renders a policy body written in the tiny markup used by
// src/lib/legal-content.ts. Everything is rendered as TEXT — never raw HTML —
// so admin-edited content stays safe, and every construct below is built from
// JSX children rather than dangerouslySetInnerHTML.
//
// IT USED TO HANDLE EXACTLY ONE CONSTRUCT, AND THE CONTENT USES THREE.
//
// The bodies have always contained "- " bullet lines and "**bold**" spans — 4
// list lines and 18 lines carrying bold across the privacy, refund, shipping
// and cookie policies. Every one of them rendered as literal characters, and
// the bullets collapsed into a single run-on paragraph because a "\n" inside a
// block is not a line break in HTML.
//
// The document that made this matter is Return & Refund. Its eligibility
// conditions — the 14-day window, "unused and unopened", "original factory
// cap/seal, fully intact" — are a four-item list, and they are the terms the
// store relies on when it DECLINES a return. They arrived as one paragraph with
// hyphens and asterisks in the middle of it. The Shipping policy has the same
// problem. Those are two of the documents a cautious buyer reads before paying,
// and one of the two a customer must affirmatively accept.
//
// A heading block also swallowed whatever followed it: "## Standard returns"
// with the sentence beneath it in the same block rendered BOTH lines inside the
// <h2>, so the lead-in to that list was styled as a heading and lost.
//
// Not fixed by rewriting the policy text to avoid the markup — the policies are
// admin-editable, so the next edit would reintroduce it.
// -----------------------------------------------------------------------------

/**
 * "**bold**" -> <strong>, on already-escaped text.
 *
 * Splitting on a capturing group keeps the delimiters, so odd (unmatched)
 * markers stay literal instead of eating the rest of the paragraph.
 */
function renderInline(text: string, keyPrefix: string) {
  const parts = text.split(/\*\*(.+?)\*\*/g);
  return parts.map((part, index) =>
    index % 2 === 1
      ? <strong key={`${keyPrefix}-b${index}`} className="font-semibold text-white/90">{part}</strong>
      : <span key={`${keyPrefix}-t${index}`}>{part}</span>,
  );
}

function renderBlock(block: string, key: string) {
  const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);

  // A heading owns ONLY its own line. Anything beneath it in the same block is
  // rendered as the content it is.
  if (lines[0]?.startsWith("## ")) {
    const [heading, ...rest] = lines;
    return (
      <div key={key}>
        <h2 className="vl2-serif mt-8 text-xl text-white">{heading.slice(3).trim()}</h2>
        {rest.length > 0 ? renderBlock(rest.join("\n"), `${key}-rest`) : null}
      </div>
    );
  }

  if (lines.length > 0 && lines.every((line) => line.startsWith("- "))) {
    return (
      <ul key={key} className="list-disc space-y-1.5 pl-5 text-sm leading-7 text-white/70">
        {lines.map((line, index) => (
          <li key={`${key}-li${index}`}>{renderInline(line.slice(2).trim(), `${key}-li${index}`)}</li>
        ))}
      </ul>
    );
  }

  return (
    <p key={key} className="text-sm leading-7 text-white/70">
      {renderInline(lines.join(" "), key)}
    </p>
  );
}

function renderBody(body: string) {
  const blocks = body.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  return blocks.map((block, index) => renderBlock(block, `b${index}`));
}

export function LegalPage({
  title,
  updated,
  body,
}: {
  title: string;
  updated: string;
  body: string;
}) {
  return (
    <div className="min-h-screen bg-[#0b0b0b] text-white">
      <SiteHeaderV2 />
      <main className="vl-nav-clearance mx-auto max-w-3xl px-6 pb-24 pt-32 lg:px-12">
        <p className="vl2-eyebrow">Legal</p>
        <h1 className="vl2-serif mt-3 text-3xl text-white sm:text-4xl">{title}</h1>
        <p className="mt-2 text-xs text-white/70">Last updated: {updated}</p>
        <div className="mt-8 space-y-4">{renderBody(body)}</div>
      </main>
    </div>
  );
}
