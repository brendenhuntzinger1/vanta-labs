#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Sweep every customer-facing route at desktop AND mobile, and report the
// things a human notices before they notice anything else: a page that errors,
// a layout that scrolls sideways, an image that never loads, a link that goes
// nowhere, a price rendered as NaN.
//
// This is deliberately BROAD and SHALLOW. Hand-driving proves one path deeply;
// this proves that no route is obviously broken, which is the check that
// actually catches the regression three directories away from the change.
//
// Chromium needs --ssl-version-max=tls1.2 in a cloud session or the egress
// proxy resets every navigation and the whole site reads as an outage. See
// docs/BROWSER-TESTING-RUNBOOK.md.
//
//   node scripts/qa-site-sweep.mjs
//   BASE_URL=http://127.0.0.1:3000 node scripts/qa-site-sweep.mjs
// ---------------------------------------------------------------------------
import { existsSync } from "node:fs";
import { chromium } from "playwright";

const BASE = process.env.BASE_URL || "http://127.0.0.1:3000";

const ROUTES = [
  "/",
  "/products",
  "/products/bpc-157-10mg",
  "/products/tb-500-5mg",
  "/cart",
  "/checkout",
  "/membership",
  "/wholesale",
  "/partner",
  "/partner/login",
  "/login",
  "/contact",
  "/research",
  "/coa-library",
  "/vault",
  "/legal/terms",
  "/legal/privacy",
  "/legal/research-disclaimer",
  "/this-route-does-not-exist",
];

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
];

// Harness seed gaps, not site defects. The seed ships placeholder image paths
// that were never real files, and `bac-water` is deliberately not seeded (the
// runbook documents both). Treating them as findings buries the real ones.
const IGNORED_CONSOLE = [
  /\/img\/[a-z0-9]+\.png/i,
  /_next\/image\?url=%2Fimg%2F/i,
  /\/api\/catalog\/bac-water/i,
];

// A guest calling /api/account/me gets a 401 by design. It is noise, not a bug,
// but it is worth counting separately rather than hiding.
const GUEST_401 = /\/api\/account\/me/i;

const findings = [];
const note = (route, viewport, kind, detail) =>
  findings.push({ route, viewport, kind, detail });

// Same resolution qa-purchase-path.mjs uses: the pre-installed Chromium moves
// between image builds, so probe for it rather than hardcoding one path, and
// fall back to Playwright's own default when neither exists.
// --ssl-version-max=tls1.2 is not optional in a cloud session: the egress proxy
// resets Chromium's default TLS 1.3 ClientHello on EVERY host, which reads as a
// site-wide outage and is not one. See docs/BROWSER-TESTING-RUNBOOK.md.
const CHROME = process.env.QA_CHROMIUM
  ?? ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/opt/pw-browsers/chromium/chrome-linux/chrome"]
    .find((p) => existsSync(p));
const browser = await chromium.launch({
  ...(CHROME ? { executablePath: CHROME } : {}),
  args: ["--no-sandbox", "--ssl-version-max=tls1.2"],
});

const context = await browser.newContext({ viewport: VIEWPORTS[0] });
// Pass the age gate once, or every route below tests the gate and none of them
// tests the page behind it. It lives in sessionStorage under
// `vl-age-confirmed-session` (see the long comment in age-gate.tsx for why
// sessionStorage and not a cookie), and an init script is the only way to seed
// it before the app's first render.
await context.addInitScript(() => {
  try {
    window.sessionStorage.setItem("vl-age-confirmed-session", "true");
  } catch {
    /* private mode; the gate will simply be shown */
  }
});

let guest401s = 0;

