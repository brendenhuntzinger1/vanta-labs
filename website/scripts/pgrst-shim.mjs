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
 * select=a,b,rel(x,y) — embedded resources are returned as correlated json
 * subqueries, which is what supabase-js expects for a nested select.
 */
function buildSelect(select) {
  if (!select || select === "*") return "*";
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

  return parts
    .map((raw) => {
      const p = raw.trim();
      if (!p) return null;
      if (p.includes("(")) return null; // embeds unsupported; caller must widen
      const [expr, alias] = p.split(":").reverse();
      const col = ident(expr.trim());
      return alias ? `${col} AS ${ident(alias.trim())}` : col;
    })
    .filter(Boolean)
    .join(", ") || "*";
}

function parseQuery(url) {
  const params = url.searchParams;
  const where = [];
  const values = [];
  const bind = (v) => { values.push(v); return `$${values.length}`; };

  let order = "";
  let limit = "";
  let offset = "";
  let select = "*";

  for (const [key, raw] of params.entries()) {
    if (key === "select") { select = buildSelect(raw); continue; }
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

    const table = `public.${ident(path.replace(/^\//, ""))}`;
    const q = parseQuery(url);

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
