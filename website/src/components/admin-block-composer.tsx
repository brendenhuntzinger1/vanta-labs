"use client";

import { useMemo } from "react";
import { parseBlocks, type BlockType, type EmailBlock } from "@/lib/email/blocks";

/**
 * THE BLOCK COMPOSER.
 *
 * Writing a campaign meant editing 130KB of TypeScript and shipping a deploy.
 * This is the screen that replaces that, and it writes its blocks as JSON into
 * the campaign's existing `body` column — so nothing about how a campaign is
 * stored, previewed or sent changes.
 *
 * THE STORED VALUE IS THE ONLY STATE. Every edit re-serialises the whole block
 * list back to the parent's form. A composer that keeps its own React copy is a
 * composer that can show one email and send another — the same reason the rule
 * builder works this way.
 *
 * NO FREE-HTML BLOCK, DELIBERATELY. The seven primitives each satisfy
 * template-standards by construction; the moment an operator can paste markup,
 * the plain-text part stops matching the HTML and a CTA becomes a naked anchor.
 * The constraint is the feature.
 */

const LABELS: Record<BlockType, string> = {
  heading: "Heading",
  paragraph: "Paragraph",
  list: "Bullet list",
  button: "Button",
  image: "Image",
  divider: "Divider",
  spacer: "Spacer",
};

const ADDABLE: BlockType[] = ["heading", "paragraph", "list", "button", "image", "divider", "spacer"];

function blankBlock(type: BlockType): EmailBlock {
  switch (type) {
    case "heading":
      return { type: "heading", text: "" };
    case "paragraph":
      return { type: "paragraph", text: "" };
    case "list":
      return { type: "list", items: [""] };
    case "button":
      return { type: "button", label: "" };
    case "image":
      return { type: "image", url: "", alt: "" };
    case "divider":
      return { type: "divider" };
    case "spacer":
      return { type: "spacer" };
  }
}

const inputClass =
  "w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white placeholder:text-zinc-600 focus:border-white/25 focus:outline-none";
const chipClass =
  "rounded-lg border border-white/10 px-2.5 py-1 text-[11px] font-semibold text-zinc-300 hover:border-white/25 hover:text-white disabled:opacity-30 disabled:hover:border-white/10";

