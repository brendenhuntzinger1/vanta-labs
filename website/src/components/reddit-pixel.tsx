"use client";

import Script from "next/script";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

/**
 * Reddit Pixel — installed globally, behind the same consent gate as TikTok and
 * Snap.
 *
 * Mounted once in the root layout so it is present on every page, and injected
 * with next/script at `afterInteractive`, which is the correct placement in the
 * App Router: Next puts it in the document rather than the React tree, so it
 * survives client navigation without re-executing the loader.
 *
 * It is NOT hard-coded into <head> unconditionally, and that is deliberate.
 * Dropping a third-party advertising script before consent is the single most
 * common finding in a cookie audit, and the banner promises Decline is a real
 * no-track path. Gating it here means the SDK is never fetched for someone who
 * declined — no request to redditstatic.com, no cookie, nothing to revoke.
 *
 * The loader below is Reddit's own snippet, unmodified, so it can be diffed
 * against whatever the Reddit Ads console currently generates without having to
 * read past reformatting. Reddit's snippet ships with the comment "DO NOT
 * MODIFY UNLESS TO REPLACE A USER IDENTIFIER"; the only substitution made is
 * the pixel id, and it is the same id the snippet arrived with.
 *
 * ON IDENTITY (Advanced Matching, Reddit's setup step 3): `rdt('init')` takes
 * an optional second argument carrying match keys. Reddit's own example puts a
 * PLAINTEXT address there and lets its SDK hash it in the browser. This does
 * not do that. The keys are SHA-256 digests computed on the server and fetched
 * from /api/ads/reddit-match-keys, so the raw address is never handed to client
 * JavaScript, never sits in a prop, and never appears in the page's serialised
 * payload — the same rule the TikTok and Snap integrations follow. Reddit
 * cannot tell the difference; it hashes to the same 64 hex digits either way.
 *
 * Keys exist only for a SIGNED-IN customer. A guest sends none, which is the
 * behaviour this component shipped with.
 *
 * The lookup is best-effort and must never gate the pixel: on error, on a slow
 * response, or for a guest, the script is injected with no keys rather than not
 * at all. An advertising identifier is not worth losing the page view over.
 */

export const REDDIT_PIXEL_ID = process.env.NEXT_PUBLIC_REDDIT_PIXEL_ID ?? "a2_jipuxv3ugrju";
const STORAGE_KEY = "vl_cookie_consent";
const CONSENT_EVENT = "vanta:cookie-consent";

declare global {
  interface Window {
    rdt?: (command: string, ...args: unknown[]) => void;
  }
}

function hasAccepted(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "accepted";
  } catch {
    // Storage blocked (private mode, some in-app browsers). Absence of a
    // recorded "yes" is a no.
    return false;
  }
}

type MatchKeys = { email?: string; externalId?: string };

/** How long the match-key lookup may delay the pixel before we give up on it. */
const MATCH_KEY_TIMEOUT_MS = 1500;

export function RedditPixel() {
  const [accepted, setAccepted] = useState(false);
  // undefined = still deciding, null = resolved with no keys (guest, error or
  // timeout). The script waits only for the transition out of undefined.
  const [matchKeys, setMatchKeys] = useState<MatchKeys | null | undefined>(undefined);
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // The inline snippet fires PageVisit once on load. Skipping that first
  // route-change effect avoids double-counting the landing page.
  const initialPageSent = useRef(false);

  useEffect(() => {
    const sync = () => setAccepted(hasAccepted());
    sync();
    window.addEventListener(CONSENT_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(CONSENT_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  // Resolve the match keys once, after consent. Deliberately not re-run on
  // navigation: init happens once, so a later answer could not be applied
  // without a second init, and a second init double-counts.
  useEffect(() => {
    if (!accepted) return;
    let cancelled = false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MATCH_KEY_TIMEOUT_MS);

    fetch("/api/ads/reddit-match-keys", { signal: controller.signal, cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        if (!cancelled) setMatchKeys((body?.matchKeys as MatchKeys | null) ?? null);
      })
      .catch(() => {
        // Guest, offline, aborted, anything: load the pixel without keys.
        if (!cancelled) setMatchKeys(null);
      })
      .finally(() => clearTimeout(timer));

    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [accepted]);

  // A single-page app: after the first load, navigation never reloads the
  // document, so without this every visit would report exactly one page view
  // however much of the site someone read.
  useEffect(() => {
    if (!accepted) return;
    if (!initialPageSent.current) {
      initialPageSent.current = true;
      return;
    }
    window.rdt?.("track", "PageVisit");
  }, [accepted, pathname, searchParams]);

  if (!accepted) return null;
  // Still waiting on the lookup. It resolves within MATCH_KEY_TIMEOUT_MS in
  // every case including failure, so this is a brief delay, never a dead end.
  if (matchKeys === undefined) return null;

  // Serialised rather than interpolated by hand: JSON.stringify is what makes
  // the values inert inside an inline <script>, and the digests are plain hex
  // so nothing here can carry a quote or a script-closing sequence.
  const init = matchKeys
    ? `rdt('init','${REDDIT_PIXEL_ID}',${JSON.stringify(matchKeys)});`
    : `rdt('init','${REDDIT_PIXEL_ID}');`;

  return (
    <Script id="reddit-pixel" strategy="afterInteractive">
      {`
!function(w,d){if(!w.rdt){var p=w.rdt=function(){p.sendEvent?p.sendEvent.apply(p,arguments):p.callQueue.push(arguments)};p.callQueue=[];var t=d.createElement("script");t.src="https://www.redditstatic.com/ads/pixel.js?pixel_id=${REDDIT_PIXEL_ID}",t.async=!0;var s=d.getElementsByTagName("script")[0];s.parentNode.insertBefore(t,s)}}(window,document);${init}rdt('track', 'PageVisit');
      `}
    </Script>
  );
}
