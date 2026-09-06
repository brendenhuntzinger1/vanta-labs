#!/usr/bin/env node
// ---------------------------------------------------------------------------
// THE CUSTOMER JOURNEY, IN ALL THREE ENGINES, AT PHONE AND DESKTOP SIZE.
//
// WHY THIS EXISTS ALONGSIDE THE OTHER TWO CROSS-ENGINE SCRIPTS.
//
//   login-portal-cross-engine.mjs  measures the PORTAL's geometry. Read-only:
//                                  it ticks boxes to observe enabled states and
//                                  never signs in.
//   cross-engine-check.mjs         walks a list of routes looking for overflow.
//
// Neither one INTERACTS. Between them they prove the portal is laid out
// correctly and that pages do not overflow — and they proved that while the
// storefront behind the wall was unreachable to them, because neither had a
// session. "Do not accept screenshots as proof when interaction is required" is
// the standard this closes: this script signs in, browses, adds to a cart,
// opens the cart and reaches checkout, in Chromium, WebKit and Firefox, and
// reports the first step that does not work in each.
//
// The three engines are not interchangeable. Every iOS in-app browser — TikTok,
// Instagram, Facebook, Snapchat — is WKWebView, i.e. WebKit, and that is where
// paid traffic lands. A spoofed user-agent changes the string, not the engine.
//
// Development-only: it signs in as a seeded QA account and refuses to run
// against anything but the local harness.
//
//   ENGINE=webkit node scripts/qa-cross-engine-journey.mjs
//   ENGINE=firefox VIEWPORT=375 node scripts/qa-cross-engine-journey.mjs
// ---------------------------------------------------------------------------

import { randomBytes } from "node:crypto";
import * as pw from "playwright-core";

const BASE = process.env.QA_BASE_URL || "http://127.0.0.1:3000";
const ENGINE = process.env.ENGINE || "chromium";
const EMAIL = process.env.QA_SIGNIN_EMAIL || "qa.verified@example.test";
const PASSWORD = process.env.QA_SIGNIN_PASSWORD || "HarnessPass123!";

if (!/127\.0\.0\.1|localhost/.test(BASE)) {
  console.error(`Refusing to run against ${BASE}. This script signs in and drives the local harness only.`);
  process.exit(1);
}

const launcher = pw[ENGINE];
if (!launcher) {
  console.error(`unknown ENGINE "${ENGINE}" — use chromium, webkit or firefox`);
  process.exit(2);
}

// The egress proxy resets TLS 1.3 and each engine needs a different cap. Inert
// on loopback; kept so the same script works against a preview URL. Without
// them every page looks dead, which reads as an outage and is not one.
const LAUNCH = {
  chromium: {
    headless: true,
    executablePath: "/opt/pw-browsers/chromium",
    args: ["--no-sandbox", "--ssl-version-max=tls1.2"],
  },
  firefox: { headless: true, firefoxUserPrefs: { "security.tls.version.max": 3 } },
  webkit: { headless: true },
}[ENGINE];

/** Desktop plus the two phone widths the audit names. */
const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  390: { width: 390, height: 844 },
  375: { width: 375, height: 812 },
};
const ONLY = process.env.VIEWPORT;

/**
 * A CLIENT IP THIS RUN HAS TO ITSELF.
 *
 * Every context here shares one loopback address otherwise, so a second run
 * inside the limiter's window arrives at a bucket the first one spent: the
 * journey then collects 429s and the console-error check reports them as a
 * site defect. 100.64.0.0/10 is carrier-grade NAT — never routable — and three
 * random octets give ~16 million addresses. The same reasoning as
 * qa-customer-journey.mjs and qa-purchase-path.mjs, which were given their own
 * addresses for exactly this.
 */
/**
 * FRESH PER VIEWPORT, not per process. One address for all three viewports left
 * the third one arriving at a bucket the first two had spent, so the journey
 * collected 429s and the console-error check reported the limiter working as a
 * site defect.
 */
const clientIp = () => {
  const [a, b, c] = randomBytes(3);
  return `100.${64 + (a % 64)}.${b}.${(c % 254) + 1}`;
};

const results = [];
let failures = 0;

