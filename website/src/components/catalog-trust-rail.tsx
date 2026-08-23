import Link from "next/link";
import { catalogTrustRail } from "@/lib/trust-claims";

// ---------------------------------------------------------------------------
// THE CATALOG TRUST RAIL.
//
// Five signals in place of the paragraph that used to sit under the headline.
// The paragraph said more; this says enough, and it says it in the two seconds
// somebody arriving from social actually gives a store they have never heard of.
//
// Deliberately NOT five cards. Cards would put a border around every claim and
// turn a quiet row into five competing boxes — the exact "everything in a box"
// look that reads as a template. Separation here is a single hairline between
// items, and nothing else.
//
// At 320-430px five columns cannot hold two words each without the type going
// microscopic, so below sm the rail scrolls horizontally instead. Overflow is
// contained to the rail, never the page. `snap` makes that feel deliberate
// rather than like a layout accident, and the items keep full-size type.
//
// Two of the five are links (COAs, Support) because they lead somewhere real.
// The other three are statements, and are not made to look tappable.
// ---------------------------------------------------------------------------

const ICONS: Record<string, React.ReactNode> = {
  // Dispatch — a van, because this is about the parcel leaving.
  fulfillment: (
    <>
      <path d="M3 7h10v8H3z" />
      <path d="M13 10h4l3 3v2h-7z" />
      <circle cx="7" cy="17.5" r="1.5" />
      <circle cx="16.5" cy="17.5" r="1.5" />
    </>
  ),
  // Documentation — a shield with a check, the COA is the proof.
  coas: (
    <>
      <path d="M12 3 5 5.5v5.2c0 4.3 2.9 7.5 7 9.3 4.1-1.8 7-5 7-9.3V5.5z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  // Purity — a droplet, the assay.
  purity: <path d="M12 3s5.5 6 5.5 9.6A5.5 5.5 0 0 1 12 18a5.5 5.5 0 0 1-5.5-5.4C6.5 9 12 3 12 3z" />,
  // Support — a headset, a person on the other end.
  support: (
    <>
      <path d="M4 13v-1a8 8 0 0 1 16 0v1" />
      <path d="M4 13h2.5v5H5a1 1 0 0 1-1-1z" />
      <path d="M20 13h-2.5v5H19a1 1 0 0 0 1-1z" />
    </>
  ),
  // Checkout — a closed padlock.
  checkout: (
    <>
      <rect x="5" y="10.5" width="14" height="9.5" rx="1.6" />
      <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
    </>
  ),
};

function Item({ top, bottom, icon }: { top: string; bottom: string; icon: string }) {
  return (
    <>
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="vl-rail-icon"
      >
        {ICONS[icon]}
      </svg>
      <span className="vl-rail-label">
        {top}
        <br />
        {bottom}
      </span>
    </>
  );
}

/**
 * `everyProductHasCoa` decides which COA claim the rail is allowed to make.
 * Omitted means "not established", which renders the weaker, always-true line —
 * the rail never over-claims by default or while the catalogue is loading.
 */
export function CatalogTrustRail({ everyProductHasCoa = false }: { everyProductHasCoa?: boolean }) {
  return (
    <div className="vl-rail" role="list" aria-label="Why Vanta Labs">
      {catalogTrustRail(everyProductHasCoa).map(({ top, bottom, href, icon }) =>
        href ? (
          <Link key={bottom} href={href} className="vl-rail-item vl-focus-ring" role="listitem">
            <Item top={top} bottom={bottom} icon={icon} />
          </Link>
        ) : (
          <div key={bottom} className="vl-rail-item" role="listitem">
            <Item top={top} bottom={bottom} icon={icon} />
          </div>
        ),
      )}
    </div>
  );
}