export function BlockComposer({
  value,
  onChange,
}: {
  /** The campaign body. Block JSON when in block mode. */
  value: string;
  onChange: (json: string) => void;
}) {
  const blocks = useMemo<EmailBlock[]>(() => parseBlocks(value) ?? [], [value]);

  function commit(next: EmailBlock[]) {
    onChange(JSON.stringify(next));
  }

  function update(index: number, patch: Partial<EmailBlock>) {
    commit(blocks.map((block, i) => (i === index ? ({ ...block, ...patch } as EmailBlock) : block)));
  }

  function add(type: BlockType) {
    commit([...blocks, blankBlock(type)]);
  }

  function remove(index: number) {
    commit(blocks.filter((_, i) => i !== index));
  }

  /** Reordering is a swap, so a block never lands two places away from where it was dragged. */
  function move(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= blocks.length) return;
    const next = [...blocks];
    [next[index], next[target]] = [next[target], next[index]];
    commit(next);
  }

  return (
    <div className="space-y-3" data-testid="block-composer">
      {blocks.length === 0 ? (
        <p className="rounded-xl border border-dashed border-white/15 px-3 py-6 text-center text-xs text-zinc-500">
          No blocks yet. Add one below.
        </p>
      ) : null}

      {blocks.map((block, index) => (
        <div key={index} className="rounded-xl border border-white/10 bg-black/20 p-3">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
              {LABELS[block.type as BlockType] ?? block.type}
            </span>
            <div className="ml-auto flex items-center gap-1">
              <button
                type="button"
                className={chipClass}
                onClick={() => move(index, -1)}
                disabled={index === 0}
                aria-label={`Move ${LABELS[block.type as BlockType]} up`}
              >
                ↑
              </button>
              <button
                type="button"
                className={chipClass}
                onClick={() => move(index, 1)}
                disabled={index === blocks.length - 1}
                aria-label={`Move ${LABELS[block.type as BlockType]} down`}
              >
                ↓
              </button>
              <button
                type="button"
                className={chipClass}
                onClick={() => remove(index)}
                aria-label={`Remove ${LABELS[block.type as BlockType]}`}
              >
                Remove
              </button>
            </div>
          </div>

          {block.type === "heading" || block.type === "paragraph" ? (
            <textarea
              rows={block.type === "heading" ? 1 : 3}
              className={inputClass}
              aria-label={LABELS[block.type]}
              value={(block as { text: string }).text ?? ""}
              onChange={(event) => update(index, { text: event.target.value } as Partial<EmailBlock>)}
              placeholder={block.type === "heading" ? "Back in stock" : "Plain text. The branded layout is applied automatically."}
            />
          ) : null}

          {block.type === "list" ? (
            <div className="space-y-2">
              {((block as { items: string[] }).items ?? []).map((item, itemIndex) => (
                <div key={itemIndex} className="flex items-center gap-2">
                  <span className="text-zinc-600">•</span>
                  <input
                    className={inputClass}
                    aria-label={`List item ${itemIndex + 1}`}
                    value={item}
                    onChange={(event) => {
                      const items = [...((block as { items: string[] }).items ?? [])];
                      items[itemIndex] = event.target.value;
                      update(index, { items } as Partial<EmailBlock>);
                    }}
                    placeholder="Third-party tested"
                  />
                  <button
                    type="button"
                    className={chipClass}
                    aria-label={`Remove list item ${itemIndex + 1}`}
                    onClick={() => update(index, {
                      items: ((block as { items: string[] }).items ?? []).filter((_, i) => i !== itemIndex),
                    } as Partial<EmailBlock>)}
                  >
                    ×
                  </button>
                </div>
              ))}
              <button
                type="button"
                className={chipClass}
                onClick={() => update(index, {
                  items: [...((block as { items: string[] }).items ?? []), ""],
                } as Partial<EmailBlock>)}
              >
                + Item
              </button>
            </div>
          ) : null}

          {block.type === "button" ? (
            <div className="space-y-1">
              <input
                className={inputClass}
                aria-label="Button label"
                value={(block as { label: string }).label ?? ""}
                onChange={(event) => update(index, { label: event.target.value } as Partial<EmailBlock>)}
                placeholder="BROWSE THE CATALOG"
              />
              {/* NO URL FIELD, DELIBERATELY. A button block links to the
                  campaign's own CTA destination through the tracked click
                  route, so the click is counted and any gift on the campaign is
                  armed. Letting an operator type a raw URL here would produce a
                  link around the tracker — an uncounted click, and an email that
                  can promise a gift the store never applies. */}
              <p className="text-[11px] text-zinc-600">
                Goes to the campaign&rsquo;s CTA destination below, through the tracked link.
              </p>
            </div>
          ) : null}

          {block.type === "image" ? (
            <div className="grid gap-2 sm:grid-cols-2">
              <input
                className={inputClass}
                aria-label="Image URL"
                value={(block as { url: string }).url ?? ""}
                onChange={(event) => update(index, { url: event.target.value } as Partial<EmailBlock>)}
                placeholder="https://vantalabsresearch.com/hero.png"
              />
              <input
                className={inputClass}
                aria-label="Image alt text"
                value={(block as { alt?: string }).alt ?? ""}
                onChange={(event) => update(index, { alt: event.target.value } as Partial<EmailBlock>)}
                placeholder="Alt text — most clients block images"
              />
            </div>
          ) : null}

          {block.type === "divider" || block.type === "spacer" ? (
            <p className="text-[11px] text-zinc-600">
              {block.type === "divider" ? "A horizontal rule." : "Vertical space."} Nothing to fill in.
            </p>
          ) : null}
        </div>
      ))}

      <div className="flex flex-wrap gap-2">
        {ADDABLE.map((type) => (
          <button
            key={type}
            type="button"
            className="rounded-lg border border-white/10 px-3 py-1.5 text-xs font-semibold text-zinc-300 hover:border-white/25 hover:text-white"
            onClick={() => add(type)}
          >
            + {LABELS[type]}
          </button>
        ))}
      </div>
    </div>
  );
}
