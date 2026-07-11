// src/overlay.js
// Burns a caption onto a photo in the sayso grid style: bold white Archivo
// Black, centered horizontally, anchored to a clear band (top or bottom) so it
// never sits on the face. Crops to 4:5 (Instagram's tallest allowed feed ratio)
// so we control the crop instead of letting Instagram do it.
//
// `position` ("top" | "bottom") is chosen by the vision step based on where the
// face is. Legibility comes from a semi-transparent dark stroke behind the
// white fill (paint-order) — one text layer, so no ghosting/doubling.

import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { ROOT } from "./config.js";

// Point fontconfig at the bundled font before sharp's native lib loads.
const FONT_DIR = join(ROOT, "assets", "fonts");
const FC_PATH = "/tmp/ig-autopilot-fonts.conf";
writeFileSync(
  FC_PATH,
  `<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig>\n  <dir>${FONT_DIR}</dir>\n  <cachedir>/tmp/ig-autopilot-fontcache</cachedir>\n</fontconfig>\n`
);
process.env.FONTCONFIG_FILE = FC_PATH;
const sharp = (await import("sharp")).default;

const W = 1080;
const H = 1350; // 4:5
const SIDE_PAD = 70;
const BAND_PAD = Math.round(H * 0.06); // gap from top/bottom edge
const FACE_GAP = Math.round(H * 0.045); // hard safety gap between text and face
// Where we assume the face sits (as a fraction of the 4:5 frame) if the vision
// step doesn't report one — a centered portrait, leaving top & bottom clear.
const DEFAULT_FACE_BAND = { top: 0.28, bottom: 0.74 };
const FONT_STEPS = [68, 60, 54, 48, 42, 38, 34, 30];

function esc(s) {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function wrap(text, fontSize) {
  const maxChars = Math.floor((W - 2 * SIDE_PAD) / (fontSize * 0.6));
  const words = text.split(/\s+/);
  const rows = [];
  let cur = "";
  for (const w of words) {
    if (w.length > maxChars) return null;
    if ((cur + " " + w).trim().length <= maxChars) cur = (cur + " " + w).trim();
    else {
      rows.push(cur);
      cur = w;
    }
  }
  if (cur) rows.push(cur);
  return rows;
}

const clamp01 = (n) => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));

/** Largest font whose wrapped block (≤4 rows) fits within `availH` px. */
function fitToHeight(text, availH) {
  for (const fs of FONT_STEPS) {
    const rows = wrap(text, fs);
    if (!rows || rows.length > 4) continue;
    const lineHeight = Math.round(fs * 1.14);
    if (rows.length * lineHeight <= availH) {
      return { fontSize: fs, rows, lineHeight };
    }
  }
  return null;
}

/**
 * Build the transparent SVG text layer. Exported for testing.
 *
 * Places the caption in the clear band (top or bottom) furthest from the face,
 * sized so the block never crosses into the face region + a safety gap. Falls
 * back to the other band, then to the roomier band at min size, if needed.
 *
 * opts.faceBand: { top, bottom } as fractions (0=top edge, 1=bottom) of the
 * final 4:5 frame — the vertical span the head/face occupies.
 */
export function buildOverlaySvg(line, opts = {}) {
  const text = (opts.lowercase === false ? line : line.toLowerCase()).trim();
  const fb = opts.faceBand || DEFAULT_FACE_BAND;
  const faceTop = clamp01(fb.top) * H;
  const faceBottom = clamp01(fb.bottom) * H;

  // Clear regions above and below the face (with a safety gap).
  const topRegion = { a: BAND_PAD, b: Math.max(BAND_PAD, faceTop - FACE_GAP) };
  const botRegion = { a: Math.min(H - BAND_PAD, faceBottom + FACE_GAP), b: H - BAND_PAD };
  const heightOf = (r) => Math.max(0, r.b - r.a);

  const requested = opts.position === "bottom" ? "bottom" : "top";
  let position = requested;
  let region = position === "bottom" ? botRegion : topRegion;
  let fit = fitToHeight(text, heightOf(region));

  // Doesn't fit the requested band? Try the other one.
  if (!fit) {
    const other = position === "bottom" ? "top" : "bottom";
    const otherRegion = other === "bottom" ? botRegion : topRegion;
    const otherFit = fitToHeight(text, heightOf(otherRegion));
    if (otherFit) {
      position = other;
      region = otherRegion;
      fit = otherFit;
    }
  }
  // Still nothing (face nearly fills the frame): use the roomier band, min font.
  if (!fit) {
    const useTop = heightOf(topRegion) >= heightOf(botRegion);
    position = useTop ? "top" : "bottom";
    region = useTop ? topRegion : botRegion;
    const fs = 30;
    fit = { fontSize: fs, rows: wrap(text, fs) || [text], lineHeight: Math.round(fs * 1.14) };
  }

  const { fontSize, rows, lineHeight } = fit;
  let firstBaseline;
  if (position === "bottom") {
    firstBaseline = region.b - (rows.length - 1) * lineHeight;
  } else {
    firstBaseline = region.a + fontSize;
  }

  const tspans = rows
    .map((r, i) => `<tspan x="${W / 2}" y="${firstBaseline + i * lineHeight}">${esc(r)}</tspan>`)
    .join("");

  // Clean white text with a soft drop shadow only — no outline/border.
  return (
    `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">` +
    `<defs><filter id="ds" x="-20%" y="-20%" width="140%" height="140%">` +
    `<feDropShadow dx="0" dy="3" stdDeviation="4" flood-color="#000000" flood-opacity="0.42"/>` +
    `</filter></defs>` +
    `<text font-family="Archivo Black" font-size="${fontSize}" text-anchor="middle" ` +
    `fill="#FFFFFF" filter="url(#ds)">${tspans}</text>` +
    `</svg>`
  );
}

/** Crop `inputPath` to 4:5, overlay `line` in the chosen band, write JPEG. */
export async function overlayCaption(inputPath, line, outPath, opts = {}) {
  const gravity = opts.gravity || "centre";
  const base = await sharp(inputPath)
    .rotate() // respect EXIF orientation
    .resize(W, H, { fit: "cover", position: gravity })
    .toBuffer();

  const svg = buildOverlaySvg(line, opts);
  await sharp(base)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 92 })
    .toFile(outPath);
  return outPath;
}
