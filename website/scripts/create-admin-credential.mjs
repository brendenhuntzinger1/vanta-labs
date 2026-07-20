// One-time provisioning script for the first /admin login.
//
// The admin_credentials table (src/lib/sql/partner-system-repair.sql) has no
// rows by default, and there is no other way to create one — admin-auth.ts
// verifies logins with scrypt, so a row can't just be inserted with a plain
// password. This script generates a salt + scrypt hash using the exact same
// scheme as src/lib/admin-auth.ts (`scryptSync(password, salt, 64)`, hex
// encoded) and upserts the credential using the Supabase service role key.
//
// Usage:
//   node scripts/create-admin-credential.mjs <username> <password> [role]
//
// role is one of staff | manager | super_admin (see src/lib/admin-roles.ts).
// Defaults to super_admin for a brand-new account, since this script is the
// only way to create the first admin and someone needs full access to grant
// roles to anyone else afterward. Rotating an existing account's password
// (same username, no role argument) leaves its current role untouched.
//
// Requires SUPABASE_SERVICE_ROLE_KEY and NEXT_PUBLIC_SUPABASE_URL to be set
// (loaded from .env.local if present, same as scripts/audit-partner-system.mjs).

import fs from "fs";
import path from "path";
import { randomBytes, scryptSync } from "crypto";
import { createClient } from "@supabase/supabase-js";

function loadEnvFile(filePath) {
  const fullPath = path.resolve(filePath);
  if (!fs.existsSync(fullPath)) {
    return;
  }

  const raw = fs.readFileSync(fullPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    process.env[key] = value;
  }
}

(async () => {
  loadEnvFile(".env.local");

  const [username, password, roleArg] = process.argv.slice(2);
  if (!username || !password) {
    console.error("Usage: node scripts/create-admin-credential.mjs <username> <password> [role]");
    process.exit(1);
  }

  if (password.length < 12) {
    console.error("Password must be at least 12 characters.");
    process.exit(1);
  }

  const validRoles = ["staff", "manager", "super_admin"];
  if (roleArg && !validRoles.includes(roleArg)) {
    console.error(`Invalid role "${roleArg}". Must be one of: ${validRoles.join(", ")}`);
    process.exit(1);
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY (set them in .env.local).");
    process.exit(1);
  }

  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  const normalizedUsername = username.trim().toLowerCase();

  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: existing } = await client
    .from("admin_credentials")
    .select("role")
    .eq("username", normalizedUsername)
    .maybeSingle();

  const role = roleArg ?? existing?.role ?? "super_admin";

  const { error } = await client
    .from("admin_credentials")
    .upsert(
      {
        username: normalizedUsername,
        password_salt: salt,
        password_hash: hash,
        is_active: true,
        role,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "username" },
    );

  if (error) {
    console.error("Failed to create/update admin credential:", error);
    process.exit(1);
  }

  console.log(`Admin credential ready for username "${normalizedUsername}" (role: ${role}). You can now log in at /admin.`);
})();
