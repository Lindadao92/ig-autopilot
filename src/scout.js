// src/scout.js
// The outbound engagement co-pilot: "bot finds, human touches."
//
// Reads the top posts for your niche hashtags, has Claude pick the best targets
// and DRAFT a comment for each in your brand voice, and writes a daily briefing
// to content/engage/YYYY-MM-DD.md.
//
// ⚠️ HASHTAG SEARCH REQUIRES A FACEBOOK-LOGIN GRAPH API TOKEN.
// The Instagram hashtag search endpoints (ig_hashtag_search + {hashtag}/top_media)
// exist ONLY on the Instagram Graph API via graph.facebook.com with an "EAA..."
// token. They are NOT part of the Instagram API with Instagram Login (the
// "IGA..." tokens on graph.instagram.com). With an Instagram Login token these
// calls fail and the briefing comes back empty. To use scouting, set an EAA
// token and IG_GRAPH_HOST=https://graph.facebook.com. Publishing and replies
// work fine on either host.
//
// You then spend ~10 minutes posting the good ones from your phone. Human
// fingers, human pace, your real judgment on every comment = zero ban risk.
// The bot never touches anyone else's post; it only preps your morning.
//
// Run:  node src/scout.js
//
// Tuning (env or repo Variables):
//   SCOUT_HASHTAGS="nocap,dadhat"   comma list. Keep it to ~4-6: Instagram
//                                   allows querying 30 UNIQUE hashtags per
//                                   rolling 7 days (same tags daily are fine).
//   SCOUT_TARGETS=10                how many suggestions per briefing

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import {
  config,
  requireIgConfig,
  requireAnthropicConfig,
  ROOT,
} from "./config.js";
import { graphGet } from "./instagram.js";

const ENGAGE_DIR = join(ROOT, "content", "engage");
const STATE_PATH = join(ROOT, "content", "scouted.json");
const BRAND_PATH = join(ROOT, "brand.json");

