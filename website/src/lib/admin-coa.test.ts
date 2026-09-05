import { beforeEach, describe, expect, it, vi } from "vitest";

// A COA record and its stored document are two writes that must agree. These
// tests drive the admin functions against a fake Supabase so the pairing can be
// checked directly: a row that survives without its file leaves the library
// advertising a "View COA" that 404s, and a file that survives without its row
// is unreachable weight in a private bucket nobody will ever clean out.

type Row = Record<string, unknown>;

const db: Record<string, Row[]> = { coa_records: [], products: [], product_doses: [], admin_audit_logs: [] };
const objects = new Map<string, number>();
const removedPaths: string[] = [];
const failures = { insert: null as string | null, update: null as string | null, upload: null as string | null };
let idCounter = 0;

// supabase-js hands back JSON-parsed objects, never live references into its
// own state. The fake copies on read so a test can't pass because a "snapshot"
// silently tracked a later write.
function copy(row: Row | undefined): Row | undefined {
  return row ? { ...row } : undefined;
}

function matches(row: Row, filters: Array<[string, unknown]>, inFilter: [string, unknown[]] | null) {
  for (const [column, value] of filters) {
    if (row[column] !== value) return false;
  }
  if (inFilter && !inFilter[1].includes(row[inFilter[0]])) return false;
  return true;
}

function tableClient(name: string) {
  const filters: Array<[string, unknown]> = [];
  let inFilter: [string, unknown[]] | null = null;
  let op: "select" | "insert" | "update" | "delete" = "select";
  let payload: Row | null = null;

  async function run(single: boolean) {
    const rows = db[name] ?? (db[name] = []);

    if (op === "insert") {
      if (failures.insert) return { data: null, error: { message: failures.insert } };
      idCounter += 1;
      const row: Row = { id: `row-${idCounter}`, created_at: "2026-08-01T00:00:00Z", updated_at: "2026-08-01T00:00:00Z", ...payload };
      rows.push(row);
      return { data: single ? row : [row], error: null };
    }

    const hits = rows.filter((row) => matches(row, filters, inFilter));

    if (op === "update") {
      if (failures.update) return { data: null, error: { message: failures.update } };
      for (const row of hits) Object.assign(row, payload, { updated_at: "2026-08-02T00:00:00Z" });
      return { data: single ? (copy(hits[0]) ?? null) : hits.map(copy), error: null };
    }

    if (op === "delete") {
      db[name] = rows.filter((row) => !matches(row, filters, inFilter));
      return { data: null, error: null };
    }

    return { data: single ? (copy(hits[0]) ?? null) : hits.map(copy), error: null };
  }

  const query = {
    select: () => query,
    order: () => query,
    limit: () => query,
    eq: (column: string, value: unknown) => { filters.push([column, value]); return query; },
    in: (column: string, values: unknown[]) => { inFilter = [column, values]; return query; },
    insert: (value: Row) => { op = "insert"; payload = value; return query; },
    update: (value: Row) => { op = "update"; payload = value; return query; },
    delete: () => { op = "delete"; return query; },
    maybeSingle: () => run(true),
    single: () => run(true),
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => run(false).then(resolve, reject),
  };

  return query;
}

vi.mock("@/lib/supabase-server", () => ({
  createServerClient: () => mockClient,
  supabaseAdmin: {
    from: (table: string) => tableClient(table),
    storage: {
      from: () => ({
        upload: async (path: string, body: ArrayBuffer) => {
          if (failures.upload) return { data: null, error: { message: failures.upload } };
          objects.set(path, body.byteLength);
          return { data: { path }, error: null };
        },
        remove: async (paths: string[]) => {
          for (const path of paths) {
            objects.delete(path);
            removedPaths.push(path);
          }
          return { data: null, error: null };
        },
        createSignedUrl: async (path: string) =>
          objects.has(path)
            ? { data: { signedUrl: `https://signed.example/${path}` }, error: null }
            : { data: null, error: { message: "Object not found" } },
      }),
    },
  },
}));

const mockClient = { from: (table: string) => tableClient(table) };

const {
  createAdminCoaRecord,
  deleteAdminCoaRecord,
  replaceAdminCoaFile,
  updateAdminCoaRecord,
  CoaValidationError,
} = await import("@/lib/admin-coa");
const { resolveCoaFileUrl } = await import("@/lib/coa");

function pdfBytes(): ArrayBuffer {
  return new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3]).buffer;
}

