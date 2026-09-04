import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

import { middleware } from "../../middleware";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

// ---------------------------------------------------------------------------
// AN APP'S EMBEDDED BROWSER IS NEVER SENT THE HOME PAGE.
//
// The home page IS the spinning vial: a full-bleed hero that fills the screen
// and moves. In TikTok, Snapchat, Instagram and the rest it cannot move — five
// rounds of iOS video fixes ended with the clip taken over or refused, so
// hero-video.tsx serves those browsers a still instead. What is left is a
// motionless, magnified product shot with the headline printed across the
// vial's own label, occupying an entire phone screen before the visitor has
// seen a single product. The owner's word for it was "weird". Measured in the
// harness at 390x844 with a TikTok user-agent, it is exactly that.
//
// This used to be handled entirely inside the age gate: clear the gate on "/",
// and a client-side router.push moved you to the catalog. That fixed one
// arrival and left two holes, both reproduced on the harness before this file
// existed (Chromium, TikTok UA, 390x844, 4x CPU throttle, 1.6 Mbps):
//
//   1. THE HOME PAGE FLASHED. The gate closes on the tap, revealing the page
//      behind it, and the router then has to fetch the catalog before it can
//      move. The home page was on screen, ungated, for ~430ms.
//
//   2. EVERY OTHER ROUTE TO "/" STILL LANDED THERE. The push only ran from the
//      gate's enter handler, and the gate only appears once per visit — so the
//      header wordmark, a product page's "Home" breadcrumb, the 404 and error
//      pages' buttons, the media-file correction below, and any second link
//      opened after the visit was already confirmed all left the visitor
//      sitting on the home page with nothing to move them off it.
//
// So the decision moved to the server, where the User-Agent is on the request
// and the answer is known before a byte of HTML is written. No home page is
// rendered, nothing flashes, and it holds however "/" was reached.
//
// The age gate keeps its own version of this check. It is now unreachable in
// practice — a visitor cannot be standing on "/" in an in-app browser — and is
// kept as the fallback for any path where middleware does not run.
// ---------------------------------------------------------------------------

const IN_APP_AGENTS = {
  tiktok:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 BytedanceWebview/d8a21c6 musical_ly_34.5.0 JsSdk/2.0 NetType/WIFI",
  snapchat:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Snapchat/12.98.0.44 (like Safari/605.1.15)",
  instagram:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 334.0.0.42.95 (iPhone14,3; iOS 17_5_1; en_US)",
  facebook:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FBAN/FBIOS;FBAV/468.0.0.47.109;FBBV/597869427",
};

// Browsers that render the hero exactly as designed. Every one of these must
// keep the home page, whatever link brought them.
const REAL_BROWSER_AGENTS = {
  "safari ios":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  "chrome android":
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  "chrome desktop":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  // A crawler must be served the real home page or the store's most important
  // URL indexes as the catalog.
  googlebot:
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
};

type RequestShape = {
  path?: string;
  ua?: string;
  /** A real page load sets this; an RSC fetch from the client router does not. */
  document?: boolean;
};

function request({ path = "/", ua, document = true }: RequestShape) {
  const headers = new Headers();
  if (ua) headers.set("user-agent", ua);
  if (document) headers.set("sec-fetch-dest", "document");
  else headers.set("sec-fetch-dest", "empty");
  return new NextRequest(new URL(path, "https://www.vantalabsresearch.com"), {
    method: "GET",
    headers,
  });
}

/** The Location a middleware redirect points at, or null if it did not redirect. */
async function redirectTarget(shape: RequestShape): Promise<string | null> {
  const response = await middleware(request(shape));
  const location = response.headers.get("location");
  if (!location) return null;
  const url = new URL(location);
  return `${url.pathname}${url.search}`;
}

describe("an in-app browser is never handed the home page", () => {
  for (const [app, ua] of Object.entries(IN_APP_AGENTS)) {
    it(`sends ${app} to the catalog instead of "/"`, async () => {
      expect(await redirectTarget({ path: "/", ua })).toBe("/products");
    });
  }

  it("does it on the server, before any home page HTML exists", async () => {
    // The distinction that matters: a redirect carries a Location and no body,
    // so the hero is never rendered, never fetched and never painted. The
    // client-side push it replaces could only run after the page was on screen.
    const response = await middleware(request({ path: "/", ua: IN_APP_AGENTS.tiktok }));
    expect(response.status).toBe(307);
    expect(response.headers.get("x-middleware-next")).toBeNull();
  });

  it("is temporary, so no browser or CDN pins it to the URL", async () => {
    // 308 or 301 would be cached against "/" itself and outlive the browser
    // that asked — the same URL opened later in Safari would still bounce.
    // The answer depends on WHO is asking, so it can only ever be a 307.
    const response = await middleware(request({ path: "/", ua: IN_APP_AGENTS.snapchat }));
    expect(response.status).toBe(307);
  });

  it("carries the campaign query onto the catalog", async () => {
    // Nearly all of this traffic is paid. Dropping ttclid or fbclid here would
    // break attribution for exactly the visitors this rule exists to serve, and
    // the loss would be invisible until a report came back empty.
    expect(
      await redirectTarget({
        path: "/?ttclid=ABC123&utm_source=tiktok&utm_medium=paid",
        ua: IN_APP_AGENTS.tiktok,
      }),
    ).toBe("/products?ttclid=ABC123&utm_source=tiktok&utm_medium=paid");
  });

  it("moves a client-side navigation too, not just a fresh page load", async () => {
    // THIS IS THE HOLE THE CLIENT-SIDE VERSION COULD NOT CLOSE. Tapping the
    // header wordmark is an RSC fetch, not a document request — it never
    // carries `sec-fetch-dest: document`. A rule that only redirected real page
    // loads would leave the wordmark, the "Home" breadcrumb and the 404 button
    // all landing on the page this exists to skip.
    expect(
      await redirectTarget({ path: "/", ua: IN_APP_AGENTS.tiktok, document: false }),
    ).toBe("/products");
  });

  it("marks the redirect itself as varying by user-agent, and uncacheable", async () => {
    // This redirect was invented from the User-Agent, so no intermediary may
    // replay it to a different browser. It is the ONLY response that needs
    // saying: middleware runs before the CDN cache, so a cache is only ever
    // consulted for requests already let through, and it therefore only ever
    // holds the one variant of "/" — the home page.
    //
    // Asserted on the redirect and not on the pass-through deliberately.
    // Verified with curl against the harness build: the 307 carries
    // `Vary: User-Agent`, and a `Vary` set on the page response does NOT
    // survive — Next replaces it with its own RSC value. A test asserting the
    // pass-through here would pass on the object and be false on the wire.
    const response = await middleware(request({ path: "/", ua: IN_APP_AGENTS.tiktok }));
    expect(response.headers.get("vary") ?? "").toMatch(/user-agent/i);
    expect(response.headers.get("cache-control") ?? "").toContain("no-store");
  });
});

