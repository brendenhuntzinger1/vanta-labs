import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// I-05 REPRODUCTION, at the helper both upload routes funnel through.
//
//   POST  /api/admin/upload-image           checks the CLIENT-DECLARED file.type
//                                           against an allow-list, caps at 8 MB
//   PATCH /api/admin/products/[productId]   multipart action=upload_image --
//                                           no type check, no size check at all
//
// Both call uploadProductImageToStorage, which never looked at the bytes, took
// the extension from the client's filename, and set the stored contentType from
// the client's declared type -- into a PUBLIC bucket whose URL is attached to a
// product and served from the company's own origin.
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));
vi.mock("@/lib/catalog-cache", () => ({ invalidateCatalogCache: () => {} }));
vi.mock("@/lib/product-image", () => ({ resolveProductImage: () => null }));

const uploads: Array<{ path: string; contentType: string | undefined; size: number }> = [];

vi.mock("@/lib/supabase-server", () => {
  const storage = {
    listBuckets: async () => ({ data: [{ name: "product-images" }], error: null }),
    createBucket: async () => ({ error: null }),
    from: () => ({
      upload: async (path: string, body: Buffer, options: { contentType?: string }) => {
        uploads.push({ path, contentType: options?.contentType, size: body.length });
        return { error: null };
      },
      getPublicUrl: (path: string) => ({ data: { publicUrl: `https://cdn.test/${path}` } }),
    }),
  };
  const from = () => {
    const b: Record<string, unknown> = {
      select() { return b; }, eq() { return b; }, order() { return b; }, limit() { return b; },
      insert: async () => ({ error: null }), update: async () => ({ error: null }),
      maybeSingle: async () => ({ data: null, error: null }),
      then(resolve: (v: { data: unknown; error: unknown }) => unknown) {
        return Promise.resolve({ data: [], error: null }).then(resolve);
      },
    };
    return b;
  };
  return { supabaseAdmin: { storage, from } };
});

/** A File whose declared type is whatever the client says, like any multipart part. */
function forgedFile(name: string, declaredType: string, content: string | Uint8Array) {
  const source = typeof content === "string" ? new TextEncoder().encode(content) : content;
  // Copied into a plain ArrayBuffer: File's BlobPart type rejects a
  // Uint8Array whose backing buffer could be a SharedArrayBuffer.
  const body = new ArrayBuffer(source.byteLength);
  new Uint8Array(body).set(source);
  return new File([body], name, { type: declaredType });
}

const realPng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(32).fill(0)]);

async function upload() {
  return (await import("@/lib/admin-products")).uploadProductImageToStorage;
}

beforeEach(() => {
  uploads.length = 0;
});

describe("I-05 — product image upload must inspect the bytes", () => {
  it("rejects an HTML payload declared as image/png", async () => {
    const run = await upload();
    await expect(run({
      productId: "p1",
      file: forgedFile("payload.html", "image/png", "<!DOCTYPE html><script>alert(1)</script>"),
    })).rejects.toThrow();

    expect(uploads).toHaveLength(0);
  });

  it("rejects an SVG declared as image/png — the classic stored-XSS carrier", async () => {
    const run = await upload();
    await expect(run({
      productId: "p1",
      file: forgedFile("logo.svg", "image/png", '<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'),
    })).rejects.toThrow();

    expect(uploads).toHaveLength(0);
  });

  it("rejects an executable declared as image/webp", async () => {
    const run = await upload();
    await expect(run({
      productId: "p1",
      file: forgedFile("setup.exe", "image/webp", new Uint8Array([0x4d, 0x5a, 0x90, 0x00, ...new Array(32).fill(0)])),
    })).rejects.toThrow();

    expect(uploads).toHaveLength(0);
  });

  it("never lets the client's filename choose the stored extension", async () => {
    const run = await upload();
    await run({ productId: "p1", file: forgedFile("totally.html", "image/png", realPng) });

    expect(uploads).toHaveLength(1);
    expect(uploads[0].path).toMatch(/\.png$/);
    expect(uploads[0].path).not.toContain(".html");
  });

  it("stores the contentType the BYTES say, not the one the client declared", async () => {
    const run = await upload();
    await run({ productId: "p1", file: forgedFile("x.png", "text/html", realPng) });

    expect(uploads[0].contentType).toBe("image/png");
  });

  it("caps size in the helper, so the route that checks nothing inherits the cap", async () => {
    const run = await upload();
    const oversize = new Uint8Array(8 * 1024 * 1024 + 1);
    oversize.set(realPng.slice(0, 8));

    await expect(run({ productId: "p1", file: forgedFile("big.png", "image/png", oversize) })).rejects.toThrow();
    expect(uploads).toHaveLength(0);
  });

  it("still accepts a genuine image — the point is to keep the feature working", async () => {
    const run = await upload();
    const url = await run({ productId: "p1", file: forgedFile("hero.png", "image/png", realPng) });

    expect(uploads).toHaveLength(1);
    expect(url).toContain("https://cdn.test/p1/");
  });
});
