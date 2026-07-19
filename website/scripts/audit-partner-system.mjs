import fs from "fs";
import path from "path";
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

function placeholder(value) {
  if (!value) return true;
  return value.includes("YOUR_") || value.includes("REPLACE_");
}

function printSection(title) {
  console.log(`\n=== ${title} ===`);
}

function printResult(ok, label, detail = "") {
  const marker = ok ? "OK" : "FAIL";
  console.log(`[${marker}] ${label}${detail ? `\n  ${detail}` : ""}`);
}

async function probeTable(client, table, columns = "*") {
  const { error } = await client.from(table).select(columns).limit(1);
  if (error) {
    return { ok: false, error };
  }
  return { ok: true };
}

(async () => {
  loadEnvFile(".env.local");

  const requiredEnv = [
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "NEXT_PUBLIC_SITE_URL",
  ];

  printSection("Environment");
  let envOk = true;
  for (const key of requiredEnv) {
    const value = process.env[key] ?? "";
    const ok = Boolean(value) && !placeholder(value);
    envOk = envOk && ok;
    printResult(ok, key, ok ? "set" : "missing or placeholder");
  }

  if (!envOk) {
    console.log("\nEnvironment is not ready. Fix .env.local and rerun this script.");
    process.exit(2);
  }

  const client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  printSection("Connectivity");
  const ping = await client.from("orders").select("order_id").limit(1);
  if (ping.error) {
    printResult(false, "Supabase connection", JSON.stringify(ping.error, null, 2));
    process.exit(3);
  }
  printResult(true, "Supabase connection");

  printSection("Table + Column Probes");
  const probes = [
    ["partners", "id,name,email,referral_code,status,commission_percent,auth_user_id,invited_at,approved_at,disabled_at,created_by,updated_at"],
    ["referrals", "id,partner_id,referral_code,event_type,order_id,landing_path,utm_source,utm_medium,utm_campaign,referrer,user_agent,ip_address,created_at"],
    ["commissions", "id,partner_id,order_id,referral_code,commission_percent,commission_amount,status,created_at,updated_at"],
    ["payouts", "id,partner_id,amount,note,processed_by,created_at"],
    ["partner_program_stats", "key,value_numeric,updated_at"],
    ["orders", "order_id,ambassador_id,referral_code,payment_status,amount_paid,created_at"],
    ["referral_orders", "id,order_id,ambassador_id,referral_code,commission_percent,commission_amount,payment_status,created_at,updated_at"],
    ["ambassadors", "id,name,email,referral_code,status,commission_percent,auth_user_id"],
    ["partner_clicks", "id,ambassador_id,referral_code,landing_path,created_at"],
    ["partner_payouts", "id,ambassador_id,amount,processed_by,created_at"],
    ["admin_audit_logs", "id,actor_user_id,action,target_table,target_id,metadata,created_at"],
  ];

  let tablesOk = true;
  for (const [table, cols] of probes) {
    const result = await probeTable(client, table, cols);
    if (result.ok) {
      printResult(true, table);
    } else {
      tablesOk = false;
      printResult(false, table, JSON.stringify(result.error, null, 2));
    }
  }

  printSection("RLS Smoke Checks");
  const rlsTables = ["partners", "referrals", "commissions", "payouts", "partner_program_stats"];
  for (const table of rlsTables) {
    const { error } = await client.from(table).select("*").limit(1);
    printResult(!error, `${table} query via service role`, error ? JSON.stringify(error, null, 2) : "");
  }

  printSection("Outcome");
  if (!tablesOk) {
    console.log("One or more tables/columns are missing or incompatible.");
    console.log("Run migration: src/lib/sql/partner-system-repair.sql");
    process.exit(4);
  }

  console.log("Partner system probes passed.");
})();
