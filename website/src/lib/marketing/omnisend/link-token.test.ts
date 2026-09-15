import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// THE OMNISEND LINK TOKEN IS THE RECIPIENT SIGNATURE FOR MAIL WE DO NOT SEND.
//
// The in-house click routes know who clicked from the campaign's own signed
// recipient link, and mint a browse grant only when that recipient's account is
// attested. Omnisend sends its own mail, so the only way a click can be tied
// back to an attestable contact is a token WE minted onto the contact record
// and Omnisend hands back. That makes three properties load-bearing:
//
//   * it verifies only for the address it was signed for, or one contact's
//     link replayed under another's address would borrow their attestation;
//   * it expires, and the expiry cannot be edited;
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

/** A token of our exact shape signed over a different namespace, by hand. */
async function signedOver(payload: string, expiresAtMs: number): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode("test-secret"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `v1.${expiresAtMs}.${hex.slice(0, 32)}`;
}

describe("the token round trip", () => {
  it("verifies a token it just minted, for the address it was minted for", async () => {
    const { signOmnisendLink, verifyOmnisendLink, OMNISEND_LINK_TTL_MS } = await tokens();
    const now = 1_760_000_000_000;
    const token = await signOmnisendLink(EMAIL, now);
    expect(token).toBeTruthy();
    expect(await verifyOmnisendLink(token, EMAIL, now)).toEqual({ expiresAtMs: now + OMNISEND_LINK_TTL_MS });
  });

  it("is version, expiry and 32 hex — the address is signed over, never carried", async () => {
    const { signOmnisendLink } = await tokens();
    const token = (await signOmnisendLink(EMAIL))!;
    const [version, expiry, mac, ...rest] = token.split(".");
    expect(rest).toHaveLength(0);
    expect(version).toBe("v1");
    expect(expiry).toMatch(/^\d+$/);
    expect(mac).toMatch(/^[0-9a-f]{32}$/);
    expect(token).not.toMatch(/@/);
    expect(token.length).toBeLessThanOrEqual(128);
  });

  // Omnisend lowercases identifiers and the contact payload lowercases before
  // sending, so `[[contact.email]]` comes back lowercase whatever the operator
  // typed. A token that only verified for the typed spelling would never
  // verify in practice.
  it("treats the address case- and whitespace-insensitively", async () => {
    const { signOmnisendLink, verifyOmnisendLink } = await tokens();
    const token = await signOmnisendLink("  A@X.com ");
    expect(await verifyOmnisendLink(token, "a@x.com")).not.toBeNull();
    expect(await verifyOmnisendLink(token, "A@X.COM")).not.toBeNull();
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
  it("does not verify for a different address", async () => {
    const { signOmnisendLink, verifyOmnisendLink } = await tokens();
    const token = await signOmnisendLink(EMAIL);
    expect(await verifyOmnisendLink(token, "b@x.com")).toBeNull();
  });

  it("does not verify for a blank address", async () => {
    const { signOmnisendLink, verifyOmnisendLink } = await tokens();
    const token = await signOmnisendLink(EMAIL);
    expect(await verifyOmnisendLink(token, "")).toBeNull();
    expect(await verifyOmnisendLink(token, "   ")).toBeNull();
  });

  it("refuses one that has expired", async () => {
    const { signOmnisendLink, verifyOmnisendLink, OMNISEND_LINK_TTL_MS } = await tokens();
    const now = Date.now();
    const token = await signOmnisendLink(EMAIL, now);
    expect(await verifyOmnisendLink(token, EMAIL, now + OMNISEND_LINK_TTL_MS)).toBeNull();
    expect(await verifyOmnisendLink(token, EMAIL, now + OMNISEND_LINK_TTL_MS + 1)).toBeNull();
  });

  // Stamped further out than the TTL permits was not minted here, even if the
  // signature somehow matched — belt and braces against a future change that
  // lengthens the TTL and leaves old long-dated tokens honoured.
  it("refuses one stamped beyond the ceiling", async () => {
    const { signOmnisendLink, verifyOmnisendLink, OMNISEND_LINK_TTL_MS } = await tokens();
    const now = Date.now();
    const token = await signOmnisendLink(EMAIL, now + 1);
    expect(await verifyOmnisendLink(token, EMAIL, now)).toBeNull();
    expect(await verifyOmnisendLink(await signOmnisendLink(EMAIL, now + OMNISEND_LINK_TTL_MS), EMAIL, now)).toBeNull();
  });

  it("refuses an extended expiry, because the expiry is signed", async () => {
    const { signOmnisendLink, verifyOmnisendLink } = await tokens();
    const [version, expiry, mac] = (await signOmnisendLink(EMAIL))!.split(".");
    expect(await verifyOmnisendLink(`${version}.${Number(expiry) + 1000}.${mac}`, EMAIL)).toBeNull();
  });

  it("refuses an edited signature", async () => {
    const { signOmnisendLink, verifyOmnisendLink } = await tokens();
    const [version, expiry, mac] = (await signOmnisendLink(EMAIL))!.split(".");
    const flipped = mac[0] === "0" ? `1${mac.slice(1)}` : `0${mac.slice(1)}`;
    expect(await verifyOmnisendLink(`${version}.${expiry}.${flipped}`, EMAIL)).toBeNull();
  });

  it("refuses anything longer than 128 characters without hashing it", async () => {
    const { signOmnisendLink, verifyOmnisendLink } = await tokens();
    const genuine = (await signOmnisendLink(EMAIL))!;
    // A genuine token padded past the ceiling is refused on length alone.
    expect(await verifyOmnisendLink(`${genuine}${"a".repeat(129 - genuine.length)}`, EMAIL)).toBeNull();
    expect(await verifyOmnisendLink(`v1.${Date.now() + 1000}.${"a".repeat(5000)}`, EMAIL)).toBeNull();
  });

  it.each<[string | null | undefined, string]>([
    [null, "null"],
    [undefined, "undefined"],
    ["", "empty"],
    ["v1", "no fields"],
    ["v1.123", "two fields"],
    ["v1.123.abc.def", "four fields"],
    ["v2.9999999999999.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "wrong version"],
    ["v1.notanumber.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "expiry is not a number"],
    ["v1.1.7e9.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "expiry in exponent form"],
  ])("refuses %o (%s)", async (token) => {
    const { verifyOmnisendLink } = await tokens();
    expect(await verifyOmnisendLink(token, EMAIL)).toBeNull();
  });

  it("mints nothing and verifies nothing without a secret, rather than throwing", async () => {
    const { signOmnisendLink, verifyOmnisendLink } = await tokens();
    const genuine = (await signOmnisendLink(EMAIL))!;
    vi.stubEnv("UNSUBSCRIBE_SECRET", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    try {
      expect(await signOmnisendLink(EMAIL)).toBeNull();
      expect(await verifyOmnisendLink(genuine, EMAIL)).toBeNull();
    } finally {
      vi.stubEnv("UNSUBSCRIBE_SECRET", "test-secret");
    }
  });
});

// All three grant families sign with the SAME secret. Without the namespace
// prefix inside the signed payload, a token minted for one could verify as
// another — and the cart grant is minted for guests with no attestation at all,
// so a cart token verifying as an Omnisend link would let an unattested guest
// borrow a browse grant.
describe("the grant families are disjoint", () => {
  it("a token of the same shape signed over the cart namespace does not verify", async () => {
    const { verifyOmnisendLink, OMNISEND_LINK_TTL_MS } = await tokens();
    const now = Date.now();
    const expiresAtMs = now + OMNISEND_LINK_TTL_MS;
    // Identical address, identical expiry, identical secret: only the
    // namespace differs, so this isolates the property being tested.
    const cartShaped = await signedOver(`cart_recovery_grant:v1:${EMAIL}:${expiresAtMs}`, expiresAtMs);
    expect(cartShaped).toMatch(/^v1\.\d+\.[0-9a-f]{32}$/);
    expect(await verifyOmnisendLink(cartShaped, EMAIL, now)).toBeNull();
    // And the control: the same construction over OUR namespace does verify.
    const ours = await signedOver(`omnisend_link:v1:${EMAIL}:${expiresAtMs}`, expiresAtMs);
    expect(await verifyOmnisendLink(ours, EMAIL, now)).toEqual({ expiresAtMs });
  });

  it("a real cart-recovery grant does not verify as an Omnisend link", async () => {
    const { verifyOmnisendLink } = await tokens();
    const { signGuestRecoveryGrant } = await import("@/lib/cart-recovery-grant");
    const cartToken = await signGuestRecoveryGrant("11111111-2222-3333-4444-555555555555");
    expect(cartToken).toBeTruthy();
    expect(await verifyOmnisendLink(cartToken, EMAIL)).toBeNull();
  });

  it("a real marketing-link grant does not verify as an Omnisend link", async () => {
    const { verifyOmnisendLink } = await tokens();
    const { signEmailLinkGrant } = await import("@/lib/email/link-grant");
    const grant = await signEmailLinkGrant();
    expect(grant).toBeTruthy();
    expect(await verifyOmnisendLink(grant, EMAIL)).toBeNull();
  });

  it("an Omnisend link does not verify as a marketing-link grant", async () => {
    const { signOmnisendLink } = await tokens();
    const { verifyEmailLinkGrant } = await import("@/lib/email/link-grant");
    expect(await verifyEmailLinkGrant(await signOmnisendLink(EMAIL))).toBeNull();
  });
});

describe("omnisendLinkUrl, the link a template carries", () => {
  const ORIGIN = "https://www.example.test";

  it("is pinned exactly, with the personalisation tags left literal", async () => {
    const { omnisendLinkUrl } = await tokens();
    expect(omnisendLinkUrl("/products/bpc-157", { campaign: "welcome", medium: "email" }, ORIGIN)).toBe(
      "https://www.example.test/api/email/omnisend-link"
      + "?t=[[contact.custom_properties.vl_link]]"
      + "&e=[[contact.email]]"
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
      + "&e=[[contact.email]]"
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
  it("never percent-encodes the tags", async () => {
    const { omnisendLinkUrl } = await tokens();
    const url = omnisendLinkUrl("/products", { campaign: "welcome", medium: "email" }, ORIGIN);
    expect(url).toContain("t=[[contact.custom_properties.vl_link]]");
    expect(url).toContain("e=[[contact.email]]");
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
