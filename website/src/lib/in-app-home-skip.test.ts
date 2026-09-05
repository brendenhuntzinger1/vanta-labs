import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
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

// ---------------------------------------------------------------------------
// THE REDIRECT DESCRIBED ABOVE IS GONE, AND THE CATALOG GATE IS WHY.
//
// Everything in the header above was true and the reasoning still holds: an
// app's WebView cannot play the hero, and a motionless magnified vial filling a
// phone screen is a poor first impression. The fix was to send those visitors
// to the catalog instead.
//
// The catalog now requires an account (GATED_PREFIXES in middleware.ts). So the
// redirect's destination became a login wall, and "skip the still hero" turned
// into "meet a sign-in form before seeing anything at all" — strictly worse
// than the problem it solved, and inflicted on precisely the paid social
// traffic the rule existed to serve.
//
// So IN_APP_HOME_REPLACEMENT is null and homePageReplacement returns null for
// everyone. What these tests now pin is that the redirect STAYS gone, because
// re-adding it would be an easy and plausible-looking mistake for anyone
// reading the header comment above without reading this one.
//
// The signed-out home page is a reasonable landing for these browsers now: it
// carries the brand, the testing story, and an explicit invitation to sign in,
// and hero-video.tsx independently serves a still rather than a broken player.
// ---------------------------------------------------------------------------
describe("an in-app browser now keeps the home page, like everyone else", () => {
  for (const [app, ua] of Object.entries(IN_APP_AGENTS)) {
    it(`answers ${app} exactly as it answers desktop Chrome`, async () => {
      // "/" requires an account now, so everyone is sent to sign in. What must
      // stay true — and is the only thing worth testing here — is that the
      // answer does not depend on WHO is asking. A wall that varied by browser
      // would be a cloak.
      const inApp = await redirectTarget({ path: "/", ua });
      const desktop = await redirectTarget({ path: "/", ua: REAL_BROWSER_AGENTS["chrome desktop"] });
      expect(inApp).toContain("/account/login");
      expect(inApp).toBe(desktop);
    });
  }

  it("never routes an in-app visitor through the catalog to get to sign-in", async () => {
    // The regression this guards is a DOUBLE hop. A redirect to /products would
    // immediately be re-redirected to /account/login, costing a second round
    // trip on the slowest connections there are. One hop, straight to the door.
    for (const ua of Object.values(IN_APP_AGENTS)) {
      const target = await redirectTarget({ path: "/", ua });
      expect(target).toContain("/account/login");
      expect(target, "must not detour via the catalog").not.toContain("/products");
    }
  });

  it("carries the campaign query through the hop, so paid attribution survives", async () => {
    // There IS a hop now, and this is the expensive one to get wrong: every
    // click the store pays for arrives with a ttclid, and losing it on the way
    // to the sign-in page means the conversion is never attributed to the ad
    // that bought it. The whole original URL rides in ?next=.
    const target = await redirectTarget({
      path: "/?ttclid=ABC123&utm_source=tiktok",
      ua: IN_APP_AGENTS.tiktok,
    });
    expect(target).toContain("/account/login");
    const next = new URLSearchParams(target!.split("?")[1]).get("next");
    expect(next, "the visitor's original URL must survive the redirect").toBe(
      "/?ttclid=ABC123&utm_source=tiktok",
    );
  });

  it("treats an RSC navigation the same as a page load", async () => {
    // A client-side navigation fetches the flight payload rather than a
    // document. If that shape were answered differently, the payload for a
    // protected page would be served to someone the document is withheld from.
    const asDocument = await redirectTarget({ path: "/", ua: IN_APP_AGENTS.tiktok });
    const asPayload = await redirectTarget({ path: "/", ua: IN_APP_AGENTS.tiktok, document: false });
    expect(asPayload).toContain("/account/login");
    expect(asPayload).toBe(asDocument);
  });

  it("holds the replacement at null, so the rule cannot come back by accident", () => {
    const mw = read("middleware.ts");
    expect(mw).toMatch(/const IN_APP_HOME_REPLACEMENT: string \| null = null;/);
  });
});

