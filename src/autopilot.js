// src/autopilot.js
// The "drop a selfie, get a post" pipeline.
//
// Scans media/ for NEW photos (skips anything already in the queue), has Claude
// LOOK at each one and (a) write a one-liner in the sayso voice and (b) say
// which band — top or bottom — is clear of the face. It burns the line onto the
// photo in the brand font, reuses the same line as the post caption, and
// schedules it on your cadence. The publisher posts it when the time comes.
//
// Run:  node src/autopilot.js             (caption + schedule new selfies)
//       node src/autopilot.js --review    (add as drafts for approval instead)
//
// Cadence (env or GitHub repo Variables):
//   POST_DAYS      default "MON,TUE,WED,THU,FRI,SAT,SUN"  (daily)
//   POST_TIME_UTC  default "17:00"                        (19:00 Berlin / 10am SF)

import {
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  statSync,
} from "node:fs";
import { join, extname, basename } from "node:path";
import { config, requireAnthropicConfig, ROOT } from "./config.js";
import { overlayCaption } from "./overlay.js";

const MEDIA_DIR = join(ROOT, "media");
const RENDERED_DIR = join(ROOT, "media", "rendered");
const QUEUE_PATH = join(ROOT, "content", "queue.json");
const BRAND_PATH = join(ROOT, "brand.json");
const LINES_PATH = join(ROOT, "content", "lines.json");

const DAY_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

export const cadence = {
  days: (process.env.POST_DAYS || "MON,TUE,WED,THU,FRI,SAT,SUN")
    .split(",")
    .map((s) => s.trim().toUpperCase()),
  timeUtc: process.env.POST_TIME_UTC || "17:00",
};

export function nextSlot(afterMs, cad = cadence) {
  const [hh, mm] = cad.timeUtc.split(":").map(Number);
  const base = new Date(afterMs);
  for (let i = 0; i <= 14; i++) {
    const cand = Date.UTC(
      base.getUTCFullYear(),
      base.getUTCMonth(),
      base.getUTCDate() + i,
      hh,
      mm,
      0,
      0
    );
    if (cand > afterMs && cad.days.includes(DAY_NAMES[new Date(cand).getUTCDay()])) {
      return new Date(cand);
    }
  }
  throw new Error(`No posting day within 14 days — check POST_DAYS.`);
}

/** Already scheduled/posted? Matched by the ORIGINAL source filename. */
export function isQueued(queue, filename) {
  return queue.some((item) => item.source_file === filename);
}

export function publicUrlFor(relPath) {
  if (config.mediaBaseUrl) {
    return `${config.mediaBaseUrl.replace(/\/$/, "")}/${relPath}`;
  }
  const repo = process.env.GITHUB_REPOSITORY;
  if (repo) {
    const branch = process.env.GITHUB_REF_NAME || "main";
    return `https://raw.githubusercontent.com/${repo}/${branch}/${relPath
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`;
  }
  throw new Error(
    "Can't build a public URL: set MEDIA_BASE_URL, or run inside GitHub Actions on a PUBLIC repo."
  );
}

function slug(s) {
  return s
    .toLowerCase()
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

function buildVisionSystem(brand) {
  return [
    "You are the voice of the brand below. You'll be shown ONE selfie. Do two jobs.",
    "",
    "BRAND:",
    JSON.stringify(brand, null, 2),
    "",
    "JOB 1 — WRITE THE LINE:",
    "- One original one-liner in the brand voice, to be printed ON the photo AND",
    "  used as the caption. 4-13 words. Lowercase. No hashtags, no emojis, no quotes.",
    "- Match the registers and structures in the brand. It must sound like the",
    "  voice_examples — deadpan, unhinged-confident, a punchline. Never wholesome.",
    "- You MAY riff on what's in the photo (wine, travel, an outfit, a mood) but",
    "  the joke leads; the photo is just the excuse.",
    "- Do NOT reuse or closely echo any voice_example or any line in the used list.",
    "",
    "JOB 2 — PLACE THE TEXT (so it never covers the face):",
    "- Report where the face is and which horizontal band is clearest for text.",
    '- "position": "top" if the area above the face is clearer, "bottom" if below is clearer.',
    "",
    "OUTPUT: return ONLY valid JSON, no fences, exactly:",
    '{ "line": string, "position": "top" | "bottom", "alt_text": string }',
    "alt_text = one factual sentence describing the photo (accessibility).",
  ].join("\n");
}

async function analyzePhoto(filePath, filename, brand, usedLines) {
  const b64 = readFileSync(filePath).toString("base64");
  const ext = extname(filename).toLowerCase();
  const mediaType = ext === ".png" ? "image/png" : "image/jpeg";
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": config.anthropicApiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: config.anthropicModel,
      max_tokens: 800,
      system: buildVisionSystem(brand),
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: b64 } },
            {
              type: "text",
              text:
                `Recently used lines (avoid echoing):\n${JSON.stringify(usedLines.slice(-120))}\n\n` +
                "Write the line and report text placement for this selfie.",
            },
          ],
        },
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
  return JSON.parse(cleaned);
}

