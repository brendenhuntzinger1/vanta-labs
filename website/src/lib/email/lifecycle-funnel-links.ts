import type { FunnelWindowKey } from "@/lib/email/lifecycle-funnel";
import type { FunnelWindowLink } from "@/components/lifecycle-funnel-table";

/**
 * The three windows the funnel can be read over, as links that keep every
 * other query parameter the page already carries (a stats range, a filter).
 * Pure, so the pages can build them at render time and a test can pin them.
 */
export function funnelWindowLinks(
  path: string,
  params: Record<string, string | string[] | undefined>,
  active: FunnelWindowKey,
): FunnelWindowLink[] {
  const options: Array<{ key: FunnelWindowKey; label: string }> = [
    // No date here: the table's own label prints it, in Florida time, from
    // the same constant, and two spellings of one moment read as two moments.
    { key: "plain", label: "since the note-shaped stages" },
    { key: "28", label: "28 days" },
    { key: "90", label: "90 days" },
  ];
  return options.map(({ key, label }) => {
    const search = new URLSearchParams();
    for (const [name, value] of Object.entries(params)) {
      if (name === "window" || value === undefined) continue;
      for (const v of Array.isArray(value) ? value : [value]) search.append(name, v);
    }
    search.set("window", key);
    return { key, label, href: `${path}?${search.toString()}`, active: key === active };
  });
}
