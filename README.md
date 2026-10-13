# EmbedYourMusic

Browser extension (Edge, Firefox) that replaces Spotify and Bandcamp links on rateyourmusic.com with inline players. Personal use.

## How it works

- `content.js` scans RYM pages (and watches for dynamically added links) for Spotify and Bandcamp URLs and inserts an iframe after the link's container. Players load lazily as they scroll into view.
- Spotify links map directly to `open.spotify.com/embed/...`.
- Bandcamp embeds need a numeric ID, so `background.js` fetches the Bandcamp page, reads `og:video` (fallback: `bc-page-properties`), and returns the player URL. Results are cached in `storage.local`.
- Custom-domain Bandcamp links (not `*.bandcamp.com`) are not handled.

## Install

**Edge:** `edge://extensions` → Developer mode → Load unpacked → select this folder.

**Firefox (temporary):** `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → select `manifest.json`. Removed on restart.

**Firefox (permanent):** `npx web-ext sign --channel=unlisted --api-key=... --api-secret=...` (free AMO credentials), then install the resulting `.xpi`.

## If embeds are blocked by RYM's CSP

Set `"enabled": true` for the `strip_csp` ruleset in `manifest.json`. That removes CSP headers on rateyourmusic.com, so only enable it if needed.

## Tests

```
node test/run.js
```
