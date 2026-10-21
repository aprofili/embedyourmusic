// Resolves Bandcamp page URLs to embeddable player URLs.
// Runs in the background context because content scripts are subject to CORS.

const api = globalThis.browser ?? globalThis.chrome;

const CACHE_PREFIX = "bc:";

// <shared:bandcamp>
function isBandcampItemUrl(raw) {
  try {
    const u = new URL(raw);
    return (
      u.protocol === "https:" &&
      u.hostname.endsWith(".bandcamp.com") &&
      /^\/(album|track)\//.test(u.pathname)
    );
  } catch {
    return false;
  }
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function metaContent(html, attr, value) {
  const tag = html.match(
    new RegExp(`<meta[^>]+${attr}=["']${value}["'][^>]*>`, "i")
  );
  if (!tag) return null;
  const content = tag[0].match(/content=(["'])(.*?)\1/is);
  return content ? decodeEntities(content[2]) : null;
}

// Returns { src, height } or null.
function parseBandcampEmbed(html) {
  // Preferred: the og:video tag already holds a ready-made player URL.
  const ogVideo = metaContent(html, "property", "og:video");
  if (ogVideo && /bandcamp\.com\/EmbeddedPlayer\//.test(ogVideo)) {
    const src = ogVideo.replace(/^http:/, "https:");
    const small = /\/size=small\//.test(src);
    const tracklist = /\/tracklist=true\//.test(src);
    const height = small ? 42 : tracklist ? 472 : 120;
    return { src, height };
  }

  // Fallback: build the URL from bc-page-properties.
  const props = metaContent(html, "name", "bc-page-properties");
  if (props) {
    try {
      const { item_type: type, item_id: id } = JSON.parse(props);
      const kind = type === "a" ? "album" : type === "t" ? "track" : null;
      if (kind && id) {
        return {
          src:
            `https://bandcamp.com/EmbeddedPlayer/${kind}=${id}` +
            "/size=large/bgcol=ffffff/linkcol=0687f5/tracklist=false/artwork=small/transparent=true/",
          height: 120,
        };
      }
    } catch {
      /* fall through */
    }
  }
  return null;
}

// </shared:bandcamp>

// <shared:find>
// Finds streaming links for a release by artist/title/year when RYM's own page can't be fetched.
// Keeps letters/digits of any script (Japanese titles etc.); drops punctuation, bracketed notes
// and edition words. Spaces are removed so "Kinoko Teikoku" == "Kinokoteikoku".
const normName = (s) =>
  String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\(.*?\)|\[.*?\]/g, " ")
    .replace(/\b(ep|single|deluxe|remaster(ed)?|edition)\b/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, "");

// RYM shows "Latin name [native name]"; textContent runs them together. Try each part.
function nameVariants(s) {
  const str = String(s || "");
  const native = (str.match(/[^\u0000-\u024F]+/g) || []).join(" ");
  const latin = str.replace(/[^\u0000-\u024F]+/g, " ");
  return [...new Set([str, latin, native].map(normName).filter(Boolean))];
}

function bigrams(s) {
  const out = new Map();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    out.set(g, (out.get(g) || 0) + 1);
  }
  return out;
}

// 0..1 similarity between two normalized names.
function similar(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length > 3 && b.length > 3 && (a.includes(b) || b.includes(a))) return 0.9;
  if (a.length < 2 || b.length < 2) return 0;
  const A = bigrams(a);
  const B = bigrams(b);
  let hit = 0;
  for (const [g, n] of A) hit += Math.min(n, B.get(g) || 0);
  return (2 * hit) / (a.length - 1 + b.length - 1);
}

const bestSim = (xs, ys) => Math.max(0, ...xs.flatMap((x) => ys.map((y) => similar(x, y))));

// Best candidate {title, artist, year, href} for the wanted release, or null. Fuzzy: romanization
// and native-script names, small spelling differences. If the artist matches well and the year
// agrees but the titles are in different scripts, that still counts (weakest tier).
function pickAlbum(want, cands) {
  const wt = nameVariants(want.title);
  const wa = nameVariants(want.artist);
  let best = null;
  let bestScore = 0;
  for (const c of cands) {
    if (!c.href) continue;
    const a = bestSim(wa, nameVariants(c.artist));
    if (a < 0.7) continue;
    const t = bestSim(wt, nameVariants(c.title));
    const yearOk = want.year && c.year && Math.abs(want.year - c.year) <= 1;
    let score = 0;
    if (t >= 0.6) score = 2 + t + a + (yearOk ? 0.5 : 0);
    else if (yearOk && a >= 0.9) score = 1 + a * 0.1; // different script, same artist and year
    if (score > bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}

// getText(url) → response text. Returns [{service, href}] (Apple Music, Deezer).
async function findAlbumLinks(want, getText) {
  const latin = (s) => String(s).replace(/[^\u0000-\u024F]+/g, " ").replace(/\s+/g, " ").trim();
  const term = `${latin(want.artist) || want.artist} ${latin(want.title) || want.title}`;
  const out = [];
  const tasks = [
    async () => {
      const j = JSON.parse(await getText(`https://itunes.apple.com/search?entity=album&limit=10&term=${encodeURIComponent(term)}`));
      const hit = pickAlbum(
        want,
        (j.results || []).map((r) => ({
          title: r.collectionName,
          artist: r.artistName,
          year: parseInt(r.releaseDate, 10),
          href: r.collectionViewUrl,
        }))
      );
      if (hit && /^https:\/\/(music|itunes)\.apple\.com\//.test(hit.href)) out.push({ service: "applemusic", href: hit.href.replace(/\?.*$/, "") });
    },
    async () => {
      const j = JSON.parse(await getText(`https://api.deezer.com/search/album?limit=10&q=${encodeURIComponent(term)}`));
      const hit = pickAlbum(
        want,
        (j.data || []).map((r) => ({ title: r.title, artist: r.artist && r.artist.name, href: r.id ? `https://www.deezer.com/album/${r.id}` : null }))
      );
      if (hit) out.push({ service: "deezer", href: hit.href });
    },
  ];
  await Promise.all(tasks.map((t) => t().catch(() => {})));
  return out;
}
// </shared:find>

async function resolveBandcamp(url) {
  if (!isBandcampItemUrl(url)) return null;

  const key = CACHE_PREFIX + url;
  try {
    const hit = await api.storage.local.get(key);
    if (hit && hit[key]) return hit[key];
  } catch {
    /* cache is best-effort */
  }

  const res = await fetch(url, { credentials: "omit" });
  if (!res.ok) return null;
  const embed = parseBandcampEmbed(await res.text());

  if (embed) {
    try {
      await api.storage.local.set({ [key]: embed });
    } catch {
      /* ignore */
    }
  }
  return embed;
}

// ---- Spotify: per-track library saves (OAuth PKCE, no client secret) ----
const SPOTIFY_CLIENT_ID = "c66c2741c3284f4eae7341cc156ca0e8";
const SPOTIFY_SCOPES = "user-library-read user-library-modify";
const SPOTIFY_AUTH_KEY = "sp:auth";

const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function spotifyToken(params) {
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: SPOTIFY_CLIENT_ID, ...params }),
  });
  if (!res.ok) throw new Error(`Spotify token request failed (${res.status})`);
  return res.json();
}