function upload(fileName = "coa.pdf") {
  return { fileName, bytes: pdfBytes(), declaredType: "application/pdf" };
}

const BASE_INPUT = {
  productId: "prod-1",
  batchNumber: "VL-BPC-0826",
  labName: "Janoshik",
  testDate: "2026-08-04",
  purity: "99.2",
  status: "published" as const,
};

beforeEach(() => {
  db.coa_records = [];
  db.products = [{ id: "prod-1", name: "BPC-157", slug: "bpc-157", is_archived: false, is_published: true, is_active: true, is_enabled: true }];
  db.product_doses = [];
  db.admin_audit_logs = [];
  objects.clear();
  removedPaths.length = 0;
  failures.insert = null;
  failures.update = null;
  failures.upload = null;
  idCounter = 0;
});

describe("createAdminCoaRecord", () => {
  it("stores the document and the row together", async () => {
    const record = await createAdminCoaRecord({ ...BASE_INPUT, upload: upload() });

    expect(record.batchNumber).toBe("VL-BPC-0826");
    expect(record.status).toBe("published");
    expect(record.hasFile).toBe(true);
    expect(objects.size).toBe(1);
    // Readable key so the bucket stays navigable by hand.
    expect([...objects.keys()][0]).toMatch(/^bpc-157\/vl-bpc-0826\/[a-z0-9-]+\.pdf$/);
  });

  // The row is what makes the object findable. If the insert fails and the
  // upload stays, the bucket accumulates files nothing references and no
  // interface can reach.
  it("removes the uploaded file when the row cannot be written", async () => {
    failures.insert = "insert exploded";

    await expect(createAdminCoaRecord({ ...BASE_INPUT, upload: upload() })).rejects.toThrow();

    expect(objects.size).toBe(0);
    expect(removedPaths).toHaveLength(1);
    expect(db.coa_records).toHaveLength(0);
  });

  it("refuses a record with neither a file nor a link", async () => {
    await expect(createAdminCoaRecord({ ...BASE_INPUT })).rejects.toBeInstanceOf(CoaValidationError);
    expect(db.coa_records).toHaveLength(0);
  });

  it("refuses a batch number that is only whitespace", async () => {
    await expect(createAdminCoaRecord({ ...BASE_INPUT, batchNumber: "   ", upload: upload() }))
      .rejects.toBeInstanceOf(CoaValidationError);
    // Rejected before anything was uploaded, so nothing to clean up.
    expect(objects.size).toBe(0);
  });

  // The declared Content-Type on a multipart upload is caller-controlled.
  it("refuses content whose bytes are not a document, whatever it claims to be", async () => {
    const html = new TextEncoder().encode("<html><script>alert(1)</script></html>");
    await expect(
      createAdminCoaRecord({ ...BASE_INPUT, upload: { fileName: "coa.pdf", bytes: html.buffer, declaredType: "application/pdf" } }),
    ).rejects.toBeInstanceOf(CoaValidationError);
    expect(objects.size).toBe(0);
  });

  it("refuses a link that isn't an http(s) URL", async () => {
    await expect(createAdminCoaRecord({ ...BASE_INPUT, externalUrl: "javascript:alert(1)" }))
      .rejects.toBeInstanceOf(CoaValidationError);
    await expect(createAdminCoaRecord({ ...BASE_INPUT, externalUrl: "coa.pdf" }))
      .rejects.toBeInstanceOf(CoaValidationError);
  });

  it("accepts a link-only record for a COA hosted elsewhere", async () => {
    const record = await createAdminCoaRecord({ ...BASE_INPUT, externalUrl: "https://cdn.example.com/coa.pdf" });
    expect(record.hasFile).toBe(true);
    expect(record.fileKind).toBe("link");
    expect(objects.size).toBe(0);
  });

  it("refuses a product that does not exist", async () => {
    await expect(createAdminCoaRecord({ ...BASE_INPUT, productId: "ghost", upload: upload() }))
      .rejects.toBeInstanceOf(CoaValidationError);
    expect(objects.size).toBe(0);
  });
});

