import { Suspense } from "react";

import { adsReportingAllowed } from "@/lib/ads/ads-environment";
import { OmnisendRouteViews } from "@/components/omnisend-route-views";

/**
 * Omnisend website script — the store's email and SMS marketing platform —
 * SERVER-RENDERED, in the document, on every page, for every visitor, the
 * way Omnisend's install screen describes ("paste the snippet right before
 * the closing </body> tag").
 *
 * THIS LOADS WITHOUT CONSENT, AND THAT IS A DECISION THE OWNER MADE, exactly
 * as for the Meta Pixel. TikTok, Snap and Reddit are still held back until
 * Accept. Omnisend is loaded like the Meta Pixel and the Google tag: present
 * in the served HTML, active before and regardless of the cookie banner. The
 * Cookie and Privacy policies describe it in its own paragraph for exactly
 * that reason and must not fold it into the "nothing loads if you decline"
 * sentence, which is true of the three pixels and false of this one.
 * omnisend-source.test.ts fails if they ever are.
 *
 * Server-rendered rather than a client component because a client component
 * is absent from the served HTML: Omnisend's own installation check reads
 * the document, and a snippet that cannot be verified is a snippet nobody
 * can trust is working. It is the last thing in <body>, where Omnisend asks
 * for it.
 *
 * ENVIRONMENT-GATED, like every tracker here (K-16, lib/ads/ads-environment.ts):
 * a production Vercel deployment and a production build, resolved on the
 * server. The brand id falls back to the live account, so a preview
 * deployment or a local run would otherwise register as real visitors in
 * Omnisend — and a browse-abandonment automation could send a real message
 * over a QA session.
 *
 * WHAT IT DOES. The launcher renders the account's sign-up forms, feeds Live
 * View and browse-abandonment automations with page views, and links a visit
 * to a contact record when someone subscribes through one of its forms or
 * arrives through a link in an Omnisend message. It sets a session identifier
 * (30 minutes of inactivity) and a visitor identifier (a year).
 *
 * PAGE VIEWS ONLY. The snippet is the one Omnisend's install screen
 * generates, verbatim apart from the brand id, and it reports `$pageViewed`
 * and nothing else. `identifyContact` is deliberately not called anywhere:
 * Omnisend's docs invite it "as soon as the customer logs in", which would
 * hand a raw email address to a third party from client code — something no
 * other integration here does (they send server-side SHA-256 digests, and
 * only where a policy paragraph says so). Omnisend learns an address only
 * when the visitor types it into an Omnisend form.
 *
 * The brand id is not a secret: it ships to every visitor and names the
 * Omnisend account, not a credential. It is overridable by env so a staging
 * deployment can be pointed at a different account without a code change.
 */

function snippetIsPermittedHere(): boolean {
  return adsReportingAllowed({
    vercelEnv: process.env.VERCEL_ENV ?? process.env.NEXT_PUBLIC_VERCEL_ENV,
    nodeEnv: process.env.NODE_ENV,
  }).allowed;
}

const BRAND_ID = process.env.NEXT_PUBLIC_OMNISEND_BRAND_ID ?? "6aa09072ca3afa5724d4d71a";

/**
 * The id is interpolated into an inline <script>, so it is checked rather
 * than trusted. An Omnisend brand id is 24 hex characters; anything else is
 * refused and the snippet simply does not render.
 */
const BRAND_ID_SHAPE = /^[0-9a-f]{24}$/;

export function OmnisendSnippet() {
  if (!snippetIsPermittedHere()) return null;
  if (!BRAND_ID_SHAPE.test(BRAND_ID)) return null;

  return (
    <>
      {/* Omnisend snippet */}
      <script
        dangerouslySetInnerHTML={{
          __html: `
window.omnisend = window.omnisend || [];
omnisend.push(["brandID", "${BRAND_ID}"]);
omnisend.push(["track", "$pageViewed"]);
!function(){var e=document.createElement("script");e.type="text/javascript",e.async=!0,e.src="https://omnisnippet1.com/inshop/launcher-v2.js";var t=document.getElementsByTagName("script")[0];t.parentNode.insertBefore(e,t)}();
`,
        }}
      />
      {/* End Omnisend snippet */}
      <Suspense fallback={null}>
        <OmnisendRouteViews />
      </Suspense>
    </>
  );
}