async function storeAuth(tok, previous) {
  const auth = {
    access: tok.access_token,
    refresh: tok.refresh_token || (previous && previous.refresh),
    expires: Date.now() + (tok.expires_in - 60) * 1000,
  };
  await api.storage.local.set({ [SPOTIFY_AUTH_KEY]: auth });
  return auth;
}

async function spotifyAuth() {
  const got = await api.storage.local.get(SPOTIFY_AUTH_KEY);
  return got && got[SPOTIFY_AUTH_KEY] ? got[SPOTIFY_AUTH_KEY] : null;
}

async function spotifyAccessToken() {
  let auth = await spotifyAuth();
  if (!auth) throw new Error("not connected");
  if (Date.now() >= auth.expires) {
    auth = await storeAuth(await spotifyToken({ grant_type: "refresh_token", refresh_token: auth.refresh }), auth);
  }
  return auth.access;
}

async function spotifyConnect() {
  const redirect = api.identity.getRedirectURL();
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(12)));
  const authUrl =
    "https://accounts.spotify.com/authorize?" +
    new URLSearchParams({
      client_id: SPOTIFY_CLIENT_ID,
      response_type: "code",
      redirect_uri: redirect,
      scope: SPOTIFY_SCOPES,
      code_challenge_method: "S256",
      code_challenge: challenge,
      state,
    });
  const back = await api.identity.launchWebAuthFlow({ url: authUrl, interactive: true });
  const q = new URL(back).searchParams;
  if (q.get("state") !== state || !q.get("code")) throw new Error(q.get("error") || "login cancelled");
  await storeAuth(
    await spotifyToken({ grant_type: "authorization_code", code: q.get("code"), redirect_uri: redirect, code_verifier: verifier })
  );
}

