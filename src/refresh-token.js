// src/refresh-token.js
// Instagram long-lived access tokens last ~60 days. This refreshes one and
// prints the new token. You then update your IG_ACCESS_TOKEN secret.
//
// This uses the Instagram Login for Business refresh endpoint (graph.instagram.com).
// If you authenticated via Facebook Login and use a System User token, that token
// can be set to NEVER expire — in that case you don't need this at all.
//
// Run:  node src/refresh-token.js

import { config } from "./config.js";

async function main() {
  if (!config.igAccessToken) {
    console.error("IG_ACCESS_TOKEN is not set.");
    process.exit(1);
  }
  const url =
    "https://graph.instagram.com/refresh_access_token" +
    "?grant_type=ig_refresh_token" +
    `&access_token=${encodeURIComponent(config.igAccessToken)}`;

  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(`Refresh failed: ${JSON.stringify(data.error || data)}`);
  }
  console.log("New long-lived token (valid ~60 days):\n");
  console.log(data.access_token);
  console.log(`\nExpires in ~${Math.round((data.expires_in || 0) / 86400)} days.`);
  console.log(
    "\nUpdate your IG_ACCESS_TOKEN secret (GitHub → Settings → Secrets → Actions)."
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
