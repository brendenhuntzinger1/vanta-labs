"use client";

import { useState, type ReactNode } from "react";

/**
 * A section switcher for the advertising page.
 *
 * Deliberately local rather than a change to the admin shell: the console's own
 * navigation already works and rebuilding it to accommodate one page is the
 * sort of unrelated redesign that breaks things nobody was looking at.
 *
 * Every panel is rendered by the server and handed over as a slot, so switching
 * sections is instant and nothing is fetched twice.
 */
export type AdsSection = { id: string; label: string; content: ReactNode };

export function AdsSectionTabs({ sections, initial }: { sections: AdsSection[]; initial?: string }) {
  const [active, setActive] = useState(initial ?? sections[0]?.id);
  const current = sections.find((section) => section.id === active) ?? sections[0];

  return (
    <div className="space-y-5">
      <nav
        className="flex flex-wrap gap-1 rounded-xl border border-white/[0.07] bg-[#141414] p-1"
        aria-label="Advertising sections"
      >
        {sections.map((section) => {
          const selected = section.id === current?.id;
          return (
            <button
              key={section.id}
              type="button"
              onClick={() => setActive(section.id)}
              aria-current={selected ? "page" : undefined}
              className={`rounded-lg px-3 py-2 text-xs transition ${
                selected ? "bg-white/[0.08] text-white" : "text-white/45 hover:text-white/80"
              }`}
            >
              {section.label}
            </button>
          );
        })}
      </nav>
      <div className="space-y-5">{current?.content}</div>
    </div>
  );
}