// Returns the Response (caller checks ok). Retries once on 401 with a refreshed token.
async function spotifyFetch(method, path, query) {
  const url = "https://api.spotify.com/v1" + path + (query ? "?" + new URLSearchParams(query) : "");
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, { method, headers: { Authorization: `Bearer ${await spotifyAccessToken()}` } });
    if (res.status !== 401 || attempt) return res;
    const auth = await spotifyAuth();
    if (auth) await api.storage.local.set({ [SPOTIFY_AUTH_KEY]: { ...auth, expires: 0 } });
  }
}

async function spotifyJson(path, query) {
  const res = await spotifyFetch("GET", path, query);
  if (!res.ok) throw new Error(`Spotify API ${res.status}`);
  return res.json();
}

const FALLBACK_STATUSES = [400, 403, 404, 410];

async function albumSaved(id) {
  let res = await spotifyFetch("GET", "/me/albums/contains", { ids: id });
  if (!res.ok && FALLBACK_STATUSES.includes(res.status)) {
    res = await spotifyFetch("GET", "/me/library/contains", { uris: `spotify:album:${id}` });
  }
  if (!res.ok) throw new Error(`Spotify API ${res.status}`);
  return !!(await res.json())[0];
}

async function setAlbumSaved(id, save) {
  const method = save ? "PUT" : "DELETE";
  let res = await spotifyFetch(method, "/me/albums", { ids: id });
  if (!res.ok && FALLBACK_STATUSES.includes(res.status)) {
    res = await spotifyFetch(method, "/me/library", { uris: `spotify:album:${id}` });
  }
  if (!res.ok) throw new Error(`Spotify API ${res.status}`);
}

// Library endpoints exist in two generations (/me/tracks and the newer /me/library); try both.
async function savedFlags(ids) {
  const flags = [];
  for (let i = 0; i < ids.length; i += 40) {
    const chunk = ids.slice(i, i + 40);
    let res = await spotifyFetch("GET", "/me/tracks/contains", { ids: chunk.join(",") });
    if (!res.ok && FALLBACK_STATUSES.includes(res.status)) {
      res = await spotifyFetch("GET", "/me/library/contains", { uris: chunk.map((id) => `spotify:track:${id}`).join(",") });
    }
    if (!res.ok) throw new Error(`Spotify API ${res.status}`);
    flags.push(...(await res.json()));
  }
  return flags;
}