describe("updateAdminCoaRecord", () => {
  it("edits metadata without disturbing the stored document", async () => {
    const created = await createAdminCoaRecord({ ...BASE_INPUT, upload: upload() });
    const path = [...objects.keys()][0];

    const updated = await updateAdminCoaRecord(created.id, { labName: "Colmaric", purity: "99.4" });

    expect(updated.labName).toBe("Colmaric");
    expect(updated.purity).toBe("99.4");
    // Untouched fields survive a partial patch.
    expect(updated.batchNumber).toBe("VL-BPC-0826");
    expect(updated.testDate).toBe("2026-08-04");
    expect(objects.has(path)).toBe(true);
  });

  // The library's entire promise is that "View COA" opens something.
  it("refuses to publish a record with no document", async () => {
    const created = await createAdminCoaRecord({ ...BASE_INPUT, status: "draft", externalUrl: "https://cdn.example.com/coa.pdf" });
    await updateAdminCoaRecord(created.id, { externalUrl: "" });

    await expect(updateAdminCoaRecord(created.id, { status: "published" }))
      .rejects.toBeInstanceOf(CoaValidationError);
  });

  it("unpublishes without deleting anything", async () => {
    const created = await createAdminCoaRecord({ ...BASE_INPUT, upload: upload() });

    const unpublished = await updateAdminCoaRecord(created.id, { status: "draft" });
    expect(unpublished.status).toBe("draft");
    expect(objects.size).toBe(1);

    const republished = await updateAdminCoaRecord(created.id, { status: "published" });
    expect(republished.status).toBe("published");
  });
});

describe("replaceAdminCoaFile", () => {
  it("swaps the document and clears the one it replaced", async () => {
    const created = await createAdminCoaRecord({ ...BASE_INPUT, upload: upload("first.pdf") });
    const originalPath = [...objects.keys()][0];

    const updated = await replaceAdminCoaFile(created.id, upload("second.pdf"));

    expect(updated.fileName).toBe("second.pdf");
    expect(objects.has(originalPath)).toBe(false);
    expect(removedPaths).toContain(originalPath);
    expect(objects.size).toBe(1);
  });

  // Order matters: the old file is only dropped once the row points at the new
  // one. Reversed, a failed update would leave a published record pointing at a
  // document that no longer exists.
  it("keeps the existing document when the row update fails", async () => {
    const created = await createAdminCoaRecord({ ...BASE_INPUT, upload: upload("first.pdf") });
    const originalPath = [...objects.keys()][0];
    failures.update = "update exploded";

    await expect(replaceAdminCoaFile(created.id, upload("second.pdf"))).rejects.toThrow();

    expect(objects.has(originalPath)).toBe(true);
    expect(objects.size).toBe(1);
    expect(removedPaths).not.toContain(originalPath);
  });
});

describe("deleteAdminCoaRecord", () => {
  it("removes the row and its stored document", async () => {
    const created = await createAdminCoaRecord({ ...BASE_INPUT, upload: upload() });
    const path = [...objects.keys()][0];

    await deleteAdminCoaRecord(created.id);

    expect(db.coa_records).toHaveLength(0);
    expect(objects.has(path)).toBe(false);
    expect(removedPaths).toContain(path);
  });

  it("is a no-op for an id that is already gone", async () => {
    await expect(deleteAdminCoaRecord("row-999")).resolves.toBeNull();
    expect(removedPaths).toHaveLength(0);
  });

  // ADM-11: the route audits what was removed, so the delete must answer it.
  it("answers what it deleted, for the audit row", async () => {
    const created = await createAdminCoaRecord({ ...BASE_INPUT, upload: upload() });
    const path = [...objects.keys()][0];

    const deleted = await deleteAdminCoaRecord(created.id);

    expect(deleted).toEqual({
      id: created.id,
      productId: "prod-1",
      batchNumber: "VL-BPC-0826",
      status: "published",
      filePath: path,
    });
  });
});

