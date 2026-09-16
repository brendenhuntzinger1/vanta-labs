import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// THE OMNISEND LINK TOKEN IS THE RECIPIENT SIGNATURE FOR MAIL WE DO NOT SEND.
//
// The in-house click routes know who clicked from the campaign's own signed
// recipient link, and mint a browse grant only when that recipient's account is
// attested. Omnisend sends its own mail, so the only way a click can be tied
// back to an attestable contact is a token WE minted onto the contact record
// and Omnisend hands back. That makes four properties load-bearing:
//
//   * it opens to exactly the address it was minted for, and to nothing the
//     request can substitute, or one contact's link could borrow another's
//     attestation;
//   * the address is SEALED, so it never travels in a URL, a click log or a
//     referrer;
//   * it expires, and neither the expiry nor the address can be edited;
//   * it is disjoint from the cart and marketing grants that share its secret,
//     because the cart grant is minted for guests with no attestation at all.
// ---------------------------------------------------------------------------

beforeAll(() => {
  vi.stubEnv("UNSUBSCRIBE_SECRET", "test-secret");
});

afterAll(() => {
  vi.unstubAllEnvs();
});

const tokens = () => import("@/lib/marketing/omnisend/link-token");

const EMAIL = "a@x.com";
const NOW = 1_760_000_000_000;

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Exactly the module's construction, so a plaintext of our choosing can be sealed under the real key. */
async function sealed(plaintext: string, secret = "test-secret"): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`omnisend_link:v2:${secret}`));
  const key = await crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(plaintext)));
  const bytes = new Uint8Array(iv.length + body.length);
  bytes.set(iv);
  bytes.set(body, iv.length);
  return `v2.${toBase64Url(bytes)}`;
}

