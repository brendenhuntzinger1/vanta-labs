import Image from "next/image";
import { PLACEHOLDER_IMAGE_PATHS, resolveProductImage } from "@/lib/product-image";

/**
 * The hero and bulk visuals, composed from real catalogue photography.
 *
 * There is no bulk product shot in this repository — only a logo, an OG image
 * and a placeholder. Rather than drop in stock photography of somebody else's
 * vials, or leave the dark rectangle that made the first version of this page
 * look unfinished, the composition is assembled from the product photographs
 * the catalogue already has: one vial in front, two set back and dimmed, on a
 * single soft light source.
 *
 * Depth comes from scale, offset, blur and opacity — not from a second copy of
 * the same image at full strength, which reads as a mistake rather than as
 * distance. Every layer keeps its own aspect ratio and uses object-contain, so
 * nothing is stretched to fill a frame.
 *
 * When the catalogue has no usable photography the whole composition is
 * withheld and the caller renders a typographic panel instead. A stack of three
 * grey placeholders would be worse than the empty rectangle it replaced.
 */

export type StackImage = { src: string; alt: string };

/** Photographs only — a placeholder is not product imagery and must not stack. */
export function selectStackImages(
  products: { name: string; image?: string | null; coverImage?: string | null }[],
  limit = 3,
): StackImage[] {
  const seen = new Set<string>();
  const picked: StackImage[] = [];

  for (const product of products) {
    const src = resolveProductImage(product.coverImage ?? product.image);
    if (PLACEHOLDER_IMAGE_PATHS.includes(src)) continue;
    if (seen.has(src)) continue;
    seen.add(src);
    picked.push({ src, alt: product.name });
    if (picked.length >= limit) break;
  }

  return picked;
}

export function WholesaleVialStack({ images, priority = false }: { images: StackImage[]; priority?: boolean }) {
  if (images.length === 0) return null;

  const [front, ...behind] = images;

  return (
    <div className="relative isolate mx-auto aspect-square w-full max-w-[380px] sm:max-w-[460px] lg:max-w-[560px]">
      {/* One light source for the whole composition. Every panel on the old
          page had its own glow, which flattened the page rather than lighting
          it. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-1/2 h-[70%] w-[70%] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[color:var(--accent-gold)]/[0.06] blur-3xl"
      />

      {/* Set back: smaller, dimmed and softened so they read as distance. */}
      {behind[0] ? (
        <div className="absolute left-0 top-[14%] h-[62%] w-[46%] opacity-45 blur-[1.5px]">
          <Image src={behind[0].src} alt="" fill sizes="(max-width: 640px) 175px, 260px" className="object-contain" />
        </div>
      ) : null}
      {behind[1] ? (
        <div className="absolute right-[2%] top-[8%] h-[56%] w-[42%] opacity-35 blur-[2px]">
          <Image src={behind[1].src} alt="" fill sizes="(max-width: 640px) 160px, 235px" className="object-contain" />
        </div>
      ) : null}

      {/* Foreground. The only layer that carries alt text — the others are
          decorative duplicates of products named elsewhere on the page. */}
      <div className="absolute bottom-0 left-1/2 h-[84%] w-[62%] -translate-x-1/2 drop-shadow-[0_30px_60px_rgba(0,0,0,0.85)]">
        <Image
          src={front.src}
          alt={front.alt}
          fill
          sizes="(max-width: 640px) 236px, (max-width: 1024px) 285px, 347px"
          className="object-contain"
          priority={priority}
        />
      </div>

      {/* Grounds the stack so the vials sit on a surface rather than float. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-[8%] bottom-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent"
      />
    </div>
  );
}
