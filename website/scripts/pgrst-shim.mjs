#!/usr/bin/env node
/**
 * PostgREST-compatible shim for offline browser testing.
 *
 * WHY THIS EXISTS
 *
 * Supabase's REST API is PostgREST. The audit environment's egress policy
 * denies every *.supabase.co host, so a locally running Next.js app cannot
 * reach any Supabase project — production or throwaway. That blocked every
 * browser phase of the certification audit, including the one that matters
 * most: proving a customer can complete a purchase.
 *
 * Downloading real PostgREST is also blocked (GitHub release assets are
 * proxied to this session's own repositories only). So this speaks enough of
 * the PostgREST wire protocol, over a local Postgres, for supabase-js to work.
 *
 * WHAT THIS IS NOT
 *
 * Not a Supabase replacement and not a test double. It translates HTTP to SQL
 * and runs the REAL schema, the REAL constraints and the REAL plpgsql
 * functions. A bug in a database function still reproduces here. What it does
 * NOT reproduce is RLS (it connects as superuser, like the service-role key
 * production uses) or GoTrue auth. So:
 *
 *   - guest checkout, catalogue, cart, discounts, inventory  -> faithful
 *   - anything requiring a signed-in user                     -> NOT covered
 *   - RLS policy enforcement                                  -> NOT covered
 *
 * Evidence obtained through this shim is BROWSER-PROVEN for application
 * behaviour and must be recorded as NOT VERIFIED for anything auth- or
 * RLS-dependent. Do not let it launder one into the other.
 *
 * USAGE
 *   node scripts/pgrst-shim.mjs --port 54321 \
 *        --db postgres://postgres@localhost:55432/storefront
 *   then set NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
 */

import http from "node:http";
import pg from "pg";
import { handleAuth } from "./gotrue-shim.mjs";

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const PORT = Number(argOf("--port", "54321"));
const DB = argOf("--db", "postgres://postgres@localhost:55432/storefront");

const pool = new pg.Pool({ connectionString: DB, max: 12 });

/** PostgREST filter operators -> SQL. Order matters: longest prefix first. */
const OPS = [
  ["not.in.", (c, v) => [`${c}::text <> ALL(${lit(splitList(v))})`, []]],
  ["not.is.", (c, v) => [`${c} IS NOT ${isLiteral(v)}`, []]],
  ["not.eq.", (c, v, p) => [`${c} <> ${p(v)}`, [v]]],
  ["gte.", (c, v, p) => [`${c} >= ${p(v)}`, [v]]],
  ["lte.", (c, v, p) => [`${c} <= ${p(v)}`, [v]]],
  ["neq.", (c, v, p) => [`${c} <> ${p(v)}`, [v]]],
  ["ilike.", (c, v, p) => [`${c} ILIKE ${p(v.replace(/\*/g, "%"))}`, []]],
  ["like.", (c, v, p) => [`${c} LIKE ${p(v.replace(/\*/g, "%"))}`, []]],
  ["gt.", (c, v, p) => [`${c} > ${p(v)}`, [v]]],
  ["lt.", (c, v, p) => [`${c} < ${p(v)}`, [v]]],
  ["eq.", (c, v, p) => [`${c} = ${p(v)}`, [v]]],
  ["is.", (c, v) => [`${c} IS ${isLiteral(v)}`, []]],
  // Cast the column, not the array: a uuid/int column compared against a
  // text[] literal is `operator does not exist`, and .in() is the workhorse
  // filter for every parent->children fetch in this codebase.
  ["in.", (c, v) => [`${c}::text = ANY(${lit(splitList(v))})`, []]],
];

function isLiteral(v) {
  const s = String(v).toLowerCase();
  if (s === "null") return "NULL";
  if (s === "true") return "TRUE";
  if (s === "false") return "FALSE";
  return "NULL";
}

/** PostgREST in.(a,b,"c,d") — quoted members may contain commas. */
function splitList(raw) {
  const inner = raw.replace(/^\(/, "").replace(/\)$/, "");
  const out = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch === '"') { quoted = !quoted; continue; }
    if (ch === "," && !quoted) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur !== "" || out.length === 0) out.push(cur);
  return out;
}

const lit = (values) =>
  `ARRAY[${values.map((v) => `'${String(v).replace(/'/g, "''")}'`).join(",")}]::text[]`;

const ident = (name) => `"${String(name).replace(/"/g, '""')}"`;

