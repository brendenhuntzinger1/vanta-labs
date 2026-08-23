import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// THE OWNER'S HOME ADDRESS MUST NEVER REACH A CUSTOMER.
//
// A parcel needs two addresses and they are not the same thing:
//
//   ORIGIN  — where it physically ships from. Carriers rate on this ZIP, so it
//             has to be true. For a business run from home, it is a house.
//   RETURN  — what is PRINTED on the label, what a customer reads off the box,
//             and where an undeliverable parcel comes back to.
//
// Shippo defaults address_return to address_from when address_return is
// omitted. So "not setting a return address" does not mean no return address —
// it means the origin gets printed on every parcel. Two defects existed:
//
//   1. THE PATH THAT BUYS THE LABEL DIDN'T SEND ONE. order-sync.ts passed
//      addressReturn; quoteShipment in service.ts did not, and that is the
//      shipment whose rate is purchased. Every label was carrying the origin.
//
//   2. A MISSING RETURN ADDRESS ONLY WARNED. The admin showed a red panel and
//      shipping worked anyway, which makes it the kind of warning read once and
//      then never again. Now it fails closed.
//
// NO REAL PRIVATE VALUE APPEARS IN THIS FILE. The tests use synthetic
// sentinels: committing the actual address to prove it does not leak would put
// it in git history permanently, which is the leak.
// ---------------------------------------------------------------------------

const PRIVATE_OWNER_NAME_SENTINEL = "ZZPRIVATEOWNERNAMEZZ";
const PRIVATE_OWNER_STREET_SENTINEL = "ZZPRIVATESTREETZZ";
const PRIVATE_OWNER_PHONE_SENTINEL = "ZZPRIVATEPHONEZZ";

/** A complete address, so validation passes and only privacy is under test. */
const privateHome = {
  name: PRIVATE_OWNER_NAME_SENTINEL,
  street1: PRIVATE_OWNER_STREET_SENTINEL,
  city: "Somewhere",
  state: "FL",
  zip: "00000",
  country: "US",
  phone: PRIVATE_OWNER_PHONE_SENTINEL,
};

const businessReturn = {
  name: "Vanta Labs",
  company: "Vanta Labs",
  street1: "PO Box 000",
  city: "Somewhere",
  state: "FL",
  zip: "00000",
  country: "US",
  phone: "+10000000000",
};

const snapshot = vi.fn();
vi.mock("@/lib/admin-control", () => ({
  getControlSnapshot: (section: string) => snapshot(section),
}));

async function resolveWith(origin: unknown, returnAddress: unknown) {
  snapshot.mockImplementation(async (section: string) =>
    section === "shipping_origin"
      ? { shipping_origin: origin }
      : { shipping_return_address: returnAddress },
  );
  const { getShippingAddresses } = await import("@/lib/shipping-origin");
  return getShippingAddresses();
}

beforeEach(() => {
  vi.resetModules();
  snapshot.mockReset();
});

describe("a missing return address fails closed instead of printing the origin", () => {
  it("blocks rates entirely when no return address is configured", async () => {
    const result = await resolveWith(privateHome, {});
    expect(result.canRequestRates).toBe(false);
    expect(result.usesSeparateReturn).toBe(false);
    // And says why, in words naming the real problem rather than the ship-from
    // address, which is complete and correct.
    expect(result.blockedReason).toMatch(/return address/i);
  });

  it("blocks on a HALF-FILLED return address rather than falling back", async () => {
    // The dangerous middle case: the owner started typing the PO box, missed a
    // field, and it silently reverted to the house.
    const result = await resolveWith(privateHome, { name: "Vanta Labs", city: "Somewhere" });
    expect(result.canRequestRates).toBe(false);
    expect(result.blockedReason).toMatch(/return address/i);
  });

  it("names the missing ship-from fields when THAT is what is wrong", async () => {
    const result = await resolveWith({ name: "Vanta Labs" }, businessReturn);
    expect(result.canRequestRates).toBe(false);
    expect(result.blockedReason).toMatch(/[Ss]hip-from/);
  });

  it("allows rates only once BOTH addresses are complete", async () => {
    const result = await resolveWith(privateHome, businessReturn);
    expect(result.canRequestRates).toBe(true);
    expect(result.blockedReason).toBeNull();
    expect(result.usesSeparateReturn).toBe(true);
  });
});

describe("the private origin never becomes the customer-facing return address", () => {
  it("returns the business address, with no trace of the private one", async () => {
    const { returnAddress } = await resolveWith(privateHome, businessReturn);
    const printed = JSON.stringify(returnAddress);
    for (const sentinel of [
      PRIVATE_OWNER_NAME_SENTINEL,
      PRIVATE_OWNER_STREET_SENTINEL,
      PRIVATE_OWNER_PHONE_SENTINEL,
    ]) {
      expect(printed).not.toContain(sentinel);
    }
    expect(returnAddress.street1).toBe(businessReturn.street1);
  });

  it("still reports the true origin, because carriers rate on it", async () => {
    // The private address is not erased — it is the real ship-from and the rate
    // depends on it. What must never happen is it reaching the LABEL.
    const { origin } = await resolveWith(privateHome, businessReturn);
    expect(origin.street1).toBe(PRIVATE_OWNER_STREET_SENTINEL);
  });
});

