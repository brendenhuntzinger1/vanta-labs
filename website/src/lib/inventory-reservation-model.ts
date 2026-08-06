// Pure, in-memory mirror of the inventory-reservations SQL RPCs. It exists to
// PROVE the reservation state machine upholds "never oversell" and conserves
// stock across reserve → finalize/release/expire, under concurrency.
//
// Why this is a faithful concurrency model: in production the atomicity comes
// from a single row-locked Postgres UPDATE. JavaScript is single-threaded, so a
// synchronous reserve() here is likewise indivisible — no two reserves can
// interleave mid-operation. That's exactly the guarantee the SQL provides, so a
// test that fans out hundreds of concurrent async checkouts over this model
// exercises the same invariant the database enforces.

interface SkuState {
  inventory: number;
  reserved: number;
}

type ReservationStatus = "active" | "finalized" | "released";

interface Reservation {
  sku: string;
  quantity: number;
  status: ReservationStatus;
  expiresAt: number;
}

export class InventoryReservationModel {
  private readonly skus = new Map<string, SkuState>();
  private readonly reservations = new Map<string, Reservation>();

  private lineKey(orderId: string, sku: string) {
    return `${orderId}|${sku}`;
  }

  setStock(sku: string, inventory: number): void {
    const existing = this.skus.get(sku);
    this.skus.set(sku, { inventory, reserved: existing?.reserved ?? 0 });
  }

  inventoryOf(sku: string): number {
    return this.skus.get(sku)?.inventory ?? 0;
  }

  reservedOf(sku: string): number {
    return this.skus.get(sku)?.reserved ?? 0;
  }

  // A SKU that was given a count (via setStock) is TRACKED forever — even at 0,
  // where it is sold out, not "untracked". A SKU never given a count is
  // untracked (no enforced count) and always available.
  available(sku: string): number {
    const s = this.skus.get(sku);
    if (!s) return Number.POSITIVE_INFINITY; // untracked / no enforced count
    return s.inventory - s.reserved;
  }

  // Atomic hold — mirrors reserve_inventory(). true = held or untracked;
  // false = tracked item with insufficient available stock (incl. sold out).
  reserve(orderId: string, sku: string, quantity: number, expiresAt: number): boolean {
    if (quantity <= 0) return true;
    const key = this.lineKey(orderId, sku);
    const existing = this.reservations.get(key);
    if (existing && (existing.status === "active" || existing.status === "finalized")) {
      return true; // idempotent: a refresh/retry never double-holds
    }
    const s = this.skus.get(sku);
    if (!s) {
      return true; // untracked: never blocked, never held
    }
    if (s.inventory - s.reserved >= quantity) {
      s.reserved += quantity;
      this.reservations.set(key, { sku, quantity, status: "active", expiresAt });
      return true;
    }
    return false;
  }

  private eachActive(predicate: (r: Reservation, key: string) => boolean, apply: (r: Reservation, s: SkuState) => void): number {
    let n = 0;
    for (const [key, r] of this.reservations) {
      if (r.status !== "active" || !predicate(r, key)) continue;
      const s = this.skus.get(r.sku);
      if (s) {
        apply(r, s);
        n += 1;
      }
    }
    return n;
  }

  // Verified payment: permanently deduct every active hold for the order.
  finalize(orderId: string): number {
    const prefix = `${orderId}|`;
    return this.eachActive(
      (_r, key) => key.startsWith(prefix),
      (r, s) => {
        s.inventory = Math.max(0, s.inventory - r.quantity);
        s.reserved = Math.max(0, s.reserved - r.quantity);
        r.status = "finalized";
      },
    );
  }

  // Failed/canceled/abandoned: return every active hold for the order.
  release(orderId: string): number {
    const prefix = `${orderId}|`;
    return this.eachActive(
      (_r, key) => key.startsWith(prefix),
      (r, s) => {
        s.reserved = Math.max(0, s.reserved - r.quantity);
        r.status = "released";
      },
    );
  }

  // Sweep: release every active hold past its expiry.
  expire(now: number): number {
    return this.eachActive(
      (r) => r.expiresAt < now,
      (r, s) => {
        s.reserved = Math.max(0, s.reserved - r.quantity);
        r.status = "released";
      },
    );
  }
}
