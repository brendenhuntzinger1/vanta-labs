"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import type { Product, ProductBadge, ProductDose } from "@/lib/catalog-types";

type ProductStatusFilter = "all" | "published" | "draft" | "archived" | "disabled";

type AdminProductsResponse = {
  success: boolean;
  rows?: Product[];
  error?: string;
};

type WizardState = {
  name: string;
  category: string;
  shortDescription: string;
  longDescription: string;
  isPublished: boolean;
  variants: Array<{
    id: string;
    label: string;
    slugSuffix: string;
    sku: string;
    price: string;
    compareAtPrice: string;
    salePrice: string;
    inventoryQuantity: string;
    batchNumber: string;
    coaUrl: string;
    imageUrl: string;
    purityResult: string;
    isDefault: boolean;
  }>;
};

const CATEGORIES = [
  "Research Peptides",
  "Growth Factors",
  "Metabolic Research",
  "Cognitive Research",
  "Analytical Reference",
  "Calibration Series",
  "Solvents & Solutions",
];

const BADGE_OPTIONS: Array<{ label: string; value: ProductBadge }> = [
  { label: "None", value: null },
  { label: "New", value: "new" },
  { label: "Best Seller", value: "best_seller" },
  { label: "Sale", value: "sale" },
];

function parseMoneyToCents(value: string) {
  const parsed = Number(value.replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.max(0, Math.round(parsed * 100));
}

function statusLabel(product: Product) {
  if (product.isArchived) return "Archived";
  if (!product.isEnabled) return "Disabled";
  if (!product.isPublished) return "Draft";
  return "Published";
}

function statusClasses(product: Product) {
  if (product.isArchived) return "bg-zinc-800 text-zinc-300 border-zinc-700";
  if (!product.isEnabled) return "bg-amber-500/15 text-amber-300 border-amber-500/30";
  if (!product.isPublished) return "bg-blue-500/15 text-blue-300 border-blue-500/30";
  return "bg-emerald-500/15 text-emerald-300 border-emerald-500/30";
}

function toDoseInput(dose: ProductDose, index: number) {
  return {
    id: dose.id,
    label: dose.label,
    slugSuffix: dose.slugSuffix,
    sku: dose.sku ?? "",
    priceCents: parseMoneyToCents(dose.price),
    compareAtPriceCents: parseMoneyToCents(dose.compareAtPrice ?? ""),
    salePriceCents: parseMoneyToCents(dose.salePrice ?? ""),
    inventoryQuantity: Number(dose.inventoryQuantity ?? 0),
    stockStatus: dose.stockStatus,
    batchNumber: dose.batchNumber ?? "",
    coaUrl: dose.coaUrl ?? "",
    imageUrl: dose.imageUrl ?? "",
    purityResult: dose.purityResult ?? "",
    isDefault: dose.isDefault,
    isEnabled: dose.isEnabled,
    position: dose.position ?? index,
  };
}

function VariantEditor({
  variant,
  onChange,
  onDelete,
  onSetDefault,
}: {
  variant: WizardState["variants"][number];
  onChange: (next: WizardState["variants"][number]) => void;
  onDelete: () => void;
  onSetDefault: () => void;
}) {
  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-950/60 p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold text-white">Variant</p>
        <div className="flex items-center gap-2">
          <button type="button" onClick={onSetDefault} className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-200 hover:border-cyan-400/60 hover:text-cyan-300">
            {variant.isDefault ? "Default" : "Set default"}
          </button>
          <button type="button" onClick={onDelete} className="rounded-md border border-rose-600/40 px-2 py-1 text-xs text-rose-300 hover:bg-rose-500/15">
            Remove
          </button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-zinc-400">Dose label
          <input value={variant.label} onChange={(e) => onChange({ ...variant, label: e.target.value })} className="vl-input mt-1 w-full px-3 py-2" placeholder="10mg" />
        </label>
        <label className="text-xs text-zinc-400">Slug suffix
          <input value={variant.slugSuffix} onChange={(e) => onChange({ ...variant, slugSuffix: e.target.value })} className="vl-input mt-1 w-full px-3 py-2" placeholder="10mg" />
        </label>
        <label className="text-xs text-zinc-400">SKU
          <input value={variant.sku} onChange={(e) => onChange({ ...variant, sku: e.target.value })} className="vl-input mt-1 w-full px-3 py-2" placeholder="GLP1-10MG" />
        </label>
        <label className="text-xs text-zinc-400">Inventory
          <input value={variant.inventoryQuantity} onChange={(e) => onChange({ ...variant, inventoryQuantity: e.target.value })} className="vl-input mt-1 w-full px-3 py-2" placeholder="120" />
        </label>
        <label className="text-xs text-zinc-400">Price
          <input value={variant.price} onChange={(e) => onChange({ ...variant, price: e.target.value })} className="vl-input mt-1 w-full px-3 py-2" placeholder="89.00" />
        </label>
        <label className="text-xs text-zinc-400">Compare-at price
          <input value={variant.compareAtPrice} onChange={(e) => onChange({ ...variant, compareAtPrice: e.target.value })} className="vl-input mt-1 w-full px-3 py-2" placeholder="109.00" />
        </label>
        <label className="text-xs text-zinc-400">Sale price
          <input value={variant.salePrice} onChange={(e) => onChange({ ...variant, salePrice: e.target.value })} className="vl-input mt-1 w-full px-3 py-2" placeholder="79.00" />
        </label>
        <label className="text-xs text-zinc-400">Purity
          <input value={variant.purityResult} onChange={(e) => onChange({ ...variant, purityResult: e.target.value })} className="vl-input mt-1 w-full px-3 py-2" placeholder="99.8%" />
        </label>
        <label className="text-xs text-zinc-400">Batch number
          <input value={variant.batchNumber} onChange={(e) => onChange({ ...variant, batchNumber: e.target.value })} className="vl-input mt-1 w-full px-3 py-2" placeholder="GLP-2410B" />
        </label>
        <label className="text-xs text-zinc-400">COA URL
          <input value={variant.coaUrl} onChange={(e) => onChange({ ...variant, coaUrl: e.target.value })} className="vl-input mt-1 w-full px-3 py-2" placeholder="https://...pdf" />
        </label>
        <label className="text-xs text-zinc-400 sm:col-span-2">Variant image URL
          <input value={variant.imageUrl} onChange={(e) => onChange({ ...variant, imageUrl: e.target.value })} className="vl-input mt-1 w-full px-3 py-2" placeholder="https://...png" />
        </label>
      </div>
    </div>
  );
}