async function main() {
  requireAnthropicConfig();
  const review =
    process.argv.includes("--review") || process.env.AUTOPILOT_REVIEW === "true";

  if (!existsSync(MEDIA_DIR)) {
    console.log("No media/ folder — nothing to do.");
    return;
  }

  const queue = existsSync(QUEUE_PATH)
    ? JSON.parse(readFileSync(QUEUE_PATH, "utf8"))
    : [];
  const brand = existsSync(BRAND_PATH)
    ? JSON.parse(readFileSync(BRAND_PATH, "utf8"))
    : {};
  const usedLines = existsSync(LINES_PATH)
    ? JSON.parse(readFileSync(LINES_PATH, "utf8"))
    : [];

  // New, postable source photos (skip the rendered/ output folder + non-images).
  const candidates = [];
  for (const f of readdirSync(MEDIA_DIR).filter((f) => !f.startsWith("."))) {
    const full = join(MEDIA_DIR, f);
    if (statSync(full).isDirectory()) continue;
    const ext = extname(f).toLowerCase();
    if (![".jpg", ".jpeg", ".png"].includes(ext)) {
      if (f !== "README.md") console.log(`skip ${f}: not a JPEG/PNG`);
      continue;
    }
    if (isQueued(queue, f)) continue;
    const size = statSync(full).size;
    if (size > 4.5 * 1024 * 1024) {
      console.log(`skip ${f}: ${(size / 1e6).toFixed(1)} MB — resize under ~4 MB`);
      continue;
    }
    candidates.push(f);
  }
  candidates.sort();

  if (candidates.length === 0) {
    console.log("No new selfies to schedule.");
    return;
  }
  console.log(`Found ${candidates.length} new selfie(s): ${candidates.join(", ")}`);

  // Schedule after the latest thing already on the calendar.
  let latest = Date.now();
  for (const item of queue) {
    if ((item.status === "scheduled" || item.status === "published") && item.publish_at) {
      latest = Math.max(latest, Date.parse(item.publish_at));
    }
  }

  if (!existsSync(RENDERED_DIR)) mkdirSync(RENDERED_DIR, { recursive: true });

  let added = 0;
  for (const f of candidates) {
    try {
      console.log(`Analyzing ${f} ...`);
      const { line, position = "top", alt_text } = await analyzePhoto(
        join(MEDIA_DIR, f),
        f,
        brand,
        usedLines
      );

      // Burn the line onto the photo in the brand font, in the clear band.
      const outName = `post-${slug(f)}.jpg`;
      const outRel = `media/rendered/${outName}`;
      await overlayCaption(join(MEDIA_DIR, f), line, join(RENDERED_DIR, outName), {
        position,
      });

      const slot = nextSlot(latest);
      latest = slot.getTime();
      queue.push({
        id: `${slot.toISOString().slice(0, 10)}-${slug(f)}`,
        status: review ? "draft" : "scheduled",
        publish_at: slot.toISOString(),
        media_type: "IMAGE",
        media_url: publicUrlFor(outRel),
        alt_text: alt_text || line,
        caption: line, // same line as on the image
        source_file: f, // dedup key — the ORIGINAL upload
      });
      usedLines.push(line);
      added++;
      console.log(`  "${line}" [${position}] -> ${review ? "draft" : slot.toISOString()}`);
    } catch (err) {
      console.error(`  FAILED on ${f}: ${err.message}`);
    }
  }

  if (added > 0) {
    writeFileSync(QUEUE_PATH, JSON.stringify(queue, null, 2) + "\n");
    writeFileSync(LINES_PATH, JSON.stringify(usedLines, null, 2) + "\n");
    console.log(
      review
        ? `${added} draft(s) added — review, then flip status to 'scheduled'.`
        : `${added} post(s) scheduled — the publisher takes it from here.`
    );
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