describe("the token round trip", () => {
  it("opens to the address it was minted for, with the expiry", async () => {
    const { signOmnisendLink, verifyOmnisendLink, OMNISEND_LINK_TTL_MS } = await tokens();
    const token = await signOmnisendLink(EMAIL, NOW);
    expect(token).toBeTruthy();
    expect(await verifyOmnisendLink(token, NOW)).toEqual({ email: EMAIL, expiresAtMs: NOW + OMNISEND_LINK_TTL_MS });
  });

  it("is version and an opaque base64url payload; the address is sealed, never readable", async () => {
    const { signOmnisendLink } = await tokens();
    const token = (await signOmnisendLink(EMAIL))!;
    const [version, payload, ...rest] = token.split(".");
    expect(rest).toHaveLength(0);
    expect(version).toBe("v2");
    expect(payload).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token).not.toMatch(/@/);
    expect(token).not.toContain(EMAIL);
    expect(token).not.toContain(btoa(EMAIL).replace(/=+$/, ""));
    expect(token.length).toBeLessThanOrEqual(512);
  });

  it("mints a different token every time, and every one of them opens", async () => {
    const { signOmnisendLink, verifyOmnisendLink } = await tokens();
    const first = (await signOmnisendLink(EMAIL, NOW))!;
    const second = (await signOmnisendLink(EMAIL, NOW))!;
    expect(first).not.toBe(second);
    expect((await verifyOmnisendLink(first, NOW))?.email).toBe(EMAIL);
    expect((await verifyOmnisendLink(second, NOW))?.email).toBe(EMAIL);
  });

  // Omnisend lowercases identifiers and the contact payload lowercases before
  // sending, so the address the token yields must be the store's own spelling.
  it("normalises the address before sealing it", async () => {
    const { signOmnisendLink, verifyOmnisendLink } = await tokens();
    const token = await signOmnisendLink("  A@X.com ");
    expect((await verifyOmnisendLink(token))?.email).toBe("a@x.com");
  });

  it("seals the longest address a mailbox can have inside the length cap", async () => {
    const { signOmnisendLink, verifyOmnisendLink } = await tokens();
    const long = `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(58)}.com`;
    expect(long.length).toBeGreaterThanOrEqual(250);
    const token = (await signOmnisendLink(long, NOW))!;
    expect(token.length).toBeLessThanOrEqual(512);
    expect((await verifyOmnisendLink(token, NOW))?.email).toBe(long);
  });

  it("lives thirty days", async () => {
    const { OMNISEND_LINK_TTL_MS } = await tokens();
    expect(OMNISEND_LINK_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it("names the attribution cookie", async () => {
    const { OMNISEND_ATTRIBUTION_COOKIE } = await tokens();
    expect(OMNISEND_ATTRIBUTION_COOKIE).toBe("vl_omnisend");
  });
});

describe("what a token is refused for", () => {
  it("mints nothing for a blank address", async () => {
    const { signOmnisendLink } = await tokens();
    expect(await signOmnisendLink("")).toBeNull();
    expect(await signOmnisendLink("   ")).toBeNull();
  });

  it("refuses one that has expired", async () => {
    const { signOmnisendLink, verifyOmnisendLink, OMNISEND_LINK_TTL_MS } = await tokens();
    const token = await signOmnisendLink(EMAIL, NOW);
    expect(await verifyOmnisendLink(token, NOW + OMNISEND_LINK_TTL_MS)).toBeNull();
    expect(await verifyOmnisendLink(token, NOW + OMNISEND_LINK_TTL_MS + 1)).toBeNull();
  });

  // Stamped further out than the TTL permits was not minted here, even if it
  // opens cleanly — belt and braces against a future change that lengthens the
  // TTL and leaves old long-dated tokens honoured.
  it("refuses one stamped beyond the ceiling", async () => {
    const { signOmnisendLink, verifyOmnisendLink, OMNISEND_LINK_TTL_MS } = await tokens();
    expect(await verifyOmnisendLink(await signOmnisendLink(EMAIL, NOW + 1), NOW)).toBeNull();
    expect(await verifyOmnisendLink(await signOmnisendLink(EMAIL, NOW + OMNISEND_LINK_TTL_MS), NOW)).toBeNull();
  });

  it("refuses a token with a single flipped character, because it is authenticated", async () => {
    const { signOmnisendLink, verifyOmnisendLink } = await tokens();
    const token = (await signOmnisendLink(EMAIL, NOW))!;
    const [version, payload] = token.split(".");
    for (const index of [0, Math.floor(payload.length / 2), payload.length - 1]) {
      const original = payload[index];
      const flipped = original === "A" ? "B" : "A";
      expect(await verifyOmnisendLink(`${version}.${payload.slice(0, index)}${flipped}${payload.slice(index + 1)}`, NOW)).toBeNull();
    }
  });

  it("refuses a token sealed under the key but outside the namespace", async () => {
    const { verifyOmnisendLink, OMNISEND_LINK_TTL_MS } = await tokens();
    const expiresAtMs = NOW + OMNISEND_LINK_TTL_MS;
    expect(await verifyOmnisendLink(await sealed(`cart_recovery_grant:v2:${EMAIL}:${expiresAtMs}`), NOW)).toBeNull();
    expect(await verifyOmnisendLink(await sealed(`omnisend_link:v1:${EMAIL}:${expiresAtMs}`), NOW)).toBeNull();
    // And the control: our namespace, sealed the same way, opens.
    expect(await verifyOmnisendLink(await sealed(`omnisend_link:v2:${EMAIL}:${expiresAtMs}`), NOW)).toEqual({ email: EMAIL, expiresAtMs });
  });

  it("refuses a sealed address that is not in the store's spelling, or an expiry that is not an integer", async () => {
    const { verifyOmnisendLink, OMNISEND_LINK_TTL_MS } = await tokens();
    const expiresAtMs = NOW + OMNISEND_LINK_TTL_MS;
    expect(await verifyOmnisendLink(await sealed(`omnisend_link:v2:A@X.com:${expiresAtMs}`), NOW)).toBeNull();
    expect(await verifyOmnisendLink(await sealed(`omnisend_link:v2::${expiresAtMs}`), NOW)).toBeNull();
    expect(await verifyOmnisendLink(await sealed(`omnisend_link:v2:${EMAIL}:1.7e12`), NOW)).toBeNull();
    expect(await verifyOmnisendLink(await sealed(`omnisend_link:v2:${EMAIL}`), NOW)).toBeNull();
  });

  it("refuses a token sealed under another secret", async () => {
    const { verifyOmnisendLink, OMNISEND_LINK_TTL_MS } = await tokens();
    expect(await verifyOmnisendLink(await sealed(`omnisend_link:v2:${EMAIL}:${NOW + OMNISEND_LINK_TTL_MS}`, "other-secret"), NOW)).toBeNull();
  });

  it("refuses anything longer than 512 characters without decoding it", async () => {
    const { signOmnisendLink, verifyOmnisendLink } = await tokens();
    const genuine = (await signOmnisendLink(EMAIL, NOW))!;
    expect(await verifyOmnisendLink(`${genuine}${"a".repeat(513 - genuine.length)}`, NOW)).toBeNull();
    expect(await verifyOmnisendLink(`v2.${"a".repeat(5000)}`, NOW)).toBeNull();
  });

  it.each<[string | null | undefined, string]>([
    [null, "null"],
    [undefined, "undefined"],
    ["", "empty"],
    ["v2", "no payload"],
    ["v2.", "empty payload"],
    ["v2.abc.def", "three fields"],
    ["v1.1760000000000.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "the retired v1 shape"],
    ["v2.not+base64/url", "not base64url"],
    ["v2.YWJj", "too short to hold an IV and a tag"],
    [`v2.${"A".repeat(60)}`, "random bytes of a plausible length"],
  ])("refuses %o (%s)", async (token) => {
    const { verifyOmnisendLink } = await tokens();
    expect(await verifyOmnisendLink(token, NOW)).toBeNull();
  });

  it("mints nothing and opens nothing without a secret, rather than throwing", async () => {
    const { signOmnisendLink, verifyOmnisendLink } = await tokens();
    const genuine = (await signOmnisendLink(EMAIL))!;
    vi.stubEnv("UNSUBSCRIBE_SECRET", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    try {
      expect(await signOmnisendLink(EMAIL)).toBeNull();
      expect(await verifyOmnisendLink(genuine)).toBeNull();
    } finally {
      vi.stubEnv("UNSUBSCRIBE_SECRET", "test-secret");
    }
  });
});

// All three grant families derive from the SAME secret. The cart grant is
// minted for guests with no attestation at all, so a cart token opening as an
// Omnisend link would let an unattested guest borrow a browse grant.
describe("the grant families are disjoint", () => {
  it("a real cart-recovery grant does not open as an Omnisend link", async () => {
    const { verifyOmnisendLink } = await tokens();
    const { signGuestRecoveryGrant } = await import("@/lib/cart-recovery-grant");
    const cartToken = await signGuestRecoveryGrant("11111111-2222-3333-4444-555555555555");
    expect(cartToken).toBeTruthy();
    expect(await verifyOmnisendLink(cartToken)).toBeNull();
  });

  it("a real marketing-link grant does not open as an Omnisend link", async () => {
    const { verifyOmnisendLink } = await tokens();
    const { signEmailLinkGrant } = await import("@/lib/email/link-grant");
    const grant = await signEmailLinkGrant();
    expect(grant).toBeTruthy();
    expect(await verifyOmnisendLink(grant)).toBeNull();
  });

  it("an Omnisend link does not verify as a marketing-link grant", async () => {
    const { signOmnisendLink } = await tokens();
    const { verifyEmailLinkGrant } = await import("@/lib/email/link-grant");
    expect(await verifyEmailLinkGrant(await signOmnisendLink(EMAIL))).toBeNull();
  });
});

describe("omnisendLinkUrl, the link a template carries", () => {
  const ORIGIN = "https://www.example.test";

  it("is pinned exactly, with the personalisation tag left literal and no address beside it", async () => {
    const { omnisendLinkUrl } = await tokens();
    expect(omnisendLinkUrl("/products/bpc-157", { campaign: "welcome", medium: "email" }, ORIGIN)).toBe(
      "https://www.example.test/api/email/omnisend-link"
      + "?t=[[contact.custom_properties.vl_link]]"
      + "&to=%2Fproducts%2Fbpc-157"
      + "&utm_source=omnisend"
      + "&utm_medium=email"
      + "&utm_campaign=welcome",
    );
  });

  it("appends utm_content only when given, and encodes the labels", async () => {
    const { omnisendLinkUrl } = await tokens();
    expect(omnisendLinkUrl("/cart", { campaign: "cart recovery", medium: "sms", content: "hero cta" }, ORIGIN)).toBe(
      "https://www.example.test/api/email/omnisend-link"
      + "?t=[[contact.custom_properties.vl_link]]"
      + "&to=%2Fcart"
      + "&utm_source=omnisend"
      + "&utm_medium=sms"
      + "&utm_campaign=cart%20recovery"
      + "&utm_content=hero%20cta",
    );
    expect(omnisendLinkUrl("/cart", { campaign: "x", medium: "email", content: "" }, ORIGIN)).not.toContain("utm_content");
  });

  // Omnisend matches `[[...]]` as written. Percent-encoded brackets would go
  // out verbatim as a broken token in every email.
  it("never percent-encodes the tag, and never names the address", async () => {
    const { omnisendLinkUrl } = await tokens();
    const url = omnisendLinkUrl("/products", { campaign: "welcome", medium: "email" }, ORIGIN);
    expect(url).toContain("t=[[contact.custom_properties.vl_link]]");
    expect(url).not.toContain("contact.email");
    expect(url).not.toContain("%5B");
    expect(url).not.toContain("%5D");
  });

  it("tolerates a trailing slash on the origin", async () => {
    const { omnisendLinkUrl } = await tokens();
    expect(omnisendLinkUrl("/products", { campaign: "welcome", medium: "email" }, `${ORIGIN}/`))
      .toMatch(/^https:\/\/www\.example\.test\/api\/email\/omnisend-link\?/);
  });

  it("defaults the origin to the site's own URL", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://site.example.test/");
    try {
      const { omnisendLinkUrl } = await tokens();
      expect(omnisendLinkUrl("/products", { campaign: "welcome", medium: "email" }))
        .toMatch(/^https:\/\/site\.example\.test\/api\/email\/omnisend-link\?/);
    } finally {
      vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
    }
  });
});