function record(label, ok, detail) {
  results.push({ label, ok, detail });
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}

/** Anything painting past the right edge, which is what a phone reads as broken. */
const OVERFLOW = () => {
  const vw = window.innerWidth;
  const de = document.documentElement;
  const offenders = [...document.querySelectorAll("body *")]
    .filter((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none") return false;
      return r.right > vw + 1;
    })
    .slice(0, 3)
    .map((el) => `${el.tagName.toLowerCase()}.${String(el.className || "").slice(0, 24)}`);
  return { over: de.scrollWidth > vw + 1, by: de.scrollWidth - vw, offenders, len: (document.body.innerText || "").trim().length };
};

async function run(name, viewport) {
  console.log(`\n### ${ENGINE} — ${name} ${viewport.width}x${viewport.height}`);
  const browser = await launcher.launch(LAUNCH);
  const ctx = await browser.newContext({
    viewport,
    extraHTTPHeaders: { "x-real-ip": clientIp() },
    // The TLS-fronted harness serves a self-signed pair. Needed for WebKit,
    // which refuses to store the Secure session cookie over plain http and
    // therefore cannot be certified on the http port at all — see
    // docs/BROWSER-TESTING-RUNBOOK.md §5c. Inert on http.
    ignoreHTTPSErrors: true,
    // Firefox does not implement Playwright's mobile emulation.
    ...(viewport.width < 500 && ENGINE !== "firefox" ? { isMobile: true, hasTouch: true } : {}),
  });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 120)); });

  const tag = `${ENGINE}/${name}`;
  try {
    // 1. The wall holds, and the portal is what a signed-out visitor gets.
    await page.goto(`${BASE}/products`, { waitUntil: "domcontentloaded", timeout: 60000 });
    const walled = /\/account\/login/.test(new URL(page.url()).pathname);
    record(`${tag}: the wall sends a signed-out visitor to the portal`, walled, page.url().replace(BASE, ""));

    // 2. The portal renders and does not overflow.
    await page.waitForSelector(".vl-portal-row", { timeout: 20000 }).catch(() => {});
    const portal = await page.evaluate(OVERFLOW);
    record(`${tag}: the portal fits the viewport`, !portal.over && portal.len > 200,
      portal.over ? `+${portal.by}px ${portal.offenders.join(", ")}` : `${portal.len} chars`);

    // 3. Sign in through the portal's own door.
    for (let i = 0; i < 5 && !(await page.$("form input[type=email]")); i += 1) {
      await page.evaluate(() => {
        const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Sign in with email");
        if (b) b.click();
      });
      await page.waitForTimeout(700);
    }
    const formOpened = Boolean(await page.$("form input[type=email]"));
    record(`${tag}: "Sign in with email" opens the form`, formOpened);
    if (!formOpened) return;

    await page.fill("form input[type=email]", EMAIL);
    await page.fill("form input[type=password]", PASSWORD);
    await Promise.all([
      page.waitForResponse((r) => r.url().includes("/api/auth/session") && r.request().method() === "POST", { timeout: 30000 }).catch(() => null),
      page.click("form button[type=submit]"),
    ]);
    await page.waitForTimeout(2000);
    const signedIn = (await ctx.cookies()).some((c) => c.name === "vl_session_token");
    record(`${tag}: the credentials establish a session`, signedIn);
    if (!signedIn) return;

    // 4. The catalogue renders for a signed-in customer.
    await page.goto(`${BASE}/products`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2000);
    const links = await page.$$eval('a[href^="/products/"]', (as) => as.map((a) => a.getAttribute("href")));
    const grid = await page.evaluate(OVERFLOW);
    record(`${tag}: the product grid renders and fits`, links.length > 0 && !grid.over,
      grid.over ? `+${grid.by}px ${grid.offenders.join(", ")}` : `${links.length} products`);
    if (!links.length) return;

    // 5. A product page renders, fits, and its buy control is reachable.
    await page.goto(`${BASE}${links[0]}`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2000);
    const pdp = await page.evaluate(() => {
      const vw = window.innerWidth;
      const de = document.documentElement;
      const btn = [...document.querySelectorAll("button")]
        .find((x) => /add to cart|add to bag/i.test(x.textContent || ""));
      const r = btn?.getBoundingClientRect();
      return {
        over: de.scrollWidth > vw + 1,
        by: de.scrollWidth - vw,
        len: (document.body.innerText || "").trim().length,
        hasBuy: Boolean(btn),
        buyDisabled: btn ? btn.disabled : null,
        // A control narrower than 44px, or painted off-screen, is not tappable.
        buyBox: r ? { w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right) } : null,
      };
    });
    record(`${tag}: the product page renders and fits`, !pdp.over && pdp.len > 400,
      pdp.over ? `+${pdp.by}px` : `${pdp.len} chars`);
    record(`${tag}: the buy control is present and tappable`,
      pdp.hasBuy && pdp.buyDisabled === false && pdp.buyBox && pdp.buyBox.h >= 40 && pdp.buyBox.right <= viewport.width + 1,
      pdp.buyBox ? `${pdp.buyBox.w}x${pdp.buyBox.h} right=${pdp.buyBox.right}` : "no add-to-cart button");

    // 6. Adding to the cart works, and the cart shows it.
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")]
        .find((x) => /add to cart|add to bag/i.test(x.textContent || "") && !x.disabled);
      if (b) b.click();
    });
    await page.waitForTimeout(2500);
    await page.goto(`${BASE}/cart`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2500);
    const cart = await page.evaluate(() => {
      const vw = window.innerWidth;
      const de = document.documentElement;
      const text = document.body.innerText || "";
      return {
        over: de.scrollWidth > vw + 1,
        by: de.scrollWidth - vw,
        empty: /your cart is empty/i.test(text),
        // The word the cart uses for its own number, and the sentence beneath
        // it. "Estimated total" plus a named pending charge is what makes a
        // later increase honest rather than a surprise.
        // NOT the first label containing "total" — that is "Subtotal", which
        // matched and made the disclosure check read the wrong row.
        totalLabel: ([...document.querySelectorAll("div, li")]
          .map((el) => el.querySelectorAll(":scope > span"))
          .filter((sp) => sp.length === 2
            && /total/i.test(sp[0].textContent || "")
            && !/subtotal/i.test(sp[0].textContent || ""))
          .map((sp) => (sp[0].textContent || "").trim())[0]) || "",
        pendingNotice: (text.match(/[^.\n]*(service fee|sales tax is calculated)[^.\n]*\./i) || [""])[0].trim(),
        // The summary rows, read by label, so the numbers can be compared with
        // the ones checkout shows.
        // Keyed by MEANING, not by wording: the cart says "Estimated shipping"
        // and checkout says "Shipping", so matching the literal label compares
        // the two screens on the subtotal alone and misses the row that
        // free-shipping-sitewide actually moves.
        rows: [...document.querySelectorAll("div, li")].reduce((acc, el) => {
          const spans = el.querySelectorAll(":scope > span");
          if (spans.length !== 2) return acc;
          const label = (spans[0].textContent || "").trim().toLowerCase();
          const value = (spans[1].textContent || "").trim();
          const key = /subtotal/.test(label) ? "subtotal"
            : /shipping protection/.test(label) ? "shipping protection"
            : /shipping/.test(label) ? "shipping"
            : /total/.test(label) ? "total"
            : null;
          if (key && /\$|free|calculated/i.test(value)) acc[key] = value;
          return acc;
        }, {}),
      };
    });
    record(`${tag}: the cart holds the item and fits`, !cart.empty && !cart.over,
      cart.over ? `+${cart.by}px` : Object.entries(cart.rows).map(([k, v]) => `${k} ${v}`).join(", ") || "no rows read");

    // 7. Checkout is reachable, renders, and agrees with the cart on the money.
    await page.goto(`${BASE}/checkout`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(3000);
    const checkout = await page.evaluate(() => {
      const vw = window.innerWidth;
      const de = document.documentElement;
      const text = document.body.innerText || "";
      return {
        bounced: /\/account\/login/.test(location.pathname),
        over: de.scrollWidth > vw + 1,
        by: de.scrollWidth - vw,
        len: text.trim().length,
        hasEmail: Boolean(document.querySelector('input[type=email]')),
        // Keyed by MEANING, not by wording: the cart says "Estimated shipping"
        // and checkout says "Shipping", so matching the literal label compares
        // the two screens on the subtotal alone and misses the row that
        // free-shipping-sitewide actually moves.
        rows: [...document.querySelectorAll("div, li")].reduce((acc, el) => {
          const spans = el.querySelectorAll(":scope > span");
          if (spans.length !== 2) return acc;
          const label = (spans[0].textContent || "").trim().toLowerCase();
          const value = (spans[1].textContent || "").trim();
          const key = /subtotal/.test(label) ? "subtotal"
            : /shipping protection/.test(label) ? "shipping protection"
            : /shipping/.test(label) ? "shipping"
            : /total/.test(label) ? "total"
            : null;
          if (key && /\$|free|calculated/i.test(value)) acc[key] = value;
          return acc;
        }, {}),
      };
    });
    record(`${tag}: checkout renders for a signed-in customer`,
      !checkout.bounced && !checkout.over && checkout.len > 400 && checkout.hasEmail,
      checkout.bounced ? "bounced to the portal" : checkout.over ? `+${checkout.by}px` : `${checkout.len} chars`);

    // THE ONE COMPARISON THAT MATTERS ON THIS SCREEN.
    //
    // Subtotal and shipping must match exactly: nothing legitimately moves
    // between the two screens, and a disagreement there is the shape of every
    // pricing bug this store has had. Shipping in particular is where
    // free-shipping-sitewide shows up, and where the stale-config bug lived.
    //
    // THE TOTAL IS ALLOWED TO GROW, BUT ONLY IF THE CART SAID SO. A card
    // service fee depends on the payment method, which is not chosen until
    // checkout, so lib/cart-total-disclosure.ts renames the cart's number
    // "Estimated total" and prints a sentence naming what is still to come.
    // That is a deliberate, disclosed design, not drift — but an UNDISCLOSED
    // difference is exactly the "Final total $344.96 became $355.31" defect
    // that disclosure exists to prevent, so the test demands the disclosure.
    const exact = ["subtotal", "shipping"]
      .filter((k) => cart.rows[k] && checkout.rows[k] && cart.rows[k] !== checkout.rows[k])
      .map((k) => `${k}: cart ${cart.rows[k]} vs checkout ${checkout.rows[k]}`);
    const comparedExact = ["subtotal", "shipping"].filter((k) => cart.rows[k] && checkout.rows[k]);
    record(`${tag}: the cart and checkout agree on subtotal and shipping`,
      comparedExact.length > 0 && exact.length === 0,
      exact.length ? exact.join("; ") : `${comparedExact.join(", ")} agree`);

    const totalsMatch = cart.rows.total && checkout.rows.total && cart.rows.total === checkout.rows.total;
    const estimateDisclosed = /estimated total/i.test(cart.totalLabel) && cart.pendingNotice.length > 0;
    record(`${tag}: any change to the total between cart and checkout was disclosed on the cart`,
      Boolean(totalsMatch || (cart.rows.total && checkout.rows.total && estimateDisclosed)),
      totalsMatch
        ? `both quote ${cart.rows.total}`
        : cart.rows.total && checkout.rows.total
          ? `cart ${cart.rows.total} (${cart.totalLabel || "no label"}) -> checkout ${checkout.rows.total}; notice: ${cart.pendingNotice.slice(0, 90) || "NONE"}`
          : "no total row on one of the screens");

    record(`${tag}: no console errors across the journey`, consoleErrors.length === 0,
      consoleErrors.slice(0, 2).join(" | "));
  } catch (error) {
    record(`${tag}: journey completed without throwing`, false, String(error?.message ?? error).split("\n")[0].slice(0, 160));
  } finally {
    await ctx.close();
    await browser.close();
  }
}

for (const [name, viewport] of Object.entries(VIEWPORTS)) {
  if (ONLY && ONLY !== name) continue;
  await run(name, viewport);
}

console.log(`\n${results.length} checks, ${failures} failing (${ENGINE})`);
if (failures) {
  console.log("\nFailures:");
  for (const r of results.filter((x) => !x.ok)) console.log(`  ${r.label}${r.detail ? ` — ${r.detail}` : ""}`);
}
process.exit(failures ? 1 : 0);
