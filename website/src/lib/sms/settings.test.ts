import { describe, expect, it } from "vitest";

import { smsBlockedReason, type SmsRuntimeConfig } from "@/lib/sms/settings";

// ---------------------------------------------------------------------------
// M1's load-bearing invariant: NOTHING CAN SEND.
//
// Every credential is unset and every switch is off at M1, and the whole
// programme is built in that state on purpose — the day A2P registration lands
// is a flag flip, not a deploy. So this file's job is to prove the gate refuses
// in every partially-configured intermediate state, not just the empty one,
// because the intermediate states are the ones that actually occur while an
// operator is filling the Settings page in.
//
// smsBlockedReason is pure, so this needs no database and no Twilio.
// ---------------------------------------------------------------------------

const NOTHING_CONFIGURED: SmsRuntimeConfig = {
  enabled: false,
  transactionalEnabled: false,
  marketingEnabled: false,
  accountSid: "",
  authToken: "",
  transactionalMessagingServiceSid: "",
  marketingMessagingServiceSid: "",
  verifyServiceSid: "",
  statusCallbackUrl: "",
  brandName: "Vanta Labs",
  helpContact: "",
  messagesPerMonth: "4",
};

const FULLY_CONFIGURED: SmsRuntimeConfig = {
  ...NOTHING_CONFIGURED,
  enabled: true,
  transactionalEnabled: true,
  marketingEnabled: true,
  accountSid: "AC" + "0".repeat(32),
  authToken: "token",
  transactionalMessagingServiceSid: "MGtransactional",
  marketingMessagingServiceSid: "MGmarketing",
  verifyServiceSid: "VA1",
  statusCallbackUrl: "https://vantalabsresearch.com/api/webhooks/twilio",
  helpContact: "support@vantalabsresearch.com",
};

describe("M1: with nothing configured, no channel may send", () => {
  it.each(["transactional", "marketing"] as const)("blocks %s", (channel) => {
    expect(smsBlockedReason(NOTHING_CONFIGURED, channel)).not.toBeNull();
  });

  it("names the master switch first, because that is the one an operator looks for", () => {
    expect(smsBlockedReason(NOTHING_CONFIGURED, "marketing")).toContain("turned off");
  });
});

describe("the master switch outranks everything", () => {
  it("blocks both channels even when fully configured and both channel switches are on", () => {
    const config = { ...FULLY_CONFIGURED, enabled: false };
    expect(smsBlockedReason(config, "transactional")).not.toBeNull();
    expect(smsBlockedReason(config, "marketing")).not.toBeNull();
  });

  it("is the rollback lever: flipping it off stops everything with no deploy", () => {
    expect(smsBlockedReason(FULLY_CONFIGURED, "marketing")).toBeNull();
    expect(smsBlockedReason({ ...FULLY_CONFIGURED, enabled: false }, "marketing")).not.toBeNull();
  });
});

describe("the two channels are independent, because their A2P campaigns are approved weeks apart", () => {
  it("transactional can be live while marketing is still pending — the expected state for weeks", () => {
    const config = { ...FULLY_CONFIGURED, marketingEnabled: false };
    expect(smsBlockedReason(config, "transactional")).toBeNull();
    expect(smsBlockedReason(config, "marketing")).not.toBeNull();
    expect(smsBlockedReason(config, "marketing")).toContain("marketing campaign is not approved");
  });

  it("marketing can be live while transactional is off, without borrowing its approval", () => {
    const config = { ...FULLY_CONFIGURED, transactionalEnabled: false };
    expect(smsBlockedReason(config, "transactional")).not.toBeNull();
    expect(smsBlockedReason(config, "marketing")).toBeNull();
  });
});

describe("every missing credential fails closed", () => {
  it.each([
    ["accountSid", { accountSid: "" }],
    ["authToken", { authToken: "" }],
  ])("blocks both channels when %s is missing", (_name, patch) => {
    const config = { ...FULLY_CONFIGURED, ...patch };
    expect(smsBlockedReason(config, "transactional")).not.toBeNull();
    expect(smsBlockedReason(config, "marketing")).not.toBeNull();
  });

  it("a channel is blocked by ITS OWN missing Messaging Service, not the other's", () => {
    // The services carry separate campaign registrations. Falling back to the
    // other one would send marketing traffic down a transactional campaign,
    // which is the misuse carriers actually police.
    const noMarketing = { ...FULLY_CONFIGURED, marketingMessagingServiceSid: "" };
    expect(smsBlockedReason(noMarketing, "marketing")).toContain("Messaging Service");
    expect(smsBlockedReason(noMarketing, "transactional")).toBeNull();

    const noTransactional = { ...FULLY_CONFIGURED, transactionalMessagingServiceSid: "" };
    expect(smsBlockedReason(noTransactional, "transactional")).toContain("Messaging Service");
    expect(smsBlockedReason(noTransactional, "marketing")).toBeNull();
  });
});

describe("marketing carries an extra requirement transactional does not", () => {
  it("blocks marketing without a support contact — HELP must be answerable", () => {
    // A marketing programme that cannot answer HELP is one a carrier can fault.
    // Transactional is exempt: an order notification is not a solicitation and
    // carries the store's contact details in the order itself.
    const config = { ...FULLY_CONFIGURED, helpContact: "" };
    expect(smsBlockedReason(config, "marketing")).toContain("support contact");
    expect(smsBlockedReason(config, "transactional")).toBeNull();
  });
});

describe("fully configured and switched on, both channels are allowed", () => {
  it("returns null — the only state in which anything sends", () => {
    expect(smsBlockedReason(FULLY_CONFIGURED, "transactional")).toBeNull();
    expect(smsBlockedReason(FULLY_CONFIGURED, "marketing")).toBeNull();
  });
});