for (const vp of VIEWPORTS) {
  const page = await context.newPage();
  await page.setViewportSize({ width: vp.width, height: vp.height });

  for (const route of ROUTES) {
    const consoleErrors = [];
    const badResponses = [];
    const onConsole = (m) => {
      if (m.type() !== "error") return;
      // A failed subresource logs "Failed to load resource: ... 400" and NOTHING
      // about which resource — the URL is on location(), not in text(). Filtering
      // on text() alone therefore matches nothing and every ignored seed image
      // comes back as a finding, which is how 38 console "errors" appeared for
      // 0 real ones.
      const text = m.text();
      const where = m.location()?.url || "";
      const subject = `${text} ${where}`;
      if (GUEST_401.test(subject)) { guest401s++; return; }
      if (IGNORED_CONSOLE.some((re) => re.test(subject))) return;
      consoleErrors.push(`${text.slice(0, 110)}${where ? ` @ ${where.replace(BASE, "").slice(0, 80)}` : ""}`);
    };
    const onResponse = (r) => {
      const url = r.url();
      if (r.status() < 400) return;
      if (GUEST_401.test(url)) { guest401s++; return; }
      if (IGNORED_CONSOLE.some((re) => re.test(url))) return;
      badResponses.push(`${r.status()} ${url.replace(BASE, "").slice(0, 110)}`);
    };
    page.on("console", onConsole);
    page.on("response", onResponse);

    let status = 0;
    try {
      const res = await page.goto(BASE + route, {
        waitUntil: "domcontentloaded",
        timeout: 45000,
      });
      status = res ? res.status() : 0;
      await page.waitForTimeout(1400);
    } catch (err) {
      note(route, vp.name, "NAVIGATION", String(err).slice(0, 160));
      page.off("console", onConsole);
      page.off("response", onResponse);
      continue;
    }

    const expected404 = route === "/this-route-does-not-exist";
    if (status >= 500) note(route, vp.name, "HTTP", `page returned ${status}`);
    if (expected404 && status !== 404) {
      note(route, vp.name, "HTTP", `unknown route answered ${status}, expected 404`);
    }

    const probe = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const body = document.body.innerText || "";
      // The page itself must not scroll sideways. A rail with its own
      // overflow-x:auto is the correct pattern and is NOT overflow.
      const overflow = document.documentElement.scrollWidth > vw + 1;
      const brokenImgs = Array.from(document.images)
        .filter((i) => i.complete && i.naturalWidth === 0)
        .map((i) => i.currentSrc || i.src || "");
      const deadLinks = Array.from(document.querySelectorAll("a"))
        .filter((a) => {
          const h = a.getAttribute("href");
          return h === null || h === "" || h === "#" || h === "undefined";
        })
        .map((a) => (a.textContent || "").trim().slice(0, 40) || "(no text)");
      const junk = ["undefined", "NaN", "[object Object]", "Lorem ipsum", "TODO:"]
        .filter((s) => body.includes(s));
      // An empty <main> is a page that rendered nothing — the failure mode a
      // 200 status will never show you.
      const main = document.querySelector("main");
      const emptyMain = main ? (main.innerText || "").trim().length < 40 : false;
      const h1s = Array.from(document.querySelectorAll("h1")).length;
      return { overflow, brokenImgs, deadLinks, junk, emptyMain, h1s, scrollW: document.documentElement.scrollWidth, vw };
    });

    if (probe.overflow) {
      note(route, vp.name, "OVERFLOW", `page scrolls sideways: ${probe.scrollW}px > ${probe.vw}px`);
    }
    // The seed's placeholder paths were never real files, so they break on every
    // page that renders a product. Filtering them HERE rather than in the probe
    // keeps the ignore list in one place.
    const realBroken = probe.brokenImgs.filter(
      (src) => !IGNORED_CONSOLE.some((re) => re.test(src)),
    );
    if (realBroken.length) {
      note(route, vp.name, "IMAGE", `${realBroken.length} broken: ${realBroken.slice(0, 3).map((s) => s.slice(-70)).join(", ")}`);
    }
    if (probe.deadLinks.length) {
      note(route, vp.name, "LINK", `${probe.deadLinks.length} href-less: ${probe.deadLinks.slice(0, 4).join(" | ")}`);
    }
    if (probe.junk.length) {
      note(route, vp.name, "CONTENT", `rendered literal ${probe.junk.join(", ")}`);
    }
    if (probe.emptyMain && !expected404) {
      note(route, vp.name, "EMPTY", "main region rendered almost no text");
    }
    if (probe.h1s === 0 && !expected404) {
      note(route, vp.name, "SEO", "no <h1> on the page");
    }
    if (probe.h1s > 1) {
      note(route, vp.name, "SEO", `${probe.h1s} <h1> elements`);
    }
    if (consoleErrors.length) {
      note(route, vp.name, "CONSOLE", consoleErrors.slice(0, 3).join(" ;; "));
    }
    if (badResponses.length) {
      note(route, vp.name, "REQUEST", [...new Set(badResponses)].slice(0, 3).join(" ;; "));
    }

    page.off("console", onConsole);
    page.off("response", onResponse);
  }
  await page.close();
}

await browser.close();

const routesChecked = ROUTES.length * VIEWPORTS.length;
console.log(`\nSwept ${ROUTES.length} routes x ${VIEWPORTS.length} viewports = ${routesChecked} page loads`);
console.log(`Ignored ${guest401s} guest 401s on /api/account/me (by design for a signed-out visitor)\n`);

if (!findings.length) {
  console.log("No findings.");
  process.exit(0);
}

const byKind = {};
for (const f of findings) (byKind[f.kind] ||= []).push(f);
for (const [kind, items] of Object.entries(byKind)) {
  console.log(`${kind} (${items.length})`);
  for (const f of items) console.log(`  ${f.route}  [${f.viewport}]  ${f.detail}`);
  console.log("");
}
console.log(`${findings.length} findings.`);
process.exit(findings.length ? 1 : 0);