describe("every browser that can play the vial keeps it", () => {
  for (const [name, ua] of Object.entries(REAL_BROWSER_AGENTS)) {
    it(`answers ${name} with the same sign-in redirect as every other browser`, async () => {
      expect(await redirectTarget({ path: "/", ua })).toContain("/account/login");
    });

    it(`answers ${name} the same way from a paid social link`, async () => {
      // A ttclid says where a visitor came from, not what their browser can
      // render, and it is attacker-supplied. It must not move the answer.
      const plain = await redirectTarget({ path: "/", ua });
      const paid = await redirectTarget({ path: "/?ttclid=ABC123", ua });
      expect(paid).toContain("/account/login");
      // Same destination; only the carried ?next= differs, by the path asked for.
      expect(paid?.split("?next=")[0]).toBe(plain?.split("?next=")[0]);
    });
  }

  it("answers a request with no user-agent identically", async () => {
    // A crawler, a curl, a scanner. Unknown gets the same wall as everyone.
    const anonymous = await redirectTarget({ path: "/" });
    const desktop = await redirectTarget({ path: "/", ua: REAL_BROWSER_AGENTS["chrome desktop"] });
    expect(anonymous).toContain("/account/login");
    expect(anonymous).toBe(desktop);
  });
});

describe("no page is redirected on account of the browser", () => {
  // The in-app rule is gone entirely, so nothing is moved because of WHO is
  // asking. These paths must stay reachable without an account, and an in-app
  // browser must reach every one of them exactly as any other browser does.
  for (const path of ["/account/login", "/legal/terms", "/contact"]) {
    it(`leaves ${path} alone in an in-app browser`, async () => {
      expect(await redirectTarget({ path, ua: IN_APP_AGENTS.tiktok })).toBeNull();
    });
  }

  // And these now require an account. Same answer for every browser.
  for (const path of ["/cart", "/checkout", "/membership", "/research"]) {
    it(`sends ${path} to sign in, identically for every browser`, async () => {
      const inApp = await redirectTarget({ path, ua: IN_APP_AGENTS.tiktok });
      const desktop = await redirectTarget({ path, ua: REAL_BROWSER_AGENTS["chrome desktop"] });
      expect(inApp).toContain("/account/login");
      expect(inApp).toBe(desktop);
    });
  }

  // The catalog paths DO redirect now, and it is essential that they redirect
  // for a reason that has nothing to do with the browser. These assertions are
  // the proof: the same path gives the same answer to an in-app browser and to
  // desktop Chrome. If those two ever diverge, the wall has become a cloak.
  for (const path of ["/products", "/products/bpc-157-10mg", "/coa-library"]) {
    it(`sends ${path} to sign in, identically for every browser`, async () => {
      const inApp = await redirectTarget({ path, ua: IN_APP_AGENTS.tiktok });
      const desktop = await redirectTarget({ path, ua: REAL_BROWSER_AGENTS["chrome desktop"] });
      expect(inApp).toContain("/account/login");
      expect(inApp).toBe(desktop);
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
  it("puts an in-app visitor on the home page, like everyone else", async () => {
    // This used to land on /products, because the in-app rule sent that
    // audience there and the correction obeyed it in one hop rather than two.
    // With the catalog gated there is no such destination, so the correction
    // has one answer for every browser — which is also one fewer way for this
    // file to develop a browser-dependent behaviour.
    // The correction's own answer is "/". That "/" then requires an account
    // like everything else, which is a separate hop and a separate rule.
    expect(
      await redirectTarget({ path: "/videos/vanta-labs-hero-opt.mp4", ua: IN_APP_AGENTS.tiktok }),
    ).toBe("/");
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

  it("has no second component left that could move a visitor after paint", () => {
    // This used to pair middleware with the age gate, which held its own
    // client-side destination: if the two disagreed, a visitor got moved by the
    // client after the page was already on screen — the flash this whole
    // mechanism exists to remove. That overlay is gone, so the pairing has one
    // member. What is pinned now is that no replacement destination has come
    // back, in middleware or anywhere else.
    expect(mw).toMatch(/const IN_APP_HOME_REPLACEMENT: string \| null = null;/);
    const components = readdirSync(join(process.cwd(), "src/components"));
    expect(components).not.toContain("age-gate.tsx");
  });
});
