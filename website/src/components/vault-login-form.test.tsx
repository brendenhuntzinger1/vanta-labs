import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// ---------------------------------------------------------------------------
// AA-5 — THE FORM ASKS FOR A PASSCODE EXACTLY WHEN THE SERVER CHECKS ONE.
//
// /vault marked a "6-Digit Passcode" field required while the login route
// accepted any value — or none — whenever no passcode was provisioned, so an
// operator believed a second factor was enforced when it was not. The page now
// asks the same predicate the route uses (isAnyAdminSecondFactorProvisioned)
// and the form shows the field only when the answer is yes.
// ---------------------------------------------------------------------------

const auth = vi.hoisted(() => ({ isAnyAdminSecondFactorProvisioned: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, replace: () => {} }) }));
vi.mock("@/lib/admin-auth", () => ({ isAnyAdminSecondFactorProvisioned: auth.isAnyAdminSecondFactorProvisioned }));

const { VaultLoginForm } = await import("./vault-login-form");

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("VaultLoginForm", () => {
  it("demands the six digits when a passcode is configured", () => {
    const html = renderToStaticMarkup(<VaultLoginForm passcodeRequired />);

    expect(html).toContain("6-Digit Passcode");
    expect(html).toMatch(/data-testid="vault-passcode"[^>]*required/);
    expect(html).not.toContain("vault-passcode-not-configured");
  });

  it("does not demand one — and says so — when none is configured", () => {
    const html = renderToStaticMarkup(<VaultLoginForm passcodeRequired={false} />);

    expect(html).not.toContain("6-Digit Passcode");
    expect(html).not.toContain('data-testid="vault-passcode"');
    expect(html).toContain("No login passcode is configured yet");
    // Username and password are still required.
    expect(html.match(/required/g)?.length).toBe(2);
  });
});

describe("/vault page", () => {
  it("shows the passcode field when a second factor is provisioned anywhere", async () => {
    auth.isAnyAdminSecondFactorProvisioned.mockResolvedValue(true);
    const { default: VaultPage } = await import("@/app/vault/page");
    const html = renderToStaticMarkup(await VaultPage());

    expect(html).toContain("6-Digit Passcode");
  });

  it("hides it when the server would not check one", async () => {
    auth.isAnyAdminSecondFactorProvisioned.mockResolvedValue(false);
    const { default: VaultPage } = await import("@/app/vault/page");
    const html = renderToStaticMarkup(await VaultPage());

    expect(html).not.toContain("6-Digit Passcode");
    expect(html).toContain("No login passcode is configured yet");
  });

  it("falls back to showing the field when the check itself fails — the server still decides", async () => {
    auth.isAnyAdminSecondFactorProvisioned.mockRejectedValue(new Error("db down"));
    const { default: VaultPage } = await import("@/app/vault/page");
    const html = renderToStaticMarkup(await VaultPage());

    expect(html).toContain("6-Digit Passcode");
  });
});
