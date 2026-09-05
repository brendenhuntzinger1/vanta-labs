#!/usr/bin/env node
/**
 * Re-master the homepage hero media so a bright studio background can never
 * reach a screen edge.
 *
 * WHY THIS EXISTS
 *
 * The hero clip is a beautiful product film — and it is shot high-key, on a
 * white studio background. Measured on frame 60 of the shipped file, the median
 * luminance is 217/255 and the four corners sit between 172 and 200. It is, in
 * the most literal sense, a white square with a vial in the middle.
 *
 * Every "white box round the vial" report traces back to that one fact. The
 * asset has no alpha channel and never had one; nothing about it is
 * transparent. What made the page look right was CSS drawn OVER it — an
 * opacity, a scrim, and latterly a `mask-image` vignette. Wherever that CSS did
 * not fully apply, the raw asset showed through as exactly what it is:
 *
 *   * an in-app WebView that ignores or mis-composites `mask-image` paints the
 *     unmasked rectangle;
 *   * iOS handing the clip to its native fullscreen player paints it with no
 *     page CSS at all — "the vial alone on white", the symptom that has been
 *     reported from TikTok, Instagram and Snapchat;
 *   * opening the media URL directly does the same.
 *
 * So the fix cannot live in CSS. It has to live in the pixels: the media is
 * re-mastered with a vignette burned in, falling to true black before the frame
 * border on every side. After this, there is no rendering path — no browser, no
 * player, no failed mask — that can show a bright edge, because the asset no
 * longer has one.
 *
 * This is deliberately a GUARD, not the composition. It is gentle in the middle
 * (the vial is untouched) and absolute at the border. The visible falloff that
 * blends the shot into the page is applied as real alpha by the canvas in
 * `hero-video.tsx`; this makes sure that even when that alpha is not there, the
 * result is on-brand rather than a white panel.
 *
 * Run:  node scripts/build-hero-media.mjs
 * Needs ffmpeg. Outputs are committed; this only has to be re-run if the source
 * film is replaced.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PUBLIC = new URL("../public/", import.meta.url).pathname;

/**
 * The un-processed master: 960x960, H.264 Main, with an audio track. BOTH
 * outputs are derived from it, so re-running this script is idempotent — it
 * never reads a file it has already written and the vignette can never be
 * applied twice.
 *
 * NOT UNDER public/. The master is 6.2 MB — 80% of everything the site shipped
 * as static assets — and nothing on the site referenced it; only this script
 * did. It is kept with the design sources instead. Pass its location with
 * HERO_MASTER_VIDEO=/path/to/vanta-labs-hero.mp4 (or drop a copy at the old
 * path locally; it is gitignored-by-absence, never committed).
 */
