import fs from "fs";
import path from "path";
import { createClient } from "@supabase/supabase-js";

const ROOT = process.cwd();
const SRC_DIR = path.join(ROOT, "src");
const OUTPUT_PATH = path.join(ROOT, "DB_COMPATIBILITY_REPORT.md");

function loadEnvFile(filePath) {
  const fullPath = path.resolve(filePath);
  if (!fs.existsSync(fullPath)) return;

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

function getFilesRecursive(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...getFilesRecursive(fullPath));
      continue;
    }

    if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }

  return files;
}

function parseTablesAndColumns(source) {
  const tableSet = new Set();
  const tableColumns = new Map();

  const fromRegex = /\.from\(["']([a-zA-Z0-9_]+)["']\)/g;
  for (const match of source.matchAll(fromRegex)) {
    tableSet.add(match[1]);
  }

  const selectRegex = /\.from\(["']([a-zA-Z0-9_]+)["']\)[\s\S]{0,260}?\.select\(["']([^"']*)["']/g;
  for (const match of source.matchAll(selectRegex)) {
    const table = match[1];
    const rawColumns = match[2];
    const columns = rawColumns
      .split(",")
      .map((col) => col.trim())
      .filter((col) => col.length > 0 && col !== "*" && !col.includes("(") && !col.includes(" "))
      .map((col) => col.split(".").pop())
      .filter(Boolean);

    if (!tableColumns.has(table)) {
      tableColumns.set(table, new Set());
    }

    const colSet = tableColumns.get(table);
    for (const col of columns) {
      colSet.add(col);
    }
  }

  const rpcSet = new Set();
  const rpcRegex = /\.rpc\(["']([a-zA-Z0-9_]+)["']/g;
  for (const match of source.matchAll(rpcRegex)) {
    rpcSet.add(match[1]);
  }

  return { tableSet, tableColumns, rpcSet };
}

function mergeMaps(target, source) {
  for (const [key, valueSet] of source.entries()) {
    if (!target.has(key)) {
      target.set(key, new Set());
    }

    const targetSet = target.get(key);
    for (const value of valueSet) {
      targetSet.add(value);
    }
  }
}

function fmtError(error) {
  if (!error) return "";
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function rpcMissingError(error) {
  const message = fmtError(error).toLowerCase();
  return message.includes("could not find the function") || message.includes("does not exist") || message.includes("pgrst202");
}

async function main() {
  loadEnvFile(".env.local");

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    console.error("Missing Supabase credentials in environment.");
    process.exit(2);
  }

  const files = getFilesRecursive(SRC_DIR);
  const allTables = new Set();
  const allRpcs = new Set();
  const tableColumns = new Map();

  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    const parsed = parseTablesAndColumns(source);

    for (const table of parsed.tableSet) {
      allTables.add(table);
    }

    for (const rpcName of parsed.rpcSet) {
      allRpcs.add(rpcName);
    }

    mergeMaps(tableColumns, parsed.tableColumns);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const tableResults = [];
  for (const table of Array.from(allTables).sort()) {
    const requiredColumns = Array.from(tableColumns.get(table) ?? []).sort();

    const existsProbe = await supabase.from(table).select("*").limit(1);
    const exists = !existsProbe.error;

    let columnsMatch = null;
    let columnsError = "";

    if (exists && requiredColumns.length > 0) {
      const columnProbe = await supabase.from(table).select(requiredColumns.join(",")).limit(1);
      columnsMatch = !columnProbe.error;
      if (columnProbe.error) {
        columnsError = fmtError(columnProbe.error);
      }
    }

    tableResults.push({
      table,
      exists,
      requiredColumns,
      columnsMatch,
      existsError: existsProbe.error ? fmtError(existsProbe.error) : "",
      columnsError,
    });
  }

  const rpcResults = [];
  for (const rpcName of Array.from(allRpcs).sort()) {
    const probe = await supabase.rpc(rpcName, {});
    const missing = probe.error ? rpcMissingError(probe.error) : false;

    rpcResults.push({
      rpcName,
      exists: !missing,
      note: probe.error ? fmtError(probe.error) : "OK",
    });
  }

  const now = new Date().toISOString();
  const missingTables = tableResults.filter((row) => !row.exists);
  const mismatchedColumns = tableResults.filter((row) => row.exists && row.columnsMatch === false);
  const missingRpcs = rpcResults.filter((row) => !row.exists);

  const lines = [];
  lines.push("# Database Compatibility Report");
  lines.push("");
  lines.push(`Generated: ${now}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Tables referenced in app code: ${tableResults.length}`);
  lines.push(`- Missing tables: ${missingTables.length}`);
  lines.push(`- Tables with column mismatches: ${mismatchedColumns.length}`);
  lines.push(`- RPC functions referenced: ${rpcResults.length}`);
  lines.push(`- Missing RPC functions: ${missingRpcs.length}`);
  lines.push("");
  lines.push("## Table Compatibility");
  lines.push("");
  lines.push("| Table | Exists in Supabase | Required Columns Match | Required Column Count |");
  lines.push("|---|---|---|---|");

  for (const row of tableResults) {
    const existsMark = row.exists ? "Yes" : "No";
    const columnMark = row.columnsMatch === null ? "n/a" : (row.columnsMatch ? "Yes" : "No");
    lines.push(`| public.${row.table} | ${existsMark} | ${columnMark} | ${row.requiredColumns.length} |`);
  }

  if (missingTables.length > 0) {
    lines.push("");
    lines.push("## Missing Tables");
    lines.push("");
    for (const row of missingTables) {
      lines.push(`- public.${row.table}`);
      if (row.existsError) {
        lines.push(`  - Probe error: ${row.existsError}`);
      }
    }
  }

  if (mismatchedColumns.length > 0) {
    lines.push("");
    lines.push("## Column Mismatches");
    lines.push("");
    for (const row of mismatchedColumns) {
      lines.push(`- public.${row.table}`);
      lines.push(`  - Required columns: ${row.requiredColumns.join(", ") || "(none parsed)"}`);
      lines.push(`  - Probe error: ${row.columnsError || "unknown"}`);
    }
  }

  lines.push("");
  lines.push("## RPC Compatibility");
  lines.push("");
  lines.push("| RPC Function | Exists in Supabase | Probe Result |");
  lines.push("|---|---|---|");
  for (const row of rpcResults) {
    lines.push(`| public.${row.rpcName} | ${row.exists ? "Yes" : "No"} | ${row.note.replace(/\|/g, "\\|")} |`);
  }

  fs.writeFileSync(OUTPUT_PATH, `${lines.join("\n")}\n`, "utf8");

  console.log(`Report written to ${path.relative(ROOT, OUTPUT_PATH)}`);
  console.log(`Tables: ${tableResults.length}, missing: ${missingTables.length}, column mismatches: ${mismatchedColumns.length}`);
  console.log(`RPCs: ${rpcResults.length}, missing: ${missingRpcs.length}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
