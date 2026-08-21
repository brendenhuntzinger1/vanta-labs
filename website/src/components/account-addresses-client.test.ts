import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const CLIENT = read("src/components/account-addresses-client.tsx");
const CREATE_ROUTE = read("src/app/api/account/addresses/route.ts");
const ITEM_ROUTE = read("src/app/api/account/addresses/[addressId]/route.ts");

// A reload is a fresh document load, and the age gate is shown on EVERY fresh
// load and remembered nowhere. Reloading after an address mutation therefore
// walled a signed-in customer behind the 21+ attestation for saving an address,
// and destroyed the "Address saved." confirmation before it could be read.
describe("the address book never reloads the document", () => {
  it("does not reload after a mutation", () => {
    expect(CLIENT).not.toContain("window.location.reload");
    expect(CLIENT).not.toContain("location.reload()");
  });

  it("updates the list from the response instead", () => {
    for (const marker of [
      "setAddresses(result.addresses)",
      "AddressMutationResult",
    ]) {
      expect(CLIENT).toContain(marker);
    }
  });

  it("create and set-default return the refreshed list", () => {
    for (const route of [CREATE_ROUTE, ITEM_ROUTE]) {
      expect(route).toContain("getCustomerAddresses(user.id)");
    }
  });

  // DELETE is exempt: the client already removes the row from local state, so
  // it needs no list back. Everything else does — a bare success would leave
  // the client with nothing to re-render from.
  it("only DELETE returns a bare success", () => {
    expect(CREATE_ROUTE).not.toMatch(/success: true \}\)/);
    const deleteBody = ITEM_ROUTE.slice(ITEM_ROUTE.indexOf("export async function DELETE"));
    const patchBody = ITEM_ROUTE.slice(0, ITEM_ROUTE.indexOf("export async function DELETE"));
    expect(patchBody).not.toMatch(/success: true \}\)/);
    expect(deleteBody).toMatch(/success: true \}\)/);
  });
});