export default function AdminProductsPage() {
  const router = useRouter();
  const [products, setProducts] = useState<Product[]>([]);
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<ProductStatusFilter>("all");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isWizardOpen, setIsWizardOpen] = useState(false);
  const [isSavingWizard, setIsSavingWizard] = useState(false);
  const [authState, setAuthState] = useState<"checking" | "ok" | "denied">("checking");

  const [wizard, setWizard] = useState<WizardState>({
    name: "",
    category: "Research Peptides",
    shortDescription: "",
    longDescription: "",
    isPublished: true,
    variants: [
      {
        id: crypto.randomUUID(),
        label: "10mg",
        slugSuffix: "10mg",
        sku: "",
        price: "",
        compareAtPrice: "",
        salePrice: "",
        inventoryQuantity: "0",
        batchNumber: "",
        coaUrl: "",
        imageUrl: "",
        purityResult: "",
        isDefault: true,
      },
    ],
  });

  const selectedProduct = useMemo(
    () => products.find((product) => product.id === selectedProductId) ?? null,
    [products, selectedProductId],
  );

  const loadProducts = useCallback(async () => {
    if (authState !== "ok") {
      return;
    }

    setLoading(true);
    try {
      const params = new URLSearchParams({
        search,
        category: categoryFilter,
        status: statusFilter,
      });
      const res = await fetch(`/api/admin/products?${params.toString()}`, { cache: "no-store" });
      const json = await res.json() as AdminProductsResponse;
      if (!res.ok || !json.success) {
        throw new Error(json.error ?? "Unable to load products");
      }
      const rows = json.rows ?? [];
      setProducts(rows);
      if (selectedProductId && !rows.some((row) => row.id === selectedProductId)) {
        setSelectedProductId(rows[0]?.id ?? null);
      }
      if (!selectedProductId && rows.length > 0) {
        setSelectedProductId(rows[0].id ?? null);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to load products.");
    } finally {
      setLoading(false);
    }
  }, [authState, categoryFilter, search, selectedProductId, statusFilter]);

  useEffect(() => {
    let cancelled = false;

    const checkSession = async () => {
      try {
        const res = await fetch("/api/admin/auth/session", { cache: "no-store" });
        if (cancelled) {
          return;
        }

        if (!res.ok) {
          setAuthState("denied");
          router.replace("/vault");
          return;
        }

        setAuthState("ok");
      } catch {
        if (!cancelled) {
          setAuthState("denied");
          router.replace("/vault");
        }
      }
    };

    void checkSession();

    return () => {
      cancelled = true;
    };
  }, [router]);

  useEffect(() => {
    if (authState !== "ok") {
      return;
    }

    queueMicrotask(() => {
      void loadProducts();
    });
  }, [authState, loadProducts]);

  useEffect(() => {
    if (authState !== "ok") {
      return;
    }

    const channel = supabase
      .channel("admin-products-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "products" }, () => {
        loadProducts();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "product_doses" }, () => {
        loadProducts();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "product_images" }, () => {
        loadProducts();
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [authState, loadProducts]);

  const categories = useMemo(() => {
    const dynamic = Array.from(new Set(products.map((product) => product.category))).filter(Boolean);
    return ["all", ...new Set([...CATEGORIES, ...dynamic])];
  }, [products]);

  if (authState === "checking") {
    return (
      <div className="vl-page-shell min-h-screen bg-zinc-950 px-4 py-8 text-zinc-100 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-7xl">
          <div className="vl-panel rounded-2xl p-6 text-sm text-zinc-300">Verifying access...</div>
        </div>
      </div>
    );
  }

  if (authState === "denied") {
    return null;
  }

  const clearMessageSoon = () => {
    window.setTimeout(() => setMessage(null), 2500);
  };

  const setBulkSelection = (productId: string, selected: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (selected) {
        next.add(productId);
      } else {
        next.delete(productId);
      }
      return next;
    });
  };

  const runBulkAction = async (action: string, value?: string | null) => {
    if (selectedIds.size === 0) {
      setMessage("Select products first.");
      clearMessageSoon();
      return;
    }

    const res = await fetch("/api/admin/products", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productIds: Array.from(selectedIds), action, value: value ?? null }),
    });
    const json = await res.json() as { success: boolean; error?: string };
    if (!res.ok || !json.success) {
      setMessage(json.error ?? "Bulk action failed.");
      clearMessageSoon();
      return;
    }

    setMessage("Bulk action applied.");
    setSelectedIds(new Set());
    clearMessageSoon();
    await loadProducts();
  };

  const createFromWizard = async () => {
    if (!wizard.name.trim()) {
      setMessage("Product name is required.");
      clearMessageSoon();
      return;
    }

    if (wizard.variants.length === 0) {
      setMessage("Add at least one dosage variant.");
      clearMessageSoon();
      return;
    }

    setIsSavingWizard(true);
    try {
      const res = await fetch("/api/admin/products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: wizard.name,
          category: wizard.category,
          shortDescription: wizard.shortDescription,
          longDescription: wizard.longDescription,
          isPublished: wizard.isPublished,
          isEnabled: true,
          doses: wizard.variants.map((variant, index) => ({
            label: variant.label,
            slugSuffix: variant.slugSuffix,
            sku: variant.sku,
            priceCents: parseMoneyToCents(variant.price),
            compareAtPriceCents: parseMoneyToCents(variant.compareAtPrice),
            salePriceCents: parseMoneyToCents(variant.salePrice),
            inventoryQuantity: Number(variant.inventoryQuantity || 0),
            batchNumber: variant.batchNumber,
            coaUrl: variant.coaUrl,
            imageUrl: variant.imageUrl,
            purityResult: variant.purityResult,
            isDefault: variant.isDefault,
            isEnabled: true,
            position: index,
          })),
          imageUrl: wizard.variants.find((variant) => variant.isDefault)?.imageUrl || undefined,
          batchNumber: wizard.variants.find((variant) => variant.isDefault)?.batchNumber || undefined,
          coaUrl: wizard.variants.find((variant) => variant.isDefault)?.coaUrl || undefined,
        }),
      });

      const json = await res.json() as { success: boolean; error?: string; product?: Product };
      if (!res.ok || !json.success) {
        throw new Error(json.error ?? "Unable to create product");
      }

      setIsWizardOpen(false);
      setWizard({
        name: "",
        category: "Research Peptides",
        shortDescription: "",
        longDescription: "",
        isPublished: true,
        variants: [
          {
            id: crypto.randomUUID(),
            label: "10mg",
            slugSuffix: "10mg",
            sku: "",
            price: "",
            compareAtPrice: "",
            salePrice: "",
            inventoryQuantity: "0",
            batchNumber: "",
            coaUrl: "",
            imageUrl: "",
            purityResult: "",
            isDefault: true,
          },
        ],
      });
      setMessage("Product created with variants.");
      clearMessageSoon();
      await loadProducts();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to create product");
      clearMessageSoon();
    } finally {
      setIsSavingWizard(false);
    }
  };

  const saveProduct = async (nextProduct: Product) => {
    if (!nextProduct.id) {
      return;
    }

    const res = await fetch(`/api/admin/products/${nextProduct.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "update",
        payload: {
          name: nextProduct.name,
          category: nextProduct.category,
          shortDescription: nextProduct.shortDescription,
          longDescription: nextProduct.longDescription,
          priceCents: parseMoneyToCents(nextProduct.price),
          compareAtPriceCents: parseMoneyToCents(nextProduct.compareAtPrice ?? ""),
          salePriceCents: parseMoneyToCents(nextProduct.salePrice ?? ""),
          inventoryQuantity: Number(nextProduct.inventoryQuantity ?? 0),
          stockStatus: nextProduct.stockStatus,
          isPublished: nextProduct.isPublished,
          isEnabled: nextProduct.isEnabled,
          isArchived: nextProduct.isArchived,
          isFeatured: nextProduct.isFeatured,
          badge: nextProduct.badge,
          batchNumber: nextProduct.batchNumber,
          coaUrl: nextProduct.coaUrl,
          imageUrl: nextProduct.coverImage,
          seoTitle: nextProduct.seoTitle,
          seoDescription: nextProduct.seoDescription,
          doses: (nextProduct.doses ?? []).map(toDoseInput),
        },
      }),
    });

    const json = await res.json() as { success: boolean; error?: string; product?: Product };
    if (!res.ok || !json.success || !json.product) {
      setMessage(json.error ?? "Unable to save product.");
      clearMessageSoon();
      return;
    }

    const savedProduct = json.product;

    setProducts((prev) => prev.map((product) => (product.id === savedProduct.id ? savedProduct : product)));
    setMessage("Product saved.");
    clearMessageSoon();
  };

  const uploadVariantImage = async (productId: string, variantId: string, file: File) => {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("productId", productId);
    formData.append("makePrimary", "false");

    const res = await fetch("/api/admin/upload-image", {
      method: "POST",
      body: formData,
    });

    const json = await res.json() as { success: boolean; error?: string; imageUrl?: string; product?: Product };
    if (!res.ok || !json.success || !json.imageUrl || !json.product) {
      setMessage(json.error ?? "Upload failed.");
      clearMessageSoon();
      return;
    }

    const product = json.product;
    const updatedDoses = (product.doses ?? []).map((dose) => (
      dose.id === variantId ? { ...dose, imageUrl: json.imageUrl } : dose
    ));
    await saveProduct({ ...product, doses: updatedDoses });
  };

  const deleteProduct = async (productId: string) => {
    const confirmed = window.confirm("Delete this product permanently?");
    if (!confirmed) {
      return;
    }

    const res = await fetch(`/api/admin/products/${productId}`, { method: "DELETE" });
    const json = await res.json() as { success: boolean; error?: string };
    if (!res.ok || !json.success) {
      setMessage(json.error ?? "Unable to delete product.");
      clearMessageSoon();
      return;
    }

    setProducts((prev) => prev.filter((product) => product.id !== productId));
    setSelectedProductId((prev) => (prev === productId ? null : prev));
    setMessage("Product deleted.");
    clearMessageSoon();
  };

  const duplicateProduct = async (productId: string) => {
    const res = await fetch(`/api/admin/products/${productId}/duplicate`, { method: "POST" });
    const json = await res.json() as { success: boolean; error?: string; product?: Product };
    if (!res.ok || !json.success) {
      setMessage(json.error ?? "Unable to duplicate product.");
      clearMessageSoon();
      return;
    }
    await loadProducts();
    setMessage("Product duplicated.");
    clearMessageSoon();
  };

  const reorderProducts = async (draggedId: string, droppedId: string) => {
    if (draggedId === droppedId) return;
    const rows = [...products];
    const fromIndex = rows.findIndex((row) => row.id === draggedId);
    const toIndex = rows.findIndex((row) => row.id === droppedId);
    if (fromIndex < 0 || toIndex < 0) return;

    const [moved] = rows.splice(fromIndex, 1);
    rows.splice(toIndex, 0, moved);
    setProducts(rows);

    await fetch("/api/admin/products/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productIds: rows.map((row) => row.id) }),
    });
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="border-b border-zinc-800 bg-zinc-950/90">
        <div className="mx-auto max-w-7xl px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.3em] text-zinc-500">Admin</p>
              <h1 className="text-2xl font-semibold text-white">Products</h1>
            </div>
            <div className="flex items-center gap-2">
              <Link href="/products" className="rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:text-white">View Store</Link>
              <button type="button" onClick={() => setIsWizardOpen(true)} className="rounded-lg bg-cyan-300 px-4 py-2 text-sm font-semibold text-zinc-950 hover:bg-cyan-200">
                Add Product Wizard
              </button>
            </div>
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-[1fr_auto_auto_auto]">
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search products instantly" className="vl-input px-3 py-2" />
            <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)} className="vl-input px-3 py-2">
              {categories.map((category) => (
                <option key={category} value={category}>{category === "all" ? "All Categories" : category}</option>
              ))}
            </select>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as ProductStatusFilter)} className="vl-input px-3 py-2">
              <option value="all">All Statuses</option>
              <option value="published">Published</option>
              <option value="draft">Draft</option>
              <option value="disabled">Disabled</option>
              <option value="archived">Archived</option>
            </select>
            <button type="button" onClick={loadProducts} className="rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-200 hover:border-zinc-500">Refresh</button>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => runBulkAction("publish")} className="rounded-md border border-emerald-500/40 px-3 py-1 text-xs text-emerald-300">Publish</button>
            <button type="button" onClick={() => runBulkAction("unpublish")} className="rounded-md border border-blue-500/40 px-3 py-1 text-xs text-blue-300">Unpublish</button>
            <button type="button" onClick={() => runBulkAction("enable")} className="rounded-md border border-cyan-500/40 px-3 py-1 text-xs text-cyan-300">Enable</button>
            <button type="button" onClick={() => runBulkAction("disable")} className="rounded-md border border-amber-500/40 px-3 py-1 text-xs text-amber-300">Disable</button>
            <button type="button" onClick={() => runBulkAction("archive")} className="rounded-md border border-zinc-600 px-3 py-1 text-xs text-zinc-300">Archive</button>
            <button type="button" onClick={() => runBulkAction("set_badge", "sale")} className="rounded-md border border-rose-500/40 px-3 py-1 text-xs text-rose-300">Mark Sale</button>
          </div>
        </div>
      </div>

      <div className="mx-auto grid max-w-7xl gap-4 px-4 py-6 sm:px-6 lg:grid-cols-[380px_1fr] lg:px-8">
        <aside className="space-y-3">
          {loading ? <div className="text-sm text-zinc-400">Loading products…</div> : null}
          {products.map((product) => (
            <div
              key={product.id}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData("text/product-id", product.id ?? "");
              }}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                const draggedId = event.dataTransfer.getData("text/product-id");
                if (product.id && draggedId) {
                  reorderProducts(draggedId, product.id);
                }
              }}
              className={`rounded-2xl border p-3 transition ${selectedProductId === product.id ? "border-cyan-400/50 bg-zinc-900" : "border-zinc-800 bg-zinc-950/70 hover:border-zinc-700"}`}
            >
              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={selectedIds.has(product.id ?? "")}
                  onChange={(e) => setBulkSelection(product.id ?? "", e.target.checked)}
                  className="mt-1"
                />
                <button type="button" onClick={() => setSelectedProductId(product.id ?? null)} className="flex-1 text-left">
                  <div className="flex items-center gap-2">
                    <div className="relative h-12 w-12 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900">
                      {product.coverImage ? <Image src={product.coverImage} alt={product.name} fill sizes="48px" className="object-cover" /> : null}
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-white">{product.name}</p>
                      <p className="truncate text-xs text-zinc-500">{product.category}</p>
                    </div>
                  </div>
                </button>
                <span className={`rounded-full border px-2 py-1 text-[10px] font-semibold ${statusClasses(product)}`}>
                  {statusLabel(product)}
                </span>
              </div>
              <div className="mt-3 flex items-center justify-between text-xs text-zinc-400">
                <span>{product.doses?.length ?? 0} doses</span>
                <span>{product.price}</span>
              </div>
            </div>
          ))}
        </aside>

        <section className="rounded-2xl border border-zinc-800 bg-zinc-950/70 p-4 sm:p-5">
          {selectedProduct ? (
            <ProductEditor
              key={selectedProduct.id}
              product={selectedProduct}
              onSave={saveProduct}
              onDelete={deleteProduct}
              onDuplicate={duplicateProduct}
              onUploadVariantImage={uploadVariantImage}
            />
          ) : (
            <div className="text-sm text-zinc-400">Select a product to edit.</div>
          )}
        </section>
      </div>

      {isWizardOpen ? (
        <div className="fixed inset-0 z-50 bg-black/70 p-3 sm:p-6">
          <div className="mx-auto max-h-[95vh] max-w-4xl overflow-auto rounded-2xl border border-zinc-800 bg-zinc-950 p-4 sm:p-6">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-xl font-semibold text-white">Add Product Wizard</h2>
              <button type="button" onClick={() => setIsWizardOpen(false)} className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300">Close</button>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-xs text-zinc-400">Product name
                <input value={wizard.name} onChange={(e) => setWizard((prev) => ({ ...prev, name: e.target.value }))} className="vl-input mt-1 w-full px-3 py-2" placeholder="GLP-1" />
              </label>
              <label className="text-xs text-zinc-400">Category
                <select value={wizard.category} onChange={(e) => setWizard((prev) => ({ ...prev, category: e.target.value }))} className="vl-input mt-1 w-full px-3 py-2">
                  {CATEGORIES.map((category) => <option key={category} value={category}>{category}</option>)}
                </select>
              </label>
              <label className="text-xs text-zinc-400 sm:col-span-2">Short description
                <input value={wizard.shortDescription} onChange={(e) => setWizard((prev) => ({ ...prev, shortDescription: e.target.value }))} className="vl-input mt-1 w-full px-3 py-2" />
              </label>
              <label className="text-xs text-zinc-400 sm:col-span-2">Long description
                <textarea value={wizard.longDescription} onChange={(e) => setWizard((prev) => ({ ...prev, longDescription: e.target.value }))} className="vl-input mt-1 min-h-24 w-full px-3 py-2" />
              </label>
            </div>

            <div className="mt-5 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-white">Dosage variants</h3>
                <button
                  type="button"
                  onClick={() => setWizard((prev) => ({
                    ...prev,
                    variants: [
                      ...prev.variants,
                      {
                        id: crypto.randomUUID(),
                        label: "",
                        slugSuffix: "",
                        sku: "",
                        price: "",
                        compareAtPrice: "",
                        salePrice: "",
                        inventoryQuantity: "0",
                        batchNumber: "",
                        coaUrl: "",
                        imageUrl: "",
                        purityResult: "",
                        isDefault: false,
                      },
                    ],
                  }))}
                  className="rounded-lg border border-zinc-700 px-3 py-2 text-xs text-zinc-200"
                >
                  Add dose variant
                </button>
              </div>

              {wizard.variants.map((variant, index) => (
                <VariantEditor
                  key={variant.id}
                  variant={variant}
                  onChange={(next) => setWizard((prev) => ({
                    ...prev,
                    variants: prev.variants.map((item, itemIndex) => itemIndex === index ? next : item),
                  }))}
                  onDelete={() => setWizard((prev) => ({
                    ...prev,
                    variants: prev.variants.filter((_, itemIndex) => itemIndex !== index),
                  }))}
                  onSetDefault={() => setWizard((prev) => ({
                    ...prev,
                    variants: prev.variants.map((item, itemIndex) => ({ ...item, isDefault: itemIndex === index })),
                  }))}
                />
              ))}
            </div>

            <div className="mt-6 flex items-center justify-end gap-2">
              <button type="button" onClick={() => setIsWizardOpen(false)} className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-300">Cancel</button>
              <button type="button" onClick={createFromWizard} disabled={isSavingWizard} className="rounded-lg bg-cyan-300 px-4 py-2 text-sm font-semibold text-zinc-950 disabled:opacity-60">
                {isSavingWizard ? "Saving…" : "Publish Product"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {message ? (
        <div className="fixed bottom-4 right-4 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100">
          {message}
        </div>
      ) : null}
    </div>
  );
}

function ProductEditor({
  product,
  onSave,
  onDelete,
  onDuplicate,
  onUploadVariantImage,
}: {
  product: Product;
  onSave: (product: Product) => Promise<void>;
  onDelete: (productId: string) => Promise<void>;
  onDuplicate: (productId: string) => Promise<void>;
  onUploadVariantImage: (productId: string, variantId: string, file: File) => Promise<void>;
}) {
  const [draft, setDraft] = useState<Product>(product);

  const setDose = (doseId: string, updater: (dose: ProductDose) => ProductDose) => {
    setDraft((prev) => ({
      ...prev,
      doses: (prev.doses ?? []).map((dose) => (dose.id === doseId ? updater(dose) : dose)),
    }));
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xl font-semibold text-white">{draft.name}</h2>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => onDuplicate(draft.id ?? "")} className="rounded-md border border-zinc-700 px-3 py-2 text-xs text-zinc-200">Duplicate</button>
          <button type="button" onClick={() => onDelete(draft.id ?? "")} className="rounded-md border border-rose-500/40 px-3 py-2 text-xs text-rose-300">Delete</button>
          <button type="button" onClick={() => onSave(draft)} className="rounded-md bg-cyan-300 px-3 py-2 text-xs font-semibold text-zinc-950">Save</button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-zinc-400">Name
          <input value={draft.name} onChange={(e) => setDraft((prev) => ({ ...prev, name: e.target.value }))} className="vl-input mt-1 w-full px-3 py-2" />
        </label>
        <label className="text-xs text-zinc-400">Slug
          <input value={draft.slug} onChange={(e) => setDraft((prev) => ({ ...prev, slug: e.target.value }))} className="vl-input mt-1 w-full px-3 py-2" />
        </label>
        <label className="text-xs text-zinc-400">Category
          <input value={draft.category} onChange={(e) => setDraft((prev) => ({ ...prev, category: e.target.value }))} className="vl-input mt-1 w-full px-3 py-2" />
        </label>
        <label className="text-xs text-zinc-400">Badge
          <select value={draft.badge ?? ""} onChange={(e) => setDraft((prev) => ({ ...prev, badge: (e.target.value || null) as ProductBadge }))} className="vl-input mt-1 w-full px-3 py-2">
            {BADGE_OPTIONS.map((badge) => <option key={badge.label} value={badge.value ?? ""}>{badge.label}</option>)}
          </select>
        </label>
      </div>

      <div className="grid gap-2 sm:grid-cols-4">
        <label className="flex items-center gap-2 rounded-lg border border-zinc-800 p-2 text-xs text-zinc-300">
          <input type="checkbox" checked={Boolean(draft.isPublished)} onChange={(e) => setDraft((prev) => ({ ...prev, isPublished: e.target.checked }))} />
          Published
        </label>
        <label className="flex items-center gap-2 rounded-lg border border-zinc-800 p-2 text-xs text-zinc-300">
          <input type="checkbox" checked={Boolean(draft.isEnabled)} onChange={(e) => setDraft((prev) => ({ ...prev, isEnabled: e.target.checked }))} />
          Enabled
        </label>
        <label className="flex items-center gap-2 rounded-lg border border-zinc-800 p-2 text-xs text-zinc-300">
          <input type="checkbox" checked={Boolean(draft.isFeatured)} onChange={(e) => setDraft((prev) => ({ ...prev, isFeatured: e.target.checked }))} />
          Featured
        </label>
        <label className="flex items-center gap-2 rounded-lg border border-zinc-800 p-2 text-xs text-zinc-300">
          <input type="checkbox" checked={Boolean(draft.isArchived)} onChange={(e) => setDraft((prev) => ({ ...prev, isArchived: e.target.checked }))} />
          Archived
        </label>
      </div>

      <label className="text-xs text-zinc-400">Short description
        <input value={draft.shortDescription ?? ""} onChange={(e) => setDraft((prev) => ({ ...prev, shortDescription: e.target.value }))} className="vl-input mt-1 w-full px-3 py-2" />
      </label>
      <label className="text-xs text-zinc-400">Long description
        <textarea value={draft.longDescription ?? draft.description ?? ""} onChange={(e) => setDraft((prev) => ({ ...prev, longDescription: e.target.value, description: e.target.value }))} className="vl-input mt-1 min-h-24 w-full px-3 py-2" />
      </label>

      <label className="text-xs text-zinc-400">SEO title
        <input value={draft.seoTitle ?? ""} onChange={(e) => setDraft((prev) => ({ ...prev, seoTitle: e.target.value }))} className="vl-input mt-1 w-full px-3 py-2" />
      </label>
      <label className="text-xs text-zinc-400">SEO description
        <textarea value={draft.seoDescription ?? ""} onChange={(e) => setDraft((prev) => ({ ...prev, seoDescription: e.target.value }))} className="vl-input mt-1 min-h-20 w-full px-3 py-2" />
      </label>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-white">Dosage variants</h3>
          <button
            type="button"
            onClick={() => setDraft((prev) => ({
              ...prev,
              doses: [
                ...(prev.doses ?? []),
                {
                  id: crypto.randomUUID(),
                  label: "",
                  slugSuffix: "",
                  sku: "",
                  price: "$0.00",
                  inventoryQuantity: 0,
                  isDefault: false,
                  isEnabled: true,
                  position: (prev.doses ?? []).length,
                },
              ],
            }))}
            className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-200"
          >
            Add variant
          </button>
        </div>

        {(draft.doses ?? []).map((dose) => (
          <div key={dose.id} className="rounded-2xl border border-zinc-800 bg-zinc-950/60 p-4 space-y-3">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <label className="text-xs text-zinc-400">Dose label
                <input value={dose.label} onChange={(e) => setDose(dose.id, (prev) => ({ ...prev, label: e.target.value }))} className="vl-input mt-1 w-full px-3 py-2" />
              </label>
              <label className="text-xs text-zinc-400">Slug suffix
                <input value={dose.slugSuffix} onChange={(e) => setDose(dose.id, (prev) => ({ ...prev, slugSuffix: e.target.value }))} className="vl-input mt-1 w-full px-3 py-2" />
              </label>
              <label className="text-xs text-zinc-400">SKU
                <input value={dose.sku ?? ""} onChange={(e) => setDose(dose.id, (prev) => ({ ...prev, sku: e.target.value }))} className="vl-input mt-1 w-full px-3 py-2" />
              </label>
              <label className="text-xs text-zinc-400">Price
                <input value={dose.price} onChange={(e) => setDose(dose.id, (prev) => ({ ...prev, price: e.target.value }))} className="vl-input mt-1 w-full px-3 py-2" />
              </label>
              <label className="text-xs text-zinc-400">Inventory
                <input value={String(dose.inventoryQuantity ?? 0)} onChange={(e) => setDose(dose.id, (prev) => ({ ...prev, inventoryQuantity: Number(e.target.value || 0) }))} className="vl-input mt-1 w-full px-3 py-2" />
              </label>
              <label className="text-xs text-zinc-400">Batch
                <input value={dose.batchNumber ?? ""} onChange={(e) => setDose(dose.id, (prev) => ({ ...prev, batchNumber: e.target.value }))} className="vl-input mt-1 w-full px-3 py-2" />
              </label>
              <label className="text-xs text-zinc-400">COA URL
                <input value={dose.coaUrl ?? ""} onChange={(e) => setDose(dose.id, (prev) => ({ ...prev, coaUrl: e.target.value }))} className="vl-input mt-1 w-full px-3 py-2" />
              </label>
              <label className="text-xs text-zinc-400">Variant image URL
                <input value={dose.imageUrl ?? ""} onChange={(e) => setDose(dose.id, (prev) => ({ ...prev, imageUrl: e.target.value }))} className="vl-input mt-1 w-full px-3 py-2" />
              </label>
              <label className="text-xs text-zinc-400">Purity
                <input value={dose.purityResult ?? ""} onChange={(e) => setDose(dose.id, (prev) => ({ ...prev, purityResult: e.target.value }))} className="vl-input mt-1 w-full px-3 py-2" />
              </label>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2 rounded-md border border-zinc-800 px-2 py-1 text-xs text-zinc-300">
                <input type="checkbox" checked={Boolean(dose.isEnabled)} onChange={(e) => setDose(dose.id, (prev) => ({ ...prev, isEnabled: e.target.checked }))} />
                Enabled
              </label>
              <label className="flex items-center gap-2 rounded-md border border-zinc-800 px-2 py-1 text-xs text-zinc-300">
                <input
                  type="checkbox"
                  checked={Boolean(dose.isDefault)}
                  onChange={() => setDraft((prev) => ({
                    ...prev,
                    doses: (prev.doses ?? []).map((item) => ({ ...item, isDefault: item.id === dose.id })),
                  }))}
                />
                Default
              </label>
              <label className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300 cursor-pointer">
                Upload image
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file && draft.id) {
                      onUploadVariantImage(draft.id, dose.id, file);
                    }
                  }}
                />
              </label>
              <button
                type="button"
                onClick={() => setDraft((prev) => ({
                  ...prev,
                  doses: (prev.doses ?? []).filter((item) => item.id !== dose.id),
                }))}
                className="rounded-md border border-rose-500/40 px-2 py-1 text-xs text-rose-300"
              >
                Remove
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
