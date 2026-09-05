import { isAnyAdminSecondFactorProvisioned } from "@/lib/admin-auth";
import { VaultLoginForm } from "@/components/vault-login-form";

export const dynamic = "force-dynamic";

// The form asks for a passcode exactly when the login route will check one.
//
// AA-5: the client form demanded six digits unconditionally, while the server
// (api/admin/auth/login) lets a fully-unprovisioned deployment in on username
// and password alone. The server already fails closed the moment ANY second
// factor exists (a global ADMIN_ACCESS_CODE or one account's passcode), so the
// only thing to fix is the form's claim. The same predicate the route uses
// decides what the form shows. If it cannot be read, the field is shown — the
// server still decides, and asking for a code that is not checked is the
// smaller mistake than hiding one that is.
export default async function VaultPage() {
  let passcodeRequired = true;
  try {
    passcodeRequired = await isAnyAdminSecondFactorProvisioned();
  } catch (error) {
    console.error("Could not determine whether an admin passcode is provisioned", error);
    passcodeRequired = true;
  }

  return <VaultLoginForm passcodeRequired={passcodeRequired} />;
}
