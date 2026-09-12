// Serve the compiled production build WITHOUT `next start`'s unconditional
// NODE_ENV=production.
//
// WHY THIS EXISTS
// ---------------
// The Block G/H browser harness needs PAYMENT_PROVIDER=mock so a purchase can
// be driven end to end without a real processor. Mock payments are hard-blocked
// whenever NODE_ENV === 'production' -- deliberately, with no env override
// (see resolvePaymentProviderName in src/lib/payment-provider.ts, and the
// regression test in src/lib/mock-payment-lockout.test.ts). That control is
// correct and must NOT be weakened to make testing convenient.
//
// `next start` sets NODE_ENV=production itself, so it cannot serve a mock-mode
// build. This server runs the SAME compiled bundle under NODE_ENV=test.
// It is a production build: no HMR socket, no Fast Refresh, no React state
// being reset mid-test -- so the runbook's reason for banning `next dev`
// still holds in full.
//
// Development-only. Never used by the deployed app.
import { createServer } from "node:http";
import next from "next";

const port = Number(process.env.PORT ?? 3000);
const app = next({ dev: false, dir: process.cwd() });
const handle = app.getRequestHandler();

await app.prepare();
// next() forces NODE_ENV=production internally; put it back.
//
// THIS DOES NOT REACH THE ROUTE HANDLERS. It cannot, and the reason is not the
// one this comment used to give.
//
// The old explanation was: "the value is NOT inlined at build — the compiled
// chunk still contains the runtime comparison — so the reassignment below is
// simply not visible where the route runs. Next re-establishes its own
// environment after prepare()." That is wrong in its load-bearing half, and the
// wrong half is what matters: it sends the next person to look for a way to set
// the variable later, and NO such way exists.
//
// What is actually true, read out of the build on 2026-09-12
// (.next/server/chunks/[root-of-the-server]__*.js):
//
//   PAYMENT_PROVIDER){let t=(e??"").trim().toLowerCase();
//   if("mock"===t||"test"===t)throw Error("PAYMENT_PROVIDER=mock/test is forbidden…
//
// The source guard is `if (process.env.NODE_ENV === "production") throw`. In the
// compiled output THE GUARD IS GONE and the throw is unconditional — Turbopack
// folded process.env.NODE_ENV to the literal "production" at build time and the
// minifier then deleted the always-true `if`. `next build` sets NODE_ENV=production
// for itself no matter what the caller exports, so `NODE_ENV=test next build`
// (what harness:build runs) produces exactly the same folded chunk.
//
// CONSEQUENCE: the mock gateway is unreachable from ANY `next build` output, at
// any runtime, through any environment variable. Setting NODE_ENV here, or per
// request, or in .env.local, changes nothing — there is no comparison left to
// change the answer to. `npm run qa:purchase` therefore cannot create an order
// against this harness: measured 2026-09-12, /api/checkout/create-session
// answers 400 and the run reports 12 of 18 steps SKIPPED.
//
// DO NOT "FIX" THIS BY WEAKENING THE LOCKOUT. It is what stops
// /api/checkout/mock-pay marking orders paid in production, and it deliberately
// has no override variable. A real fix has to stop the fold at BUILD time —
// which means a build whose NODE_ENV is genuinely not "production" — and that is
// a change to how the harness is built, not to how it is served or to what the
// lockout permits.
//
// CONSEQUENCE, which is the part worth knowing: every checkout page rendered
// through this harness has been served with payment-methods 500ing, so the card
// service-fee disclosure never rendered in any browser evidence gathered here.
// Cart and checkout still load and still total correctly — the route fails
// closed and the page degrades — but any claim about the fee row on those pages
// is NOT browser-proven.
//
// The lockout itself is correct and must not be weakened to make testing
// convenient: it is what stops /api/checkout/mock-pay marking orders paid in
// production, and it deliberately has no override variable. Making the mock
// gateway reachable here needs the harness to run a build whose NODE_ENV is
// genuinely not "production", not a runtime poke at an already-initialised
// server.
process.env.NODE_ENV = "test";

// STRIP THE TWO HEADERS THAT ASSUME https. HARNESS ONLY.
//
// middleware.ts sets, correctly for production:
//
//   Content-Security-Policy: …; upgrade-insecure-requests
//   Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
//
// This server listens on plain http and speaks no TLS.
// `upgrade-insecure-requests` rewrites every subresource URL to https, so on an
// engine that applies it to loopback the whole page dies: measured 2026-08-29,
// 14 of 14 scripts failed with "Error performing TLS handshake", React never
// booted, and the age gate's Continue button stayed disabled forever. A dead
// site that is purely an artifact of a production header on a plaintext port.
//
// Chromium hides it — it exempts potentially-trustworthy origins (localhost,
// 127.0.0.1) from the upgrade — which is why this went unnoticed while Chromium
// was the only engine installed. WebKit does not exempt loopback, and WebKit is
// what every iOS in-app browser runs, i.e. precisely what we most need to test.
//
// HSTS is dropped for a second reason: honoured on 127.0.0.1 it PINS the origin
// to https inside the browser profile, so a later, otherwise-correct run is
// upgraded and fails before it starts.
//
// Confined to this file. middleware.ts is untouched and production still sends
// both headers; this server is development-only and never deployed.
const HTTPS_ONLY_HEADERS = ["strict-transport-security"];
function stripHttpsOnlyHeaders(res) {
  const setHeader = res.setHeader.bind(res);
  res.setHeader = (name, value) => {
    const key = String(name).toLowerCase();
    if (HTTPS_ONLY_HEADERS.includes(key)) return res;
    if (key === "content-security-policy" && value != null) {
      // Drop only the one directive; every other protection stays on, so the
      // harness still exercises the real CSP.
      const filtered = (Array.isArray(value) ? value : [value]).map((v) =>
        String(v)
          .split(";")
          .map((d) => d.trim())
          .filter((d) => d && d.toLowerCase() !== "upgrade-insecure-requests")
          .join("; "),
      );
      return setHeader(name, Array.isArray(value) ? filtered : filtered[0]);
    }
    return setHeader(name, value);
  };
  return res;
}

createServer((req, res) => handle(req, stripHttpsOnlyHeaders(res))).listen(port, "127.0.0.1", () => {
  console.log(`harness server on http://127.0.0.1:${port}  NODE_ENV=${process.env.NODE_ENV}`);
});
