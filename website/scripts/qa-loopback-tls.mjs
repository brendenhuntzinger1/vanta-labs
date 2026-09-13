/**
 * TRUST THE HARNESS'S OWN SELF-SIGNED CERTIFICATE, AND NOTHING ELSE'S.
 *
 * THE FAILURE THIS EXISTS TO STOP. Links inside a captured email are built from
 * NEXT_PUBLIC_SITE_URL, which in the harness is the TLS proxy on
 * https://127.0.0.1:3443. A suite that follows one with Node's `fetch` gets
 * `TypeError: fetch failed` and nothing else — the cause, DEPTH_ZERO_SELF_SIGNED_CERT,
 * is two levels down in `error.cause.code`. Reported as a step failure it reads
 * like a dead unsubscribe endpoint or a broken campaign click, and it is neither.
 *
 * WHY IT IS A FILE RATHER THAN AN ENVIRONMENT VARIABLE. It used to work because
 * whoever ran the suites happened to have NODE_TLS_REJECT_UNAUTHORIZED=0 exported
 * in their shell. That is the worst possible arrangement: the suite's verdict
 * depended on something the suite never stated, so it passed by hand and failed
 * under a runner, and the difference looked like a product regression. Fourteen
 * checks in qa-lifecycle-email moved on nothing but that variable.
 *
 * Node's `fetch` has no per-request TLS option, so the relaxation is necessarily
 * process-wide — which is exactly why it is gated on the target being loopback
 * and why every caller here is a script that refuses to run against anything
 * else. Pointed at a real host it does nothing at all, and certificate
 * verification stays fully on.
 */

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * Accept the harness proxy's self-signed certificate when `base` is loopback.
 * Returns true if verification was relaxed, false if it was left alone.
 */
export function allowLoopbackSelfSignedTls(base) {
  let host;
  try {
    host = new URL(String(base)).hostname;
  } catch {
    return false;
  }
  if (!LOOPBACK_HOSTS.has(host)) return false;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  return true;
}
