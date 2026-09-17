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
    // Unlike the email box, which may default on for a US destination. Pinned
    // on the declaration itself rather than on the distance between the two
    // names in the file: the welcome-offer block added in September puts
    // `smsOptIn` in the JSX a few hundred characters above the email box's
    // country default, which a proximity match reads as a pre-tick.
    const declaration = CHECKOUT.slice(
      CHECKOUT.indexOf("const [smsOptIn, setSmsOptIn]"),
      CHECKOUT.indexOf(";", CHECKOUT.indexOf("const [smsOptIn, setSmsOptIn]")),
    );
    expect(declaration).toContain("useState(false)");
    expect(declaration).not.toContain("isUnitedStates");
    // And nothing anywhere sets it from the country.
    expect(CHECKOUT).not.toMatch(/setSmsOptIn\([^)]*isUnitedStates/);
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
    // UNCONDITIONAL, not on a change. Reading the change from the account
    // mirror meant a missing or unreadable row silently swallowed the stop.
    expect(PREFERENCES).toContain("if (!body.smsMarketing) {");
    expect(PREFERENCES).toContain("await recordSmsOptOut(stopAddress, now);");
  });
});

describe("the consent row is service-role only and part of the harness schema", () => {
  // THE MIGRATION MUST NOT PRETEND TO CREATE A TABLE THAT ALREADY EXISTS.
  //
  // It did, with `create table if not exists`, against a production
  // sms_subscribers of a completely different shape. Applying it would have
  // been a silent no-op and every consent write would then have failed on
  // columns that are not there — while this module catches its own errors, so
  // nothing would have reported it. The file is now additive only.
  it("sms-subscribers.sql only adds what is missing, and never creates the table", () => {
    const sql = read("src/lib/sql/sms-subscribers.sql");
    expect(sql).toContain("alter table public.sms_subscribers");
    expect(sql).toContain("add column if not exists email text;");
    // Statements only: the comment above explains the bug by quoting the
    // very phrase this forbids, so the check reads the SQL and not the prose.
    const statements = sql.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    expect(statements).not.toMatch(/create table/i);
    expect(statements).not.toMatch(/drop /i);
    expect(statements).not.toMatch(/create policy/i);
    expect(read("scripts/setup-local-harness.sh")).toMatch(/omnisend-sync customer-sms-consent sms-subscribers; do/);
  });

  it("the harness builds the table production actually has, so it cannot pass on a shape nobody holds", () => {
    const setup = read("scripts/setup-local-harness.sh");
    for (const column of ["phone_e164 text primary key", "marketing_consent boolean", "disclosure_version text", "resubscribe_count integer", "opt_out_keyword text"]) {
      expect(setup).toContain(column);
    }
  });
});
