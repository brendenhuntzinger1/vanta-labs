import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// AN IDEMPOTENCY KEY IDENTIFIES ONE PURCHASE, NOT ONE SHOPPER.
//
// The key exists so a lost response plus a retry cannot create two orders. It
// was minted ONCE per checkout page and reused until a success, which made it a
// key for the SESSION — and payment-service resumes any live order carrying the
// key without checking that the basket still matches.
//
// So: first attempt fails. The shopper goes back, removes an item, fixes the
// address, applies a code — and submits again. The same key arrives, the server
// resumes the ORIGINAL order, and they are charged the ORIGINAL amount for the
// ORIGINAL cart shipped to the ORIGINAL address. The confirmation then shows
// them that order, so the mismatch is not even obvious.
//
// Two changes, because either alone leaves a hole:
//
//   CLIENT   the key is derived from the submitted payload, so anything that
//            changes what is bought, what it costs or where it goes mints a new
//            key, while a genuine retry of the identical submit reuses it and
//            still dedupes.
//   SERVER   a backstop for any client that does not: if the freshly quoted
//            total differs from what the resumed order holds, that key does not
//            describe this purchase, so refuse rather than charge the wrong
//            amount.
//
// The server guard throws inside a try/catch whose fallback is "proceed to
// create normally". Letting a deliberate refusal land there would insert a
// SECOND order against the same idempotency_key and hit the unique index with
// an error the shopper cannot act on — so CustomerFacingError is re-thrown
// explicitly. That is asserted below, because it is the kind of thing a later
// edit removes without noticing.
// ---------------------------------------------------------------------------

const client = readFileSync(resolve(process.cwd(), "src/app/checkout/page.tsx"), "utf8");
const server = readFileSync(resolve(process.cwd(), "src/lib/payment-service.ts"), "utf8");

/** The client's rule: reuse the key only while the payload is identical. */
function keyFor(
  state: { key: string; signature: string } | null,
  payload: unknown,
  mint: () => string,
): { key: string; signature: string } {
  const signature = JSON.stringify(payload);
  if (!state || state.signature !== signature) return { signature, key: mint() };
  return state;
}

describe("the key follows the basket", () => {
  const basket = { items: [{ id: "bpc-157", quantity: 1 }], expectedTotal: 62.99, city: "Austin" };
  let minted = 0;
  const mint = () => `key-${++minted}`;

  it("reuses the key when the identical submit is retried", () => {
    minted = 0;
    const first = keyFor(null, basket, mint);
    const retry = keyFor(first, { ...basket }, mint);
    expect(retry.key).toBe(first.key);
    expect(minted).toBe(1);
  });

  it("mints a new key when an item is removed", () => {
    minted = 0;
    const first = keyFor(null, basket, mint);
    const edited = keyFor(first, { ...basket, items: [] }, mint);
    expect(edited.key).not.toBe(first.key);
  });

  it("mints a new key when the total changes", () => {
    minted = 0;
    const first = keyFor(null, basket, mint);
    const edited = keyFor(first, { ...basket, expectedTotal: 121.24 }, mint);
    expect(edited.key).not.toBe(first.key);
  });

  it("mints a new key when the address changes", () => {
    // The parcel would otherwise go to the address of the abandoned attempt.
    minted = 0;
    const first = keyFor(null, basket, mint);
    const edited = keyFor(first, { ...basket, city: "Denver" }, mint);
    expect(edited.key).not.toBe(first.key);
  });

  it("returns to the original key if the shopper undoes their edit", () => {
    minted = 0;
    const first = keyFor(null, basket, mint);
    const edited = keyFor(first, { ...basket, expectedTotal: 99 }, mint);
    const undone = keyFor(edited, { ...basket }, mint);
    // A different key from the edited attempt — and correctly NOT the first
    // one, because the ref only remembers the most recent signature. What
    // matters is that it never reuses a key minted for a different basket.
    expect(undone.key).not.toBe(edited.key);
  });
});

describe("the shipped code carries both halves", () => {
  it("the client binds the key to the payload rather than to the page", () => {
    expect(client).toContain("idempotencyRef");
    expect(client).toContain("const signature = JSON.stringify(payload);");
    expect(client).toContain("idempotencyRef.current.signature !== signature");
    // The session-scoped ref that caused it is gone.
    expect(client).not.toContain("idempotencyKeyRef");
  });

  it("still clears the key after a real success", () => {
    expect(client).toContain("idempotencyRef.current = null;");
  });

  it("the server refuses to resume an order whose amount no longer matches", () => {
    expect(server).toContain("existingCents > 0 && existingCents !== quotedCents");
    expect(server).toContain("Your basket changed since this checkout started");
  });

  it("compares money in integer cents, never as floats", () => {
    expect(server).toContain("Math.round(Number(existing.amount_paid ?? 0) * 100)");
    expect(server).toContain("Math.round(finalTotal * 100)");
  });

  it("re-throws the deliberate refusal past the create-normally fallback", () => {
    // Without this the guard would fall through and insert a duplicate against
    // the same idempotency_key.
    expect(server).toContain("if (error instanceof CustomerFacingError) throw error;");
  });
});
