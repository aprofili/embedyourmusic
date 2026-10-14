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

On release pages (desktop width):

- **Left column:** cover art, then Rate/Catalog, then Previous/Next, then Album info, then RYM's other left-column sections (track listing, credits, lists, comments, discussion).
- **Right column:** album title, then the player (streaming tabs) and suggestions (two columns), then the remaining sections (catalog, issues, reviews). Contributions stays full-width below both columns.

Narrow/mobile layouts are left alone.

## Artist page ratings

On artist pages each discography row's "Rate" cell becomes RYM's star widget, so a release can be rated in one click without expanding the issues list. It is the same widget and request the release page's Rate/Catalog box uses (`RYMrating('l', albumId)` → `CatalogSetRating`), so it rates the album itself. Existing ratings show as filled stars. This runs in the page's JavaScript world (`artist-ratings.js`, manifest `"world": "MAIN"`) because it needs RYM's own `RYMrating` class.

## Recommendations page

On `/recommendations/...` (desktop width):

- Each cover gets a ▶ button. Click it to load that album in a sticky player on the right; nothing navigates. The extension fetches the release page (same-origin), reads RYM's `data-links`, and shows a tab per service (Spotify default). Results are cached per release, and nothing is fetched until you click.
- The Avg/Ratings/Reviews columns are replaced by one line under the genres (`★ avg · ratings`).
- Playlists, Settings and Affinities move below the lists.
- Not hover-to-play: that would fetch a page and load an iframe for every cover the mouse crosses.

## Install

Run `node build.js` first. It writes `dist/chromium` and `dist/firefox`; the two differ only in `manifest.json` (Edge rejects `background.scripts`, Firefox has no service worker).

**Edge:** `edge://extensions` → Developer mode → Load unpacked → select `dist/chromium` (or the repo root).

**Firefox (temporary):** `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → select `dist/firefox/manifest.json`. Removed on restart.

**Firefox (permanent):** `npx web-ext sign --channel=unlisted --api-key=... --api-secret=...` from `dist/firefox` (free AMO credentials), then install the resulting `.xpi`.

## iOS (Safari)

`node build.js` also writes `dist/userscript/embedyourmusic.user.js`, for the free [Userscripts](https://apps.apple.com/app/userscripts/id1463298887) Safari app (no Mac needed).

1. Install Userscripts, set its script folder, enable it in Settings → Safari → Extensions (allow rateyourmusic.com).
2. Put `embedyourmusic.user.js` in that folder.

Same embeds/tabs (under the icon row) and collapsed sections as desktop. Bandcamp lookups use `GM_xmlhttpRequest` and a `localStorage` cache. Artist-page stars are not included (RYM hides that column on small screens). If RYM's CSP blocks the iframes, Safari offers no way around it.

## If embeds are blocked by RYM's CSP

Set `"enabled": true` for the `strip_csp` ruleset in `manifest.json`. That removes CSP headers on rateyourmusic.com, so only enable it if needed.

## Tests

```
npm install
npm test
```
