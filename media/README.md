# 📸 media/ — drop your selfies here

This is the only folder you touch. Add photos, the machine does the rest.

## How to add images

**Every day, just drop new selfies in here.** Two ways:

- **Phone / browser (no terminal):** open this folder on github.com → "Add file"
  → "Upload files" → drag your selfies in → "Commit changes."
- **Laptop:** copy files into this folder, then `git add media/ && git commit -m "new pics" && git push`.

That push is the trigger. Within a few minutes each NEW photo gets a one-liner
written from the photo, burned on in the sayso font, and scheduled to post.

## "Will it re-post old photos?" — No.

Every photo that's ever been scheduled is remembered by filename in
`../content/queue.json`. On each run the system skips anything already there,
so **this folder can just keep growing** — dumped photos are only ever used once.
(If you rename a file, it looks new and could post again — so don't rename.)

## Photo rules (Instagram's, not ours)

- **JPEG only** (`.jpg` / `.jpeg`). Export from your phone as JPEG.
- Keep files **under ~4 MB** (bigger ones are skipped so the vision step stays fast).
- Any shape is fine — it's auto-cropped to 4:5 (portrait), the tallest Instagram allows.
- Vertical selfies look best. The caption auto-places in clear space, above or
  below you, never across your face.

## Order

Photos post in **filename order**. If you care which goes first, name them
`01-...jpg`, `02-...jpg`. Otherwise don't worry about it.
