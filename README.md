# Video Outpainting — project page

Self-contained static site for video outpainting with Anchored Tree Sampling
([ATS](https://descriptinc.github.io/ATS/)). No build step.

## Files
- `index.html` — the page
- `styles.css` — shared component styles (same file as the Video Regenerate and Jumpcut Smoothing sites)
- `outpaint.css` — styles specific to this page (outpaint player, clip picker, ATS tree figure)
- `main.js` — interactions; `CLIPS` and `MEDIA` at the top list every clip
- `scripts/prepare_media.sh` — encodes outputs for the web and grabs posters
- `media/` — `<id>.mp4` (gitignored, served from GCS) and `posters/<id>.jpg` (committed)
- `.nojekyll` — tells GitHub Pages to serve files as-is

## Media
Raw outputs are named `<id>_source_<ar>_out.mp4` (e.g. `pres_9_16_source_16_9_out.mp4`).
Encode them and grab posters:

```bash
scripts/prepare_media.sh ../outpaint_vids
```

Only outputs are needed: the "Original" view masks the output down to the
source frame, which the outpainter leaves untouched. Each clip in `CLIPS`
lists its source and output sizes; the source frame is assumed to be fit and
centered on the canvas, and `box` overrides that for clips where it isn't.

Upload the encoded videos to the bucket the page reads from when deployed:

```bash
gcloud storage cp media/*.mp4 gs://lyrebird-research-web-demos/video-outpainting/
```

## Local preview
On localhost the page plays videos from `media/` instead of GCS. Use a server
that supports HTTP range requests (so the videos can seek):

```bash
npx http-server -p 8767 -c-1 .
# → http://localhost:8767/
```

## Deploy to GitHub Pages
Push to `main` and enable Pages; the site serves at
https://descriptinc.github.io/video-outpainting/.
