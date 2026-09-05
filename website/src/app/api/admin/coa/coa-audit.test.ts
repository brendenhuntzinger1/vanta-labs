import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// ADM-11 — EVERY COA WRITE LEAVES AN AUDIT ROW.
//
// Deleting a Certificate of Analysis removes the row AND the file in storage,
// and unpublishing one takes a document a customer was relying on off the
// storefront. Neither left an admin_audit_logs row, unlike product, coupon and
// partner writes — so "who removed this COA?" had no answer. These tests drive
// the REAL route handlers and read back the audit table.
// ---------------------------------------------------------------------------

const state = vi.hoisted(() => ({
  audits: [] as Array<Record<string, unknown>>,
  role: "super_admin",
}));

const coa = vi.hoisted(() => ({
  deleteAdminCoaRecord: vi.fn(),
  updateAdminCoaRecord: vi.fn(),
  replaceAdminCoaFile: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/admin-auth", () => ({
  verifyAdminSessionFromRequest: async () => ({ username: "owner", role: state.role }),
  getRequestIpAddress: () => "203.0.113.9",
  getRequestUserAgent: () => "vitest",
}));
vi.mock("@/lib/admin-coa", () => ({
  ...coa,
  CoaValidationError: class CoaValidationError extends Error {},
}));
vi.mock("@/lib/coa", () => ({ resolveCoaFileUrl: async () => null }));
vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: {
    from: (table: string) => ({
      insert: async (row: Record<string, unknown>) => {
        if (table !== "admin_audit_logs") throw new Error(`unexpected table ${table}`);
        state.audits.push(row);
        return { error: null };
      },
    }),
  },
}));

const RECORD = {
  id: "coa-1",
  productId: "prod-1",
  productDoseId: null,
  batchNumber: "VL-BPC-0826",
  status: "draft",
  fileName: "coa.pdf",
  fileSizeBytes: 1234,
};

beforeEach(() => {
  state.audits = [];
  state.role = "super_admin";
  vi.clearAllMocks();
  coa.updateAdminCoaRecord.mockResolvedValue(RECORD);
  coa.replaceAdminCoaFile.mockResolvedValue(RECORD);
  coa.deleteAdminCoaRecord.mockResolvedValue({
    id: "coa-1", productId: "prod-1", batchNumber: "VL-BPC-0826", status: "published", filePath: "coa/bpc-157/x.pdf",
  });
});

const params = Promise.resolve({ coaId: "coa-1" });

describe("DELETE /api/admin/coa/[coaId]", () => {
  it("writes a coa_delete audit row naming who did it and what was removed", async () => {
    const { DELETE } = await import("./[coaId]/route");
    const res = await DELETE(new Request("http://localhost/api/admin/coa/coa-1", { method: "DELETE" }), { params });

    expect(res.status).toBe(200);
    expect(state.audits).toHaveLength(1);
    expect(state.audits[0]).toMatchObject({
      action: "coa_delete",
      target_table: "coa_records",
      target_id: "coa-1",
    });
    expect(state.audits[0].metadata).toMatchObject({
      performedBy: "owner",
      ipAddress: "203.0.113.9",
      productId: "prod-1",
      batchNumber: "VL-BPC-0826",
      status: "published",
      filePath: "coa/bpc-157/x.pdf",
    });
  });

  it("writes nothing when there was nothing to delete", async () => {
    coa.deleteAdminCoaRecord.mockResolvedValue(null);
    const { DELETE } = await import("./[coaId]/route");
    await DELETE(new Request("http://localhost/api/admin/coa/coa-1", { method: "DELETE" }), { params });

    expect(state.audits).toHaveLength(0);
  });

  it("writes no audit row when the role is refused", async () => {
    state.role = "viewer";
    const { DELETE } = await import("./[coaId]/route");
    const res = await DELETE(new Request("http://localhost/api/admin/coa/coa-1", { method: "DELETE" }), { params });

    expect(res.status).toBe(403);
    expect(coa.deleteAdminCoaRecord).not.toHaveBeenCalled();
    expect(state.audits).toHaveLength(0);
  });
});

describe("PATCH /api/admin/coa/[coaId]", () => {
  it("records a publish/unpublish toggle as coa_status_update", async () => {
    const { PATCH } = await import("./[coaId]/route");
    const res = await PATCH(
      new Request("http://localhost/api/admin/coa/coa-1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "draft" }),
      }),
      { params },
    );

    expect(res.status).toBe(200);
    expect(state.audits).toHaveLength(1);
    expect(state.audits[0]).toMatchObject({ action: "coa_status_update", target_id: "coa-1" });
    expect(state.audits[0].metadata).toMatchObject({ performedBy: "owner", changes: { status: "draft" }, status: "draft" });
  });

  it("records a metadata edit as coa_update", async () => {
    const { PATCH } = await import("./[coaId]/route");
    await PATCH(
      new Request("http://localhost/api/admin/coa/coa-1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ labName: "Janoshik", purity: "99.1" }),
      }),
      { params },
    );

    expect(state.audits[0]).toMatchObject({ action: "coa_update" });
    expect(state.audits[0].metadata).toMatchObject({ changes: { labName: "Janoshik", purity: "99.1" } });
  });

  it("writes no audit row when the update itself failed", async () => {
    coa.updateAdminCoaRecord.mockRejectedValue(new Error("boom"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { PATCH } = await import("./[coaId]/route");
    const res = await PATCH(
      new Request("http://localhost/api/admin/coa/coa-1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "draft" }),
      }),
      { params },
    );

    expect(res.status).toBe(400);
    expect(state.audits).toHaveLength(0);
  });
});

describe("POST /api/admin/coa/[coaId]/file", () => {
  it("records a document swap as coa_file_replace", async () => {
    const { POST } = await import("./[coaId]/file/route");
    const form = new FormData();
    form.set("file", new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "new.pdf", { type: "application/pdf" }));
    const res = await POST(new Request("http://localhost/api/admin/coa/coa-1/file", { method: "POST", body: form }), { params });

    expect(res.status).toBe(200);
    expect(state.audits).toHaveLength(1);
    expect(state.audits[0]).toMatchObject({ action: "coa_file_replace", target_table: "coa_records", target_id: "coa-1" });
    expect(state.audits[0].metadata).toMatchObject({ performedBy: "owner", fileName: "coa.pdf", fileSizeBytes: 1234 });
  });
});
