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
// THIS DOES NOT REACH THE ROUTE HANDLERS, and the comment here used to claim it
// did ("so the mock gateway is reachable in this harness"). Measured 2026-08-28
// on a clean restart with no other server bound to :3000:
//
//   GET /api/catalog/payment-methods  ->  500
//   harness log: "PAYMENT_PROVIDER=mock/test is forbidden in production."
//
// That throw is resolvePaymentProviderName reading process.env.NODE_ENV at call
// time (payment-provider.ts:318). The value is NOT inlined at build — the
// compiled chunk still contains the runtime comparison — so the reassignment
// below is simply not visible where the route runs. Next re-establishes its own
// environment after prepare(); reassigning the parent's process.env afterwards
// does not follow.
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
