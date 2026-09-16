import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Repository invariants for the Omnisend website script.
 *
 * Omnisend is the store's email and SMS marketing platform, and its snippet is
 * a tracker: it sets a session and a visitor identifier, reports page views,
 * and can identify a contact. It is loaded for EVERY visitor, before and
 * regardless of the cookie banner — the owner's decision, the same one made
 * for the Meta Pixel. That makes the guarantees here MORE important than for
 * the gated pixels, not less:
 *
 * - The policies must describe it honestly. A "nothing loads if you decline"
 *   sentence that sweeps Omnisend in is a false statement about a live script.
 * - No email address may ever reach it from client code. The script is on
 *   every page for everyone, so an `identifyContact` call — which the vendor
 *   docs invite "as soon as the customer logs in" — would hand a raw address
 *   to a third party at scale, and no policy paragraph describes that.
 *
 * Plus the usual: one loader, one brand id, one mount, the environment gate.
 */

const SRC = join(process.cwd(), "src");
const OMNISEND = join(SRC, "components", "omnisend-snippet.tsx");
const ROUTE_VIEWS = join(SRC, "components", "omnisend-route-views.tsx");
const META_PIXEL = join(SRC, "components", "meta-pixel.tsx");
const LAYOUT = join(SRC, "app", "layout.tsx");
const BANNER = join(SRC, "components", "cookie-consent.tsx");
const LEGAL = join(SRC, "lib", "legal-content.ts");
/** The owner's brand id, as it arrived in the snippet Omnisend generated. */
const BRAND_ID = "6aa09072ca3afa5724d4d71a";
const LAUNCHER = "https://omnisnippet1.com/inshop/launcher-v2.js";

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      sourceFiles(path, found);
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      found.push(path);
    }
  }
  return found;
}

const files = sourceFiles(SRC);
const read = (path: string) => readFileSync(path, "utf8");
const relative = (path: string) => path.replace(SRC, "src");

/** Source with comments removed: documenting a trap is not falling into it. */
function executableSource(path: string): string {
  return read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
}

