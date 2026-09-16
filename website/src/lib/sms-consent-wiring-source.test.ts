import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SMS_CONSENT_TEXT } from "@/lib/sms-consent-text";

// ---------------------------------------------------------------------------
// WHERE SMS CONSENT IS COLLECTED, AND ON WHAT TERMS.
//
// Three surfaces show the box (the sign-up page, the checkout, the account
// settings page) and the Omnisend pop-up shows it a fourth time. Every one
// shows the same sentence, none is ever pre-ticked, and each hands the tick
// to sms-consent.ts rather than writing consent itself. Pinned in source
// because a pre-ticked box or a drifted sentence is the kind of change that
// passes every behavioural test and fails a carrier audit.
// ---------------------------------------------------------------------------

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const SIGNUP_FORM = read("src/components/account-auth-form.tsx");
const SIGNUP_ROUTE = read("src/app/api/auth/signup/route.ts");
const CHECKOUT = read("src/app/checkout/page.tsx");
const CREATE_SESSION = read("src/app/api/checkout/create-session/route.ts");
const PREFERENCES = read("src/app/api/account/preferences/route.ts");
const SETTINGS = read("src/components/account-settings-client.tsx");
const POPUP = read("scripts/omnisend/form.mjs");

describe("one sentence, everywhere the box appears", () => {
  it("is imported from sms-consent-text.ts by the sign-up form, the checkout and the settings page", () => {
    for (const source of [SIGNUP_FORM, CHECKOUT, SETTINGS]) {
      expect(source).toMatch(/import \{[^}]*\bSMS_CONSENT_TEXT\b[^}]*\} from "@\/lib\/sms-consent-text";/);
      expect(source).toContain("{SMS_CONSENT_TEXT}");
    }
  });

  it("is the sentence the Omnisend pop-up carries, word for word", () => {
    expect(POPUP).toContain(`export const SMS_CONSENT = "${SMS_CONSENT_TEXT}";`);
  });

  it("names STOP, HELP, rates, frequency and that consent is not a condition of purchase", () => {
    for (const phrase of ["Reply STOP", "HELP", "Message and data rates may apply", "Message frequency varies", "Consent is not a condition of purchase"]) {
      expect(SMS_CONSENT_TEXT).toContain(phrase);
    }
  });
});

describe("never pre-ticked", () => {
  it("the sign-up form and the checkout start the box off", () => {
    expect(SIGNUP_FORM).toContain("const [smsOptIn, setSmsOptIn] = useState(false);");
    expect(CHECKOUT).toContain("const [smsOptIn, setSmsOptIn] = useState(false);");
    // Unlike the email box, which may default on for a US destination.
    expect(CHECKOUT).not.toMatch(/smsOptIn[^;]*isUnitedStates/);
  });

  it("the sign-up form asks for a number beside the box and refuses a tick without one", () => {
    expect(SIGNUP_FORM).toContain('data-testid="signup-sms-phone"');
    expect(SIGNUP_FORM).toContain('data-testid="signup-sms-opt-in"');
    expect(SIGNUP_FORM).toContain("if (smsOptIn && !acceptableSmsPhone(smsPhone)) {");
    expect(SIGNUP_FORM).toMatch(/smsOptIn,\s*phone: smsPhone\.trim\(\),/);
  });

  it("the checkout box sits under the delivery phone and posts its own flag", () => {
    expect(CHECKOUT).toContain('data-testid="checkout-sms-opt-in"');
    expect(CHECKOUT.indexOf('label="Phone"')).toBeLessThan(CHECKOUT.indexOf('data-testid="checkout-sms-opt-in"'));
    expect(CHECKOUT).toMatch(/marketingOptIn,\s*smsOptIn,\s*expectedTotal: postedTotal,/);
  });
});

describe("the routes record the tick through sms-consent.ts, SMS before email so one push carries both", () => {
  it("sign-up: only a ticked box with an acceptable number, on the account just created", () => {
    expect(SIGNUP_ROUTE).toMatch(/import \{ recordSmsConsent \} from "@\/lib\/sms-consent";/);
    expect(SIGNUP_ROUTE).toContain('const smsPhone = acceptableSmsPhone(read("phone"));');
    expect(SIGNUP_ROUTE).toContain("const smsOptIn = (body as { smsOptIn?: unknown })?.smsOptIn === true && smsPhone !== null;");
    const sms = SIGNUP_ROUTE.indexOf('await recordSmsConsent({ email: input.email, phone: input.smsPhone, source: "signup", userId: data.user?.id ?? null });');
    const email = SIGNUP_ROUTE.indexOf("await recordSignupMarketingConsent(data.user?.id ?? null, input.email);");
    expect(sms).toBeGreaterThan(-1);
    expect(email).toBeGreaterThan(sms);
  });

  it("checkout: the delivery number with the box, guest or signed in", () => {
    expect(CREATE_SESSION).toMatch(/import \{ recordSmsConsent \} from "@\/lib\/sms-consent";/);
    const sms = CREATE_SESSION.indexOf('void recordSmsConsent({ email: customer.email, phone: customer.phone, source: "checkout", userId: customerUserId ?? null });');
    const email = CREATE_SESSION.indexOf('void recordMarketingOptIn(customer.email, "checkout");');
    expect(sms).toBeGreaterThan(-1);
    expect(email).toBeGreaterThan(sms);
    expect(CREATE_SESSION).toContain("if (body.smsOptIn === true && customer.email && customer.phone) {");
  });

  it("account settings: an untick stops the address's own row too", () => {
    expect(PREFERENCES).toMatch(/import \{ recordSmsOptOut \} from "@\/lib\/sms-consent";/);
    expect(PREFERENCES).toContain("if (address && !body.smsMarketing) await recordSmsOptOut(address, now);");
  });
});

describe("the consent row is service-role only and part of the harness schema", () => {
  it("sms-subscribers.sql enables RLS with no policies, and the harness applies it", () => {
    const sql = read("src/lib/sql/sms-subscribers.sql");
    expect(sql).toContain("create table if not exists public.sms_subscribers (");
    expect(sql).toContain("alter table public.sms_subscribers enable row level security;");
    expect(sql).not.toMatch(/create policy/i);
    expect(read("scripts/setup-local-harness.sh")).toMatch(/omnisend-sync sms-subscribers; do/);
  });
});
