import "server-only";
import { createClient } from "@supabase/supabase-js";

function getEnvValue(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

export function createServerClient() {
  const supabaseUrl = getEnvValue("NEXT_PUBLIC_SUPABASE_URL");
  const serviceRoleKey = getEnvValue("SUPABASE_SERVICE_ROLE_KEY");

  return createClient(
    supabaseUrl,
    serviceRoleKey,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    },
  );
}

export const supabaseAdmin = createServerClient();