async function setSaved(id, save) {
  const method = save ? "PUT" : "DELETE";
  let res = await spotifyFetch(method, "/me/tracks", { ids: id });
  if (!res.ok && FALLBACK_STATUSES.includes(res.status)) {
    res = await spotifyFetch(method, "/me/library", { uris: `spotify:track:${id}` });
  }
  if (!res.ok) throw new Error(`Spotify API ${res.status}`);
}

async function spotifyTracks(type, id) {
  let items;
  if (type === "track") {
    items = [await spotifyJson(`/tracks/${id}`)];
  } else if (type === "album") {
    items = [];
    let page = await spotifyJson(`/albums/${id}/tracks`, { limit: "50" });
    for (;;) {
      items.push(...page.items);
      if (!page.next) break;
      const res = await fetch(page.next, { headers: { Authorization: `Bearer ${await spotifyAccessToken()}` } });
      if (!res.ok) throw new Error(`Spotify API ${res.status}`);
      page = await res.json();
    }
  } else {
    throw new Error("unsupported type");
  }
  const ids = items.map((t) => t.id);
  const flags = await savedFlags(ids);
  return items.map((t, i) => ({
    id: t.id,
    name: t.name,
    number: t.track_number,
    disc: t.disc_number,
    ms: t.duration_ms,
    saved: !!flags[i],
  }));
}


// Spotify search (needs the account connected); returns [{service, href}].
async function findSpotify(want) {
  if (!(await spotifyAuth())) return [];
  const latin = (s) => String(s).replace(/[^\u0000-\u024F]+/g, " ").replace(/\s+/g, " ").trim();
  const artist = latin(want.artist) || want.artist;
  const title = latin(want.title) || want.title;
  // Several loose queries (fielded queries miss romanized / native-script names).
  const queries = [`${artist} ${title}`, `artist:${artist}`, `${artist} ${want.year || ""}`.trim()];
  const seen = new Map();
  for (const q of queries) {
    try {
      const j = await spotifyJson("/search", { q, type: "album", limit: "10" });
      for (const a of (j.albums && j.albums.items) || []) seen.set(a.id, a);
    } catch {
      /* try the next query */
    }
    const hit = pick(want, seen);
    if (hit) {
      const a = seen.get(hit.href.split("/").pop());
      const imgs = (a && a.images) || [];
      return [{ service: "spotify", href: hit.href, art: (imgs[imgs.length > 1 ? 1 : 0] || {}).url || "" }];
    }
  }
  return [];
}

// Cover art from Spotify, for list covers RYM's image host won't serve to the panel. Cached 30 days; 2 at a time.
let artRunning = 0;
const artQueue = [];
async function coverArt(it) {
  const KEY = "sp:art";
  const cache = ((await api.storage.local.get(KEY))[KEY]) || {};
  const k = it.href || `${it.artist}|${it.title}`;
  const c = cache[k];
  if (c && Date.now() - c.t < (c.url ? 30 * 24 * 3600e3 : 24 * 3600e3)) return c.url; // misses are retried daily
  if (artRunning >= 2) await new Promise((r) => artQueue.push(r));
  artRunning++;
  try {
    const hit = (await findSpotify({ artist: it.artist || "", title: it.title || "", year: 0 }))[0];
    const url = (hit && hit.art) || "";
    const now = ((await api.storage.local.get(KEY))[KEY]) || {};
    now[k] = { t: Date.now(), url };
    const keys = Object.keys(now);
    if (keys.length > 2000) for (const x of keys.slice(0, keys.length - 2000)) delete now[x];
    await api.storage.local.set({ [KEY]: now });
    return url;
  } catch {
    return "";
  } finally {
    artRunning--;
    const next = artQueue.shift();
    if (next) next();
  }
}