const MASTER_VIDEO = process.env.HERO_MASTER_VIDEO || join(PUBLIC, "videos/vanta-labs-hero.mp4");
if (!existsSync(MASTER_VIDEO)) {
  console.error(
    `Master hero video not found at ${MASTER_VIDEO}.\n` +
    "It is not committed (6.2 MB, referenced by nothing on the site). Point HERO_MASTER_VIDEO at the design-source copy.",
  );
  process.exit(1);
}
/** What the page actually loads: 720x720, Constrained Baseline, no audio. */
const OUT_VIDEO = join(PUBLIC, "videos/vanta-labs-hero-opt.mp4");
const OUT_POSTER = join(PUBLIC, "images/hero-vial-poster.jpg");
/** The same film, rotated for phones. See LOOP_START. */
const OUT_VIDEO_PHONE = join(PUBLIC, "videos/vanta-labs-hero-phone.mp4");
const OUT_POSTER_PHONE = join(PUBLIC, "images/hero-vial-poster-phone.jpg");
/**
 * WHERE THE PHONE'S LOOP STARTS, AND WHY ONLY THE PHONE'S.
 *
 * The vial's printed label — "VANTA LABS / GHK-Cu / 50 mg" — is black type on
 * white at roughly the size of the homepage headline. On a phone the hero is
 * full bleed and the copy sits ON the picture, so the two land in the same
 * place. That collision cannot be scrimmed away: a wash multiplies the label's
 * white AND its black by the same factor, so the ratio the eye reads type by
 * survives any alpha. Measured at 390x844 with the copy hidden, the ground
 * behind the headline was 43/255 — well inside the 118 that white type needs
 * for 4.5:1 — and "GHK-Cu" still read straight across it. Cropping the frame
 * instead was tried and taken back out: it magnified the shot 43% and cost the
 * hero a third of its light.
 *
 * The film solves it. The vial turns, and for frames 136-184 the label is
 * edge-on and not legible at all — measured across all 241 frames by horizontal
 * edge energy over the label band, 43 facing camera against 3-7 through that
 * window. Rotating the loop to start there gives a phone an opening with no
 * type in it to compete with the headline.
 *
 * A WIDE SCREEN GETS THE FILM AS SHOT, AND THAT IS DELIBERATE. Its copy is a
 * column on the LEFT and the vial is biased right, so the two never touch —
 * there is no collision to fix. And the turned-away window is not a free
 * substitution: the vial has descended into water by then, so it is a moodier,
 * darker setup than the studio opening. Rendered at 1440x900 it is visibly less
 * clean than what ships today. A phone-only asset costs a second file that only
 * phones fetch; giving it to everyone would cost the desktop hero.
 *
 * The rotation itself is free. The film's own wrap (frame 240 -> 0) measures a
 * 9.6/255 step, and re-ordering as [136..240, 0..135] simply moves that step
 * into the middle of the loop; the new wrap is 135 -> 136, two adjacent frames,
 * measured at 3.5 — the same as ordinary motion, and smoother than the join it
 * replaces.
 *
 * Set this to 0 and the phone pair becomes a copy of the desktop pair.
 */
const LOOP_START = 136;

/**
 * The still is always the clip's OWN first frame.
 *
 * It used to be master frame 29, chosen to match the shipped poster while the
 * clip also started at zero. The rule underneath has not changed and is the one
 * that matters: a still that is not the clip's opening frame shows up as a jump
 * the moment playback starts. Deriving both from one frame number per variant
 * keeps that true by construction rather than by luck.
 */
const POSTER_FRAME = 0;

/**
 * The guard vignette, in normalised frame coordinates where the centre is 0 and
 * an edge midpoint is 1.
 *
 * START is where the shot begins to give way; END is where it is fully black.
 * END is at 1.0 exactly, which is what makes the guarantee total: every pixel
 * on the border sits at radius >= 1 (the corners at 1.41), so the whole
 * perimeter is black by construction rather than by eye. `hero-video.test.ts`
 * asserts it by sampling the shipped files.
 *
 * START at 0.66, AND IT WAS BRIEFLY 0.50, WHICH WAS WRONG.
 *
 * At 0.50 this stopped being a guard and became the composition: it ate the
 * studio backdrop from the vial's shoulders outward, and with the media also
 * blended further into the page, the hero went from a lit photograph to a small
 * object on a black field. The owner's words were "why is it all black, it never
 * was like that", and they were right — killing the rectangle never required
 * killing the light.
 *
 * 0.66 is the honest line for a guard. The subject spans radius 0.76 at the cap
 * and 0.69 at the base, so the ramp still only reaches the vial at its black cap
 * and clear glass base, where dimming costs nothing. Everything inside — the
 * label at 0.4, the shoulders at 0.45, and the lit backdrop that gives the hero
 * its glow — is untouched. The perimeter is still absolutely black, which is the
 * only thing this file has to guarantee.
 */
const START = 0.66;
const END = 1.0;

/**
 * Smootherstep (6t^5 - 15t^4 + 10t^3), not smoothstep.
 *
 * Its second derivative is zero at both ends as well as its first, so the ramp
 * has no onset. Smoothstep over the same span leaves a visible dark ring where
 * the falloff begins — a porthole around the vial, which is a different edge
 * artefact, not an improvement on the one being removed.
 */
const alphaExpr = (size) => {
  const c = size / 2;
  const r = `hypot((X-${c})/${c},(Y-${c})/${c})`;
  const t = `clip((${r}-${START})/(${END}-${START}),0,1)`;
  return `255*(${t})*(${t})*(${t})*((${t})*((${t})*6-15)+10)`;
};

const run = (args) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: "inherit" });

