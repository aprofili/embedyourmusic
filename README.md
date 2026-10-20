# EmbedYourMusic

<img src="store/logo-300.png" width="96" alt="EmbedYourMusic logo">

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

- Each cover shows a ▶ badge; click anywhere on the cover (Ctrl-click still opens the release) to load that album in a sticky player on the right; nothing navigates. The extension fetches the release page (same-origin), reads RYM's `data-links`, and shows a tab per service (Spotify default). Results are cached per release, and nothing is fetched until you click.
- The Avg/Ratings/Reviews columns are replaced by one line under the genres (`★ avg · ratings`).
- Affinities (two columns) move below the lists, with Settings under the left column and Playlists under the right.
- A star rating sits left of each row's X (same widget and request as the release page; existing ratings are read from each release page as the row scrolls into view, two fetches at a time, cached per tab). RYM's rating code lives in its release-page script, so `reco-ratings.js` (page world) loads that script if it is missing.
- Not hover-to-play: that would fetch a page and load an iframe for every cover the mouse crosses.

## Saving individual Spotify tracks

Under the Spotify player, the "♡ Save tracks" list (open by default; the button collapses it) shows the tracks with a ♥ per track (adds/removes it in Liked Songs). Works on release pages and the recommendations player.

One-time setup: the extension uses the Spotify app with client ID `c66c2741c3284f4eae7341cc156ca0e8` (OAuth PKCE, no secret). In the Spotify dashboard add the redirect URI for each browser under Settings → Redirect URIs. The first time you open the track list, it prints the exact URI for your browser; Edge's is fixed by the `key` in `manifest.json`: `https://pniflpimiiljpgeepfdjmjeeagldjmbk.chromiumapp.org/`. Then click "Connect Spotify". Scopes: `user-library-read`, `user-library-modify`. Tokens are stored in `storage.local`. The API calls run in `background.js`; the iOS userscript doesn't support this.

If Spotify has retired `/me/tracks`, the code falls back to `/me/library`.

## Releases and updates

Every push to `main` runs `.github/workflows/release.yml`: if the `version` in `manifest.json` has no release yet, it runs the tests and publishes release `v<version>` (bump the version and merge to release). Assets:
- `embedyourmusic-edge.zip`: Edge and other Chromium browsers (unzip, Load unpacked)
- `embedyourmusic.user.js`: Safari on iOS via the Userscripts app

iOS: the userscript has `@updateURL`/`@downloadURL` pointing at the latest release, so the Userscripts app can update it from there (Userscripts settings → check for updates).

Edge: unpacked extensions never auto-update. For automatic updates, publish the extension to Microsoft Edge Add-ons as an unlisted listing (free): create the listing once in Partner Center, then add repo secrets `EDGE_PRODUCT_ID`, `EDGE_CLIENT_ID`, `EDGE_API_KEY` and each tagged release is also submitted to the store (`embedyourmusic-edge-store.zip`, built without the pinned `key`, since the store assigns its own extension id; the OAuth redirect URI for Spotify saving then changes to the store id's `chromiumapp.org` URL).

## Install

Run `node build.js` first. It writes `dist/chromium` and `dist/firefox`; the two differ only in `manifest.json` (Edge rejects `background.scripts`, Firefox has no service worker).

**Edge:** `edge://extensions` → Developer mode → Load unpacked → select `dist/chromium` (or the repo root).

**Firefox (temporary):** `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → select `dist/firefox/manifest.json`. Removed on restart.

**Firefox (permanent):** `npx web-ext sign --channel=unlisted --api-key=... --api-secret=...` from `dist/firefox` (free AMO credentials), then install the resulting `.xpi`.

## iOS (Safari)

`node build.js` also writes `dist/userscript/embedyourmusic.user.js`, for the free [Userscripts](https://apps.apple.com/app/userscripts/id1463298887) Safari app (no Mac needed).

1. Install Userscripts, set its script folder, enable it in Settings → Safari → Extensions (allow rateyourmusic.com).
2. Put `embedyourmusic.user.js` in that folder.

Same embeds/tabs (under the icon row) and collapsed sections as desktop. Bandcamp lookups use `GM_xmlhttpRequest` and a `localStorage` cache. On `/recommendations/` (phone width) the userscript: shows a one-line `★ avg · ratings` per row instead of the three-chip box; opens the player inline under the row you tap (tap the same cover again to close); dims and shrinks rows you've rated; loads and scrolls to the first unrated album on load. It runs at document-start so the loading spinner covers the page before first paint. Not included on iOS: star ratings (they need RYM's page-world code) and Spotify track saving. Artist-page stars are not included (RYM hides that column on small screens). If RYM's CSP blocks the iframes, Safari offers no way around it.

## If embeds are blocked by RYM's CSP

Set `"enabled": true` for the `strip_csp` ruleset in `manifest.json`. That removes CSP headers on rateyourmusic.com, so only enable it if needed.

## Tests

```
npm install
npm test
```

The playing track is bolded using the playback messages the Spotify embed posts to the page (matched by track URI, else by duration). That depends on Spotify's undocumented message format; set `localStorage.eymDebug = "1"` on rateyourmusic.com to log the raw messages. On the recommendations page the Spotify album player is 560px tall.

Recommendations page, ratings: rows you've already rated dim and shrink to one line (order unchanged). On load, the extension walks the list from the top, reading ratings from the release pages, and loads the first unrated album into the player.

Loading cover: release and recommendations pages are covered with a spinner (pure CSS in `content.css`, keyed on `html.page_release` / `html.page_recommendations`) until the layout is final: after the first run on release pages, and after the first unrated album is loaded on the recommendations page. A CSS animation removes the cover after 8s even if the script fails.

## Request volume (rateyourmusic.com)

Reading ratings and streaming links needs a release-page request per album, so `release-data.js` keeps this small:
- Results are cached in `localStorage` (rated releases 14 days, unrated 20 minutes; shared by all tabs and both script worlds). Ratings you give from the list update the cache.
- Nothing is fetched just because a row scrolled into view. On load, rows already in the cache are decorated for free, and the "find first unrated" walk may make at most 3 network requests (it continues from the cache next load). Otherwise a request happens only when you click a cover.
- Requests are one at a time, ~400ms apart, and callers for the same release share one.
- A 403/429/503 pauses all extension requests: 15 min, then 1 h, 6 h, 24 h if it keeps happening (a success resets this). The player shows the HTTP status and a "Retry now" link that clears the pause.

## Side panel player

Click the toolbar button to open the side panel (Firefox: View → Sidebars, or the toolbar button). While it is open, clicking a streaming tab on a release page, or an album cover on the recommendations page, plays in the panel instead of the page: art, service tabs, player, your star rating, and Spotify's ♥ track list. With the panel closed, players embed in the page as before. Ratings made in the panel are applied through the originating RYM tab, so keep that tab open.

The panel also has lists to play from: **Similar** (the suggestions on the current album's RYM page), **Recommended** and **Challenge** (from your recommendations page; open it once to fill them), **Favorites** (a random pick of your 4+ star albums, refreshed once a day) and **History** (albums you pressed play on). Opening one closes the others; each opens to the window height with a Show more button.