// New-music filter: keep only releases Spotify has (fuzzy match via findSpotify), remembering the answer for a week.
// Not connected to Spotify -> nothing can be checked, so everything is returned as is.
async function spFilter(items) {
  if (!(await spotifyAuth())) return { items, filtered: false };
  const KEY = "sp:avail";
  const cache = ((await api.storage.local.get(KEY))[KEY]) || {};
  const WEEK = 7 * 24 * 3600e3;
  const out = new Array(items.length);
  let next = 0;
  const work = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      const it = items[i];
      const c = cache[it.href];
      if (c && Date.now() - c.t < WEEK) {
        out[i] = c.ok ? { ...it, spotify: c.href } : null;
        continue;
      }
      try {
        const hit = (await findSpotify({ artist: it.artist, title: it.title, year: 0 }))[0];
        cache[it.href] = { t: Date.now(), ok: !!hit, href: hit ? hit.href : "" };
        out[i] = hit ? { ...it, spotify: hit.href } : null;
      } catch {
        out[i] = it; // couldn't check: keep it
      }
    }
  };
  await Promise.all([work(), work(), work(), work()]);
  const keys = Object.keys(cache);
  if (keys.length > 3000) for (const k of keys.slice(0, keys.length - 3000)) delete cache[k];
  await api.storage.local.set({ [KEY]: cache });
  return { items: out.filter(Boolean), filtered: true };
}

function pick(want, seen) {
  return pickAlbum(
    want,
    [...seen.values()].map((a) => ({
      title: a.name,
      artist: a.artists && a.artists[0] && a.artists[0].name,
      year: parseInt(a.release_date, 10),
      href: a.id ? `https://open.spotify.com/album/${a.id}` : null,
    }))
  );
}

async function findAlbum(want) {
  const getText = async (u) => {
    const r = await fetch(u, { credentials: "omit" });
    if (!r.ok) throw new Error(String(r.status));
    return r.text();
  };
  const [spotify, others] = await Promise.all([findSpotify(want).catch(() => []), findAlbumLinks(want, getText)]);
  return [...spotify, ...others];
}

