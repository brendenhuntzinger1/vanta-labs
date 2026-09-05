import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// EMAIL-07 — the footer unsubscribe link was a bare state-changing GET.
//
// Corporate and ISP link scanners (Outlook Safe Links, Proofpoint, Mimecast,
// some Gmail prefetch) GET every link in a message, and the HMAC token is
// per-address and never expires — so one scan of any marketing email silently
// unsubscribed that recipient for good. The GET now renders a confirmation page
// with one button; the button POSTs the same token. RFC 8058 one-click POST from
// a mail client is unchanged.
// ---------------------------------------------------------------------------

process.env.UNSUBSCRIBE_SECRET = "test-unsubscribe-secret";

vi.mock("server-only", () => ({}));

const suppressions: Array<Record<string, unknown>> = [];
vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: {
    from(table: string) {
      return {
        upsert: async (row: Record<string, unknown>) => {
          if (table === "email_suppressions") suppressions.push(row);
          return { error: null };
        },
      };
    },
    auth: { admin: { listUsers: async () => ({ data: { users: [] }, error: null }) } },
  },
}));

const EMAIL = "reader@example.test";

async function signedParams() {
  const { generateUnsubscribeToken } = await import("@/lib/email/unsubscribe");
  return new URLSearchParams({ email: EMAIL, token: generateUnsubscribeToken(EMAIL), s: "campaign:abc" });
}

async function get(params: URLSearchParams) {
  const { GET } = await import("@/app/api/unsubscribe/route");
  return GET(new NextRequest(`https://vantalabsresearch.test/api/unsubscribe?${params}`));
}

async function post(params: URLSearchParams, body: string | null, contentType = "application/x-www-form-urlencoded") {
  const { POST } = await import("@/app/api/unsubscribe/route");
  return POST(new NextRequest(`https://vantalabsresearch.test/api/unsubscribe?${params}`, {
    method: "POST",
    headers: body === null ? {} : { "content-type": contentType },
    body: body ?? undefined,
  }));
}

beforeEach(() => { suppressions.length = 0; });

describe("GET — the footer link", () => {
  it("renders a confirmation page and suppresses NOTHING", async () => {
    const response = await get(await signedParams());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("Unsubscribe from marketing emails");
    expect(html).toContain(EMAIL);
    expect(html).toContain('<form method="post"');
    expect(html).toContain('name="confirm" value="1"');
    // The button POSTs the very same signed token back to this route.
    const params = await signedParams();
    expect(html).toContain(`action="/api/unsubscribe?email=${encodeURIComponent(EMAIL)}&amp;token=${params.get("token")}&amp;s=campaign%3Aabc"`);
    expect(suppressions).toHaveLength(0);
  });

  it("a link scanner following the URL therefore changes nothing", async () => {
    // Ten scans, zero opt-outs.
    for (let i = 0; i < 10; i += 1) await get(await signedParams());
    expect(suppressions).toHaveLength(0);
  });

  it("still refuses a bad token", async () => {
    const params = await signedParams();
    params.set("token", "0".repeat(64));
    const response = await get(params);
    expect(response.status).toBe(400);
    expect(suppressions).toHaveLength(0);
  });
});

describe("POST — the confirmation button", () => {
  it("suppresses the address and shows the person a rendered page", async () => {
    const response = await post(await signedParams(), "confirm=1");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    // The title is HTML-escaped by the page renderer (the apostrophe becomes &#39;).
    expect(await response.text()).toContain("You&#39;re unsubscribed");
    expect(suppressions).toHaveLength(1);
    expect(suppressions[0]).toMatchObject({ email: EMAIL, reason: "unsubscribed", source: "campaign:abc" });
  });

  it("refuses a bad token with a rendered page and suppresses nothing", async () => {
    const params = await signedParams();
    params.set("token", "0".repeat(64));
    const response = await post(params, "confirm=1");
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(suppressions).toHaveLength(0);
  });
});

describe("POST — RFC 8058 one-click from a mail client is unchanged", () => {
  it("answers a bare 200 'Unsubscribed' to the List-Unsubscribe=One-Click body and suppresses", async () => {
    const response = await post(await signedParams(), "List-Unsubscribe=One-Click");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type") ?? "").not.toContain("text/html");
    expect(await response.text()).toBe("Unsubscribed");
    expect(suppressions).toHaveLength(1);
    expect(suppressions[0]).toMatchObject({ email: EMAIL, reason: "unsubscribed" });
  });

  it("answers a bare 200 to a body-less POST as well", async () => {
    const response = await post(await signedParams(), null);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("Unsubscribed");
    expect(suppressions).toHaveLength(1);
  });

  it("refuses a bad token plainly", async () => {
    const params = await signedParams();
    params.set("token", "0".repeat(64));
    const response = await post(params, "List-Unsubscribe=One-Click");
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Invalid unsubscribe link");
    expect(suppressions).toHaveLength(0);
  });
});