describe("every browser that can play the vial keeps it", () => {
  for (const [name, ua] of Object.entries(REAL_BROWSER_AGENTS)) {
    it(`leaves ${name} on the home page`, async () => {
      expect(await redirectTarget({ path: "/", ua })).toBeNull();
    });

    it(`leaves ${name} on the home page even from a paid social link`, async () => {
      // The classifier is the browser and nothing else. A ttclid says where a
      // visitor came from, not what their browser can render — keying on it is
      // what once cost a desktop Chrome visitor the hero.
      expect(await redirectTarget({ path: "/?ttclid=ABC123", ua })).toBeNull();
    });
  }

  it("leaves a request with no user-agent alone", async () => {
    // Unknown is not in-app. The failure mode is "keep the home page", which is
    // the same downgrade a false positive would be, in the harmless direction.
    expect(await redirectTarget({ path: "/" })).toBeNull();
  });
});

describe("only the home page is skipped", () => {
  // The rule is about ONE page. Redirecting anything else would throw away the
  // click that brought the visitor — an ad straight to a product, a shared
  // cart, a checkout mid-purchase.
  for (const path of [
    "/products",
    "/products/bpc-157-10mg",
    "/cart",
    "/checkout",
    "/membership",
    "/account/login",
    "/legal/terms",
    "/coa-library",
  ]) {
    it(`leaves ${path} alone in an in-app browser`, async () => {
      expect(await redirectTarget({ path, ua: IN_APP_AGENTS.tiktok })).toBeNull();
    });
  }
});

// ---------------------------------------------------------------------------
// The media-file correction already in middleware sends a top-level navigation
// to a .mp4 back into the site. It was written for exactly this audience — an
// ad destination resolving to the hero file, reported from TikTok — so its
// destination has to obey the same rule as everything else.
// ---------------------------------------------------------------------------
describe("the media-file correction obeys the same rule", () => {
  it("puts an in-app visitor on the catalog, in one hop", async () => {
    expect(
      await redirectTarget({ path: "/videos/vanta-labs-hero-opt.mp4", ua: IN_APP_AGENTS.tiktok }),
    ).toBe("/products");
  });

  it("still puts everyone else on the home page", async () => {
    expect(
      await redirectTarget({
        path: "/videos/vanta-labs-hero-opt.mp4",
        ua: REAL_BROWSER_AGENTS["safari ios"],
      }),
    ).toBe("/");
  });
});

// ---------------------------------------------------------------------------
// One list, one signature. hero-video.tsx decides whether the hero moves, the
// age gate keeps its fallback, and middleware decides whether the page is sent
// at all — all three from `isInAppBrowser`. A second copy of the signature list
// would drift, and the two halves would disagree about the same visitor.
// ---------------------------------------------------------------------------
describe("the classifier is not duplicated", () => {
  const mw = read("middleware.ts");

  it("middleware reads the shared signature list", () => {
    expect(mw).toMatch(/import \{ isInAppBrowser \} from "@\/lib\/in-app-browser"/);
  });

  it("judges the request's own user-agent and nothing else", () => {
    const start = mw.indexOf("function homePageReplacement");
    expect(start, "homePageReplacement must exist").toBeGreaterThan(-1);
    const after = mw.slice(start);
    const fn = after.slice(0, after.indexOf("\n}") + 2);
    expect(fn).toContain('request.headers.get("user-agent")');
    // A campaign marker or referrer says where a visitor came from, not what
    // their browser can render, and both are attacker-supplied.
    for (const forbidden of ["ttclid", "fbclid", "utm_", "referer", "referrer", "searchParams"]) {
      expect(fn, `${forbidden} must not decide this`).not.toContain(forbidden);
    }
  });

  it("keeps the age gate's fallback pointing at the same place", () => {
    const gate = read("src/components/age-gate.tsx");
    expect(gate).toMatch(/const SOCIAL_DESTINATION = "\/products";/);
    expect(mw).toMatch(/const IN_APP_HOME_REPLACEMENT = "\/products";/);
  });
});
