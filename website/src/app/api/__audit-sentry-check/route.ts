import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * TEMPORARY — pre-launch Sentry reception proof. DELETE AFTER VERIFICATION.
 *
 * Sentry had never received a single event, so "monitoring is configured" and
 * "monitoring works" were different claims and only the first was provable.
 * The controlled live order must not be the first attempt to discover which
 * one is true, so this endpoint sends ONE deliberate sentinel exception and
 * reports the event id.
 *
 * It reads nothing, writes nothing, and touches no customer data. The payload
 * is fabricated PII-shaped text whose only purpose is to prove the scrubber
 * deletes it before it leaves the process.
 *
 * Token-gated so a passer-by cannot spam the issue stream during the few
 * minutes this exists.
 */
const AUDIT_TOKEN = "cvG0J9m9BQZTG_EQWe1ZD4ePLj0ANITl";

class VantaAuditSentinel extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VantaAuditSentinel";
  }
}

export async function GET(request: Request) {
  if (new URL(request.url).searchParams.get("token") !== AUDIT_TOKEN) {
    return NextResponse.json({ success: false, error: "Not found" }, { status: 404 });
  }

  const { sentryEnabled } = await import("@/lib/sentry-init");
  const { sentryDsnState } = await import("@/lib/sentry-init");
  const { sentryEnvironment, sentryRelease } = await import("@/lib/sentry-privacy");

  const dsn = sentryDsnState();
  if (!sentryEnabled()) {
    return NextResponse.json({ success: false, sentry: "disabled", dsn }, { status: 503 });
  }

  const Sentry = await import("@sentry/nextjs");

  // Every one of these is invented. None is a real address, card, or account.
  // Each is shaped to trip one rule in PII_PATTERNS so the received event can
  // be checked field by field.
  const sentinel = new VantaAuditSentinel(
    "VANTA_AUDIT_SENTINEL scrub check — "
      + "email sentinel-not-a-real-person@example.invalid, "
      + "card 4111111111111111, "
      + "phone 555-018-2937, "
      + "zip 90210, "
      + "credential sk_test_NOTAREALKEY000000, "
      + "address 1 Nowhere Lane",
  );

  const eventId = Sentry.captureException(sentinel, (scope) => {
    // Identity must be DELETED, not merely unsent. Set it deliberately so the
    // received event proves scrubEvent removed it rather than proving we
    // simply never attached one.
    scope.setUser({ id: "sentinel-user-id", email: "sentinel-not-a-real-person@example.invalid" });
    scope.setExtra("authorization", "Bearer NOTAREALTOKEN0000000000");
    scope.setExtra("customer_email", "sentinel-not-a-real-person@example.invalid");
    scope.setExtra("harmless_marker", "vanta-audit-ok");
    scope.setTag("vanta_audit", "sentry-reception-proof");
    return scope;
  });

  // The lambda can freeze the moment the response is returned, so the event has
  // to be on the wire before we answer.
  const flushed = await Sentry.flush(5000);

  return NextResponse.json({
    success: true,
    eventId,
    flushed,
    environment: sentryEnvironment(),
    release: sentryRelease(),
    dsnHost: dsn.state === "ok" ? dsn.host : null,
    dsnProject: dsn.state === "ok" ? dsn.projectId : null,
  });
}