/** The snippet actually written into the document, inside the inline <script>. */
function injectedSnippet(): string {
  const source = read(OMNISEND);
  const start = source.indexOf("__html: `");
  expect(start, "omnisend-snippet.tsx no longer renders an inline <script>").toBeGreaterThan(-1);
  const end = source.indexOf("`", start + "__html: `".length);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("exactly one Omnisend data source", () => {
  it("injects the launcher from exactly one place", () => {
    const loaders = files.filter((path) => read(path).includes(LAUNCHER));
    expect(loaders.map(relative)).toEqual(["src/components/omnisend-snippet.tsx"]);
  });

  it("sets the brand id in exactly one place", () => {
    const setters = files.filter((path) => /\[\s*["']brandID["']/.test(executableSource(path)));
    expect(setters.map(relative)).toEqual(["src/components/omnisend-snippet.tsx"]);
  });

  it("holds the brand id literal in one file, under a public env name", () => {
    // The id is not a secret: it ships to every visitor and names the Omnisend
    // account, not a credential. It is overridable so a staging deployment can
    // be pointed at a different account without a code change.
    const withId = files.filter((path) => read(path).includes(BRAND_ID));
    expect(withId.map(relative)).toEqual(["src/components/omnisend-snippet.tsx"]);
    const source = read(OMNISEND);
    expect(source).toContain(`process.env.NEXT_PUBLIC_OMNISEND_BRAND_ID ?? "${BRAND_ID}"`);
    expect(source).not.toMatch(/SECRET|ACCESS_TOKEN|SERVICE_ROLE|API_KEY/);
  });

  it("refuses a brand id that is not an Omnisend brand id", () => {
    // The id is interpolated into an inline <script>, so it is checked rather
    // than trusted. A misconfigured env var must produce no script, not a
    // script carrying whatever the variable held.
    const source = read(OMNISEND);
    expect(source).toContain("const BRAND_ID_SHAPE = /^[0-9a-f]{24}$/;");
    expect(source).toContain("if (!BRAND_ID_SHAPE.test(BRAND_ID)) return null;");
  });

  it("ships the vendor snippet verbatim apart from the brand id", () => {
    // So it can be diffed against whatever Omnisend's install screen generates
    // without reading past reformatting.
    const snippet = injectedSnippet();
    expect(snippet).toContain("window.omnisend = window.omnisend || [];");
    expect(snippet).toContain('omnisend.push(["brandID", "${BRAND_ID}"]);');
    expect(snippet).toContain('omnisend.push(["track", "$pageViewed"]);');
    expect(snippet).toContain(
      '!function(){var e=document.createElement("script");e.type="text/javascript",e.async=!0,'
      + `e.src="${LAUNCHER}";var t=document.getElementsByTagName("script")[0];t.parentNode.insertBefore(e,t)}();`,
    );
    // The id itself appears once, in the constant; the snippet only interpolates it.
    expect(snippet).not.toContain(BRAND_ID);
  });

  it("is rendered on the SERVER, so it reaches the HTML without JavaScript", () => {
    // Omnisend's own installation check reads the document. A client component
    // is absent from the served HTML, so it could never be verified.
    const source = read(OMNISEND);
    expect(source).not.toMatch(/^"use client";/m);
    expect(source).not.toContain('from "next/script"');
    expect(source).toContain("dangerouslySetInnerHTML");
  });

  it("is mounted once, globally, from the root layout, as the last thing in <body>", () => {
    const mounts = files.filter((path) => /<OmnisendSnippet\s*\/>/.test(read(path)));
    expect(mounts.map(relative)).toEqual(["src/app/layout.tsx"]);
    // "Right before the closing </body> tag" is where Omnisend's install
    // screen asks for it, so nothing else is rendered after it.
    const layout = read(LAYOUT);
    const mount = layout.indexOf("<OmnisendSnippet />");
    const bodyEnd = layout.lastIndexOf("</body>");
    expect(mount).toBeGreaterThan(-1);
    expect(bodyEnd).toBeGreaterThan(mount);
    expect(layout.slice(mount + "<OmnisendSnippet />".length, bodyEnd)).not.toMatch(/<[A-Za-z]/);
  });
});

describe("Omnisend is ungated by consent, and the policies say so", () => {
  const snippet = read(OMNISEND);
  const routeViews = read(ROUTE_VIEWS);
  const banner = read(BANNER);
  const legal = read(LEGAL);
  const cookiesStart = legal.indexOf('title: "Cookie Policy"');
  const privacy = legal.slice(0, cookiesStart);
  const cookies = legal.slice(cookiesStart);

  it("does not consult the consent store at all", () => {
    for (const source of [snippet, routeViews]) {
      expect(source).not.toContain("cookie-consent-client");
      expect(source).not.toContain("hasAcceptedConsent");
    }
    expect(snippet).not.toContain("consentManager");
  });

  it("still applies the environment gate on the server, exactly as the Meta pixel does", () => {
    for (const source of [snippet, read(META_PIXEL)]) {
      expect(source).toContain("adsReportingAllowed({");
      expect(source).toContain("vercelEnv: process.env.VERCEL_ENV ?? process.env.NEXT_PUBLIC_VERCEL_ENV");
      expect(source).toContain("nodeEnv: process.env.NODE_ENV");
    }
    expect(snippet).toContain("if (!snippetIsPermittedHere()) return null;");
    expect(snippet.indexOf("if (!snippetIsPermittedHere()) return null;")).toBeLessThan(snippet.indexOf("dangerouslySetInnerHTML"));
  });

  it("reports client-side navigations as page views from a client component, guarded", () => {
    // A single-page app: after the first load, navigation never reloads the
    // document, so without this every visit is exactly one page view.
    expect(routeViews).toMatch(/^"use client";/m);
    expect(routeViews).toContain("usePathname");
    expect(routeViews).toContain("initialPageSent");
    expect(executableSource(ROUTE_VIEWS)).toContain('window.omnisend?.push(["track", "$pageViewed"]);');
    expect(snippet).toContain("<OmnisendRouteViews />");
  });

  it("the banner names Omnisend as loading either way, and keeps it out of the gated sentence", () => {
    expect(banner).toMatch(/Meta Pixel loads either way[^.]*Omnisend/);
    expect(banner).toMatch(/Analytics and our advertising pixels \(TikTok, Snapchat and Reddit\) load only if you accept/);
    expect(banner).not.toMatch(/Omnisend[^.]*only if you accept/);
  });

  it("the privacy policy describes Omnisend as always present, with the data shared and the purpose", () => {
    expect(cookiesStart).toBeGreaterThan(-1);
    expect(privacy).toMatch(/\*\*Omnisend is present on every page, whether or not you accept cookies\.\*\*/);
    expect(privacy).toMatch(/Declining cookies does not stop the Omnisend script/);
    expect(privacy).toMatch(/When you accept, five things run/);
    expect(privacy).toMatch(/Three more — the Meta Pixel, the Google Ads tag and the Omnisend script — are present whether or not you accept/);
    expect(privacy).toMatch(/Omnisend is our marketing email and SMS service provider/);
    // The SCRIPT still reports page views only; the server-side sync is a
    // separate paragraph that names every category it hands over.
    expect(privacy).toMatch(/The script itself is told about page views only and is never handed your email address by code running in your browser\./);
    expect(privacy).not.toMatch(/this site never hands it your email address/);
    expect(privacy).not.toMatch(/receives no shopping actions, product identifiers or order values/);
  });

  it("the privacy policy names every category the server sends Omnisend, and why", () => {
    const start = privacy.indexOf("**What our server sends Omnisend.**");
    expect(start).toBeGreaterThan(-1);
    const paragraph = privacy.slice(start, privacy.indexOf("\n\n", start));
    expect(paragraph).toContain("our server sends Omnisend your email address");
    expect(paragraph).toContain("your phone number, only where you have given SMS marketing consent");
    expect(paragraph).toContain("your marketing consent status for email and SMS and the date and time it was given or withdrawn");
    expect(paragraph).toContain("your order history (the products, amounts and dates)");
    expect(paragraph).toContain("the contents of your cart");
    expect(paragraph).toContain("while you are signed in, the products you view");
    expect(paragraph).toContain("whether you have confirmed that you are 21 or over and buying for research use");
    expect(paragraph).toContain("your referral code");
    expect(paragraph).toContain("any discount code or gift we have issued to you");
    // Honest during the transition: the switch defaults to off, and until it is
    // set the in-house engine still sends marketing through Resend.
    expect(paragraph).toContain("Until the move to Omnisend is complete, some marketing email is still sent through Resend as well.");
    expect(paragraph).toContain("so that it can send the marketing email and SMS you agreed to and measure how they perform");
    // Consent is copied, never widened: the policy must not describe a phone
    // number as reaching Omnisend on any other basis than SMS consent.
    expect(paragraph).not.toMatch(/phone number[^;]*(checkout|order)/i);
  });

  it("the privacy policy separates transactional email (Resend) from marketing (Omnisend)", () => {
    expect(privacy).toMatch(/Transactional email — order confirmations, shipping and delivery updates, refunds, password and account security messages — is not marketing and is sent through Resend/);
    expect(privacy).toMatch(/marketing email and SMS delivery \(Omnisend\)/);
    expect(privacy).toMatch(/transactional email delivery \(Resend, which also carries some marketing email until the move to Omnisend is complete\)/);
  });

  it("the privacy policy says how to stop the messages, not only the script", () => {
    const start = privacy.indexOf("**How to stop Omnisend.**");
    expect(start).toBeGreaterThan(-1);
    const paragraph = privacy.slice(start, privacy.indexOf("\n\n", start));
    expect(paragraph).toContain("Declining cookies does not stop the Omnisend script.");
    expect(paragraph).toContain("Unsubscribing from our marketing email, or replying STOP to a text message, stops those messages");
  });

  it("the SMS section names Omnisend as the provider that receives the number, only after opt-in", () => {
    const start = privacy.indexOf("## SMS / text messaging");
    expect(start).toBeGreaterThan(-1);
    const section = privacy.slice(start, privacy.indexOf("## Your choices", start));
    expect(section).toContain("Our text messages are sent through Omnisend, our marketing email and SMS service provider");
    expect(section).toContain("which receives your mobile number and your SMS consent record only once you have opted in");
    expect(section).toContain("will not be shared with, or sold to, any third party or affiliate for their own marketing purposes");
    expect(section).toContain("Reply STOP to any message to cancel at any time");
    expect(section).toContain("Reply HELP for help");
    expect(section).toContain("Message frequency varies. Message and data rates may apply.");
    expect(section).toContain("pass the withdrawal to Omnisend");
    // The old wording hid the provider behind a generic phrase.
    expect(section).not.toContain("through the messaging provider that delivers them on our behalf");
  });

  it("the cookie policy describes Omnisend as not controlled by the banner", () => {
    const start = cookies.indexOf("**Omnisend — always present, and not controlled by this banner.**");
    expect(start).toBeGreaterThan(-1);
    const bullet = cookies.slice(start, cookies.indexOf("\n\n", start));
    expect(bullet).toMatch(/loads on every page whether you accept or decline/);
    expect(bullet).toMatch(/Declining cookies does not stop it/);
    expect(bullet).toMatch(/Omnisend is our marketing email and SMS service provider/);
    expect(bullet).toMatch(/The script itself reports page views only and is never handed your email address by code running in your browser\./);
    expect(bullet).toMatch(/our server sends Omnisend your email address, your phone number where you have given SMS consent, your marketing consent and its date, your order history, your cart contents and, while you are signed in, the products you view/);
    expect(bullet).not.toMatch(/this site never sends it your email address/);
    expect(bullet).not.toMatch(/never told about shopping actions or order values/);
  });

  it("the SMS program terms match between the consent box and the policies", () => {
    // Twilio and the carriers review the opt-in form against the policy. The
    // program name, frequency line, STOP/HELP and rates sentence must agree,
    // so a change to one without the other fails here.
    const settings = read(join(SRC, "components", "account-settings-client.tsx"));
    const terms = legal.slice(legal.indexOf('title: "Terms of Service"'), cookiesStart);
    const smsPolicy = privacy.slice(privacy.indexOf("## SMS / text messaging"), privacy.indexOf("## Your choices"));
    const smsTerms = terms.slice(terms.indexOf("## SMS terms"), terms.indexOf("## Limitation of liability"));
    expect(smsTerms.length).toBeGreaterThan(0);
    for (const text of [settings, smsPolicy, smsTerms]) {
      expect(text).toMatch(/recurring automated marketing text messages from Vanta Labs/i);
      expect(text).toContain("Message frequency varies. Message and data rates may apply.");
      expect(text).toMatch(/Reply STOP/);
      expect(text).toMatch(/HELP for help/);
      expect(text).toMatch(/Consent is not a condition of (any )?purchase\./);
    }
    expect(settings).toContain("Your number is never shared with third parties for their marketing.");
    expect(smsTerms).toContain("Messages are delivered through Omnisend, our marketing email and SMS service provider.");
    expect(smsTerms).toContain("is never shared with third parties for their marketing");
  });

  it("keeps every policy free of emoji and exclamation marks", () => {
    expect(legal).not.toMatch(/!/);
    expect(legal).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it("never sweeps Omnisend into a \"nothing loads if you decline\" promise", () => {
    for (const promise of legal.match(/no request (?:is made to|reaches)[^.]*/gi) ?? []) {
      expect(promise, "Omnisend is inside a \"nothing reaches\" promise, which is false").not.toContain("Omnisend");
    }
    expect(legal).not.toMatch(/none of (them|these|the four|the five|the six)[^.]*(is|are) (ever )?loaded[^.]*Omnisend/i);
    expect(legal).not.toMatch(/Omnisend[^.]*loads only if you accept/i);
    expect(legal).not.toMatch(/Omnisend[^.]*(is|are) never (loaded|fetched)/i);
    expect(banner).not.toMatch(/Omnisend[^.]*only if you accept/);
  });

  it("counts it, so the closing promise stays true", () => {
    // The closing sentence counts the trackers. Adding one without recounting
    // publishes a false statement in the very sentence that promises honesty.
    expect(privacy).not.toMatch(/beyond the five named above/);
    expect(privacy).toMatch(/beyond the six named above/);
    expect(privacy).not.toMatch(/narrowest of the five/);
  });
});

describe("Omnisend receives page views only, and nothing identifying", () => {
  it("never calls identifyContact from anywhere in the codebase", () => {
    for (const path of files) {
      expect(executableSource(path), `${relative(path)} identifies a contact to Omnisend`).not.toContain("identifyContact");
    }
  });

  it("sends only the page-view event from the browser, so the policy's 'the script itself is told about page views only' is true", () => {
    const names = new Set<string>();
    for (const path of files) {
      for (const match of executableSource(path).matchAll(/omnisend\??\.push\(\[\s*["']track["'],\s*["']([^"']+)["']/g)) {
        names.add(match[1]);
      }
    }
    expect([...names]).toEqual(["$pageViewed"]);
  });

  it("only ever calls omnisend optionally outside the loader, so a blocked SDK is a no-op", () => {
    for (const path of files) {
      if (path === OMNISEND) continue; // the inline snippet defines it
      for (const line of executableSource(path).split("\n")) {
        // A call on the vendor object, not the component's file name in an
        // import and not the API host in the server transport.
        if (!/\bomnisend\./.test(line) || line.includes("omnisend.com")) continue;
        expect(/window\.omnisend\?\./.test(line), `${relative(path)} touches omnisend unguarded: ${line.trim()}`).toBe(true);
      }
    }
  });
});
