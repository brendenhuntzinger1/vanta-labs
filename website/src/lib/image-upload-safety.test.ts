import { describe, expect, it } from "vitest";
import { imageExtensionFor, MAX_PRODUCT_IMAGE_BYTES, sniffImageType } from "@/lib/image-upload-safety";

// ---------------------------------------------------------------------------
// I-05. The product-image upload trusted `file.type` -- the Content-Type the
// client wrote into its own multipart part -- and took the stored filename's
// extension verbatim, into a PUBLIC bucket whose URL is attached to a product.
// The bytes were never looked at.
//
// The COA path in this same codebase already does it correctly
// (admin-coa.ts:234-257: size cap, declared-type allow-list, magic-byte sniff,
// extension AND contentType derived from the SNIFFED type). This is the same
// discipline for the image allow-list, which differs from the COA one: no PDF,
// plus GIF and AVIF.
// ---------------------------------------------------------------------------

const bytes = (...values: number[]) => new Uint8Array([...values, ...new Array(24).fill(0)]);
const ascii = (text: string) => Array.from(text, (character) => character.charCodeAt(0));

const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0);
const GIF87 = bytes(...ascii("GIF87a"));
const GIF89 = bytes(...ascii("GIF89a"));
const WEBP = bytes(...ascii("RIFF"), 0x20, 0x00, 0x00, 0x00, ...ascii("WEBP"));
const AVIF = bytes(0x00, 0x00, 0x00, 0x20, ...ascii("ftyp"), ...ascii("avif"));
const AVIS = bytes(0x00, 0x00, 0x00, 0x20, ...ascii("ftyp"), ...ascii("avis"));

describe("I-05 — the bytes decide the type, not the client", () => {
  it.each([
    ["PNG", PNG, "image/png", "png"],
    ["JPEG", JPEG, "image/jpeg", "jpg"],
    ["GIF87a", GIF87, "image/gif", "gif"],
    ["GIF89a", GIF89, "image/gif", "gif"],
    ["WEBP", WEBP, "image/webp", "webp"],
    ["AVIF", AVIF, "image/avif", "avif"],
    ["AVIF sequence", AVIS, "image/avif", "avif"],
  ])("accepts a real %s and derives its own extension", (_label, input, mime, extension) => {
    expect(sniffImageType(input)).toBe(mime);
    expect(imageExtensionFor(sniffImageType(input)!)).toBe(extension);
  });

  it.each([
    ["HTML", ascii("<!DOCTYPE html><script>alert(1)</script>")],
    ["SVG", ascii('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>')],
    ["PDF", ascii("%PDF-1.7")],
    ["ZIP", [0x50, 0x4b, 0x03, 0x04]],
    ["ELF", [0x7f, 0x45, 0x4c, 0x46]],
    ["Windows PE", ascii("MZ")],
    ["shell script", ascii("#!/bin/sh\nrm -rf /")],
  ])("rejects %s no matter what Content-Type the client declared", (_label, payload) => {
    expect(sniffImageType(bytes(...payload))).toBeNull();
  });

  it("rejects a file too short to identify rather than guessing", () => {
    expect(sniffImageType(new Uint8Array([0x89, 0x50]))).toBeNull();
    expect(sniffImageType(new Uint8Array())).toBeNull();
    // The case that actually exercises the minimum-length guard: "GIF8" is a
    // complete GIF signature in 4 bytes, so without the guard a 4-byte file
    // classifies as a real image. A negative-control mutation found this gap.
    expect(sniffImageType(new Uint8Array(ascii("GIF8")))).toBeNull();
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull();
  });

  it("is not fooled by an image extension or a spoofed magic prefix on the wrong container", () => {
    // "RIFF" without "WEBP" at offset 8 is a WAV or an AVI, not an image.
    const wav = bytes(...ascii("RIFF"), 0x20, 0x00, 0x00, 0x00, ...ascii("WAVE"));
    expect(sniffImageType(wav)).toBeNull();
    // ISO-BMFF with a non-AVIF brand is an MP4, not an image.
    const mp4 = bytes(0x00, 0x00, 0x00, 0x20, ...ascii("ftyp"), ...ascii("isom"));
    expect(sniffImageType(mp4)).toBeNull();
  });

  it("caps size at the documented 8 MB", () => {
    expect(MAX_PRODUCT_IMAGE_BYTES).toBe(8 * 1024 * 1024);
  });
});
