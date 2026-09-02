import { describe, expect, it } from "vitest";
import { isSecretControlKey, redactControlSnapshot } from "@/lib/admin-control-secrets";

describe("which control keys are credentials", () => {
  it("treats the Pushover pair as secret", () => {
    expect(isSecretControlKey("notifications", "pushover_token")).toBe(true);
    expect(isSecretControlKey("notifications", "pushover_user_key")).toBe(true);
  });

  it("leaves the ordinary settings in the same section alone", () => {
    // The panel has to render these, and neither is a credential: the alert
    // email is an address the owner already knows, and the webhook URL is
    // reported as set/not-set through the same redaction as the token below
    // only if it is ever added to the list — today it is a plain setting.
    expect(isSecretControlKey("notifications", "order_push_webhook_url")).toBe(false);
    expect(isSecretControlKey("alerts", "email")).toBe(false);
  });
});

describe("redacting a snapshot for the admin panel", () => {
  const snapshot = () => ({
    notifications: {
      pushover_token: "SECRET-TOKEN",
      pushover_user_key: "SECRET-USER",
      order_push_webhook_url: "https://hooks.example.com/catch/1/abc",
    },
    alerts: { email: "owner@example.com" },
  });

  it("removes the credentials from the payload entirely", () => {
    const { snapshot: redacted } = redactControlSnapshot(snapshot());
    expect(JSON.stringify(redacted)).not.toContain("SECRET-TOKEN");
    expect(JSON.stringify(redacted)).not.toContain("SECRET-USER");
    expect(redacted.notifications.pushover_token).toBe("");
  });

  it("still says whether each one is stored, which is what the panel shows", () => {
    const { secretsSet } = redactControlSnapshot(snapshot());
    expect(secretsSet["notifications.pushover_token"]).toBe(true);
    expect(secretsSet["notifications.pushover_user_key"]).toBe(true);
  });

  it("reports a key that was never written as not set", () => {
    const { secretsSet } = redactControlSnapshot({ notifications: { order_push_webhook_url: "" } });
    expect(secretsSet["notifications.pushover_token"]).toBe(false);
  });

  it("counts a stored blank as not set, because it cannot send anything", () => {
    const { secretsSet } = redactControlSnapshot({ notifications: { pushover_token: "   " } });
    expect(secretsSet["notifications.pushover_token"]).toBe(false);
  });

  it("leaves every non-secret value exactly as it was", () => {
    const { snapshot: redacted } = redactControlSnapshot(snapshot());
    expect(redacted.notifications.order_push_webhook_url).toBe("https://hooks.example.com/catch/1/abc");
    expect(redacted.alerts.email).toBe("owner@example.com");
  });

  it("does not mutate the snapshot it was given", () => {
    const original = snapshot();
    redactControlSnapshot(original);
    expect(original.notifications.pushover_token).toBe("SECRET-TOKEN");
  });
});
