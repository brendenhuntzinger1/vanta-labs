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
// next() forces NODE_ENV=production internally; put it back so the mock
// gateway is reachable in this harness and ONLY in this harness.
process.env.NODE_ENV = "test";

createServer((req, res) => handle(req, res)).listen(port, "127.0.0.1", () => {
  console.log(`harness server on http://127.0.0.1:${port}  NODE_ENV=${process.env.NODE_ENV}`);
});
