import { adsReportingAllowed } from "@/lib/ads/ads-environment";
import { META_PIXEL_ID } from "@/lib/ads/meta-pixel-id";
import { Suspense } from "react";
import { MetaPixelRouteViews } from "@/components/meta-pixel-route-views";

/**
 * Meta (Facebook) Pixel — SERVER-RENDERED, in the document, on every page,
 * for every visitor, the way Meta's install screen describes.
 *
 * THIS IS THE ONE PIXEL BESIDES GOOGLE THAT LOADS WITHOUT CONSENT, AND THAT
 * IS A DECISION THE OWNER MADE, not a default. TikTok, Snap and Reddit are
 * still held back until Accept. Meta is loaded like the Google tag: present in
 * the served HTML, active before and regardless of the cookie banner. The
 * Cookie and Privacy policies describe it in its own paragraph for exactly
 * that reason and must not fold it into the "nothing loads if you decline"
 * sentence, which is true of those three and false of this one.
 * meta-pixel-source.test.ts fails if they ever are.
 *
 * Server-rendered rather than a client component because a client component
 * is absent from the served HTML: Meta's own installation check and its Pixel
 * Helper both read the document, and a tag that cannot be verified is a tag
 * nobody can trust is working. The <noscript> image Meta's base code ships
 * with is included for the same reason.
 *
 * The environment gate is the same one the Google tag applies: a production
 * Vercel deployment and a production build, resolved on the server. A preview
 * deployment or a local run must never report into the live ad account,
 * because the pixel id falls back to the production value.
 *
 * ON ADVANCED MATCHING. `fbq('init')` takes an optional second argument of
 * match keys. Meta's docs show a PLAINTEXT address there, hashed by its SDK in
 * the browser. This does not do that. When the visitor is signed in, the root
 * layout hands this component a SHA-256 digest of the account's email and id,
 * produced on the server by the same module TikTok and Snap use; a guest gets
 * an init with the pixel id and nothing else. The raw address is never in
 * client code, never in a prop, never in the page's serialised payload.
 *
 * The snippet is Meta's base code verbatim apart from the id and the match
 * keys, so it can be diffed against whatever Events Manager generates.
 */

function pixelIsPermittedHere(): boolean {
  return adsReportingAllowed({
    vercelEnv: process.env.VERCEL_ENV ?? process.env.NEXT_PUBLIC_VERCEL_ENV,
    nodeEnv: process.env.NODE_ENV,
  }).allowed;
}

/**
 * The id is interpolated into an inline <script>, so it is checked rather
 * than trusted. A Meta pixel id is digits only; anything else is refused and
 * the pixel simply does not render.
 */
const PIXEL_ID_SHAPE = /^\d{6,}$/;
const DIGEST_SHAPE = /^[0-9a-f]{64}$/;

export type MetaMatchKeys = {
  /** SHA-256 of the normalised email. Never a raw address. */
  em?: string | null;
  /** SHA-256 of the account id. */
  external_id?: string | null;
};

export function MetaPixel({ matchKeys }: { matchKeys?: MetaMatchKeys | null }) {
  if (!pixelIsPermittedHere()) return null;
  if (!PIXEL_ID_SHAPE.test(META_PIXEL_ID)) return null;

  // Only digests are ever placed in the init call. JSON.stringify makes the
  // values inert inside an inline <script>, and the shape check means nothing
  // that is not 64 hex characters can reach it at all.
  const keys: Record<string, string> = {};
  if (matchKeys?.em && DIGEST_SHAPE.test(matchKeys.em)) keys.em = matchKeys.em;
  if (matchKeys?.external_id && DIGEST_SHAPE.test(matchKeys.external_id)) keys.external_id = matchKeys.external_id;
  const init = Object.keys(keys).length > 0
    ? `fbq('init', '${META_PIXEL_ID}', ${JSON.stringify(keys)});`
    : `fbq('init', '${META_PIXEL_ID}');`;

  return (
    <>
      {/* Meta Pixel Code */}
      <script
        dangerouslySetInnerHTML={{
          __html: `
!function(f,b,e,v,n,t,s)
{if(f.fbq)return;n=f.fbq=function(){n.callMethod?
n.callMethod.apply(n,arguments):n.queue.push(arguments)};
if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
n.queue=[];t=b.createElement(e);t.async=!0;
t.src=v;s=b.getElementsByTagName(e)[0];
s.parentNode.insertBefore(t,s)}(window,document,'script',
'https://connect.facebook.net/en_US/fbevents.js');
${init}
fbq('track', 'PageView');
`,
        }}
      />
      <noscript>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          height="1"
          width="1"
          style={{ display: "none" }}
          alt=""
          src={`https://www.facebook.com/tr?id=${META_PIXEL_ID}&ev=PageView&noscript=1`}
        />
      </noscript>
      {/* End Meta Pixel Code */}
      <Suspense fallback={null}>
        <MetaPixelRouteViews />
      </Suspense>
    </>
  );
}
