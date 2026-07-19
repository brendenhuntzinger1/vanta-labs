"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { products } from "@/lib/demo-data";

type UploadState = "idle" | "uploading" | "done" | "error";

function parseDose(slug: string) {
  const match = slug.match(/(\d+(?:\.\d+)?(?:mg|iu|mcg|g|ml))$/i);
  return match ? match[1].toUpperCase() : "";
}

export default function AdminProductsPage() {
  const [imageOverrides, setImageOverrides] = useState<Record<string, string>>({});
  const [uploadStates, setUploadStates] = useState<Record<string, UploadState>>({});
  const [uploadMessages, setUploadMessages] = useState<Record<string, string>>({});
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  useEffect(() => {
    fetch("/product-images.json")
      .then((r) => r.json())
      .then((data) => setImageOverrides(data))
      .catch(() => {});
  }, []);

  const handleUpload = async (slug: string, file: File) => {
    setUploadStates((s) => ({ ...s, [slug]: "uploading" }));
    setUploadMessages((s) => ({ ...s, [slug]: "Uploading…" }));

    const formData = new FormData();
    formData.append("file", file);
    formData.append("slug", slug);

    try {
      const res = await fetch("/api/admin/upload-image", { method: "POST", body: formData });
      const data = await res.json();
      if (data.success) {
        setImageOverrides((prev) => ({ ...prev, [slug]: data.path + "?t=" + Date.now() }));
        setUploadStates((s) => ({ ...s, [slug]: "done" }));
        setUploadMessages((s) => ({ ...s, [slug]: "✓ Uploaded" }));
      } else {
        throw new Error(data.error);
      }
    } catch (err) {
      setUploadStates((s) => ({ ...s, [slug]: "error" }));
      setUploadMessages((s) => ({ ...s, [slug]: err instanceof Error ? err.message : "Upload failed" }));
    }
  };

  return (
    <div className="vl-page-shell min-h-screen bg-zinc-950 text-zinc-100">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-4 py-4 sm:px-6">
        <div>
          <p className="text-xs uppercase tracking-[0.3em] text-zinc-500">Admin</p>
          <h1 className="mt-1 text-xl font-bold text-white sm:text-2xl">Product Images</h1>
        </div>
        <div className="flex w-full gap-3 sm:w-auto">
          <Link href="/admin/orders" className="vl-btn-secondary vl-focus-ring flex-1 px-4 py-2 text-center text-sm sm:flex-initial">
            Orders
          </Link>
          <Link href="/products" className="vl-btn-secondary vl-focus-ring flex-1 px-4 py-2 text-center text-sm sm:flex-initial">
            View Store
          </Link>
        </div>
      </div>

      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 sm:py-10">
        <p className="mb-7 text-sm text-zinc-400 sm:mb-8">
          Upload a photo for each peptide. Images are saved to <code className="text-zinc-300 bg-zinc-800 px-1.5 py-0.5 rounded text-xs">/public/images/[slug].png</code> and applied site-wide instantly.
        </p>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {products.map((product) => {
            const currentImage = imageOverrides[product.slug] || product.image;
            const hasCustomImage = !!imageOverrides[product.slug];
            const state = uploadStates[product.slug] ?? "idle";
            const message = uploadMessages[product.slug];
            const dose = parseDose(product.slug);

            return (
              <div key={product.slug} className="vl-panel vl-elevate-hover overflow-hidden rounded-xl">
                {/* Image preview */}
                <div
                  className="relative h-40 w-full flex items-center justify-center"
                  style={{ background: "linear-gradient(135deg, #08090f 0%, #0d0f1c 100%)" }}
                >
                  {currentImage && !currentImage.includes(".svg") ? (
                    <img
                      src={currentImage}
                      alt={product.name}
                      className="h-full w-full object-contain"
                      style={{ mixBlendMode: "multiply" }}
                    />
                  ) : (
                    <div className="text-zinc-600 text-xs">No image</div>
                  )}
                  {hasCustomImage && (
                    <div className="absolute top-2 right-2 bg-emerald-500/20 text-emerald-400 text-[9px] font-bold px-2 py-0.5 rounded-full border border-emerald-500/30">
                      Custom
                    </div>
                  )}
                </div>

                {/* Info */}
                <div className="p-3">
                  <p className="text-sm font-bold text-white truncate">{product.name}</p>
                  <p className="text-xs text-zinc-500">{dose} · {product.price}</p>

                  <div className="mt-3">
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      className="hidden"
                      ref={(el) => { inputRefs.current[product.slug] = el; }}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) handleUpload(product.slug, file);
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => inputRefs.current[product.slug]?.click()}
                      disabled={state === "uploading"}
                      className="vl-btn-secondary vl-focus-ring w-full rounded-lg px-3 py-2 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {state === "uploading" ? "Uploading…" : hasCustomImage ? "Replace Image" : "Upload Image"}
                    </button>

                    {message && (
                      <p className={`mt-1.5 text-[11px] ${state === "done" ? "text-emerald-400" : "text-red-400"}`}>
                        {message}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