/**
 * Foreign keys, read from the live catalogue once and cached.
 *
 * Embeds need to know how two tables join, and the only honest source for that
 * is the database itself — hard-coding pairs here would drift from the schema
 * the shim exists to run faithfully.
 */
let fkCache = null;
async function loadForeignKeys() {
  if (fkCache) return fkCache;
  const { rows } = await pool.query(`
    select
      src.relname  as src_table,
      src_col.attname as src_column,
      tgt.relname  as tgt_table,
      tgt_col.attname as tgt_column
    from pg_constraint con
    join pg_class src on src.oid = con.conrelid
    join pg_class tgt on tgt.oid = con.confrelid
    join pg_namespace ns on ns.oid = src.relnamespace and ns.nspname = 'public'
    join lateral unnest(con.conkey)  with ordinality as sk(attnum, ord) on true
    join lateral unnest(con.confkey) with ordinality as tk(attnum, ord) on sk.ord = tk.ord
    join pg_attribute src_col on src_col.attrelid = src.oid and src_col.attnum = sk.attnum
    join pg_attribute tgt_col on tgt_col.attrelid = tgt.oid and tgt_col.attnum = tk.attnum
    where con.contype = 'f'
  `);
  fkCache = rows;
  return fkCache;
}

/**
 * How `parent` and `child` join, in whichever direction the schema declares.
 *
 * Returns null when no foreign key connects them — the caller then drops the
 * embed and says so, rather than inventing a join.
 */
function relationBetween(fks, parent, embedded) {
  // One-to-many: the embedded table points at us. `orders` <- `order_items`.
  const many = fks.find((f) => f.src_table === embedded && f.tgt_table === parent);
  if (many) return { kind: "many", localColumn: many.tgt_column, foreignColumn: many.src_column };

  // Many-to-one: we point at the embedded table. `customer_memberships` -> `membership_tiers`.
  const one = fks.find((f) => f.src_table === parent && f.tgt_table === embedded);
  if (one) return { kind: "one", localColumn: one.src_column, foreignColumn: one.tgt_column };

  return null;
}

/** Split on commas that sit outside parentheses. */
function splitTopLevel(select) {
  const parts = [];
  let depth = 0;
  let cur = "";
  for (const ch of select) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) { parts.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur) parts.push(cur);
  return parts;
}

/**
 * select=a,b,rel(x,y) — embedded resources are returned as correlated json
 * subqueries, which is what supabase-js expects for a nested select.
 *
 * THIS USED TO BE A LIE. The docblock said exactly the above while the code
 * did `if (p.includes("(")) return null` — every embed was silently dropped
 * and the row came back without the key. Three separate audit phases lost time
 * to it: nested order_items(...) reads could not be exercised at all (which is
 * part of why an order_items column that does not exist stayed invisible),
 * the order-detail page 400ed, and a membership store-credit grant could only
 * be unit-tested. A test harness that quietly returns less than it was asked
 * for is worse than one that refuses.
 *
 * An embed with no foreign key between the two tables is still dropped — but
 * loudly, on stderr, because that is a schema question and guessing a join
 * would be the same sin in a new costume.
 */
async function buildSelect(select, parentTable) {
  if (!select || select === "*") return "*";

  const fks = await loadForeignKeys().catch(() => []);
  const out = [];

  for (const raw of splitTopLevel(select)) {
    const p = raw.trim();
    if (!p) continue;

    const embed = p.match(/^(?:([\w]+)\s*:\s*)?([\w]+)\s*(?:!\s*[\w]+\s*)?\((.*)\)$/s);
    if (!embed) {
      // `*` alongside an embed — `select=*,order_items(*)` — must stay a bare
      // star. ident() would quote it into a column named "*", which is a 42703
      // and was the first thing this rewrite got wrong.
      if (p === "*") { out.push("*"); continue; }
      const [expr, alias] = p.split(":").reverse();
      const col = ident(expr.trim());
      out.push(alias ? `${col} AS ${ident(alias.trim())}` : col);
      continue;
    }

    const [, alias, table, innerRaw] = embed;
    const rel = relationBetween(fks, parentTable, table);
    if (!rel) {
      console.warn(`[pgrst-shim] no foreign key joins ${parentTable} to ${table}; dropping embed "${p}"`);
      continue;
    }

    const inner = await buildSelect(innerRaw.trim() || "*", table);
    const key = ident(alias || table);
    const t = ident(table);
    const on = `${t}.${ident(rel.foreignColumn)} = ${ident(parentTable)}.${ident(rel.localColumn)}`;
    const projection = inner === "*" ? `to_jsonb(${t})` : `to_jsonb(row) FROM (SELECT ${inner}) row`;

    if (rel.kind === "many") {
      out.push(inner === "*"
        ? `(SELECT coalesce(json_agg(to_jsonb(${t})), '[]'::json) FROM ${t} WHERE ${on}) AS ${key}`
        : `(SELECT coalesce(json_agg(row_to_json(r)), '[]'::json) FROM (SELECT ${inner} FROM ${t} WHERE ${on}) r) AS ${key}`);
    } else {
      out.push(inner === "*"
        ? `(SELECT ${projection} FROM ${t} WHERE ${on}) AS ${key}`
        : `(SELECT row_to_json(r) FROM (SELECT ${inner} FROM ${t} WHERE ${on}) r) AS ${key}`);
    }
  }

  return out.join(", ") || "*";
}

