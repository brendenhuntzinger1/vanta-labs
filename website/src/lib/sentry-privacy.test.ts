import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  scrubBreadcrumb,
  scrubEvent,
  scrubText,
  scrubUrl,
  scrubValue,
} from "./sentry-privacy";

// ---------------------------------------------------------------------------
// SENTRY MUST NOT BECOME A COPY OF THE CUSTOMER DATABASE.
//
// A crash report is worth having. A crash report carrying somebody's address
// is a liability that outlives the bug it describes — and unlike an order row,
// nothing in our retention or deletion process reaches it.
//
// These use SYNTHETIC sentinel values only. Never put a real customer detail,
// a real key, or the private ship-from address in a test fixture: that is the
// exact leak this file exists to prevent, and a fixture is forever.
// ---------------------------------------------------------------------------

const SENTINEL = {
  email: "buyer.sentinel@example.invalid",
  phone: "555-010-9999",
  card: "4111111111111111",
  zip: "78701",
  jwt: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.sentinelsentinelsentinel.sig",
  bearer: "Bearer sentineltokensentineltoken",
  secretKey: "sk_live_sentinelsentinel",
  street: "100 Example Test Way",
};

describe("free text is swept for PII regardless of which field it sits in", () => {
  it("redacts an email that arrived inside an error message", () => {
    // The realistic case: a Postgres unique-violation quotes the value.
    const message = `duplicate key value violates unique constraint (${SENTINEL.email})`;
    const out = scrubText(message);
    expect(out).not.toContain(SENTINEL.email);
    expect(out).toContain("[email]");
    // The diagnostic part must survive, or the report is useless.
    expect(out).toContain("duplicate key value violates unique constraint");
  });

  it("redacts card-length digit runs, phone numbers and ZIPs", () => {
    expect(scrubText(SENTINEL.card)).not.toContain(SENTINEL.card);
    expect(scrubText(`call ${SENTINEL.phone}`)).not.toContain("010-9999");
    expect(scrubText(`ships to ${SENTINEL.zip}`)).not.toContain(SENTINEL.zip);
  });

  it("redacts credentials that leaked into a message", () => {
    for (const secret of [SENTINEL.jwt, SENTINEL.bearer, SENTINEL.secretKey]) {
      const out = scrubText(`request failed with ${secret}`);
      expect(out, `${secret} survived`).not.toContain(secret.slice(0, 24));
    }
  });
});

describe("URLs keep the path and lose the identity", () => {
  it("redacts identifying query parameters", () => {
    const out = scrubUrl(`/checkout?email=${SENTINEL.email}&cs=sess_secret&step=2`);
    expect(out).not.toContain(SENTINEL.email);
    expect(out).not.toContain("sess_secret");
    // The route is the whole diagnostic value — it must survive.
    expect(out).toContain("/checkout");
    expect(out).toContain("step=2");
  });

  it("survives a malformed URL without throwing", () => {
    expect(() => scrubUrl("::: not a url :::")).not.toThrow();
  });
});

describe("structured values are redacted by key AND by content", () => {
  it("redacts known-sensitive keys", () => {
    const out = scrubValue({
      email: SENTINEL.email,
      address: SENTINEL.street,
      phone: SENTINEL.phone,
      orderId: "VL-1001",
    }) as Record<string, unknown>;

    expect(out.email).toBe("[redacted]");
    expect(out.address).toBe("[redacted]");
    expect(out.phone).toBe("[redacted]");
    // Safe operational identifiers are the point of the report.
    expect(out.orderId).toBe("VL-1001");
  });

  it("redacts PII hiding under an innocent key name", () => {
    // The case a key-based rule alone would miss.
    const out = scrubValue({ note: `customer said ${SENTINEL.email}` }) as Record<string, unknown>;
    expect(String(out.note)).not.toContain(SENTINEL.email);
  });

  it("terminates on deeply nested and cyclic-shaped input", () => {
    let deep: Record<string, unknown> = { email: SENTINEL.email };
    for (let i = 0; i < 40; i += 1) deep = { nested: deep };
    expect(() => scrubValue(deep)).not.toThrow();
    expect(JSON.stringify(scrubValue(deep))).not.toContain(SENTINEL.email);
  });
});

