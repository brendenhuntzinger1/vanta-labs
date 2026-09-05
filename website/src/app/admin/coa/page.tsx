"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { COA_MAX_FILE_BYTES, formatCoaFileSize, formatCoaTestDate } from "@/lib/coa-format";
import { isCoaProductHidden } from "@/lib/coa-hidden";
import type { AdminCoaRecord, CoaProductOption, CoaStatus } from "@/lib/coa-types";

type StatusFilter = CoaStatus | "all";

type LoadResponse = {
  success: boolean;
  records?: AdminCoaRecord[];
  products?: CoaProductOption[];
  settings?: { showPendingProducts: boolean; hiddenProductSlugs?: string[] };
  error?: string;
};

// A COA scan off a phone is routinely 8–12 MB, and Vercel rejects a request
// body over ~4.5 MB before the route ever runs — the upload would fail with no
// usable error. Images are downscaled in the browser first; a PDF can't be, so
// an oversized one is reported before it is sent.
const MAX_UPLOAD_EDGE_PX = 2200;

async function prepareCoaFile(file: File): Promise<{ file: File } | { error: string }> {
  if (file.size <= COA_MAX_FILE_BYTES) {
    return { file };
  }

  if (file.type === "application/pdf") {
    return {
      error: `${file.name} is ${formatCoaFileSize(file.size)}. PDFs must be ${formatCoaFileSize(COA_MAX_FILE_BYTES)} or smaller — compress it and try again.`,
    };
  }

  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_UPLOAD_EDGE_PX / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return { file };
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    // 0.9, not the 0.85 used for product photography: this is a document, and
    // JPEG artefacts land on the small print that makes it worth reading.
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
    if (!blob) return { file };
    if (blob.size > COA_MAX_FILE_BYTES) {
      return { error: `${file.name} is still too large after resizing. Please compress it below ${formatCoaFileSize(COA_MAX_FILE_BYTES)}.` };
    }
    const baseName = file.name.replace(/\.[^.]+$/, "") || "coa";
    return { file: new File([blob], `${baseName}.jpg`, { type: "image/jpeg" }) };
  } catch {
    return { error: `${file.name} couldn't be read by the browser. Save it as a PDF, PNG, or JPG and try again.` };
  }
}

type DraftRow = {
  key: string;
  file: File | null;
  productId: string;
  productDoseId: string;
  strength: string;
  batchNumber: string;
  lotNumber: string;
  labName: string;
  testDate: string;
  purity: string;
  identityResult: string;
  externalUrl: string;
  status: CoaStatus;
  state: "idle" | "saving" | "saved" | "error";
  error: string | null;
};

let draftCounter = 0;
function emptyDraft(file: File | null = null): DraftRow {
  draftCounter += 1;
  return {
    key: `draft-${draftCounter}`,
    file,
    productId: "",
    productDoseId: "",
    strength: "",
    batchNumber: "",
    lotNumber: "",
    labName: "",
    testDate: "",
    purity: "",
    identityResult: "",
    externalUrl: "",
    status: "published",
    state: "idle",
    error: null,
  };
}

const ACCEPTED = ".pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/png,image/jpeg,image/webp";