async function handleSpotify(msg) {
  try {
    switch (msg.type) {
      case "spotify-status":
        return { connected: !!(await spotifyAuth()), redirectUri: api.identity.getRedirectURL() };
      case "spotify-connect":
        await spotifyConnect();
        return { ok: true };
      case "spotify-tracks":
        return { tracks: await spotifyTracks(msg.kind, msg.id) };
      case "spotify-save":
        await setSaved(msg.id, !!msg.save);
        return { ok: true };
      case "spotify-art": {
        const j = await spotifyJson(msg.kind === "track" ? `/tracks/${msg.id}` : `/albums/${msg.id}`);
        const imgs = (msg.kind === "track" ? j.album : j).images || [];
        return { url: (imgs[imgs.length > 1 ? 1 : 0] || {}).url || "" };
      }
      case "spotify-album":
        return { saved: await albumSaved(msg.id) };
      case "spotify-album-save":
        await setAlbumSaved(msg.id, !!msg.save);
        return { ok: true };
    }
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}

// ---- Side panel player ----
// The panel connects a port while it is open, which is how pages learn whether to play there.
const sidePorts = new Set();
api.runtime.onConnect.addListener((port) => {
  if (port.name !== "sidepanel") return;
  sidePorts.add(port);
  announceSidebar();
  port.onDisconnect.addListener(() => {
    sidePorts.delete(port);
    announceSidebar();
  });
});

// Tell open RYM tabs whether the panel is open so they can simplify their layout.
function announceSidebar() {
  const open = sidePorts.size > 0;
  api.tabs
    .query({ url: ["*://rateyourmusic.com/*", "*://*.rateyourmusic.com/*"] })
    .then((tabs) => {
      for (const t of tabs) api.tabs.sendMessage(t.id, { type: "sidebar-changed", open }).catch(() => {});
    })
    .catch(() => {});
}

if (api.sidePanel && api.sidePanel.setPanelBehavior) {
  // Chromium: the toolbar button toggles the side panel.
  api.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

// ---- RYM gateway ----
// Everything the panel needs from rateyourmusic.com is a task: a message for a RYM page's content script, plus
// the page it must run on (lists) or none (anything that only needs RYM's cookies / code: rating, listening, ...).
//  1. A RYM tab you have open (on that page, if one is needed) answers it.
//  2. Otherwise a helper tab: opened in the background on that page, asked until it answers, then closed.
//     Helper tabs run one at a time, like a person clicking around, so RYM never sees a burst; their content
//     scripts know what they are (#eym-helper) and do nothing on their own (no autoplay, no further tabs).
// A real page load is what gets past RYM's bot check, which refuses script requests (HTTP 403).
const RYM_URLS = ["*://rateyourmusic.com/*", "*://*.rateyourmusic.com/*"];
const helperTabs = new Set();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pathOf = (u) => {
  try {
    return new URL(u, "https://rateyourmusic.com").pathname.replace(/\/?$/, "/");
  } catch {
    return "";
  }
};

async function rymUser() {
  const o = await api.storage.local.get("sidebar:user");
  if (o && o["sidebar:user"]) return o["sidebar:user"];
  const w = await rymTask({ msg: { type: "whoami" } });
  return (w && w.user) || "";
}

// The page a task has to run on ("" = any RYM page).
async function pageFor(msg) {
  switch (msg.type) {
    case "fetch-newmusic":
      return "/new-music/";
    case "read-reco":
    case "exclude":
      return "/recommendations/";
    case "page-record":
      return pathOf(msg.href);
    case "fetch-history":
    case "fetch-favorites": {
      const user = await rymUser();
      if (!user) throw new Error("sign in to rateyourmusic.com in this browser first");
      return msg.type === "fetch-history" ? `/play-history/${user}/` : `/collection/${user}/r3.5-5.0/${msg.page > 1 ? `${msg.page}/` : ""}`;
    }
    default:
      return "";
  }
}

async function liveTab(tabId, page) {
  const tabs = (await api.tabs.query({ url: RYM_URLS })).filter((t) => !helperTabs.has(t.id) && t.status === "complete");
  const pool = page ? tabs.filter((t) => pathOf(t.url) === page) : tabs;
  return pool.find((t) => t.id === tabId) || pool.find((t) => t.active) || pool[0] || null;
}

let helperChain = Promise.resolve();
const helperJobs = new Map();
function inHelperTab(page, msg, now = false) {
  const key = page + "|" + JSON.stringify(msg);
  if (helperJobs.has(key)) return helperJobs.get(key);
  // `now`: asked for by a helper tab itself (it is waiting on this), so it can't queue behind it.
  const job = (now ? Promise.resolve() : helperChain).then(async () => {
    let tab;
    try {
      tab = await api.tabs.create({ url: `https://rateyourmusic.com${page || "/"}#eym-helper`, active: false });
      helperTabs.add(tab.id);
      const start = Date.now();
      let last = null;
      let firstError = 0;
      while (Date.now() - start < 30000) {
        await sleep(600);
        let res;
        try {
          res = await api.tabs.sendMessage(tab.id, msg);
        } catch {
          continue; // page (or its extension code) not there yet
        }
        if (res && !res.error && !res.pending) return { ...res, via: "helper" };
        if (res && res.error) {
          last = res;
          firstError = firstError || Date.now();
          if (Date.now() - firstError > 5000) break; // the page loaded and really can't do it
        }
      }
      return last || { error: "RYM's page didn't load in time" };
    } catch (e) {
      return { error: String((e && e.message) || e) };
    } finally {
      if (tab) {
        helperTabs.delete(tab.id);
        api.tabs.remove(tab.id).catch(() => {});
      }
    }
  });
  if (!now) helperChain = job.catch(() => {});
  const done = job.finally(() => helperJobs.delete(key));
  helperJobs.set(key, done);
  return done;
}

async function rymTask({ tabId = null, msg }) {
  let page;
  try {
    page = await pageFor(msg);
  } catch (e) {
    return { error: String(e.message || e) };
  }
  const tab = await liveTab(tabId, page);
  if (tab) {
    try {
      const res = await api.tabs.sendMessage(tab.id, msg);
      if (res && !res.error && !res.pending) return { ...res, tabId: tab.id };
    } catch {
      /* a tab from before the extension was reloaded: no one answers */
    }
  }
  return inHelperTab(page, msg);
}

// release-data.js could not read a release page by script (bot check): load it in a helper tab, whose content
// script records it into the shared cache.
async function openRelease(href, fromHelper) {
  if (!/^https:\/\/([\w-]+\.)?rateyourmusic\.com\/release\//.test(href)) return false;
  const r = await inHelperTab(pathOf(href), { type: "page-record" }, fromHelper);
  return !!(r && r.ok);
}

// Chromium: Spotify plays from an offscreen document so it keeps going when the side panel is closed.
let offscreenJob = null;
function ensureOffscreen() {
  if (!api.offscreen || !api.offscreen.createDocument) return Promise.resolve(false);
  if (!offscreenJob) {
    offscreenJob = (async () => {
      try {
        const have = api.runtime.getContexts ? await api.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] }) : [];
        if (!have.length) {
          await api.offscreen.createDocument({
            url: "offscreen.html",
            reasons: ["AUDIO_PLAYBACK"],
            justification: "Keep the Spotify player going while the side panel is closed",
          });
        }
        return true;
      } catch {
        return false;
      }
    })().finally(() => {
      offscreenJob = null;
    });
  }
  return offscreenJob;
}