describe("the whole event is stripped before it leaves the process", () => {
  function eventWithEverything() {
    return {
      message: `checkout failed for ${SENTINEL.email}`,
      user: { id: "cust_1", email: SENTINEL.email, ip_address: "203.0.113.9" },
      request: {
        url: `https://vantalabsresearch.com/checkout?email=${SENTINEL.email}`,
        headers: {
          authorization: SENTINEL.bearer,
          cookie: "vl_session=sentinel",
          "x-payment-signature": "sig_sentinel",
          "user-agent": "Mozilla/5.0",
          "content-type": "application/json",
        },
        cookies: { vl_session: "sentinel" },
        query_string: `email=${SENTINEL.email}`,
        data: { customer: { email: SENTINEL.email, address: SENTINEL.street } },
      },
      exception: { values: [{ value: `insert failed: ${SENTINEL.email}` }] },
      extra: { shippingAddress: SENTINEL.street, orderId: "VL-1001" },
      contexts: { order: { customerEmail: SENTINEL.email } },
      breadcrumbs: [
        { message: `POST /api/checkout ${SENTINEL.email}`, data: { url: `/pay?email=${SENTINEL.email}` } },
      ],
    };
  }

  it("deletes identity, cookies, query string and the request body outright", () => {
    const out = scrubEvent(eventWithEverything()) as Record<string, unknown>;
    const request = out.request as Record<string, unknown>;

    expect(out.user).toBeUndefined();
    expect(request.cookies).toBeUndefined();
    expect(request.query_string).toBeUndefined();
    // The checkout request body carries the shipping address. It must never go.
    expect(request.data).toBeUndefined();
  });

  it("keeps only diagnostic headers and drops every credential header", () => {
    const out = scrubEvent(eventWithEverything());
    const headers = out.request!.headers as Record<string, string>;

    // Asserted as an exhaustive allow-list, not as three named absences: the
    // real protection is that ONLY diagnostic headers are copied, so a new
    // credential header nobody thought to deny is excluded by construction.
    expect(Object.keys(headers).sort()).toEqual(["content-type", "user-agent"]);
    expect(headers.authorization).toBeUndefined();
    expect(headers.cookie).toBeUndefined();
    expect(headers["x-payment-signature"]).toBeUndefined();
    expect(headers["user-agent"]).toBe("Mozilla/5.0");
    expect(headers["content-type"]).toBe("application/json");
  });

  it("leaves NO trace of the sentinel anywhere in the serialized event", () => {
    // The assertion that actually matters: one sweep of the whole payload,
    // rather than trusting that we enumerated every field correctly.
    const serialized = JSON.stringify(scrubEvent(eventWithEverything()));
    for (const [label, value] of Object.entries(SENTINEL)) {
      if (!serialized.includes(value)) continue;
      throw new Error(`${label} survived scrubbing in the serialized event`);
    }
    expect(serialized).not.toContain("203.0.113.9");
    expect(serialized).not.toContain("vl_session");
  });

  it("keeps the route and the error so the report is still diagnosable", () => {
    const out = scrubEvent(eventWithEverything());
    expect(String(out.request!.url)).toContain("/checkout");
    expect(String(out.exception!.values![0].value)).toContain("insert failed");
    expect(JSON.stringify(out.extra)).toContain("VL-1001");
  });

  it("KEEPS the navigation target — the breadcrumb's entire purpose", () => {
    // Found end-to-end, not by a unit test: `to`/`from` are key-redacted
    // elsewhere, and scrubValue was overwriting the scrubbed URL. A navigation
    // breadcrumb reading "[redacted]" cannot tell you a hard load landed on
    // /checkout/pay — which is precisely the seam bug this exists to catch.
    const crumb = scrubBreadcrumb({
      message: "router push",
      data: { to: "/checkout/pay/ord_1?cs=sess_opaque_handle_xyz", from: "/checkout", navigationType: "push" },
    });
    expect(String(crumb.data!.to)).toContain("/checkout/pay");
    expect(String(crumb.data!.from)).toContain("/checkout");
    // ...while the opaque session handle is still gone.
    expect(JSON.stringify(crumb)).not.toContain("sess_opaque_handle_xyz");
  });

  it("redacts a breadcrumb query value that is NOT PII-shaped", () => {
    // The text sweep catches emails and card numbers by pattern. It cannot
    // recognise an opaque session handle, so this is the case that proves
    // scrubUrl is doing work rather than being shadowed by the sweep.
    const crumb = scrubBreadcrumb({
      message: "fetch",
      data: { url: "/checkout/pay/ord_1?cs=sess_opaque_handle_xyz" },
    });
    const json = JSON.stringify(crumb);
    expect(json).not.toContain("sess_opaque_handle_xyz");
    expect(json).toContain("/checkout/pay");
  });

  it("scrubs breadcrumb URLs — the richest accidental leak", () => {
    const crumb = scrubBreadcrumb({
      message: `fetch ${SENTINEL.email}`,
      data: { url: `/api/checkout?email=${SENTINEL.email}` },
    });
    expect(JSON.stringify(crumb)).not.toContain(SENTINEL.email);
    expect(JSON.stringify(crumb)).toContain("/api/checkout");
  });
});

describe("the configuration declines what we deliberately did not enable", () => {
  const init = readFileSync(path.join(__dirname, "sentry-init.ts"), "utf8");

  it("session replay is not enabled — it would record the checkout form", () => {
    expect(init).not.toMatch(/replayIntegration|Replay\(/);
    expect(init).not.toMatch(/replaysSessionSampleRate|replaysOnErrorSampleRate/);
  });

  it("sendDefaultPii is explicitly false", () => {
    expect(init).toMatch(/sendDefaultPii:\s*false/);
  });

  it("tracing is off, so spans cannot carry request metadata", () => {
    expect(init).toMatch(/tracesSampleRate:\s*0\b/);
  });

  it("every hook fails CLOSED — a scrub error drops the event, never sends it", () => {
    // If beforeSend threw and Sentry fell back to sending the raw event, this
    // module would be worse than useless. Each hook returns null on throw.
    const hooks = init.match(/beforeSend\(|beforeSendTransaction\(|beforeBreadcrumb\(/g) ?? [];
    expect(hooks.length).toBe(3);
    expect(init.match(/return null;/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("reporting is off entirely when no DSN is configured", () => {
    // How local development and this very test suite stay silent.
    expect(readFileSync(path.join(__dirname, "sentry-privacy.ts"), "utf8")).toMatch(
      /export function sentryDsn\(\)/,
    );
    expect(init).toMatch(/export function sentryEnabled\(\)/);
  });
});
