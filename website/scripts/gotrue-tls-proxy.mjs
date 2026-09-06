#!/usr/bin/env node
// ---------------------------------------------------------------------------
// HTTPS in front of the local PostgREST/GoTrue shims. Development only.
//
// The app's NEXT_PUBLIC_SUPABASE_URL must be https for two independent reasons,
// and both of them produce convincing false bug reports when it is not:
//
//   * IN THE BROWSER it is mixed content. The Supabase client calls GoTrue
//     directly from an https page; WebKit blocks a plain-http call outright
//     ("Not allowed to request resource"), setSession fails, and the OAuth
//     callback never signs anyone in. Chromium allows it for 127.0.0.1, so the
//     two engines disagree and it reads as "Google sign-in is broken in
//     Safari". Production's Supabase URL is https; this makes the harness
//     match.
//
//   * ON THE SERVER supabaseAdmin reads the SAME variable. Point it at a port
//     with nothing listening and every server-side write fails inside a
//     best-effort try/catch: tracking pixels still return their image, redirects
//     still redirect, and nothing is recorded. That looks precisely like a
//     broken feature and is a missing proxy.
//
// Start the app with NODE_TLS_REJECT_UNAUTHORIZED=0 so Node accepts the
// self-signed certificate for its own server-side calls.
//
//   node scripts/gotrue-tls-proxy.mjs            # 54443 -> 127.0.0.1:54321
//   node scripts/gotrue-tls-proxy.mjs --port 54443 --target 127.0.0.1:9999
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

const port = Number(arg("port", "54443"));
const [targetHost, targetPort] = String(arg("target", "127.0.0.1:54321")).split(":");

/** Shared with tls-proxy.mjs by default, so one trust decision covers both. */
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

/** How many requests have crossed, so "is the app even calling Supabase?" has an answer. */
let calls = 0;

createServer(certificate(), (req, res) => {
  calls += 1;
  const upstream = httpRequest(
    {
      host: targetHost,
      port: Number(targetPort),
      method: req.method,
      path: req.url,
      // The upstream's own authority here: unlike the app proxy, nothing
      // downstream compares this against a browser Origin.
      headers: { ...req.headers, host: `${targetHost}:${targetPort}` },
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );
  upstream.on("error", (error) => {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: `upstream error: ${error.message}` }));
  });
  req.pipe(upstream);
}).listen(port, "127.0.0.1", () => {
  console.log(`[gotrue-tls-proxy] https://127.0.0.1:${port} -> http://${targetHost}:${targetPort}`);
});

process.on("SIGUSR2", () => console.log(`[gotrue-tls-proxy] ${calls} requests proxied`));
