import { describe, expect, it } from "vitest";

import { VANTA_SENDER_NAME, mentionsForeignBrand, resolveSenderIdentity } from "@/lib/email/sender-identity";

describe("customer email always says Vanta Labs", () => {
  it("keeps a correct sender exactly as it is", () => {
    const sender = resolveSenderIdentity("Vanta Labs <orders@vantalabsresearch.com>");
    expect(sender.from).toBe("Vanta Labs <orders@vantalabsresearch.com>");
    expect(sender.blocked).toBe(false);
    expect(sender.nameRewritten).toBe(false);
  });

  it("adds the Vanta Labs name to a bare address", () => {
    const sender = resolveSenderIdentity("orders@vantalabsresearch.com");
    expect(sender.from).toBe("Vanta Labs <orders@vantalabsresearch.com>");
    expect(sender.blocked).toBe(false);
  });

  it("rewrites a foreign display name on a Vanta address", () => {
    // The reported failure: right mailbox, wrong company in the inbox list.
    const sender = resolveSenderIdentity("Evo Labs <orders@vantalabsresearch.com>");
    expect(sender.from).toBe("Vanta Labs <orders@vantalabsresearch.com>");
    expect(sender.nameRewritten).toBe(true);
    expect(sender.blocked).toBe(false);
    expect(sender.reason).toMatch(/Evo Labs/);
  });

  it("rewrites any other supply-chain name too", () => {
    for (const name of ["EvoLabs", "Veyra", "Veyragate", "Arcline", "Basis Theory"]) {
      const sender = resolveSenderIdentity(`${name} <orders@vantalabsresearch.com>`);
      expect(sender.from, name).toBe("Vanta Labs <orders@vantalabsresearch.com>");
      expect(sender.blocked, name).toBe(false);
    }
  });

  it("strips quotes around a display name", () => {
    expect(resolveSenderIdentity('"Evo Labs" <orders@vantalabsresearch.com>').from).toBe(
      "Vanta Labs <orders@vantalabsresearch.com>",
    );
  });

  it("never presents any name but Vanta Labs", () => {
    for (const raw of [
      "Evo Labs <orders@vantalabsresearch.com>",
      "orders@vantalabsresearch.com",
      "Something Else <support@vantalabsresearch.com>",
    ]) {
      expect(resolveSenderIdentity(raw).displayName).toBe(VANTA_SENDER_NAME);
    }
  });
});

describe("a foreign sending address is refused, not re-labelled", () => {
  it("blocks an Evo Labs address outright", () => {
    const sender = resolveSenderIdentity("Vanta Labs <orders@evolabs.com>");
    expect(sender.blocked).toBe(true);
    expect(sender.from).toBeNull();
    expect(sender.reason).toMatch(/another company/i);
  });

  it("blocks the gateway's and vault's domains too", () => {
    for (const address of ["noreply@veyragate.com", "billing@basistheory.com", "hello@arcline.io"]) {
      expect(resolveSenderIdentity(`Vanta Labs <${address}>`).blocked, address).toBe(true);
    }
  });

  it("blocks a missing or malformed From rather than guessing one", () => {
    expect(resolveSenderIdentity("").blocked).toBe(true);
    expect(resolveSenderIdentity(null).blocked).toBe(true);
    expect(resolveSenderIdentity("not-an-address").blocked).toBe(true);
    expect(resolveSenderIdentity("Vanta Labs <nope@localhost>").blocked).toBe(true);
  });

  it("explains itself in plain English for the admin", () => {
    expect(resolveSenderIdentity("orders@evolabs.com").reason).toContain("orders@evolabs.com");
    expect(resolveSenderIdentity("").reason).toMatch(/no from address/i);
  });
});

describe("mentionsForeignBrand", () => {
  it("catches the supply-chain names in any casing or spacing", () => {
    for (const value of ["Evo Labs", "evolabs", "EVO  LABS", "veyra", "Basis Theory", "arcline"]) {
      expect(mentionsForeignBrand(value), value).toBe(true);
    }
  });

  it("passes Vanta's own wording", () => {
    expect(mentionsForeignBrand("Vanta Labs")).toBe(false);
    expect(mentionsForeignBrand("")).toBe(false);
  });
});
