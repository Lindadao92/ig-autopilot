// src/create.js
// The content factory: keeps the queue full forever, no photos required.
//
// 1. Counts how many scheduled posts are still in the future.
// 2. If below target, asks Claude for fresh one-liners in your brand voice
//    (avoiding every line it has ever used — history in content/lines.json).
// 3. Renders each line as a branded statement card (1080x1350 JPEG) into
//    media/, where the autopilot picks it up, captions it, and schedules it.
//
// Run:  node src/create.js            (top up the queue)
//       node src/create.js --sample "some line here"   (render one test card)
//
// Tuning (env or repo Variables):
//   REFILL_TARGET_POSTS=7   keep this many future posts queued

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { config, requireAnthropicConfig, ROOT } from "./config.js";

// Point fontconfig at our bundled font BEFORE sharp's native lib loads.
const FONT_DIR = join(ROOT, "assets", "fonts");
const FC_PATH = "/tmp/ig-autopilot-fonts.conf";
writeFileSync(
  FC_PATH,
  `<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig>\n  <dir>${FONT_DIR}</dir>\n  <cachedir>/tmp/ig-autopilot-fontcache</cachedir>\n</fontconfig>\n`
);
process.env.FONTCONFIG_FILE = FC_PATH;
const sharp = (await import("sharp")).default;

const MEDIA_DIR = join(ROOT, "media");
const QUEUE_PATH = join(ROOT, "content", "queue.json");
const LINES_PATH = join(ROOT, "content", "lines.json");
const BRAND_PATH = join(ROOT, "brand.json");

const TARGET = parseInt(process.env.REFILL_TARGET_POSTS || "7", 10);

const W = 1080;
const H = 1350; // 4:5 portrait — max feed real estate
const PAD = 110;

// Rotating colorways. Bold, minimal, streetwear-adjacent.
const PALETTES = [
  { bg: "#0B0B0B", fg: "#FFFFFF" }, // black
  { bg: "#F3ECDF", fg: "#141414" }, // cream
  { bg: "#D64545", fg: "#FFFFFF" }, // red pop
  { bg: "#BFCBD6", fg: "#141414" }, // dusty blue
];

function esc(s) {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Greedy word-wrap for a given font size. Returns null if a word can't fit. */
function wrap(line, fontSize) {
  const maxChars = Math.floor((W - 2 * PAD) / (fontSize * 0.64));
  const words = line.split(/\s+/);
  const rows = [];
  let cur = "";
  for (const w of words) {
    if (w.length > maxChars) return null; // single word too wide at this size
    if ((cur + " " + w).trim().length <= maxChars) {
      cur = (cur + " " + w).trim();
    } else {
      rows.push(cur);
      cur = w;
    }
  }
  if (cur) rows.push(cur);
  return rows;
}

/** Build the statement-card SVG for one line. Exported for testing. */
export function buildCardSvg(line, palette, watermark = "@2girls1cap_") {
  const text = line.toLowerCase().trim();
  let fontSize = 96;
  let rows = null;
  for (const fs of [96, 88, 80, 72, 64, 56, 48]) {
    const r = wrap(text, fs);
    if (r && r.length <= 6) {
      fontSize = fs;
      rows = r;
      break;
    }
  }
  if (!rows) {
    fontSize = 44;
    rows = wrap(text, 44) || [text];
  }
  const lineHeight = Math.round(fontSize * 1.18);
  const blockH = (rows.length - 1) * lineHeight;
  const firstBaseline = Math.round(H / 2 - blockH / 2 + fontSize * 0.35);

  const tspans = rows
    .map(
      (r, i) =>
        `<tspan x="${W / 2}" y="${firstBaseline + i * lineHeight}">${esc(r)}</tspan>`
    )
    .join("");

  return (
    `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">` +
    `<rect width="100%" height="100%" fill="${palette.bg}"/>` +
    `<text font-family="Archivo Black" font-size="${fontSize}" fill="${palette.fg}" text-anchor="middle">${tspans}</text>` +
    `<text x="${W / 2}" y="${H - 64}" font-family="Archivo Black" font-size="30" fill="${palette.fg}" fill-opacity="0.55" text-anchor="middle">${esc(watermark)}</text>` +
    `</svg>`
  );
}

export async function renderCard(line, outPath, index = 0) {
  const palette = PALETTES[index % PALETTES.length];
  const svg = buildCardSvg(line, palette);
  await sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toFile(outPath);
  return outPath;
}

function slug(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 36);
}

