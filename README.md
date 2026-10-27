# EmbedYourMusic

<img src="store/logo-300.png" width="96" alt="EmbedYourMusic logo">

Browser extension (Edge, Chrome, Brave, Opera, Vivaldi, Firefox; Safari on iOS via userscript) that replaces Spotify and Bandcamp links on rateyourmusic.com with inline players. Personal use.

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

Release assets: `embedyourmusic-chromium.zip` (Chrome, Brave, Opera, Vivaldi, Arc, Edge: unzip, then Load unpacked at `chrome://extensions` with Developer mode on), `embedyourmusic-firefox.zip`, `embedyourmusic.user.js` (Safari). Desktop Safari needs an Xcode-built app, so it is not provided.

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
- A 429/503 pauses script requests: 5 min, then 15 min, 30 min, 1 h if it keeps happening (a success resets this). A 403 is RYM's bot check on script requests, not a rate limit: the page is loaded in a helper tab instead (see below).

## Side panel player

Everything plays in the side panel (the toolbar button opens it; Firefox: the sidebar). Clicking a streaming icon on a release page, the big ▶ on its cover, or any album cover on the site opens the panel if needed and plays there: art, service tabs, player, your star rating, and Spotify's ♥ track list. Pages carry no players of their own (the iOS userscript, which has no panel, keeps the in-page players). If the browser won't let the click open the panel (Firefox may not), a note asks you to open it, and the album you clicked plays as soon as you do (within 2 minutes). Ratings made in the panel use RYM's own rating request (through any RYM tab, or a helper tab).

The panel also has lists to play from: **Similar** (RYM's suggestions for the current album), **More by <artist>** (the Albums and EPs on their RYM artist page), **Recommended** and **Challenge** (your recommendations page), **New music** (RYM's new-music page, only what Spotify has), **Top albums** (RYM's album charts: this year by default, a dropdown for all time, recent years and decades, plus any chart you filtered or saved with the bookmark on the website; more pages load on Show more, and the random button follows the pick), **Favorites** (a random pick of your 3.5+ star albums, widened by one page a day) and **History** (what you played here, newest first; separate from your RYM play history). Opening one closes the others; each opens to the window height with a Show more button.

### Where the data comes from
Every list is read from a real RYM page. Visiting that page yourself saves it. Otherwise the panel asks the background, which uses a RYM tab you have open on that page, or else opens the page in a background *helper tab* (`#eym-helper`), reads it, and closes it. Helper tabs run one at a time and do nothing on their own (no players, no autoplay). A page load is what passes RYM's bot check; script requests often get a 403. Lists older than their refresh time (recommendations 12 h, new music 6 h, history 30 min) are shown immediately and refreshed behind the scenes; a list read badly (missing titles) is never shown and is re-read instead. Rating, "Set listening" and Similar need RYM's own page code, not a specific page, so any RYM tab (or a helper tab) carries them out.

**Play history**: an album enters the panel's History after 10 s of listening. Once 3 of its songs (fewer for shorter releases) have played 20 s each, the background sends RYM's "Set listening" for the album (looking up its RYM id if the panel didn't have it), with the panel open or closed. The panel shows whether it worked.

### Spotify player in the panel
With Spotify connected, the panel hides Spotify's embed and shows its own player: art-tinted card, play/pause, a track list you pick from (♥ per song), your rating under the art, and a save-album button. Spotify's embed still plays the audio, driven by postMessage (toggle / pause / seek); the Spotify logo opens the album on Spotify if something doesn't respond. Keyboard media keys (play/pause, next, previous) and the OS media controls (volume overlay, headset buttons) control it; a press that arrives by both routes is handled once. Without Spotify connected, the normal embed is used.

Playback keeps going with the panel closed on Chromium browsers: the Spotify embed runs in an offscreen document (needs the `offscreen` permission). Firefox runs it in the panel, so it stops when the panel closes. Reopening the panel on the same release picks up the running playback (without autoplaying anything else). If the offscreen player stops answering (the browser closes it after a while without audio), the panel brings it back, or plays from the panel itself and closes the offscreen one so the two never play at once.


RYM's own streaming icon rows are hidden on the page (the side panel plays everything).

## Cloud backup

At the bottom of the side panel, "Back up to your jkprilfools.com account" logs in with the site's account (email-code 2FA supported). From then on your play history, reviews, ratings, resume position and settings are uploaded automatically (at most once an hour, when something changed). Restoring is manual only: logging in or pressing "Restore & sync" merges the saved copy into this browser (history is combined, newer reviews win, this browser's settings win). Stored in your account on jkprilfools.com (`/api/eym/backup`); Spotify tokens and regenerable caches are not included.
