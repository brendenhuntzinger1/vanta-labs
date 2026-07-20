import { SiteHeaderV2 } from "@/components/site-header-v2";

// Renders a policy body written in the tiny markup used by
// src/lib/legal-content.ts: a line starting with "## " is a heading; blank
// lines separate paragraphs. Everything is treated as text (no raw HTML), so
// admin-edited content is safe to render.
function renderBody(body: string) {
  const blocks = body.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  return blocks.map((block, index) => {
    if (block.startsWith("## ")) {
      return (
        <h2 key={index} className="vl2-serif mt-8 text-xl text-white">
          {block.slice(3).trim()}
        </h2>
      );
    }
    return (
      <p key={index} className="text-sm leading-7 text-white/70">
        {block}
      </p>
    );
  });
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
      <main className="mx-auto max-w-3xl px-6 pb-24 pt-32 lg:px-12">
        <p className="vl2-eyebrow">Legal</p>
        <h1 className="vl2-serif mt-3 text-3xl text-white sm:text-4xl">{title}</h1>
        <p className="mt-2 text-xs text-white/40">Last updated: {updated}</p>
        <div className="mt-8 space-y-4">{renderBody(body)}</div>
      </main>
    </div>
  );
}