// ---------------------------------------------------------------------------
// THE PAYLOAD.
//
// The behaviour above is only worth anything if the shipment that gets
// purchased actually carries the return address. Asserted against the source,
// because that is where the defect lived: a correct resolver feeding a call
// that dropped the field.
// ---------------------------------------------------------------------------
describe("every Shippo shipment carries an explicit return address", () => {
  const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

  it("sends address_return on the path that buys the label", () => {
    const service = read("src/lib/shippo/service.ts");
    expect(service).toContain("addressReturn: toShippoAddress(addresses.returnAddress)");
  });

  it("sends it on every other shipment-creating path too", () => {
    const sync = read("src/lib/shippo/order-sync.ts");
    const creations = (sync.match(/createShipmentWithRates\(/g) ?? []).length;
    const returns = (sync.match(/addressReturn:/g) ?? []).length;
    expect(returns).toBeGreaterThanOrEqual(creations);
  });

  it("never creates a shipment without one, anywhere", () => {
    // The general form. Counting across the whole Shippo layer catches a new
    // call site added later that forgets the field — which is exactly how this
    // defect arrived.
    for (const file of ["src/lib/shippo/service.ts", "src/lib/shippo/order-sync.ts"]) {
      const src = read(file);
      const creations = (src.match(/createShipmentWithRates\(\{/g) ?? []).length;
      const returns = (src.match(/addressReturn:/g) ?? []).length;
      expect(returns).toBe(creations);
    }
  });
});

// ---------------------------------------------------------------------------
// THE INVARIANT ON THE REAL PURCHASE PATH.
//
// Testing the resolver in isolation proves a helper is correct. It does not
// prove the money path uses it — which is exactly the gap that let this defect
// ship, since the resolver was right the whole time and the caller dropped the
// field.
//
// So this pins the chain that actually spends money:
//
//   purchaseLabelForOrder
//     -> resolveSelectedRate          (a rate id, or a re-quote)
//       -> quoteShipment              (the ONLY shipment whose rates are cached)
//         -> createShipmentWithRates  (must carry address_return)
//     -> purchaseLabel({ rate })      (buys THAT shipment's rate)
//
// The link that makes it airtight: a rate is only purchasable if it came from
// quoteShipment, because quotedRates is module-private and cacheQuotedRates has
// exactly one caller. order-sync creates shipments too, but its rates never
// enter this cache — they exist for Shippo's own dashboard.
// ---------------------------------------------------------------------------
describe("the shipment whose rate is purchased always carried a return address", () => {
  const service = readFileSync(resolve(process.cwd(), "src/lib/shippo/service.ts"), "utf8");

  it("caches purchasable rates from exactly one place", () => {
    // Two callers would mean a second shipment could feed the purchase path,
    // and that one would need its own proof.
    const calls = (service.match(/\n\s*cacheQuotedRates\(/g) ?? []).length;
    expect(calls).toBe(1);
  });

  it("caches them immediately after the shipment that carries address_return", () => {
    const creation = service.indexOf("const result = await createShipmentWithRates({");
    const caching = service.indexOf("cacheQuotedRates(order.order_id");
    expect(creation).toBeGreaterThan(-1);
    expect(caching).toBeGreaterThan(creation);
    // The return address is inside THAT call, not some other one.
    const call = service.slice(creation, service.indexOf("});", creation));
    expect(call).toContain("addressReturn: toShippoAddress(addresses.returnAddress)");
  });

  it("keeps the rate cache private, so no other module can seed it", () => {
    expect(service).toContain("const quotedRates = new Map");
    expect(service).not.toMatch(/export\s+const\s+quotedRates/);
    const orderSync = readFileSync(resolve(process.cwd(), "src/lib/shippo/order-sync.ts"), "utf8");
    expect(orderSync).not.toContain("cacheQuotedRates");
    expect(orderSync).not.toContain("quotedRates");
  });

  it("buys by rate id, which binds the label to that shipment", () => {
    const client = readFileSync(resolve(process.cwd(), "src/lib/shippo/client.ts"), "utf8");
    expect(client).toContain("rate: rateId");
  });

  it("refuses to reach Shippo at all while the return address is missing", () => {
    // The fail-closed gate sits BEFORE the shipment call, so a blocked
    // configuration cannot produce a quote, cannot cache a rate, and therefore
    // cannot buy a label.
    const gate = service.indexOf("if (!addresses.canRequestRates)");
    const creation = service.indexOf("const result = await createShipmentWithRates({");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(creation);
  });
});