const tmp = mkdtempSync(join(tmpdir(), "hero-media-"));
try {
  for (const size of [720, 960]) {
    run([
      "-f", "lavfi", "-i", `color=c=black:s=${size}x${size}:d=0.04`,
      "-vf", `format=rgba,geq=r=0:g=0:b=0:a='${alphaExpr(size)}'`,
      "-frames:v", "1", join(tmp, `vignette-${size}.png`),
    ]);
  }

  // VIDEO. Re-encoded from the 960 master rather than from the shipped 720 file,
  // so the vignette costs one generation instead of two. Everything else about
  // the output is what the page already loads: 720x720, 24 fps, Constrained
  // Baseline (the profile every WebView decodes), yuv420p, no audio track — an
  // audio track is one of the things that makes iOS treat a background clip as
  // media the visitor asked for.
  //
  // Processed in 10-bit and dithered back down: crushing a smooth studio
  // gradient towards black in 8 bits bands visibly.
  //
  // `startFrame` rotates the loop: 0 is the film as shot, which is what a wide
  // screen gets. See LOOP_START for why a phone gets a different one and why
  // re-ordering the frames costs nothing.
  const encode = (startFrame, out) => {
    const rotate = startFrame
      ? "split=2[s0][s1];" +
        `[s0]trim=start_frame=${startFrame},setpts=PTS-STARTPTS[tail];` +
        `[s1]trim=end_frame=${startFrame},setpts=PTS-STARTPTS[head];` +
        "[tail][head]concat=n=2:v=1:a=0[v];"
      : "null[v];";
    run([
      "-i", MASTER_VIDEO,
      "-i", join(tmp, "vignette-720.png"),
      "-filter_complex",
      // Rotated BEFORE the vignette is overlaid, so every output frame carries
      // the guard whichever order the frames end up in.
      `[0:v]scale=720:720:flags=lanczos,format=gbrp10le,format=rgba,${rotate}` +
        "[v][1:v]overlay=0:0,format=yuv420p",
      "-an",
      "-c:v", "libx264", "-profile:v", "baseline", "-level", "3.1",
      "-preset", "veryslow", "-crf", "26", "-maxrate", "700k", "-bufsize", "1400k",
      "-pix_fmt", "yuv420p", "-r", "24", "-g", "48",
      "-movflags", "+faststart",
      out,
    ]);
  };

  // POSTER, at the master's own 960x960.
  //
  // Ending the chain in rgb24 and letting the JPEG encoder do the final
  // conversion is load-bearing. Handing it `format=yuvj420p` instead tags the
  // overlay chain limited-range, and pure black comes out at 16/255 — a grey
  // border, which is precisely the edge this script exists to remove. Measured
  // both ways; the corner pixel is 16,16,16 one way and 0,0,0 the other.
  //
  // The frame is the clip's own opening one, so the still and the first painted
  // video frame are the same picture and playback cannot start with a jump.
  const still = (frame, out, name) => {
    run([
      "-i", MASTER_VIDEO,
      "-i", join(tmp, "vignette-960.png"),
      "-filter_complex",
      `[0:v]select='eq(n\\,${frame})',format=gbrp10le,format=rgba[v];` +
        "[v][1:v]overlay=0:0,format=rgb24",
      "-frames:v", "1", "-pix_fmt", "yuvj420p", "-q:v", "4",
      join(tmp, name),
    ]);
    execFileSync("cp", [join(tmp, name), out]);
  };

  // The film as shot, for every screen wide enough to put its copy beside the
  // vial rather than on it.
  encode(POSTER_FRAME, OUT_VIDEO);
  still(POSTER_FRAME, OUT_POSTER, "poster.jpg");

  // And the phone's, rotated to the window where the label is turned away.
  encode(LOOP_START, OUT_VIDEO_PHONE);
  still(LOOP_START, OUT_POSTER_PHONE, "poster-phone.jpg");

  for (const f of [OUT_VIDEO, OUT_POSTER, OUT_VIDEO_PHONE, OUT_POSTER_PHONE]) {
    console.log(`${f.replace(PUBLIC, "public/")}  ${(statSync(f).size / 1024).toFixed(1)} KB`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