function StatusPill({ status }: { status: CoaStatus }) {
  const classes: Record<CoaStatus, string> = {
    published: "border-emerald-500/30 bg-emerald-500/15 text-emerald-300",
    draft: "border-blue-500/30 bg-blue-500/15 text-blue-300",
    archived: "border-zinc-700 bg-zinc-800 text-zinc-300",
  };
  return (
    <span className={`inline-flex rounded-md border px-2 py-0.5 text-[11px] font-semibold capitalize ${classes[status]}`}>
      {status}
    </span>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <span className="mb-1 block text-[11px] uppercase tracking-[0.16em] text-zinc-500">{children}</span>;
}

export default function AdminCoaPage() {
  const [records, setRecords] = useState<AdminCoaRecord[]>([]);
  const [products, setProducts] = useState<CoaProductOption[]>([]);
  const [showPending, setShowPending] = useState(true);
  const [hiddenSlugs, setHiddenSlugs] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [productFilter, setProductFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  const [drafts, setDrafts] = useState<DraftRow[] | null>(null);
  const [editing, setEditing] = useState<AdminCoaRecord | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<AdminCoaRecord | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const flash = useCallback((text: string) => {
    setMessage(text);
    window.setTimeout(() => setMessage((current) => (current === text ? null : current)), 4000);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set("search", search.trim());
      if (productFilter) params.set("productId", productFilter);
      if (statusFilter !== "all") params.set("status", statusFilter);

      const res = await fetch(`/api/admin/coa?${params.toString()}`, { cache: "no-store" });
      const json = (await res.json()) as LoadResponse;
      if (!res.ok || !json.success) {
        flash(json.error ?? "Unable to load COAs.");
        return;
      }
      setRecords(json.records ?? []);
      setProducts(json.products ?? []);
      setShowPending(json.settings?.showPendingProducts !== false);
      setHiddenSlugs(json.settings?.hiddenProductSlugs ?? []);
    } catch {
      flash("Unable to reach the server.");
    } finally {
      setLoading(false);
    }
  }, [flash, productFilter, search, statusFilter]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 200);
    return () => window.clearTimeout(timer);
  }, [load]);

  const productsById = useMemo(() => new Map(products.map((product) => [product.id, product])), [products]);

  const addFiles = useCallback(async (files: FileList | File[]) => {
    const incoming = Array.from(files);
    if (incoming.length === 0) return;

    const prepared: DraftRow[] = [];
    const errors: string[] = [];
    for (const file of incoming) {
      const result = await prepareCoaFile(file);
      if ("error" in result) {
        errors.push(result.error);
        continue;
      }
      prepared.push(emptyDraft(result.file));
    }

    if (errors.length > 0) flash(errors[0]);
    if (prepared.length === 0) return;

    setDrafts((current) => [...(current ?? []), ...prepared]);
  }, [flash]);

  const updateDraft = useCallback((key: string, patch: Partial<DraftRow>) => {
    setDrafts((current) =>
      (current ?? []).map((draft) => (draft.key === key ? { ...draft, ...patch } : draft)),
    );
  }, []);

  // "Add by dose": one row per strength of the chosen product, each already
  // knowing which dose it is for. What is left for the operator is a picture
  // and a batch number per row — the two things only they know.
  const addDraftsForProduct = useCallback(
    (productId: string) => {
      const product = productsById.get(productId);
      if (!product) return;
      const rows =
        product.strengths.length > 0
          ? product.strengths.map((dose) => ({ ...emptyDraft(), productId, productDoseId: dose.id, strength: dose.label }))
          : [{ ...emptyDraft(), productId }];
      setDrafts((current) => [...(current ?? []), ...rows]);
    },
    [productsById],
  );

  // A picture chosen for a row that already exists — the by-dose flow, or a
  // link-only draft the operator has since photographed. Same downscale as a
  // drop, so a phone photo never trips the request-size limit.
  const attachDraftFile = useCallback(
    async (key: string, file: File) => {
      const result = await prepareCoaFile(file);
      if ("error" in result) {
        flash(result.error);
        return;
      }
      updateDraft(key, { file: result.file });
    },
    [flash, updateDraft],
  );

  const saveDrafts = useCallback(async () => {
    const queue = drafts ?? [];
    const pending = queue.filter((draft) => draft.state !== "saved");
    if (pending.length === 0) return;

    let savedCount = 0;

    for (const draft of pending) {
      setDrafts((current) => (current ?? []).map((row) => (row.key === draft.key ? { ...row, state: "saving", error: null } : row)));

      const form = new FormData();
      if (draft.file) form.set("file", draft.file);
      form.set("productId", draft.productId);
      form.set("productDoseId", draft.productDoseId);
      form.set("strength", draft.strength);
      form.set("batchNumber", draft.batchNumber);
      form.set("lotNumber", draft.lotNumber);
      form.set("labName", draft.labName);
      form.set("testDate", draft.testDate);
      form.set("purity", draft.purity);
      form.set("identityResult", draft.identityResult);
      form.set("externalUrl", draft.externalUrl);
      form.set("status", draft.status);

      try {
        const res = await fetch("/api/admin/coa", { method: "POST", body: form });
        const json = (await res.json()) as { success: boolean; error?: string };
        if (!res.ok || !json.success) {
          setDrafts((current) =>
            (current ?? []).map((row) =>
              row.key === draft.key ? { ...row, state: "error", error: json.error ?? "Save failed." } : row,
            ),
          );
          continue;
        }
        savedCount += 1;
        setDrafts((current) => (current ?? []).map((row) => (row.key === draft.key ? { ...row, state: "saved", error: null } : row)));
      } catch {
        setDrafts((current) =>
          (current ?? []).map((row) => (row.key === draft.key ? { ...row, state: "error", error: "Network error." } : row)),
        );
      }
    }

    await load();

    // Only the rows that failed stay on screen, with their message — closing
    // the whole panel on a partial failure would silently discard the entries
    // the operator still needs to fix.
    setDrafts((current) => {
      const remaining = (current ?? []).filter((row) => row.state !== "saved");
      return remaining.length > 0 ? remaining : null;
    });

    if (savedCount > 0) {
      flash(savedCount === 1 ? "COA saved." : `${savedCount} COAs saved.`);
    }
  }, [drafts, flash, load]);

  const patchRecord = useCallback(
    async (record: AdminCoaRecord, patch: Record<string, unknown>, successText: string) => {
      setBusyId(record.id);
      try {
        const res = await fetch(`/api/admin/coa/${record.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        const json = (await res.json()) as { success: boolean; error?: string };
        if (!res.ok || !json.success) {
          flash(json.error ?? "Update failed.");
          return false;
        }
        flash(successText);
        await load();
        return true;
      } catch {
        flash("Unable to reach the server.");
        return false;
      } finally {
        setBusyId(null);
      }
    },
    [flash, load],
  );

  const replaceFile = useCallback(
    async (record: AdminCoaRecord, file: File) => {
      const prepared = await prepareCoaFile(file);
      if ("error" in prepared) {
        flash(prepared.error);
        return;
      }
      setBusyId(record.id);
      try {
        const form = new FormData();
        form.set("file", prepared.file);
        const res = await fetch(`/api/admin/coa/${record.id}/file`, { method: "POST", body: form });
        const json = (await res.json()) as { success: boolean; error?: string };
        if (!res.ok || !json.success) {
          flash(json.error ?? "Replace failed.");
          return;
        }
        flash("COA file replaced.");
        await load();
      } catch {
        flash("Unable to reach the server.");
      } finally {
        setBusyId(null);
      }
    },
    [flash, load],
  );

  const deleteRecord = useCallback(async () => {
    const record = confirmDelete;
    if (!record) return;
    setBusyId(record.id);
    try {
      const res = await fetch(`/api/admin/coa/${record.id}`, { method: "DELETE" });
      const json = (await res.json()) as { success: boolean; error?: string };
      if (!res.ok || !json.success) {
        flash(json.error ?? "Delete failed.");
        return;
      }
      flash("COA deleted.");
      setConfirmDelete(null);
      await load();
    } catch {
      flash("Unable to reach the server.");
    } finally {
      setBusyId(null);
    }
  }, [confirmDelete, flash, load]);

  const savePendingSetting = useCallback(
    async (next: boolean) => {
      setShowPending(next);
      try {
        const res = await fetch("/api/admin/coa/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ showPendingProducts: next }),
        });
        const json = (await res.json()) as { success: boolean; error?: string };
        if (!res.ok || !json.success) {
          setShowPending(!next);
          flash(json.error ?? "Unable to save that setting.");
          return;
        }
        flash(next ? "Undocumented products now show as Documentation Pending." : "Undocumented products are now hidden from the public library.");
      } catch {
        setShowPending(!next);
        flash("Unable to reach the server.");
      }
    },
    [flash],
  );

  /**
   * Keep-or-drop one product from the public library. The server holds the
   * whole list, so the whole list is what gets sent — a slug the owner cannot
   * see here (an archived product, say) rides along untouched rather than
   * being dropped because this screen never rendered a box for it.
   */
  const saveHiddenSlugs = useCallback(
    async (slug: string, hidden: boolean) => {
      const previous = hiddenSlugs;
      const next = hidden
        ? Array.from(new Set([...previous, slug]))
        : previous.filter((candidate) => candidate !== slug);
      setHiddenSlugs(next);
      try {
        const res = await fetch("/api/admin/coa/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hiddenProductSlugs: next }),
        });
        const json = (await res.json()) as { success: boolean; error?: string; settings?: { hiddenProductSlugs?: string[] } };
        if (!res.ok || !json.success) {
          setHiddenSlugs(previous);
          flash(json.error ?? "Unable to save that setting.");
          return;
        }
        setHiddenSlugs(json.settings?.hiddenProductSlugs ?? next);
        flash(hidden ? "Removed from the public COA library." : "Back on the public COA library.");
      } catch {
        setHiddenSlugs(previous);
        flash("Unable to reach the server.");
      }
    },
    [flash, hiddenSlugs],
  );

  const publishedCount = records.filter((record) => record.status === "published").length;
  const hiddenProductCount = products.filter((product) => isCoaProductHidden(product, hiddenSlugs)).length;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="border-b border-zinc-800 bg-zinc-950/90">
        <div className="mx-auto max-w-7xl px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.3em] text-zinc-500">Admin</p>
              <h1 className="text-2xl font-semibold text-white">COA Library</h1>
              <p className="mt-1 text-sm text-zinc-400">
                {records.length} shown · {publishedCount} published
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Link href="/coa-library" className="rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:text-white">
                View public library
              </Link>
              <button
                type="button"
                onClick={() => setDrafts([emptyDraft()])}
                className="rounded-lg border border-cyan-300/50 px-4 py-2 text-sm font-semibold text-cyan-200 hover:border-cyan-200"
              >
                + Add COA
              </button>
              <button
                type="button"
                onClick={() => setDrafts([])}
                className="rounded-lg bg-cyan-300 px-4 py-2 text-sm font-semibold text-zinc-950 hover:bg-cyan-200"
              >
                + Add by dose
              </button>
            </div>
          </div>

          {message ? <p className="mt-3 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200">{message}</p> : null}

          <div className="mt-4 grid gap-3 md:grid-cols-[1fr_auto_auto_auto]">
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search product, batch, lot, or lab"
              className="vl-input px-3 py-2"
            />
            <select value={productFilter} onChange={(event) => setProductFilter(event.target.value)} className="vl-input px-3 py-2">
              <option value="">All products</option>
              {products.map((product) => (
                <option key={product.id} value={product.id}>{product.name}</option>
              ))}
            </select>
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as StatusFilter)} className="vl-input px-3 py-2">
              <option value="all">All statuses</option>
              <option value="published">Published</option>
              <option value="draft">Draft</option>
              <option value="archived">Archived</option>
            </select>
            <button type="button" onClick={() => void load()} className="rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-200 hover:border-zinc-500">
              Refresh
            </button>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-7xl space-y-5 px-4 py-6 sm:px-6 lg:px-8">
        {/* Drop anywhere. The whole point of this screen is that a folder of
            scans becomes a published library without anyone opening an editor. */}
        <div
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            void addFiles(event.dataTransfer.files);
          }}
          className="rounded-2xl border border-dashed border-zinc-700 bg-zinc-900/40 p-6 text-center"
        >
          <p className="text-sm text-zinc-300">
            Drag COA files here — PDF, PNG, JPG, or WEBP. Drop several at once to fill in a batch of them together.
          </p>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="mt-3 rounded-lg border border-zinc-600 px-4 py-2 text-sm text-zinc-200 hover:border-zinc-400"
          >
            Choose files
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED}
            multiple
            className="hidden"
            onChange={(event) => {
              if (event.target.files) void addFiles(event.target.files);
              event.target.value = "";
            }}
          />
        </div>

        <div className="vl-panel rounded-2xl p-4">
          <label className="flex items-start gap-3 text-sm text-zinc-300">
            <input
              type="checkbox"
              checked={showPending}
              onChange={(event) => void savePendingSetting(event.target.checked)}
              className="mt-0.5 h-4 w-4"
            />
            <span>
              Show products without a published COA on the public library, marked{" "}
              <strong className="text-white">Documentation Pending</strong>.
              <span className="mt-1 block text-xs text-zinc-500">
                Turn this off to list only products that have documentation. Either way the page stays complete —
                this is which story it tells while the archive fills up.
              </span>
            </span>
          </label>
        </div>

        {/* Per-product removal. Independent of the switch above: a hidden
            product is gone from the library whether or not it has a COA, so a
            product that was never sent for testing does not sit there as a
            "pending" promise. */}
        <details className="vl-panel rounded-2xl p-4" open={hiddenProductCount > 0}>
          <summary className="cursor-pointer text-sm text-zinc-300">
            <span className="font-medium text-white">Hide products from the public COA library</span>
            <span className="ml-2 whitespace-nowrap text-xs text-zinc-500">
              {hiddenProductCount === 0
                ? "Nothing hidden"
                : `${hiddenProductCount} hidden`}
            </span>
            <span className="mt-1 block text-xs text-zinc-500">
              Tick a product to take it off the library entirely — no card, no &ldquo;pending&rdquo; note, not
              counted. For products you sell but did not send for testing. Its product page is unaffected.
            </span>
          </summary>
          <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3" data-testid="coa-hidden-products">
            {products.map((product) => {
              const hidden = isCoaProductHidden(product, hiddenSlugs);
              return (
                <label
                  key={product.id}
                  className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${
                    hidden ? "border-amber-500/40 bg-amber-500/5 text-amber-100" : "border-zinc-800 text-zinc-300"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={hidden}
                    onChange={(event) => void saveHiddenSlugs(product.slug, event.target.checked)}
                    className="mt-0.5 h-4 w-4"
                    aria-label={`Hide ${product.name} from the public COA library`}
                  />
                  <span className="min-w-0">
                    <span className="block truncate">{product.name}</span>
                    <span className="block truncate text-xs text-zinc-500">
                      /{product.slug}
                      {!product.isPublished ? " · unpublished" : ""}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        </details>

        <div className="vl-panel overflow-hidden rounded-2xl">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px] text-left text-sm">
              <thead className="border-b border-zinc-800 text-[11px] uppercase tracking-[0.14em] text-zinc-500">
                <tr>
                  <th className="px-4 py-3 font-medium">Product</th>
                  <th className="px-4 py-3 font-medium">Strength</th>
                  <th className="px-4 py-3 font-medium">Batch</th>
                  <th className="px-4 py-3 font-medium">Lab</th>
                  <th className="px-4 py-3 font-medium">Test date</th>
                  <th className="px-4 py-3 font-medium">Purity</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">File</th>
                  <th className="px-4 py-3 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/80">
                {loading && records.length === 0 ? (
                  <tr><td colSpan={9} className="px-4 py-10 text-center text-zinc-400">Loading COA records…</td></tr>
                ) : null}

                {!loading && records.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="px-4 py-12 text-center">
                      <p className="text-zinc-300">No COAs yet.</p>
                      <p className="mt-1 text-sm text-zinc-500">
                        Drop a file above, pick the product and batch, and hit Save — it appears on the site immediately.
                      </p>
                    </td>
                  </tr>
                ) : null}

                {records.map((record) => (
                  <tr key={record.id} className={busyId === record.id ? "opacity-50" : undefined}>
                    <td className="px-4 py-3">
                      <div className="font-medium text-white">{record.productName}</div>
                      {record.productSlug ? <div className="text-xs text-zinc-500">/{record.productSlug}</div> : null}
                      {isCoaProductHidden(record.productSlug, hiddenSlugs) ? (
                        <span className="mt-1 inline-block rounded-full border border-amber-500/40 px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] text-amber-300">
                          Hidden from library
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-zinc-300">{record.strength ?? "—"}</td>
                    <td className="px-4 py-3">
                      <div className="font-mono text-xs text-zinc-200">{record.batchNumber}</div>
                      {record.lotNumber ? <div className="font-mono text-[11px] text-zinc-500">Lot {record.lotNumber}</div> : null}
                    </td>
                    <td className="px-4 py-3 text-zinc-300">{record.labName ?? "—"}</td>
                    <td className="px-4 py-3 text-zinc-300">{formatCoaTestDate(record.testDate) ?? "—"}</td>
                    <td className="px-4 py-3 text-zinc-300">{record.purity ?? "—"}</td>
                    <td className="px-4 py-3"><StatusPill status={record.status} /></td>
                    <td className="px-4 py-3">
                      {record.hasFile ? (
                        <div className="text-xs text-zinc-400">
                          <span className="uppercase">{record.fileKind}</span>
                          {record.fileSizeBytes ? <span className="ml-1 text-zinc-600">{formatCoaFileSize(record.fileSizeBytes)}</span> : null}
                        </div>
                      ) : (
                        <span className="text-xs text-amber-400">No document</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap items-center justify-end gap-1.5">
                        {record.hasFile ? (
                          <a
                            href={record.externalUrl && record.fileKind === "link" ? record.externalUrl : `/api/admin/coa/${record.id}/file`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-200 hover:border-zinc-500"
                          >
                            View
                          </a>
                        ) : null}
                        <button type="button" onClick={() => setEditing(record)} className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-200 hover:border-zinc-500">
                          Edit
                        </button>
                        <label className="cursor-pointer rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-200 hover:border-zinc-500">
                          Replace file
                          <input
                            type="file"
                            accept={ACCEPTED}
                            className="hidden"
                            onChange={(event) => {
                              const file = event.target.files?.[0];
                              event.target.value = "";
                              if (file) void replaceFile(record, file);
                            }}
                          />
                        </label>
                        {record.status === "published" ? (
                          <button
                            type="button"
                            onClick={() => void patchRecord(record, { status: "draft" }, "COA unpublished.")}
                            className="rounded-md border border-blue-500/40 px-2.5 py-1 text-xs text-blue-300 hover:border-blue-400"
                          >
                            Unpublish
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => void patchRecord(record, { status: "published" }, "COA published.")}
                            className="rounded-md border border-emerald-500/40 px-2.5 py-1 text-xs text-emerald-300 hover:border-emerald-400"
                          >
                            Publish
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => setConfirmDelete(record)}
                          className="rounded-md border border-rose-500/40 px-2.5 py-1 text-xs text-rose-300 hover:border-rose-400"
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {drafts ? (
        <DraftPanel
          drafts={drafts}
          products={products}
          productsById={productsById}
          onAddFiles={addFiles}
          onUpdate={updateDraft}
          onAddProduct={addDraftsForProduct}
          onAttachFile={(key, file) => void attachDraftFile(key, file)}
          onRemove={(key) =>
            setDrafts((current) => {
              const remaining = (current ?? []).filter((row) => row.key !== key);
              return remaining.length > 0 ? remaining : null;
            })
          }
          onApplyToAll={(patch) => setDrafts((current) => (current ?? []).map((row) => ({ ...row, ...patch })))}
          onClose={() => setDrafts(null)}
          onSave={saveDrafts}
        />
      ) : null}

      {editing ? (
        <EditPanel
          record={editing}
          products={products}
          onClose={() => setEditing(null)}
          onSave={async (patch) => {
            const ok = await patchRecord(editing, patch, "COA updated.");
            if (ok) setEditing(null);
          }}
        />
      ) : null}

      {confirmDelete ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-950 p-6">
            <h2 className="text-lg font-semibold text-white">Delete this COA?</h2>
            <p className="mt-2 text-sm text-zinc-400">
              {confirmDelete.productName} · batch {confirmDelete.batchNumber}. The record and its stored
              document are removed permanently, and it disappears from the public library. This cannot be undone.
            </p>
            <div className="mt-6 flex justify-end gap-2">
              <button type="button" onClick={() => setConfirmDelete(null)} className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-200">
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void deleteRecord()}
                disabled={busyId === confirmDelete.id}
                className="rounded-lg bg-rose-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
              >
                {busyId === confirmDelete.id ? "Deleting…" : "Delete COA"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function DraftPanel({
  drafts,
  products,
  productsById,
  onAddFiles,
  onUpdate,
  onAddProduct,
  onAttachFile,
  onRemove,
  onApplyToAll,
  onClose,
  onSave,
}: {
  drafts: DraftRow[];
  products: CoaProductOption[];
  productsById: Map<string, CoaProductOption>;
  onAddFiles: (files: FileList | File[]) => void;
  onUpdate: (key: string, patch: Partial<DraftRow>) => void;
  onAddProduct: (productId: string) => void;
  onAttachFile: (key: string, file: File) => void;
  onRemove: (key: string) => void;
  onApplyToAll: (patch: Partial<DraftRow>) => void;
  onClose: () => void;
  onSave: () => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [sharedLab, setSharedLab] = useState("");
  const [sharedDate, setSharedDate] = useState("");

  const incomplete = drafts.some((draft) => !draft.productId || !draft.batchNumber.trim() || (!draft.file && !draft.externalUrl.trim()));

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/75 p-4">
      <div className="mx-auto max-w-4xl rounded-2xl border border-zinc-800 bg-zinc-950 p-4 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold text-white">
              {drafts.length === 0 ? "Add COAs by dose" : drafts.length === 1 ? "Add COA" : `Add ${drafts.length} COAs`}
            </h2>
            <p className="mt-1 text-sm text-zinc-400">
              {drafts.length === 0
                ? "Choose a product and you get one row per dose. Add a picture and a batch number to each, then save."
                : "Pick the product, enter the batch, save. No code, no deploy."}
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300">
            Close
          </button>
        </div>

        {/* The product first, then its doses, is how the certificates arrive:
            a lab tests GLP-3 5mg, 10mg and 15mg in one go. This turns that
            envelope into one row per dose, each already labelled. */}
        <div className="mt-4 flex flex-wrap items-end gap-3 rounded-xl border border-cyan-300/25 bg-cyan-300/[0.06] p-4">
          <label className="min-w-[16rem] flex-1 text-sm text-zinc-300">
            <FieldLabel>Add a row for every dose of a product</FieldLabel>
            <select
              value=""
              onChange={(event) => {
                if (event.target.value) onAddProduct(event.target.value);
              }}
              className="vl-input w-full px-3 py-2"
            >
              <option value="">Choose a product…</option>
              {products.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                  {option.strengths.length > 0 ? ` — ${option.strengths.map((item) => item.label).join(" / ")}` : ""}
                  {option.isPublished ? "" : " (draft product)"}
                </option>
              ))}
            </select>
          </label>
          <p className="max-w-sm text-xs text-zinc-500">
            One picture or PDF per dose — a phone photo of the certificate is fine. Laboratory and test date
            can be filled in once for every row.
          </p>
        </div>

        {drafts.length > 1 ? (
          <div className="mt-4 grid gap-3 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 sm:grid-cols-[1fr_1fr_auto]">
            <label className="text-sm text-zinc-300">
              <FieldLabel>Laboratory (all)</FieldLabel>
              <input value={sharedLab} onChange={(event) => setSharedLab(event.target.value)} className="vl-input w-full px-3 py-2" placeholder="e.g. Janoshik Analytical" />
            </label>
            <label className="text-sm text-zinc-300">
              <FieldLabel>Test date (all)</FieldLabel>
              <input type="date" value={sharedDate} onChange={(event) => setSharedDate(event.target.value)} className="vl-input w-full px-3 py-2" />
            </label>
            <button
              type="button"
              onClick={() => {
                const patch: Partial<DraftRow> = {};
                if (sharedLab.trim()) patch.labName = sharedLab.trim();
                if (sharedDate) patch.testDate = sharedDate;
                if (Object.keys(patch).length > 0) onApplyToAll(patch);
              }}
              className="self-end rounded-lg border border-zinc-600 px-4 py-2 text-sm text-zinc-200 hover:border-zinc-400"
            >
              Apply to all
            </button>
          </div>
        ) : null}

        <div className="mt-4 space-y-4">
          {drafts.map((draft, index) => {
            const product = draft.productId ? productsById.get(draft.productId) : undefined;
            return (
              <div key={draft.key} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-white">
                      {product
                        ? `${product.name}${draft.strength ? ` · ${draft.strength}` : ""}`
                        : draft.file
                          ? draft.file.name
                          : `COA ${index + 1}`}
                    </p>
                    <p className="text-xs text-zinc-500">
                      {draft.file
                        ? `${draft.file.name} · ${formatCoaFileSize(draft.file.size)}`
                        : "No picture yet — add one, or paste a link below."}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {draft.state === "saved" ? <span className="text-xs text-emerald-400">Saved</span> : null}
                    {draft.state === "saving" ? <span className="text-xs text-zinc-400">Saving…</span> : null}
                    {/* Attach or swap the document on THIS row. A file used to
                        arrive only by drop, before the row existed, so a row
                        started from a product had no way to take one. */}
                    <label className="cursor-pointer rounded-md border border-cyan-300/50 px-2 py-1 text-xs font-semibold text-cyan-200 hover:border-cyan-200">
                      {draft.file ? "Replace picture" : "Add picture or PDF"}
                      <input
                        type="file"
                        accept={ACCEPTED}
                        className="hidden"
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          if (file) onAttachFile(draft.key, file);
                          event.target.value = "";
                        }}
                      />
                    </label>
                    <button type="button" onClick={() => onRemove(draft.key)} className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300">
                      Remove
                    </button>
                  </div>
                </div>

                {draft.error ? <p className="mt-2 rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{draft.error}</p> : null}

                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <label className="text-sm text-zinc-300 sm:col-span-2">
                    <FieldLabel>Product *</FieldLabel>
                    <select
                      value={draft.productId}
                      onChange={(event) => {
                        const nextProduct = productsById.get(event.target.value);
                        const onlyStrength = nextProduct?.strengths.length === 1 ? nextProduct.strengths[0] : null;
                        onUpdate(draft.key, {
                          productId: event.target.value,
                          // A single-variant product has exactly one answer for
                          // "which strength?" — filling it in saves a click on
                          // every upload and can't be wrong.
                          productDoseId: onlyStrength?.id ?? "",
                          strength: onlyStrength?.label ?? "",
                        });
                      }}
                      className="vl-input w-full px-3 py-2"
                    >
                      <option value="">Select a product…</option>
                      {products.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.name}
                          {option.isPublished ? "" : " (draft product)"}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="text-sm text-zinc-300">
                    <FieldLabel>Strength</FieldLabel>
                    {product && product.strengths.length > 0 ? (
                      <select
                        value={draft.productDoseId}
                        onChange={(event) => {
                          const dose = product.strengths.find((item) => item.id === event.target.value);
                          onUpdate(draft.key, { productDoseId: event.target.value, strength: dose?.label ?? "" });
                        }}
                        className="vl-input w-full px-3 py-2"
                      >
                        <option value="">Not specific to one strength</option>
                        {product.strengths.map((item) => (
                          <option key={item.id} value={item.id}>{item.label}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        value={draft.strength}
                        onChange={(event) => onUpdate(draft.key, { strength: event.target.value })}
                        placeholder="e.g. 10mg"
                        className="vl-input w-full px-3 py-2"
                      />
                    )}
                  </label>

                  <label className="text-sm text-zinc-300">
                    <FieldLabel>Batch / lot number *</FieldLabel>
                    <input
                      value={draft.batchNumber}
                      onChange={(event) => onUpdate(draft.key, { batchNumber: event.target.value })}
                      placeholder="e.g. VL-BPC-0826"
                      className="vl-input w-full px-3 py-2"
                    />
                  </label>

                  <label className="text-sm text-zinc-300">
                    <FieldLabel>Secondary lot (optional)</FieldLabel>
                    <input value={draft.lotNumber} onChange={(event) => onUpdate(draft.key, { lotNumber: event.target.value })} className="vl-input w-full px-3 py-2" />
                  </label>

                  <label className="text-sm text-zinc-300">
                    <FieldLabel>Testing laboratory</FieldLabel>
                    <input value={draft.labName} onChange={(event) => onUpdate(draft.key, { labName: event.target.value })} className="vl-input w-full px-3 py-2" />
                  </label>

                  <label className="text-sm text-zinc-300">
                    <FieldLabel>Testing date</FieldLabel>
                    <input type="date" value={draft.testDate} onChange={(event) => onUpdate(draft.key, { testDate: event.target.value })} className="vl-input w-full px-3 py-2" />
                  </label>

                  <label className="text-sm text-zinc-300">
                    <FieldLabel>Purity (optional)</FieldLabel>
                    <input
                      value={draft.purity}
                      onChange={(event) => onUpdate(draft.key, { purity: event.target.value })}
                      placeholder="e.g. 99.2%"
                      className="vl-input w-full px-3 py-2"
                    />
                  </label>

                  <label className="text-sm text-zinc-300">
                    <FieldLabel>Identity result (optional)</FieldLabel>
                    <input
                      value={draft.identityResult}
                      onChange={(event) => onUpdate(draft.key, { identityResult: event.target.value })}
                      placeholder="e.g. Conforms — MS"
                      className="vl-input w-full px-3 py-2"
                    />
                  </label>

                  {!draft.file ? (
                    <label className="text-sm text-zinc-300 sm:col-span-2">
                      <FieldLabel>COA link (used when no file is attached)</FieldLabel>
                      <input
                        value={draft.externalUrl}
                        onChange={(event) => onUpdate(draft.key, { externalUrl: event.target.value })}
                        placeholder="https://…"
                        className="vl-input w-full px-3 py-2"
                      />
                    </label>
                  ) : null}

                  <label className="text-sm text-zinc-300">
                    <FieldLabel>Publish state</FieldLabel>
                    <select
                      value={draft.status}
                      onChange={(event) => onUpdate(draft.key, { status: event.target.value as CoaStatus })}
                      className="vl-input w-full px-3 py-2"
                    >
                      <option value="published">Published — live on the site</option>
                      <option value="draft">Draft — saved, not public</option>
                    </select>
                  </label>
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
          <label className="cursor-pointer rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-200 hover:border-zinc-500">
            Add more files
            <input
              type="file"
              accept={ACCEPTED}
              multiple
              className="hidden"
              onChange={(event) => {
                if (event.target.files) onAddFiles(event.target.files);
                event.target.value = "";
              }}
            />
          </label>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-200">
              Cancel
            </button>
            <button
              type="button"
              disabled={saving || incomplete || drafts.length === 0}
              onClick={async () => {
                setSaving(true);
                try {
                  await onSave();
                } finally {
                  setSaving(false);
                }
              }}
              className="rounded-lg bg-cyan-300 px-5 py-2 text-sm font-semibold text-zinc-950 hover:bg-cyan-200 disabled:opacity-40"
            >
              {saving ? "Saving…" : drafts.length <= 1 ? "Save COA" : `Save ${drafts.length} COAs`}
            </button>
          </div>
        </div>
        {incomplete ? (
          <p className="mt-2 text-right text-xs text-zinc-500">Every COA needs a product, a batch number, and either a file or a link.</p>
        ) : null}
      </div>
    </div>
  );
}

function EditPanel({
  record,
  products,
  onClose,
  onSave,
}: {
  record: AdminCoaRecord;
  products: CoaProductOption[];
  onClose: () => void;
  onSave: (patch: Record<string, unknown>) => Promise<void>;
}) {
  const [form, setForm] = useState({
    productId: record.productId,
    productDoseId: record.productDoseId ?? "",
    strength: record.strength ?? "",
    batchNumber: record.batchNumber,
    lotNumber: record.lotNumber ?? "",
    labName: record.labName ?? "",
    testDate: record.testDate ?? "",
    purity: record.purity ?? "",
    identityResult: record.identityResult ?? "",
    externalUrl: record.externalUrl ?? "",
    status: record.status,
  });
  const [saving, setSaving] = useState(false);

  const product = products.find((option) => option.id === form.productId);
  const set = (patch: Partial<typeof form>) => setForm((current) => ({ ...current, ...patch }));

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/75 p-4">
      <div className="mx-auto max-w-2xl rounded-2xl border border-zinc-800 bg-zinc-950 p-4 sm:p-6">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-xl font-semibold text-white">Edit COA</h2>
          <button type="button" onClick={onClose} className="rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300">Close</button>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="text-sm text-zinc-300 sm:col-span-2">
            <FieldLabel>Product</FieldLabel>
            <select value={form.productId} onChange={(event) => set({ productId: event.target.value, productDoseId: "" })} className="vl-input w-full px-3 py-2">
              {products.map((option) => (
                <option key={option.id} value={option.id}>{option.name}</option>
              ))}
            </select>
          </label>

          <label className="text-sm text-zinc-300">
            <FieldLabel>Strength</FieldLabel>
            {product && product.strengths.length > 0 ? (
              <select
                value={form.productDoseId}
                onChange={(event) => {
                  const dose = product.strengths.find((item) => item.id === event.target.value);
                  set({ productDoseId: event.target.value, strength: dose?.label ?? "" });
                }}
                className="vl-input w-full px-3 py-2"
              >
                <option value="">Not specific to one strength</option>
                {product.strengths.map((item) => (
                  <option key={item.id} value={item.id}>{item.label}</option>
                ))}
              </select>
            ) : (
              <input value={form.strength} onChange={(event) => set({ strength: event.target.value })} className="vl-input w-full px-3 py-2" />
            )}
          </label>

          <label className="text-sm text-zinc-300">
            <FieldLabel>Batch / lot number</FieldLabel>
            <input value={form.batchNumber} onChange={(event) => set({ batchNumber: event.target.value })} className="vl-input w-full px-3 py-2" />
          </label>

          <label className="text-sm text-zinc-300">
            <FieldLabel>Secondary lot</FieldLabel>
            <input value={form.lotNumber} onChange={(event) => set({ lotNumber: event.target.value })} className="vl-input w-full px-3 py-2" />
          </label>

          <label className="text-sm text-zinc-300">
            <FieldLabel>Testing laboratory</FieldLabel>
            <input value={form.labName} onChange={(event) => set({ labName: event.target.value })} className="vl-input w-full px-3 py-2" />
          </label>

          <label className="text-sm text-zinc-300">
            <FieldLabel>Testing date</FieldLabel>
            <input type="date" value={form.testDate} onChange={(event) => set({ testDate: event.target.value })} className="vl-input w-full px-3 py-2" />
          </label>

          <label className="text-sm text-zinc-300">
            <FieldLabel>Purity</FieldLabel>
            <input value={form.purity} onChange={(event) => set({ purity: event.target.value })} className="vl-input w-full px-3 py-2" />
          </label>

          <label className="text-sm text-zinc-300 sm:col-span-2">
            <FieldLabel>Identity result</FieldLabel>
            <input value={form.identityResult} onChange={(event) => set({ identityResult: event.target.value })} className="vl-input w-full px-3 py-2" />
          </label>

          <label className="text-sm text-zinc-300 sm:col-span-2">
            <FieldLabel>COA link {record.fileKind === "link" ? "" : "(the uploaded file takes priority)"}</FieldLabel>
            <input value={form.externalUrl} onChange={(event) => set({ externalUrl: event.target.value })} placeholder="https://…" className="vl-input w-full px-3 py-2" />
          </label>

          <label className="text-sm text-zinc-300">
            <FieldLabel>Publish state</FieldLabel>
            <select value={form.status} onChange={(event) => set({ status: event.target.value as CoaStatus })} className="vl-input w-full px-3 py-2">
              <option value="published">Published</option>
              <option value="draft">Draft</option>
              <option value="archived">Archived</option>
            </select>
          </label>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-200">Cancel</button>
          <button
            type="button"
            disabled={saving || !form.batchNumber.trim()}
            onClick={async () => {
              setSaving(true);
              try {
                await onSave(form);
              } finally {
                setSaving(false);
              }
            }}
            className="rounded-lg bg-cyan-300 px-5 py-2 text-sm font-semibold text-zinc-950 hover:bg-cyan-200 disabled:opacity-40"
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>
    </div>
  );
}
