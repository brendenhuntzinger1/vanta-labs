import { describe, it, expect } from "vitest";

describe("admin-control.ts numeric readers, fed the same blank value", () => {
  it("three different idioms in one file give three different answers", () => {
    const blank = "";   // what clearing an admin form field produces
    const rows: Array<[string, unknown]> = [
      ["getCartRecoveryControlConfig:261-262   Number(x ?? 48)          ", Number(blank ?? 48)],
      ["getCardProcessingFeeConfig:332         Number(x) || 0           ", Number(blank) || 0],
      ["getSubscribeSaveConfig:408             Number(x ?? 10) || 10    ", Number(blank ?? 10) || 10],
      ["getWelcomeOffer:443                    Number(x ?? 10) || 10    ", Number(blank ?? 10) || 10],
      ["getBulkSavings / getProfitSettings /                            ", null],
      ["  getShippingConfig  (local num())     blank -> fallback        ", (blank === "" || blank == null) ? 48 : Number(blank)],
      ["clampPercent:552 (referral/ambassador) blank -> fallback        ", (blank === "" || blank == null) ? 10 : Number(blank)],
    ];
    for (const [k, v] of rows) if (v !== null) console.log(`  ${k} -> ${v}`);
    expect(Number(blank ?? 48)).toBe(0);                       // unguarded: blank becomes zero
    expect((blank === "" ? 48 : Number(blank))).toBe(48);      // guarded: blank keeps the default
  });

  it("the unguarded reader also passes NaN and negatives straight through", () => {
    for (const v of ["", "abc", "-12", "3.5", null, undefined] as const) {
      const n = Number(v as never);
      const unguarded = Number((v as never) ?? 48);
      const guarded = (v === "" || v == null) ? 48 : (Number.isFinite(n) && n >= 0 ? n : 48);
      console.log(`  stored ${String(JSON.stringify(v)).padEnd(11)} unguarded=${String(unguarded).padEnd(6)} guarded=${guarded}`);
    }
    expect(Number("abc")).toBeNaN();
    expect(Number("-12")).toBe(-12);
  });

  it("what each of those values does downstream in mintCartRecoveryCoupon (cart-recovery.ts:128)", () => {
    const HOUR_MS = 3600_000;
    const mint = Date.parse("2026-08-26T10:00:00Z");
    const outcome = (hours: number) => {
      let endsAt: string;
      try {
        endsAt = new Date(mint + hours * HOUR_MS).toISOString();   // cart-recovery.ts:128
      } catch (e) {
        return `THROWS ${(e as Error).constructor.name}: ${(e as Error).message}`;
      }
      // coupons.ts:157  if (ends_at && new Date(ends_at).getTime() < now) -> "This coupon has expired"
      return Date.parse(endsAt) < mint ? `ends_at=${endsAt}  -> REFUSED at checkout`
           : Date.parse(endsAt) === mint ? `ends_at=${endsAt}  -> dead on creation`
           : `ends_at=${endsAt}  -> valid`;
    };
    for (const h of [48, 0, -12, NaN]) console.log(`  couponExpirationHours=${String(h).padEnd(5)} ${outcome(h)}`);

    expect(outcome(0)).toContain("dead on creation");
    expect(outcome(-12)).toContain("REFUSED at checkout");
    expect(outcome(NaN)).toContain("THROWS RangeError");
  });
});
