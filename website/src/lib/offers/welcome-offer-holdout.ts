import { createHash } from "node:crypto";

/**
 * THE HOLDOUT BUCKET FOR AN ADDRESS.
 *
 * A randomised comparison is the only way to know what the welcome offer
 * actually earned. "Subscribers converted better than non-subscribers" proves
 * nothing: the people who hand over a mobile number were already the more
 * interested ones, and they would have bought at a higher rate with no offer
 * at all. The comparison that isolates the discount is between eligible
 * shoppers who were shown it and eligible shoppers who were not.
 *
 * STABLE, SO A SHOPPER'S EXPERIENCE NEVER FLICKERS. The bucket is a pure
 * function of the address, so the same person is on the same side of the line
 * on every page, every visit, for as long as the experiment runs. Nothing is
 * stored and nothing is randomised at request time, which also means no row to
 * migrate and no state to get out of step.
 *
 * REPRODUCIBLE IN SQL, WHICH IS THE POINT. The analysis has to be able to
 * split historical orders the same way, months later, without this code:
 *
 *   select (('x' || substr(md5(lower(customer_email)), 1, 8))::bit(32)::bigint % 100) as bucket
 *
 * gives the identical number for the identical address. MD5 is used for
 * exactly that reason — Postgres has it built in — and for nothing security
 * related.
 */
export function holdoutBucket(email: string): number {
  const address = String(email ?? "").trim().toLowerCase();
  if (!address) return 0;
  // parseInt on eight hex digits stays well inside a safe integer, so no
  // BigInt is needed — and BigInt literals do not compile at this project's
  // target anyway.
  const digest = createHash("md5").update(address).digest("hex").slice(0, 8);
  return parseInt(digest, 16) % 100;
}

/**
 * Is this address held back from the offer? `percent` of addresses are, and 0
 * holds back nobody — which is the default, so no shopper is withheld from
 * until the owner turns a measurement on.
 */
export function isHeldOut(email: string, percent: number): boolean {
  if (!Number.isFinite(percent) || percent <= 0) return false;
  return holdoutBucket(email) < Math.min(100, Math.round(percent));
}
