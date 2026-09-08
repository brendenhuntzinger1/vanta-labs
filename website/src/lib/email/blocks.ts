import { escapeHtml, renderCtaButton, type EmailCtaVariant } from "@/lib/email/templates";

/**
 * BLOCK-COMPOSED CAMPAIGN BODIES.
 *
 * Writing a campaign meant editing templates.ts — 130KB of TypeScript — and
 * shipping a deploy. That is a developer-only workflow for what is a marketing
 * task, and it is the single biggest thing an ESP was buying.
 *
 * THE BLOCKS ARE FEW AND DUMB ON PURPOSE. An operator composing from seven
 * primitives cannot produce an email that fails template-standards, because
 * each primitive already satisfies it. A free-HTML field could, which is
 * exactly why there is not one: the moment an operator can paste markup, the
 * plain-text part stops matching the HTML, links go missing from it, and a CTA
 * becomes a naked anchor. Every one of those is a standard this codebase
 * already enforces on the hand-written templates.
 *
 * HTML AND TEXT ARE PRODUCED TOGETHER, from the same pass over the same blocks.
 * Generating them separately is how they drift: the text part is the one nobody
 * looks at, so it is the one that silently rots. Here a block that emits a link
 * emits it into both, or it emits neither.
 *
 * The button is renderCtaButton, not a second implementation. Its table wrapper
 * is what template-standards.test.ts uses to tell a real CTA from a bare
 * anchor, and its 52px target was measured rather than chosen — a second
 * button would lose both.
 */

export const BLOCK_TYPES = ["heading", "paragraph", "list", "button", "image", "divider", "spacer"] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];

export type EmailBlock =
  | { type: "heading"; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; items: string[] }
  | { type: "button"; label: string; url: string; variant?: EmailCtaVariant }
  | { type: "image"; url: string; alt?: string }
  | { type: "divider" }
  | { type: "spacer" };

/**
 * A body cannot exceed this many blocks.
 *
 * Not a layout opinion — a bound. An unbounded body is an unbounded render, an
 * unbounded row and an email too large for Gmail, which clips at ~102KB and
 * hides the unsubscribe footer when it does. Clipping the footer is the part
 * that matters: it is a compliance failure, not a cosmetic one.
 */
const MAX_BLOCKS = 100;

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

/** Same test renderCtaButton applies, so a button and an image agree about what a URL is. */
function isSafeUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

type Rendered = { html: string; text: string };

function renderBlock(block: EmailBlock): Rendered | null {
  switch (block?.type) {
    case "heading": {
      const text = clean((block as { text?: unknown }).text);
      if (!text) return null;
      return {
        html: `<h2 style="margin:0 0 12px;font-size:22px;line-height:1.3;color:#f5f5f5;font-weight:600;">${escapeHtml(text)}</h2>`,
        text: `${text}\n\n`,
      };
    }

    case "paragraph": {
      const text = clean((block as { text?: unknown }).text);
      if (!text) return null;
      return {
        html: `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#c9c9c9;">${escapeHtml(text)}</p>`,
        text: `${text}\n\n`,
      };
    }

    case "list": {
      const items = Array.isArray((block as { items?: unknown }).items)
        ? ((block as { items: unknown[] }).items).map(clean).filter(Boolean)
        : [];
      if (items.length === 0) return null;
      const li = items
        .map((item) => `<li style="margin:0 0 8px;">${escapeHtml(item)}</li>`)
        .join("");
      return {
        html: `<ul style="margin:0 0 16px;padding-left:20px;font-size:15px;line-height:1.6;color:#c9c9c9;">${li}</ul>`,
        text: `${items.map((item) => `- ${item}`).join("\n")}\n\n`,
      };
    }

    case "button": {
      const label = clean((block as { label?: unknown }).label);
      const url = clean((block as { url?: unknown }).url);
      if (!label || !url || !isSafeUrl(url)) return null;
      const html = renderCtaButton({ label, url, variant: (block as { variant?: EmailCtaVariant }).variant });
      if (!html) return null;
      // The URL goes into the text part explicitly: a plain-text reader has no
      // button to press, and template-standards requires every HTML link to be
      // reachable from the text.
      return { html, text: `${label}: ${url}\n\n` };
    }

    case "image": {
      const url = clean((block as { url?: unknown }).url);
      if (!url || !isSafeUrl(url)) return null;
      // An absent alt is rendered as empty rather than dropped: that is the
      // correct treatment for a decorative image and what a screen reader
      // expects. Dropping the block would silently lose artwork the operator
      // placed.
      const alt = clean((block as { alt?: unknown }).alt);
      return {
        html: `<img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}" style="display:block;width:100%;max-width:520px;height:auto;margin:0 0 16px;border:0;" />`,
        // Most clients block images by default, so for a large share of
        // recipients the alt text IS the message.
        text: alt ? `${alt}\n\n` : "",
      };
    }

    case "divider":
      return { html: `<hr style="border:0;border-top:1px solid #262626;margin:24px 0;" />`, text: "" };

    case "spacer":
      return { html: `<div style="height:24px;line-height:24px;font-size:0;">&nbsp;</div>`, text: "" };

    default:
      // An unrecognised block renders as nothing. One bad block is not a dead
      // email — the blocks around it still send.
      return null;
  }
}

/** Render blocks into the HTML body and its plain-text twin. */
export function renderBlocks(blocks: EmailBlock[]): Rendered {
  const parts = (blocks ?? []).map(renderBlock).filter((part): part is Rendered => part !== null);

  return {
    html: parts.map((part) => part.html).join(""),
    text: parts.map((part) => part.text).join("").trimEnd(),
  };
}

/**
 * Validate untrusted block JSON (admin input, or a stored row).
 *
 * Returns null when the input is not a block list at all — that is a caller
 * error worth surfacing. An individual block it does not recognise is dropped
 * instead, because a body that mostly renders is better than a campaign that
 * cannot be opened, and renderBlocks would have skipped it anyway.
 */
export function parseBlocks(input: unknown): EmailBlock[] | null {
  let raw: unknown = input;

  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }

  if (!Array.isArray(raw)) return null;

  const known = new Set<string>(BLOCK_TYPES);
  return raw
    .filter((block): block is EmailBlock =>
      Boolean(block) && typeof block === "object" && known.has(String((block as { type?: unknown }).type)))
    .slice(0, MAX_BLOCKS);
}