async function parseQuery(url, parentTable) {
  const params = url.searchParams;
  const where = [];
  const values = [];
  const bind = (v) => { values.push(v); return `$${values.length}`; };

  let order = "";
  let limit = "";
  let offset = "";
  let select = "*";

  for (const [key, raw] of params.entries()) {
    if (key === "select") { select = await buildSelect(raw, parentTable); continue; }
    if (key === "order") {
      order = " ORDER BY " + raw.split(",").map((o) => {
        const [col, ...mods] = o.split(".");
        const dir = mods.includes("desc") ? "DESC" : "ASC";
        const nulls = mods.includes("nullslast") ? " NULLS LAST"
          : mods.includes("nullsfirst") ? " NULLS FIRST" : "";
        return `${ident(col)} ${dir}${nulls}`;
      }).join(", ");
      continue;
    }
    if (key === "limit") { limit = ` LIMIT ${Number(raw) || 0}`; continue; }
    if (key === "offset") { offset = ` OFFSET ${Number(raw) || 0}`; continue; }
    if (key.startsWith("on_conflict")) continue;

    const op = OPS.find(([prefix]) => raw.startsWith(prefix));
    if (!op) continue;
    const [prefix, fn] = op;
    const [clause] = fn(ident(key), raw.slice(prefix.length), bind);
    where.push(clause);
  }

  return {
    select,
    where: where.length ? ` WHERE ${where.join(" AND ")}` : "",
    order, limit, offset, values,
  };
}

const readBody = (req) => new Promise((resolve) => {
  let data = "";
  req.on("data", (c) => { data += c; });
  req.on("end", () => {
    try { resolve(data ? JSON.parse(data) : null); } catch { resolve(null); }
  });
});

function send(res, status, payload, extra = {}) {
  const body = payload === undefined ? "" : JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    ...extra,
  });
  res.end(body);
}

