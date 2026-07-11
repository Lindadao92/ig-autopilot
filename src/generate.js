// src/generate.js
// Uses the Anthropic API to draft Instagram captions in your brand voice.
// Reads brand.json for voice/tone and produces N caption variants for a brief.
//
// Run:  node src/generate.js "launch week — new corduroy hat, cozy fall vibe"
//       node src/generate.js "brief..." --variants 5 --append
//
// --append writes the drafts into content/queue.json as status "draft"
// (you then fill in media_url + publish_at and flip status to "scheduled").

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { config, requireAnthropicConfig, ROOT } from "./config.js";

const BRAND_PATH = join(ROOT, "brand.json");
const QUEUE_PATH = join(ROOT, "content", "queue.json");

function getArg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function loadBrand() {
  if (!existsSync(BRAND_PATH)) return {};
  return JSON.parse(readFileSync(BRAND_PATH, "utf8"));
}

function buildSystemPrompt(brand) {
  return [
    "You are a social copywriter drafting Instagram captions.",
    "",
    "BRAND:",
    JSON.stringify(brand, null, 2),
    "",
    "RULES:",
    "- Instagram does NOT render markdown. No bold, italics, headers, or bullet symbols.",
    "- The first line is a scroll-stopping hook (Instagram truncates after ~125 chars).",
    "- Keep the whole caption, including hashtags, under 2,200 characters.",
    "- Include 4–8 relevant hashtags: mix broad and niche, no banned/spammy tags.",
    "- Sound like a person, not a press release. Match the brand tone above.",
    "- No emojis unless the brand tone calls for them.",
    "",
    "OUTPUT:",
    "Return ONLY valid JSON, no markdown fences, in this exact shape:",
    '{ "variants": [ { "hook": string, "caption": string, "hashtags": string[] } ] }',
    "where `caption` is the full ready-to-post text WITHOUT the hashtags,",
    "and `hashtags` is a separate array (each item starts with #).",
  ].join("\n");
}

async function callClaude(system, userBrief, variants) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": config.anthropicApiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: config.anthropicModel,
      max_tokens: 2000,
      system,
      messages: [
        {
          role: "user",
          content: `Write ${variants} distinct caption variants for this post brief:\n\n${userBrief}`,
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

  // Be defensive: strip accidental code fences before parsing.
  const cleaned = text.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new Error("Model did not return valid JSON. Raw output:\n" + text);
  }
}

function slug(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

async function main() {
  requireAnthropicConfig();
  const brief = process.argv.slice(2).filter((a) => !a.startsWith("--"))[0];
  if (!brief) {
    console.error('Usage: node src/generate.js "your post brief" [--variants N] [--append]');
    process.exit(1);
  }
  const variants = parseInt(getArg("--variants", "3"), 10);
  const append = process.argv.includes("--append");

  const brand = loadBrand();
  const system = buildSystemPrompt(brand);
  const { variants: results } = await callClaude(system, brief, variants);

  console.log(`\nGenerated ${results.length} caption(s) for: "${brief}"\n`);
  results.forEach((v, i) => {
    const full = `${v.caption}\n\n${(v.hashtags || []).join(" ")}`;
    console.log(`--- Variant ${i + 1} ---`);
    console.log(full);
    console.log("");
  });

  if (append) {
    const queue = existsSync(QUEUE_PATH)
      ? JSON.parse(readFileSync(QUEUE_PATH, "utf8"))
      : [];
    const chosen = results[0]; // append the first; edit later as you like
    queue.push({
      id: `${new Date().toISOString().slice(0, 10)}-${slug(brief)}`,
      status: "draft",
      publish_at: "",
      media_type: "IMAGE",
      media_url: "",
      caption: `${chosen.caption}\n\n${(chosen.hashtags || []).join(" ")}`,
      _note: "Fill in media_url and publish_at, then set status to 'scheduled'.",
    });
    writeFileSync(QUEUE_PATH, JSON.stringify(queue, null, 2) + "\n");
    console.log('Appended the first variant to content/queue.json as a draft.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