// ---------------------------------------------------------------------------
// COA-2: the two failures that surfaced as a generic "Unable to save this COA."
// An impossible test date failed at the Postgres date column; a dose id that is
// not the product's failed at the foreign key. Both are the operator's to fix
// and are now refused up front, by name, as CoaValidationError (-> HTTP 400 with
// the message) rather than reaching the database at all.
// ---------------------------------------------------------------------------
describe("COA-2: specific reasons instead of a generic failure", () => {
  it("refuses an impossible test date with a message naming the field, and writes nothing", async () => {
    await expect(createAdminCoaRecord({ ...BASE_INPUT, testDate: "2026-13-45", upload: upload() }))
      .rejects.toThrow(/test date.*YYYY-MM-DD/i);
    await expect(createAdminCoaRecord({ ...BASE_INPUT, testDate: "2026-13-45", upload: upload() }))
      .rejects.toBeInstanceOf(CoaValidationError);
    expect(db.coa_records).toHaveLength(0);
    expect(objects.size).toBe(0);
  });

  it("still treats a blank test date as 'no date'", async () => {
    const record = await createAdminCoaRecord({ ...BASE_INPUT, testDate: "", upload: upload() });
    expect(record.testDate).toBeNull();
  });

  it("refuses a dose id that belongs to a different product, by name", async () => {
    db.products.push({ id: "prod-2", name: "GHK-Cu", slug: "ghk-cu", is_archived: false, is_published: true });
    db.product_doses = [
      { id: "dose-1", product_id: "prod-1", label: "5mg", position: 1 },
      { id: "dose-9", product_id: "prod-2", label: "50mg", position: 1 },
    ];

    await expect(createAdminCoaRecord({ ...BASE_INPUT, productDoseId: "dose-9", upload: upload() }))
      .rejects.toThrow(/belongs to a different product/i);
    await expect(createAdminCoaRecord({ ...BASE_INPUT, productDoseId: "dose-9", upload: upload() }))
      .rejects.toBeInstanceOf(CoaValidationError);
    expect(db.coa_records).toHaveLength(0);
  });

  it("refuses a dose id that does not exist at all, by name", async () => {
    await expect(createAdminCoaRecord({ ...BASE_INPUT, productDoseId: "dose-ghost", upload: upload() }))
      .rejects.toThrow(/dose no longer exists/i);
  });

  it("accepts the product's own dose", async () => {
    db.product_doses = [{ id: "dose-1", product_id: "prod-1", label: "5mg", position: 1 }];
    const record = await createAdminCoaRecord({ ...BASE_INPUT, productDoseId: "dose-1", upload: upload() });
    expect(record.productDoseId).toBe("dose-1");
  });

  it("checks the dose on update too, against the product the record ends up on", async () => {
    db.products.push({ id: "prod-2", name: "GHK-Cu", slug: "ghk-cu", is_archived: false, is_published: true });
    db.product_doses = [
      { id: "dose-1", product_id: "prod-1", label: "5mg", position: 1 },
      { id: "dose-9", product_id: "prod-2", label: "50mg", position: 1 },
    ];
    const created = await createAdminCoaRecord({ ...BASE_INPUT, productDoseId: "dose-1", upload: upload() });

    await expect(updateAdminCoaRecord(created.id, { productDoseId: "dose-9" }))
      .rejects.toThrow(/belongs to a different product/i);
    // Moving the record to prod-2 WITH its dose is fine.
    const moved = await updateAdminCoaRecord(created.id, { productId: "prod-2", productDoseId: "dose-9" });
    expect(moved.productDoseId).toBe("dose-9");
  });
});

describe("resolveCoaFileUrl", () => {
  it("signs a published document on a live product", async () => {
    const created = await createAdminCoaRecord({ ...BASE_INPUT, upload: upload() });

    const resolved = await resolveCoaFileUrl({ coaId: created.id, requirePublished: true });
    expect(resolved?.url).toMatch(/^https:\/\/signed\.example\//);
    expect(resolved?.isExternal).toBe(false);
  });

  // Unpublishing has to cut off links that were already shared, not just hide
  // the card on the library page.
  it("refuses a draft to the public, while admin preview still resolves it", async () => {
    const created = await createAdminCoaRecord({ ...BASE_INPUT, status: "draft", upload: upload() });

    expect(await resolveCoaFileUrl({ coaId: created.id, requirePublished: true })).toBeNull();
    expect(await resolveCoaFileUrl({ coaId: created.id, requirePublished: false })).not.toBeNull();
  });

  // Delisting a product must take its documentation down with it.
  it("refuses a published COA whose product is no longer live", async () => {
    const created = await createAdminCoaRecord({ ...BASE_INPUT, upload: upload() });
    db.products[0].is_published = false;

    expect(await resolveCoaFileUrl({ coaId: created.id, requirePublished: true })).toBeNull();
  });

  it("returns null when the stored object has gone missing", async () => {
    const created = await createAdminCoaRecord({ ...BASE_INPUT, upload: upload() });
    objects.clear();

    expect(await resolveCoaFileUrl({ coaId: created.id, requirePublished: true })).toBeNull();
  });

  it("returns null for an unknown id rather than throwing", async () => {
    expect(await resolveCoaFileUrl({ coaId: "nope", requirePublished: true })).toBeNull();
    expect(await resolveCoaFileUrl({ coaId: "", requirePublished: true })).toBeNull();
  });
});