async function generateLines(brand, history, count) {
  const system = [
    "You write one-liners for the brand below. These lines get printed as",
    "statement cards (and the best ones become embroidered caps), so each line",
    "must stand completely alone.",
    "",
    "BRAND:",
    JSON.stringify(brand, null, 2),
    "",
    "RULES:",
    "- 4 to 12 words. Lowercase. No hashtags, no emojis, no quotes around it.",
    "- The brand's registers: dating/ex/situationship humor, money/work humor,",
    "  self-aware chaos, deadpan confidence. Rotate between them.",
    "- Punchline structures beat statements: reversal, escalation, misdirection.",
    "- Must be ORIGINAL: nothing resembling the used-lines list below, and no",
    "  well-known meme phrasings.",
    "",
    "ALREADY USED (never repeat or closely echo):",
    JSON.stringify(history.slice(-150)),
    "",
    "OUTPUT: only valid JSON, no fences:",
    '{ "lines": [ string, ... ] }',
  ].join("\n");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": config.anthropicApiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: config.anthropicModel,
      max_tokens: 1200,
      system,
      messages: [
        { role: "user", content: `Write ${count} new lines.` },
      ],
    }),
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(`Anthropic API error: ${JSON.stringify(data.error || data)}`);
  }
  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  const cleaned = text.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const { lines = [] } = JSON.parse(cleaned);
  return lines
    .map((l) => String(l).replace(/^["'\s]+|["'\s]+$/g, ""))
    .filter((l) => l && l.length <= 90);
}

async function main() {
  // Test mode: render one card without calling any API.
  const sampleIdx = process.argv.indexOf("--sample");
  if (sampleIdx !== -1) {
    const line = process.argv[sampleIdx + 1] || "my toxic trait is thinking the group chat counts as therapy";
    const out = "/tmp/sample-card.jpg";
    await renderCard(line, out, Math.floor(Math.random() * PALETTES.length));
    console.log(`Sample card rendered: ${out}`);
    return;
  }

  requireAnthropicConfig();

  const queue = existsSync(QUEUE_PATH)
    ? JSON.parse(readFileSync(QUEUE_PATH, "utf8"))
    : [];
  const brand = existsSync(BRAND_PATH)
    ? JSON.parse(readFileSync(BRAND_PATH, "utf8"))
    : {};
  const history = existsSync(LINES_PATH)
    ? JSON.parse(readFileSync(LINES_PATH, "utf8"))
    : [];

  const now = Date.now();
  const futureCount = queue.filter(
    (i) => i.status === "scheduled" && i.publish_at && Date.parse(i.publish_at) > now
  ).length;

  const needed = Math.min(TARGET - futureCount, 7);
  if (needed <= 0) {
    console.log(`Queue is topped up (${futureCount} future posts >= target ${TARGET}).`);
    return;
  }
  console.log(`Queue has ${futureCount} future post(s); generating ${needed} card(s)...`);

  const lines = await generateLines(brand, history, needed);
  if (!existsSync(MEDIA_DIR)) mkdirSync(MEDIA_DIR, { recursive: true });

  const dateStr = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  let made = 0;
  for (const line of lines.slice(0, needed)) {
    const file = `gen-${dateStr}-${String(made + 1).padStart(2, "0")}-${slug(line)}.jpg`;
    await renderCard(line, join(MEDIA_DIR, file), history.length + made);
    history.push(line);
    made++;
    console.log(`  card: ${file}  ("${line}")`);
  }

  writeFileSync(LINES_PATH, JSON.stringify(history, null, 2) + "\n");
  console.log(
    `${made} card(s) written to media/. Run autopilot to caption + schedule them.`
  );
}

// Run main only when executed directly (lets tests import the renderer).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
