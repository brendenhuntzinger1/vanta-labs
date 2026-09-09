import { describe, expect, it } from "vitest";

import {
  cartFingerprint,
  clearCheckoutIdempotencyKey,
  resolveCheckoutIdempotencyKey,
} from "@/lib/checkout-idempotency";

// ---------------------------------------------------------------------------
// ONE ORDER PER CART, HOWEVER MANY TIMES THE SHOPPER TRIES.
//
// The checkout page held its idempotency key in a useRef. The handoff to the
// card form is a full-page navigation, so a shopper who came back to /checkout
// and pressed the button again started with a null ref, minted a fresh UUID,
// and the server — quite correctly, given a key it had never seen — wrote a
// second order and took a second inventory hold. Every real retry on record
// did exactly this: 4 orders for one $119.25 cart, 3 for one $252.96 cart.
// The server's dedupe had never once matched a real retry.
//
// The key now lives in sessionStorage, keyed by a fingerprint of the cart, so
// the same cart resumes the same live order (the server then mints a fresh
// processor session, which is the designed path) and a changed cart gets a
// fresh key. Storage is passed in: it can be absent or throw (private mode,
// blocked site data), and checkout must still work when it does.
// ---------------------------------------------------------------------------

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => { m.delete(k); },
    setItem: (k, v) => { m.set(k, String(v)); },
  };
}

const items = (...rows: Array<[string, string | undefined, number]>) =>
  rows.map(([slug, variantId, quantity]) => ({ slug, variantId, quantity }));

describe("cartFingerprint", () => {
  it("is stable across item order and ignores nothing that changes the order's contents", () => {
    const a = cartFingerprint(items(["kpv", "v1", 2], ["b12", "v2", 1]));
    const b = cartFingerprint(items(["b12", "v2", 1], ["kpv", "v1", 2]));
    expect(a).toBe(b);
    expect(cartFingerprint(items(["kpv", "v1", 3], ["b12", "v2", 1]))).not.toBe(a);
    expect(cartFingerprint(items(["kpv", undefined, 2], ["b12", "v2", 1]))).not.toBe(a);
    expect(cartFingerprint([])).not.toBe(a);
  });
});

describe("resolveCheckoutIdempotencyKey", () => {
  it("mints a key the first time and hands the SAME key back for the same cart", () => {
    const storage = memoryStorage();
    let n = 0;
    const generate = () => `key-${++n}`;
    const fp = cartFingerprint(items(["kpv", "v1", 2]));
    expect(resolveCheckoutIdempotencyKey({ storage, fingerprint: fp, generate })).toBe("key-1");
    // A full page load later: nothing in memory, only storage.
    expect(resolveCheckoutIdempotencyKey({ storage, fingerprint: fp, generate })).toBe("key-1");
    expect(n).toBe(1);
  });

  it("gives a changed cart a fresh key, and forgets the old one", () => {
    const storage = memoryStorage();
    let n = 0;
    const generate = () => `key-${++n}`;
    const first = resolveCheckoutIdempotencyKey({ storage, fingerprint: "fp-a", generate });
    const second = resolveCheckoutIdempotencyKey({ storage, fingerprint: "fp-b", generate });
    expect(first).not.toBe(second);
    // Only one cart's key is ever held; going back to the first cart is a new attempt.
    expect(resolveCheckoutIdempotencyKey({ storage, fingerprint: "fp-a", generate })).toBe("key-3");
  });

  it("still returns a usable key when storage is missing or throws", () => {
    const generate = () => "fresh";
    expect(resolveCheckoutIdempotencyKey({ storage: null, fingerprint: "fp", generate })).toBe("fresh");
    const broken = {
      getItem: () => { throw new Error("SecurityError"); },
      setItem: () => { throw new Error("SecurityError"); },
      removeItem: () => { throw new Error("SecurityError"); },
    } as unknown as Storage;
    expect(resolveCheckoutIdempotencyKey({ storage: broken, fingerprint: "fp", generate })).toBe("fresh");
  });

  it("does not resume an attempt older than the processor session could possibly be", () => {
    const storage = memoryStorage();
    let n = 0;
    const generate = () => `key-${++n}`;
    expect(resolveCheckoutIdempotencyKey({ storage, fingerprint: "fp", generate, now: 1_000 })).toBe("key-1");
    expect(resolveCheckoutIdempotencyKey({ storage, fingerprint: "fp", generate, now: 1_000 + 60 * 60 * 1000 })).toBe("key-1");
    expect(resolveCheckoutIdempotencyKey({ storage, fingerprint: "fp", generate, now: 1_000 + 3 * 60 * 60 * 1000 })).toBe("key-2");
  });

  it("clears the key after a placed order so the next distinct order is not deduped against it", () => {
    const storage = memoryStorage();
    let n = 0;
    const generate = () => `key-${++n}`;
    expect(resolveCheckoutIdempotencyKey({ storage, fingerprint: "fp", generate })).toBe("key-1");
    clearCheckoutIdempotencyKey(storage);
    expect(resolveCheckoutIdempotencyKey({ storage, fingerprint: "fp", generate })).toBe("key-2");
    // Clearing must never throw either.
    expect(() => clearCheckoutIdempotencyKey(null)).not.toThrow();
  });
});