// Toolbar icon badge: ▶ while something is playing (handy when the panel is closed).
let badgeOn = null;
function setPlayingBadge(on) {
  on = !!on;
  if (on === badgeOn) return;
  badgeOn = on;
  const action = api.action || api.browserAction;
  if (!action) return;
  try {
    action.setBadgeText({ text: on ? "▶" : "" });
    if (on && action.setBadgeBackgroundColor) action.setBadgeBackgroundColor({ color: "#1db954" });
    if (on && action.setBadgeTextColor) action.setBadgeTextColor({ color: "#ffffff" });
    if (action.setTitle) action.setTitle({ title: on ? "EmbedYourMusic player (playing)" : "EmbedYourMusic player" });
  } catch {}
}

// RYM play history ("Set listening"): the player reports "listened" once you have listened for a bit; this sends it,
// whether the panel is open or not, and tells the panel how it went.
async function markListening(state) {
  let id = state.rymId || "";
  const href = state.href || "";
  if (!id && href) {
    const ids = ((await api.storage.local.get("sidebar:ids")) || {})["sidebar:ids"] || {};
    try {
      id = ids[new URL(href).pathname] || "";
    } catch {}
    if (!id) {
      const r = await rymTask({ msg: { type: "check-rating", id: "", href, title: state.title || "", artist: state.artist || "" } });
      id = (r && r.id) || "";
    }
  }
  const tell = (ok, text) => {
    for (const port of sidePorts) port.postMessage({ type: "history", ok, text });
  };
  if (!id) return tell(false, "Couldn't add to RYM play history: album id not found");
  const seen = ((await api.storage.local.get("sidebar:listened")) || {})["sidebar:listened"] || {};
  if (Date.now() - (seen[id] || 0) < 6 * 3600e3) return;
  const res = await rymTask({ msg: { type: "set-listening", id } });
  if (!(res && res.ok)) return tell(false, `Couldn't add to RYM play history (${(res && res.error) || "no response"})`);
  seen[id] = Date.now();
  await api.storage.local.set({ "sidebar:listened": seen });
  const o = await api.storage.local.get("sidebar:rymhist");
  if (o && o["sidebar:rymhist"]) await api.storage.local.set({ "sidebar:rymhist": { ...o["sidebar:rymhist"], t: 0 } }); // re-read next time
  tell(true, `Added "${state.title || "this album"}" to your RYM play history`);
}

