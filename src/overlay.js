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

/**
 * Build the transparent SVG text layer. Exported for testing.
 * position: "top" anchors the block near the top edge; "bottom" near the bottom.
 */
export function buildOverlaySvg(line, opts = {}) {
  const position = opts.position === "bottom" ? "bottom" : "top";
  const text = (opts.lowercase === false ? line : line.toLowerCase()).trim();

  let fontSize = 68;
  let rows = null;
  for (const fs of [68, 60, 54, 48, 42, 38]) {
    const r = wrap(text, fs);
    if (r && r.length <= 3) {
      fontSize = fs;
      rows = r;
      break;
    }
  }
  if (!rows) {
    fontSize = 35;
    rows = wrap(text, 35) || [text];
  }

  const lineHeight = Math.round(fontSize * 1.14);
  let firstBaseline;
  if (position === "bottom") {
    const lastBaseline = H - BAND_PAD;
    firstBaseline = lastBaseline - (rows.length - 1) * lineHeight;
  } else {
    firstBaseline = BAND_PAD + fontSize;
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