const HASHTAGS = (process.env.SCOUT_HASHTAGS || "nocap,dadhat")
  .split(",")
  .map((s) => s.trim().replace(/^#/, ""))
  .filter(Boolean);
const TARGETS = parseInt(process.env.SCOUT_TARGETS || "10", 10);

function loadState() {
  return existsSync(STATE_PATH)
    ? JSON.parse(readFileSync(STATE_PATH, "utf8"))
    : [];
}

function buildScoutSystem(brand) {
  return [
    "You pick Instagram posts worth commenting on for the brand below, and you",
    "draft the comment. The brand's human will post each comment MANUALLY after",
    "reviewing it — you are drafting, not posting.",
    "",
    "BRAND:",
    JSON.stringify(brand, null, 2),
    "",
    "RULES FOR PICKING TARGETS:",
    "- Pick posts where a genuinely funny, on-voice comment adds to the thread.",
    "- Prefer posts with momentum (high recent engagement) in the brand's niche.",
    "- Skip anything where humor would punch down, anything controversial or",
    "  sad, and anything where a brand chiming in would feel gross.",
    "",
    "RULES FOR THE COMMENTS:",
    "- One line each. Funny first. NEVER salesy — no brand mentions, no 'check",
    "  our page', no links, no hashtags. The joke does the marketing; if it",
    "  lands, people tap the profile on their own.",
    "- Match each post's energy. At most one emoji, only if it truly fits.",
    "",
    "OUTPUT: return ONLY valid JSON, no markdown fences:",
    '{ "targets": [ { "id": string, "comment": string, "why": string } ] }',
    "Pick at most the requested number. If few candidates are good, pick fewer.",
  ].join("\n");
}

async function pickTargets(brand, candidates, howMany) {
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
      system: buildScoutSystem(brand),
      messages: [
        {
          role: "user",
          content:
            `Pick up to ${howMany} targets and draft a comment for each.\n\n` +
            `CANDIDATES:\n${JSON.stringify(candidates, null, 2)}`,
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

/** Render the daily briefing markdown. Exported for testing. */
export function renderBriefing(dateStr, picks) {
  const lines = [
    `# Engagement briefing — ${dateStr}`,
    "",
    "Ten minutes, from your phone. Open each link, post the comment (or riff on",
    "it), move on. **Skip any that don't feel right — your judgment is the filter.**",
    "",
  ];
  picks.forEach((t, i) => {
    lines.push(`## ${i + 1}. ${t.stats || ""}`.trim());
    if (t.caption) lines.push(`> ${t.caption}`);
    lines.push(`Link: ${t.permalink}`, "", "Suggested comment:", "```");
    lines.push(t.comment, "```", "", `_Why: ${t.why || "good fit"}_`, "");
  });
  if (picks.length === 0) {
    lines.push("_No strong targets today — better luck tomorrow._");
  }
  return lines.join("\n") + "\n";
}

async function main() {
  requireIgConfig();
  requireAnthropicConfig();

  const brand = existsSync(BRAND_PATH)
    ? JSON.parse(readFileSync(BRAND_PATH, "utf8"))
    : {};
  const state = loadState();
  const seen = new Set(state.map((s) => s.media_id));

  // 1) Gather candidates from hashtag top-media (official, read-only).
  // Note: hashtag search only exists on the Facebook-Login Graph API. On the
  // Instagram Login API (graph.instagram.com) these calls fail per-tag below.
  if (config.igGraphHost.includes("graph.instagram.com")) {
    console.warn(
      "⚠️ Hashtag search is unavailable on the Instagram Login API " +
        "(graph.instagram.com). Set an EAA token + IG_GRAPH_HOST=https://graph.facebook.com " +
        "to enable scouting. Continuing — the briefing will likely be empty."
    );
  }
  const candidates = [];
  for (const tag of HASHTAGS) {
    try {
      const found = await graphGet(`/ig_hashtag_search`, {
        user_id: config.igUserId,
        q: tag,
      });
      const hashtagId = found.data?.[0]?.id;
      if (!hashtagId) {
        console.warn(`No hashtag id for #${tag}`);
        continue;
      }
      const top = await graphGet(`/${hashtagId}/top_media`, {
        user_id: config.igUserId,
        fields: "id,caption,permalink,like_count,comments_count,timestamp",
        limit: "15",
      });
      for (const m of top.data || []) {
        if (seen.has(m.id) || !m.permalink) continue;
        candidates.push({
          id: m.id,
          tag: `#${tag}`,
          caption: (m.caption || "").slice(0, 160),
          permalink: m.permalink,
          like_count: m.like_count,
          comments_count: m.comments_count,
        });
      }
    } catch (e) {
      console.warn(`Hashtag #${tag} failed: ${e.message}`);
    }
  }

  if (candidates.length === 0) {
    console.log(
      "No candidates found. Check SCOUT_HASHTAGS, and note Instagram's limit of 30 unique hashtags per rolling week."
    );
    return;
  }
  console.log(`Collected ${candidates.length} candidate post(s). Asking Claude to pick...`);

  // 2) Claude picks targets + drafts comments.
  const { targets = [] } = await pickTargets(
    brand,
    candidates.slice(0, 40),
    TARGETS
  );

  // 3) Join back with candidate metadata for the briefing.
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const picks = targets
    .filter((t) => byId.has(t.id))
    .map((t) => {
      const c = byId.get(t.id);
      return {
        ...t,
        permalink: c.permalink,
        caption: c.caption,
        stats: [
          c.tag,
          c.like_count != null ? `${c.like_count} likes` : null,
          c.comments_count != null ? `${c.comments_count} comments` : null,
        ]
          .filter(Boolean)
          .join(" · "),
      };
    });

  // 4) Write the briefing + update state.
  if (!existsSync(ENGAGE_DIR)) mkdirSync(ENGAGE_DIR, { recursive: true });
  const dateStr = new Date().toISOString().slice(0, 10);
  const outPath = join(ENGAGE_DIR, `${dateStr}.md`);
  writeFileSync(outPath, renderBriefing(dateStr, picks));

  for (const p of picks) {
    state.push({ media_id: p.id, at: new Date().toISOString() });
  }
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");

  console.log(`Briefing written: content/engage/${dateStr}.md (${picks.length} target(s)).`);
}

// Run main only when executed directly (lets tests import renderBriefing).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