function handleSidebar(msg, sender, sendResponse) {
  switch (msg.type) {
    case "sidebar-state":
      sendResponse({ open: sidePorts.size > 0 });
      return false;
    case "sidebar-play":
      if (!sidePorts.size) {
        sendResponse({ handled: false });
        return false;
      }
      for (const port of sidePorts) {
        port.postMessage({ type: "play", payload: msg.payload, tabId: sender.tab && sender.tab.id });
      }
      sendResponse({ handled: true });
      return false;
    case "rating-changed":
      for (const port of sidePorts) port.postMessage({ type: "rating", id: msg.id, rating: msg.rating });
      sendResponse({});
      return false;
    case "to-rym":
      rymTask({ tabId: msg.tabId, msg: msg.msg }).then(sendResponse);
      return true;
    case "rate": // from the panel: any RYM tab can carry it out (RYM's own rating request)
      rymTask({ tabId: msg.tabId, msg: { type: "rate", id: msg.id, rating: msg.rating } }).then((r) => sendResponse(r.error ? { ok: false, error: r.error } : r));
      return true;
  }
  return false;
}

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && ["sidebar-state", "sidebar-play", "rating-changed", "rate", "to-rym"].includes(msg.type)) {
    return handleSidebar(msg, sender, sendResponse);
  }
  return false;
});

api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && typeof msg.type === "string" && msg.type.startsWith("spotify-")) {
    handleSpotify(msg).then(sendResponse);
    return true;
  }
  if (msg && msg.type === "cover-art") {
    coverArt(msg.item || {}).then((url) => sendResponse({ url })).catch(() => sendResponse({ url: "" }));
    return true;
  }
  if (msg && msg.type === "sp-filter") {
    spFilter(msg.items || []).then(sendResponse).catch(() => sendResponse({ items: msg.items || [], filtered: false }));
    return true;
  }
  if (msg && msg.type === "eng-ensure") {
    ensureOffscreen().then((ok) => sendResponse({ ok }));
    return true;
  }
  if (msg && msg.type === "eng-state" && msg.state) setPlayingBadge(msg.state.want && msg.state.seen && !msg.state.paused);
  if (msg && msg.type === "eng-state" && msg.event === "listened" && msg.state) {
    markListening(msg.state);
    return false;
  }
  if (msg && msg.type === "listened") {
    markListening(msg.state || {}); // the plain Spotify embed's track list (no custom player)
    return false;
  }
  if (msg && msg.type === "eng-close") {
    // The panel took over playback: make sure the offscreen player can't keep playing alongside it.
    if (api.offscreen && api.offscreen.closeDocument) api.offscreen.closeDocument().catch(() => {});
    sendResponse({});
    return false;
  }
  if (msg && msg.type === "open-release") {
    openRelease(msg.href, !!(_sender.tab && helperTabs.has(_sender.tab.id))).then((ok) => sendResponse({ ok }));
    return true;
  }
  if (msg && msg.type === "find-album") {
    findAlbum(msg.want)
      .then((links) => sendResponse({ links }))
      .catch(() => sendResponse({ links: [] }));
    return true;
  }
  if (msg && msg.type === "resolve-bandcamp") {
    resolveBandcamp(msg.url)
      .then((embed) => sendResponse({ embed }))
      .catch(() => sendResponse({ embed: null }));
    return true; // keep channel open for async response
  }
  return false;
});


// Keyboard media keys -> the player (offscreen engine; in Firefox the open panel answers).
if (api.commands && api.commands.onCommand) {
  api.commands.onCommand.addListener(async (name) => {
    const cmd = { "media-play-pause": "toggle", "media-next": "next", "media-prev": "prev" }[name];
    if (!cmd) return;
    try {
      await ensureOffscreen();
    } catch {}
    api.runtime.sendMessage({ type: "eng-cmd", cmd }).catch(() => {});
  });
}
