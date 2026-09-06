#!/usr/bin/env node
// ---------------------------------------------------------------------------
// HTTPS in front of the local harness. Development only.
//
// WHY THIS EXISTS. Two things lie to you over plain http, in opposite
// directions, and both lies look exactly like a product defect:
//
//   * the session cookie is `Secure` in a production build, and WebKit
//     correctly refuses to store one delivered over http — so every
//     authenticated assertion fails in Safari and nowhere else. Chromium
//     stores it anyway (it treats 127.0.0.1 as trustworthy), so the engines
//     disagree and the disagreement reads as "auth is broken in Safari".
//
//   * the browser's Supabase client calls GoTrue directly. Serve the app over
//     https with NEXT_PUBLIC_SUPABASE_URL still on http and that call is mixed
//     content: WebKit blocks it, setSession fails, and the OAuth callback
//     never signs anyone in. Also not a bug. Production's Supabase URL is
//     https. See gotrue-tls-proxy.mjs for the other half.
//
// These two proxies used to live in a scratch directory, which meant they
// vanished with the container and the runbook pointed at files that no longer
// existed — costing a rediscovery every time. They live here now.
//
// USE 127.0.0.1, NOT localhost. This forwards `Host: 127.0.0.1:<port>`, and
// middleware's CSRF check compares Origin against proto://host. Driven at
// https://localhost:3443 every state-changing POST answers 403 Invalid request
// origin, including /api/auth/session — so sign-in silently stops working.
//
//   node scripts/tls-proxy.mjs                  # 3443 -> 127.0.0.1:3000
//   node scripts/tls-proxy.mjs --port 9443 --target 127.0.0.1:4000
// ---------------------------------------------------------------------------

import { createServer } from "node:https";
import { request as httpRequest } from "node:http";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const port = Number(arg("port", "3443"));
const [targetHost, targetPort] = String(arg("target", "127.0.0.1:3000")).split(":");

/**
 * A self-signed pair, generated once into a temp dir and reused.
 *
 * Regenerating on every start would be fine for the proxy but not for the
 * browser: a changed certificate invalidates anything the engine cached
 * against the old one, and Playwright's `ignoreHTTPSErrors` covers the warning
 * rather than the churn.
 */
function certificate() {
  const dir = arg("certs", path.join(os.tmpdir(), "vanta-harness-certs"));
  mkdirSync(dir, { recursive: true });
  const key = path.join(dir, "key.pem");
  const cert = path.join(dir, "cert.pem");
  if (!existsSync(key) || !existsSync(cert)) {
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", key, "-out", cert, "-days", "365",
      "-subj", "/CN=127.0.0.1",
      "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost",
    ], { stdio: "ignore" });
  }
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

createServer(certificate(), (req, res) => {
  const upstream = httpRequest(
    {
      host: targetHost,
      port: Number(targetPort),
      method: req.method,
      path: req.url,
      // Host is rewritten to the PROXY's authority, not the upstream's, so the
      // app sees the origin the browser actually used. Getting this wrong is
      // the 403-on-every-POST failure described above.
      headers: { ...req.headers, host: `127.0.0.1:${port}`, "x-forwarded-proto": "https" },
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );
  upstream.on("error", (error) => {
    res.writeHead(502, { "content-type": "text/plain" });
    res.end(`upstream error: ${error.message}`);
  });
  req.pipe(upstream);
}).listen(port, "127.0.0.1", () => {
  console.log(`[tls-proxy] https://127.0.0.1:${port} -> http://${targetHost}:${targetPort}`);
  console.log("[tls-proxy] self-signed. Drive browsers with ignoreHTTPSErrors, and use 127.0.0.1 not localhost.");
});
