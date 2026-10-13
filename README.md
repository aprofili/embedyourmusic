# EmbedYourMusic

Browser extension (Edge, Firefox) that replaces Spotify and Bandcamp links on rateyourmusic.com with inline players. Personal use.

## How it works

- `content.js` scans RYM pages (and watches for dynamically added links) for Spotify and Bandcamp URLs and inserts an iframe after the link's container. Players load lazily as they scroll into view.
- On release pages, RYM's streaming icons become tabs: click one to show that service's player in the space below the icons (Spotify is the default, otherwise the first available). Players load on first click and are kept, so switching back doesn't reload. Ctrl/middle-click still opens the link normally.
- Tabs: Spotify, Apple Music, SoundCloud, Bandcamp, YouTube, Tidal, Deezer. Services without an embeddable player (Qobuz) stay plain links. Bandcamp custom domains (not `*.bandcamp.com`) also stay plain links.
- Loose links elsewhere on the page (reviews, lists) only get Spotify and Bandcamp players.
- Spotify links map directly to `open.spotify.com/embed/...`.
- Bandcamp embeds need a numeric ID, so `background.js` fetches the Bandcamp page, reads `og:video` (fallback: `bc-page-properties`), and returns the player URL. Results are cached in `storage.local`.
- Custom-domain Bandcamp links (not `*.bandcamp.com`) are not handled.

## Page cleanup

- Collapsed until clicked (toggle bar above each): issues, contributions (the third `div` under `.release_page`), discussion, comments, credits, tracklist, lists, catalog.
- Collapsible but open by default: reviews, album info table cells, suggestions.
- Each toggle reuses the section's own title (e.g. "58 Reviews") and the original title is hidden. Sections without a title (album info) use the label in `COLLAPSIBLE`.
- Collapsing is plain CSS in `content.css`; the toggles are added by `content.js`. Edit the matching lists in both files to change which sections are affected.

## Release page layout

On release pages (desktop width) the cover art stays at the top of the left column, with Previous/Next and the other left-column sections directly under it. The player block (streaming tabs and player) and the suggestions (two columns) move to the top of the right column, above the album info. Narrow/mobile layouts are left alone.

## Install

Run `node build.js` first. It writes `dist/chromium` and `dist/firefox`; the two differ only in `manifest.json` (Edge rejects `background.scripts`, Firefox has no service worker).

**Edge:** `edge://extensions` → Developer mode → Load unpacked → select `dist/chromium` (or the repo root).

**Firefox (temporary):** `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → select `dist/firefox/manifest.json`. Removed on restart.

**Firefox (permanent):** `npx web-ext sign --channel=unlisted --api-key=... --api-secret=...` from `dist/firefox` (free AMO credentials), then install the resulting `.xpi`.

## If embeds are blocked by RYM's CSP

Set `"enabled": true` for the `strip_csp` ruleset in `manifest.json`. That removes CSP headers on rateyourmusic.com, so only enable it if needed.

## Tests

```
npm install
npm test
```
