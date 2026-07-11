// src/reply.js
// The inbound engagement agent.
//
// Checks comments on your recent posts, has Claude draft a reply in your brand
// voice, and posts it. Skips trolls, spam, your own comments, and questions it
// can't verifiably answer. Never handles the same comment twice (state lives
// in content/replied.json).
//
// Run:  node src/reply.js             (reply to new comments)
//       node src/reply.js --dry-run   (print what it WOULD say, post nothing)
//
// Requires the instagram_business_manage_comments permission on your token.
//
// Tuning (env or repo Variables):
//   REPLY_DRY_RUN=true       log drafts instead of posting (recommended at first)
//   REPLY_RECENT_POSTS=5     how many recent posts to scan
//   REPLY_MAX_AGE_DAYS=7     ignore comments older than this
//   REPLY_MAX_PER_RUN=15     safety cap per run

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  config,
  requireIgConfig,
  requireAnthropicConfig,
  ROOT,
} from "./config.js";
import { graphGet, graphPost } from "./instagram.js";

const STATE_PATH = join(ROOT, "content", "replied.json");
const BRAND_PATH = join(ROOT, "brand.json");

const DRY_RUN =
  process.argv.includes("--dry-run") || process.env.REPLY_DRY_RUN === "true";
const RECENT_POSTS = parseInt(process.env.REPLY_RECENT_POSTS || "5", 10);
const MAX_AGE_DAYS = parseInt(process.env.REPLY_MAX_AGE_DAYS || "7", 10);
const MAX_PER_RUN = parseInt(process.env.REPLY_MAX_PER_RUN || "15", 10);

function loadState() {
  return existsSync(STATE_PATH)
    ? JSON.parse(readFileSync(STATE_PATH, "utf8"))
    : [];
}

function saveState(state) {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}

function buildReplySystem(brand) {
  return [
    "You reply to Instagram comments AS the brand below. You are its voice.",
    "",
    "BRAND:",
    JSON.stringify(brand, null, 2),
    "",
    "RULES:",
    "- One short reply, 1-2 sentences max. Sound like a person in the group",
    "  chat, never like support staff.",
    "- Match the commenter's energy: compliment -> playful thanks with",
    "  personality; joke -> joke back.",
    "- Never argue. Trolls, hate, or bait -> skip.",
    "- Obvious spam or bots (promo offers, crypto, follow-for-follow) -> skip.",
    "- If they ask a factual question you cannot verifiably answer (price,",
    "  shipping, restocks, sizing), do NOT invent an answer — point them to",
    "  the link in bio, or skip.",
    "- No hashtags in replies. At most one emoji, only if it genuinely fits.",
    "",
    "OUTPUT: return ONLY valid JSON, no markdown fences, one of:",
    '{ "action": "reply", "text": string }',
    '{ "action": "skip", "reason": string }',
  ].join("\n");
}

async function draftReply(brand, postCaption, comment) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": config.anthropicApiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: config.anthropicModel,
      max_tokens: 300,
      system: buildReplySystem(brand),
      messages: [
        {
          role: "user",
          content:
            `Post caption:\n"""${postCaption || "(no caption)"}"""\n\n` +
            `Comment from @${comment.username || "unknown"}:\n` +
            `"""${comment.text || ""}"""\n\n` +
            "Decide: reply (and with what) or skip.",
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
  requireIgConfig();
  requireAnthropicConfig();

  const brand = existsSync(BRAND_PATH)
    ? JSON.parse(readFileSync(BRAND_PATH, "utf8"))
    : {};
  const state = loadState();
  const seen = new Set(state.map((s) => s.comment_id));

  // Who am I? (so we never reply to ourselves)
  const me = await graphGet(`/${config.igUserId}`, { fields: "username" });
  const myUsername = (me.username || "").toLowerCase();

  const media = await graphGet(`/${config.igUserId}/media`, {
    fields: "id,caption,timestamp",
    limit: String(RECENT_POSTS),
  });

  const cutoff = Date.now() - MAX_AGE_DAYS * 86400 * 1000;
  let handled = 0;

  for (const post of media.data || []) {
    if (handled >= MAX_PER_RUN) break;
    let comments;
    try {
      comments = await graphGet(`/${post.id}/comments`, {
        fields: "id,text,username,timestamp",
        limit: "50",
      });
    } catch (e) {
      console.warn(`Could not read comments on ${post.id}: ${e.message}`);
      continue;
    }

    for (const c of comments.data || []) {
      if (handled >= MAX_PER_RUN) break;
      if (seen.has(c.id)) continue;
      if ((c.username || "").toLowerCase() === myUsername) continue;
      if (c.timestamp && Date.parse(c.timestamp) < cutoff) {
        state.push({
          comment_id: c.id,
          action: "aged_out",
          at: new Date().toISOString(),
        });
        seen.add(c.id);
        continue;
      }

      let decision;
      try {
        decision = await draftReply(brand, post.caption, c);
      } catch (e) {
        console.error(`Draft failed for comment ${c.id}: ${e.message}`);
        continue; // leave unseen so a later run retries
      }

      if (decision.action === "reply" && decision.text) {
        if (DRY_RUN) {
          console.log(
            `[dry-run] @${c.username}: "${c.text}"\n  -> would reply: "${decision.text}"`
          );
        } else {
          await graphPost(`/${c.id}/replies`, { message: decision.text });
          console.log(`Replied to @${c.username}: "${decision.text}"`);
          state.push({
            comment_id: c.id,
            action: "replied",
            text: decision.text,
            at: new Date().toISOString(),
          });
          seen.add(c.id);
        }
      } else {
        console.log(
          `Skip @${c.username} ("${(c.text || "").slice(0, 60)}"): ${
            decision.reason || "no reason given"
          }`
        );
        if (!DRY_RUN) {
          state.push({
            comment_id: c.id,
            action: "skipped",
            reason: decision.reason,
            at: new Date().toISOString(),
          });
          seen.add(c.id);
        }
      }
      handled++;
    }
  }

  if (!DRY_RUN) saveState(state);
  console.log(
    handled ? `Handled ${handled} comment(s).` : "No new comments to handle."
  );
}

// Run main only when executed directly (lets tests import without side effects).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