/** Postgres errors must surface in PostgREST's shape or supabase-js hides them. */
const pgError = (e) => ({
  code: e.code ?? "P0001",
  message: e.message,
  details: e.detail ?? null,
  hint: e.hint ?? null,
});

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return send(res, 204);

  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  // GoTrue lives on its own path prefix. Routed before the REST translation so
  // an auth call is never mistaken for a table named "auth".
  if (url.pathname.startsWith("/auth/v1")) {
    try {
      if (await handleAuth(req, res, url, pool, send, readBody)) return;
    } catch (e) {
      return send(res, 500, { error: "gotrue_shim_error", error_description: String(e?.message ?? e) });
    }
  }

  const path = url.pathname.replace(/^\/rest\/v1/, "");

  if (path === "/" || path === "") return send(res, 200, {});
  if (path === "/__health") return send(res, 200, { ok: true, db: DB });

  const prefer = String(req.headers.prefer ?? "");
  const wantsSingle = String(req.headers.accept ?? "").includes("vnd.pgrst.object");
  const wantsRepresentation = prefer.includes("return=representation");

  try {
    // ---- RPC ------------------------------------------------------------
    if (path.startsWith("/rpc/")) {
      const fn = path.slice(5);
      const body = (await readBody(req)) ?? {};
      const names = Object.keys(body);
      const sql = names.length
        ? `SELECT public.${ident(fn)}(${names.map((n, i) => `${ident(n)} => $${i + 1}`).join(", ")}) AS result`
        : `SELECT public.${ident(fn)}() AS result`;
      const { rows } = await pool.query(sql, names.map((n) => body[n]));
      const value = rows[0]?.result;
      // A set-returning function comes back as rows, not a scalar.
      return send(res, 200, value === undefined ? rows : value);
    }

    const tableName = path.replace(/^\//, "");
    const table = `public.${ident(tableName)}`;
    const q = await parseQuery(url, tableName);

    // ---- SELECT ---------------------------------------------------------
    if (req.method === "GET") {
      const sql = `SELECT ${q.select} FROM ${table}${q.where}${q.order}${q.limit}${q.offset}`;
      const { rows } = await pool.query(sql, q.values);
      if (wantsSingle) {
        if (rows.length !== 1) {
          return send(res, rows.length ? 406 : 406, {
            code: "PGRST116",
            message: `JSON object requested, multiple (or no) rows returned`,
            details: `Results contain ${rows.length} rows`,
            hint: null,
          });
        }
        return send(res, 200, rows[0]);
      }
      return send(res, 200, rows, {
        "Content-Range": `0-${Math.max(rows.length - 1, 0)}/${rows.length}`,
      });
    }

    // ---- INSERT / UPSERT ------------------------------------------------
    if (req.method === "POST") {
      const body = await readBody(req);
      const rowsIn = Array.isArray(body) ? body : [body];
      if (!rowsIn.length || !rowsIn[0]) return send(res, 400, { message: "empty body" });

      const cols = [...new Set(rowsIn.flatMap((r) => Object.keys(r)))];
      const values = [];
      const tuples = rowsIn.map((r) => `(${cols.map((c) => {
        values.push(r[c] === undefined ? null : r[c]);
        return `$${values.length}`;
      }).join(", ")})`);

      let conflict = "";
      const onConflict = url.searchParams.get("on_conflict");
      if (prefer.includes("resolution=merge-duplicates") && onConflict) {
        const keys = onConflict.split(",").map((k) => ident(k.trim())).join(", ");
        const updates = cols.filter((c) => !onConflict.split(",").includes(c))
          .map((c) => `${ident(c)} = EXCLUDED.${ident(c)}`).join(", ");
        conflict = ` ON CONFLICT (${keys}) DO ${updates ? `UPDATE SET ${updates}` : "NOTHING"}`;
      } else if (prefer.includes("resolution=ignore-duplicates")) {
        conflict = " ON CONFLICT DO NOTHING";
      }

      const sql = `INSERT INTO ${table} (${cols.map(ident).join(", ")}) VALUES ${tuples.join(", ")}${conflict}`
        + (wantsRepresentation || wantsSingle ? ` RETURNING ${q.select}` : "");
      const { rows } = await pool.query(sql, values);
      if (wantsSingle) return send(res, 201, rows[0] ?? null);
      return send(res, 201, wantsRepresentation ? rows : null);
    }

    // ---- UPDATE ---------------------------------------------------------
    if (req.method === "PATCH") {
      const body = (await readBody(req)) ?? {};
      const cols = Object.keys(body);
      if (!cols.length) return send(res, 400, { message: "empty patch" });

      // Filter placeholders were numbered from $1; re-number SET ahead of them.
      const setValues = cols.map((c) => body[c]);
      const setSql = cols.map((c, i) => `${ident(c)} = $${i + 1}`).join(", ");
      const shifted = q.where.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + cols.length}`);

      const sql = `UPDATE ${table} SET ${setSql}${shifted}`
        + (wantsRepresentation || wantsSingle ? ` RETURNING ${q.select}` : "");
      const { rows } = await pool.query(sql, [...setValues, ...q.values]);
      if (wantsSingle) return send(res, 200, rows[0] ?? null);
      return send(res, 200, wantsRepresentation ? rows : null);
    }

    // ---- DELETE ---------------------------------------------------------
    if (req.method === "DELETE") {
      const sql = `DELETE FROM ${table}${q.where}`
        + (wantsRepresentation ? ` RETURNING ${q.select}` : "");
      const { rows } = await pool.query(sql, q.values);
      return send(res, 200, wantsRepresentation ? rows : null);
    }

    return send(res, 405, { message: `unsupported method ${req.method}` });
  } catch (e) {
    // Surface the real Postgres error. Swallowing it here would hide exactly
    // the constraint violations this audit exists to find.
    return send(res, 400, pgError(e));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  process.stderr.write(`[pgrst-shim] listening on http://127.0.0.1:${PORT} -> ${DB}\n`);
  process.stderr.write(`[pgrst-shim] NO RLS, NO AUTH. Evidence from signed-in or RLS-dependent paths is NOT VERIFIED.\n`);
});
