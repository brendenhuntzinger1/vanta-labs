/**
 * One order per cart, however many times the shopper presses the button.
 *
 * The checkout submit carries an idempotency key so the server can hand back
 * the order it already wrote instead of writing a second one. That key used
 * to live only in a React ref — and the handoff to the card form is a
 * full-page navigation, so a shopper who came back to /checkout and tried
 * again started from a null ref, a fresh UUID, and a second order with its own
 * stock hold. On 2026-09-09 one $119.25 cart became four orders that way, and
 * the server's dedupe had never once matched a real retry.
 *
 * The key now lives in sessionStorage, tied to a fingerprint of the cart:
 * same cart, same key, same order (the server then mints a fresh processor
 * session, which is its designed retry path); a changed cart gets a fresh key;
 * a confirmed order clears it. Storage is passed in rather than reached for,
 * because it can be absent or throw (private browsing, blocked site data) and
 * checkout must keep working when it does.
 */
const STORAGE_KEY = "vl:checkout:idempotency";

/**
 * Older than this and the attempt is NOT resumed. The processor's checkout
 * sessions live 60 minutes, and the server's resume path hands back the SAME
 * session (its idempotency key to the processor is the order id), so resuming
 * an order past that window would send the shopper to a card form that says
 * "checkout expired". Fifty minutes keeps a retry inside the window with
 * margin; past it, a fresh key means a fresh order and a fresh session.
 */
const DEFAULT_TTL_MS = 50 * 60 * 1000;

export type CartLine = { slug: string; variantId?: string | null; quantity: number };

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem"> | null | undefined;

type StoredKey = { key: string; fingerprint: string; at: number };

/** The browser's sessionStorage, or null when touching it throws. */
export function safeSessionStorage(): StorageLike {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

/** A stable identity for the cart's contents — order-independent, quantity-aware. */
export function cartFingerprint(items: readonly CartLine[]): string {
  const lines = items
    .map((item) => `${item.slug}::${item.variantId ?? ""}::${Math.max(0, Math.floor(Number(item.quantity) || 0))}`)
    .sort();
  return lines.length > 0 ? lines.join("|") : "empty";
}

export function resolveCheckoutIdempotencyKey(input: {
  storage: StorageLike;
  fingerprint: string;
  generate: () => string;
  now?: number;
  ttlMs?: number;
}): string {
  const now = input.now ?? Date.now();
  const ttl = input.ttlMs ?? DEFAULT_TTL_MS;
  const existing = read(input.storage);
  if (
    existing
    && existing.fingerprint === input.fingerprint
    && existing.key
    && now - existing.at >= 0
    && now - existing.at <= ttl
  ) {
    return existing.key;
  }
  const key = input.generate();
  write(input.storage, { key, fingerprint: input.fingerprint, at: now });
  return key;
}

/** After an order is placed or paid: the next distinct order must not be deduped against it. */
export function clearCheckoutIdempotencyKey(storage: StorageLike): void {
  try {
    storage?.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable — nothing to clear */
  }
}

function read(storage: StorageLike): StoredKey | null {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredKey>;
    if (typeof parsed.key !== "string" || typeof parsed.fingerprint !== "string" || typeof parsed.at !== "number") {
      return null;
    }
    return { key: parsed.key, fingerprint: parsed.fingerprint, at: parsed.at };
  } catch {
    return null;
  }
}

function write(storage: StorageLike, value: StoredKey): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    /* storage unavailable — the in-memory key still serves this page */
  }
}
