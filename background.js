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

// Saves or removes a liked song and then reads it back: a request can succeed without doing anything (an
// endpoint generation that is no longer honoured), so if the flag didn't change the other generation is tried.
async function setSaved(id, save) {
  const method = save ? "PUT" : "DELETE";
  const tries = [
    () => spotifyFetch(method, "/me/tracks", { ids: id }),
    () => spotifyFetch(method, "/me/library", { uris: `spotify:track:${id}` }),
  ];
  let last = null;
  for (const go of tries) {
    const res = await go();
    last = res;
    if (!res.ok) continue;
    for (let i = 0; i < 3; i++) {
      if (i) await new Promise((r) => setTimeout(r, 400));
      const flags = await savedFlags([id]).catch(() => null);
      if (!flags || !!flags[0] === save) return;
    }
  }
  throw new Error(last && !last.ok ? `Spotify API ${last.status}` : "Spotify didn't keep the change");
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

// ---- Newer editions: a Spotify album that has a deluxe / remastered / anniversary edition released later is played
// as that edition (better mixes, extra tracks). Only the same artist's albums whose base title is the same and whose
// name says it is an edition are considered; the newest release date wins. Remembered per album (sp:newer).
const EDITION_WORDS = /\b(deluxe|expanded|anniversary|remaster(?:ed)?|edition|bonus|special|collector'?s?|super|reissue|re-?mix(?:ed)?|new mix|stereo mix|\d{4} mix)\b/i;
const NOT_THE_ALBUM = /\b(live|karaoke|instrumentals?|tribute|made famous|originally performed|covers?)\b/i;
function albumBase(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, " ")
    .replace(/\s[-–—:]\s.*$/, " ")
    .replace(EDITION_WORDS, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
const fullDate = (d) => (/^\d{4}$/.test(d || "") ? `${d}-01-01` : /^\d{4}-\d\d$/.test(d || "") ? `${d}-01` : d || "");
function pickNewerEdition(orig, cands) {
  const base = albumBase(orig.name);
  const origMono = /\bmono\b/i.test(orig.name);
  const artist = ((orig.artists || [])[0] || {}).id;
  let best = null;
  for (const c of cands || []) {
    if (!c || c.id === orig.id || (c.album_type && c.album_type !== "album")) continue;
    if (albumBase(c.name) !== base || !EDITION_WORDS.test(c.name) || NOT_THE_ALBUM.test(c.name)) continue;
    if (/\bmono\b/i.test(c.name) && !origMono) continue;
    if (artist && !(c.artists || []).some((a) => a.id === artist)) continue;
    if (!(fullDate(c.release_date) > fullDate(orig.release_date))) continue;
    if (!best || fullDate(c.release_date) > fullDate(best.release_date) || (c.release_date === best.release_date && (c.total_tracks || 0) > (best.total_tracks || 0))) best = c;
  }
  return best ? { id: best.id, name: best.name, date: best.release_date } : null;
}
async function newerEdition(id) {
  const key = "sp:newer";
  const all = ((await api.storage.local.get(key)) || {})[key] || {};
  const hit = all[id];
  if (hit && Date.now() - hit.t < (hit.id ? 7 : 3) * 24 * 3600e3) return hit.id ? { id: hit.id, name: hit.name } : {};
  const orig = await spotifyJson(`/albums/${id}`);
  const q = `album:"${albumBase(orig.name) || orig.name}" artist:"${((orig.artists || [])[0] || {}).name || ""}"`;
  const res = await spotifyJson("/search", { q, type: "album", limit: "10" });
  const found = pickNewerEdition({ ...orig, id }, (res.albums && res.albums.items) || []);
  all[id] = { t: Date.now(), id: found ? found.id : "", name: found ? found.name : "" };
  const keys = Object.keys(all);
  if (keys.length > 300) keys.sort((a, b) => all[a].t - all[b].t).slice(0, keys.length - 300).forEach((k) => delete all[k]);
  await api.storage.local.set({ [key]: all });
  return found ? { id: found.id, name: found.name } : {};
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
      case "spotify-newer":
        return await newerEdition(msg.id).catch(() => ({}));
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
let pendingPlay = null; // an album clicked on a page while the panel was closed; played when it opens (2 min)
api.runtime.onConnect.addListener((port) => {
  if (port.name !== "sidepanel") return;
  sidePorts.add(port);
  getListenQueue().then((q) => q.length && flushListening()).catch(() => {});
  if (pendingPlay && Date.now() - pendingPlay.t < 120e3) {
    const p = pendingPlay;
    setTimeout(() => port.postMessage({ type: "play", payload: p.payload, tabId: p.tabId }), 50);
  }
  pendingPlay = null;
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
    case "exclude": {
      const user = await rymUser();
      if (!user) throw new Error("sign in to rateyourmusic.com in this browser first");
      return `/recommendations/${user}/release/`;
    }
    case "fetch-artist":
    case "fetch-chart":
      return msg.path;
    case "set-listening": // the album's own page when we know it: RYM's "Set listening" box lives there
      return msg.href ? pathOf(msg.href) : "";
    case "page-record":
    case "check-review":
    case "save-review":
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

// What the extension is waiting on, shown in the panel when something takes a while.
let latestSeq = 0; // the panel's newest album request; helper jobs for older ones are skipped or stopped
let queued = 0;
function status(text) {
  for (const port of sidePorts) {
    try {
      port.postMessage({ type: "task-status", text });
    } catch {}
  }
}

let helperChain = Promise.resolve();
const helperJobs = new Map();
function inHelperTab(page, msg, now = false, seq = 0) {
  const key = page + "|" + JSON.stringify(msg);
  if (helperJobs.has(key)) return helperJobs.get(key);
  // `now`: asked for by a helper tab itself (it is waiting on this), so it can't queue behind it.
  if (!now && queued) status(`Waiting for ${queued} earlier RYM page${queued > 1 ? "s" : ""} to finish loading`);
  queued++;
  const job = (now ? Promise.resolve() : helperChain).then(async () => {
    queued--;
    if (seq && seq < latestSeq) return { error: "superseded by a newer request" };
    let tab;
    // The tab you're on stays the tab you're on: Edge activates some other tab when a background tab closes,
    // so remember where you were (or moved to meanwhile) and go back there afterwards.
    const prev = (await api.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []))[0];
    let back = prev ? prev.id : null;
    const onAct = (info) => {
      if (tab && info.tabId !== tab.id && prev && info.windowId === prev.windowId) back = info.tabId;
    };
    if (api.tabs.onActivated) api.tabs.onActivated.addListener(onAct);
    try {
      tab = await api.tabs.create({ url: `https://rateyourmusic.com${page || "/"}#eym-helper`, active: false, ...(prev ? { openerTabId: prev.id, windowId: prev.windowId } : {}) });
      helperTabs.add(tab.id);
      status(`Opened ${page || "/"} on RYM in a background tab`);
      const start = Date.now();
      let last = null;
      let firstError = 0;
      let said = 0;
      while (Date.now() - start < 30000) {
        await sleep(600);
        if (seq && seq < latestSeq) return { error: "superseded by a newer request" };
        if (Date.now() - said > 2500) {
          said = Date.now();
          status(`Waiting for RYM's ${page || "/"} page${last ? ` (it answered: ${last.error})` : " to load"}… ${Math.round((Date.now() - start) / 1000)} s`);
        }
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
      if (api.tabs.onActivated) api.tabs.onActivated.removeListener(onAct);
      if (tab) {
        helperTabs.delete(tab.id);
        await api.tabs.remove(tab.id).catch(() => {});
        if (back != null && prev) {
          await sleep(120);
          const now = (await api.tabs.query({ active: true, windowId: prev.windowId }).catch(() => []))[0];
          if (now && now.id !== back) api.tabs.update(back, { active: true }).catch(() => {});
        }
      }
    }
  });
  if (!now) helperChain = job.catch(() => {});
  const done = job.finally(() => helperJobs.delete(key));
  helperJobs.set(key, done);
  return done;
}

async function rymTask({ tabId = null, msg, seq = 0 }) {
  if (seq) latestSeq = Math.max(latestSeq, seq);
  let page;
  try {
    page = await pageFor(msg);
  } catch (e) {
    return { error: String(e.message || e) };
  }
  const tab = await liveTab(tabId, page);
  if (tab) {
    status("Asking your open RYM tab");
    try {
      const res = await api.tabs.sendMessage(tab.id, msg);
      if (res && !res.error && !res.pending) return { ...res, tabId: tab.id };
    } catch {
      /* a tab from before the extension was reloaded: no one answers */
    }
  }
  return inHelperTab(page, msg, false, seq);
}

// release-data.js could not read a release page by script (bot check): load it in a helper tab, whose content
// script records it into the shared cache.
async function openRelease(href, fromHelper, seq = 0) {
  if (!/^https:\/\/([\w-]+\.)?rateyourmusic\.com\/release\//.test(href)) return false;
  const r = await inHelperTab(pathOf(href), { type: "page-record" }, fromHelper, seq);
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
// Play history sends. A send that fails (RYM down, no tab, no id...) stays in a persistent queue
// (sidebar:listenqueue) and goes out first the next time anything can be sent: on the next listened album, when the
// panel connects, or on a retry a few minutes later. Order is kept; the same album is never sent twice in a row.
const LISTEN_QUEUE = "sidebar:listenqueue";
let listenFlushing = false;
let listenRetry = null;
const tellListening = (ok, text) => {
  for (const port of sidePorts) port.postMessage({ type: "history", ok, text });
};
const getListenQueue = async () => ((await api.storage.local.get(LISTEN_QUEUE)) || {})[LISTEN_QUEUE] || [];
async function listenId(item) {
  if (item.id) return item.id;
  if (!item.href) return "";
  try {
    const ids = ((await api.storage.local.get("sidebar:ids")) || {})["sidebar:ids"] || {};
    const hit = ids[new URL(item.href).pathname];
    if (hit) return hit;
  } catch {}
  const r = await rymTask({ msg: { type: "check-rating", id: "", href: item.href, title: item.title || "", artist: item.artist || "" } });
  return (r && r.id) || "";
}
async function flushListening() {
  if (listenFlushing) return;
  listenFlushing = true;
  try {
    for (;;) {
      let q = (await getListenQueue()).filter((x) => Date.now() - (x.t || 0) < 7 * 24 * 3600e3);
      if (!q.length) {
        await api.storage.local.set({ [LISTEN_QUEUE]: [] });
        return;
      }
      const item = q[0];
      const id = await listenId(item);
      const res = id ? await rymTask({ msg: { type: "set-listening", id, href: item.href || "" } }) : { error: "album id not found" };
      if (!(res && res.ok)) {
        tellListening(false, `Couldn't add "${item.title || "this album"}" to RYM play history (${(res && res.error) || "no response"}); it will be sent when RYM answers (${q.length} waiting)`);
        clearTimeout(listenRetry);
        listenRetry = setTimeout(flushListening, 3 * 60e3);
        return;
      }
      q = (await getListenQueue()).filter((x) => (x.id || x.href) !== (item.id || item.href));
      await api.storage.local.set({ [LISTEN_QUEUE]: q, "sidebar:lastlistened": id });
      const o = await api.storage.local.get("sidebar:rymhist");
      if (o && o["sidebar:rymhist"]) await api.storage.local.set({ "sidebar:rymhist": { ...o["sidebar:rymhist"], t: 0 } }); // re-read next time
      tellListening(true, `Added "${item.title || "this album"}" to your RYM play history`);
    }
  } finally {
    listenFlushing = false;
  }
}

// After a restart: whatever was left in the queue goes out once things are up.
if (typeof setTimeout === "function") setTimeout(() => getListenQueue().then((q) => q.length && flushListening()).catch(() => {}), 8000);

let listenChain = Promise.resolve();
function markListening(state) {
  listenChain = listenChain.then(() => doMarkListening(state)).catch(() => {});
  return listenChain;
}
async function doMarkListening(state) {
  const item = { id: state.rymId || "", href: state.href || "", title: state.title || "", artist: state.artist || "", t: Date.now() };
  if (!item.id && !item.href) return tellListening(false, "Couldn't add to RYM play history: album not identified");
  // The same album as the last one in line (queued, else last sent) is not sent again.
  const q = await getListenQueue();
  const key = (x) => x.id || x.href;
  const last = q.length ? key(q[q.length - 1]) : ((await api.storage.local.get("sidebar:lastlistened")) || {})["sidebar:lastlistened"] || "";
  const same = (a) => a && (a === key(item) || (item.id && a === item.id));
  if (same(last) || q.some((x) => key(x) === key(item))) {
    if (q.length) await flushListening();
    return;
  }
  q.push(item);
  await api.storage.local.set({ [LISTEN_QUEUE]: q.slice(-30) });
  await flushListening();
}

function handleSidebar(msg, sender, sendResponse) {
  switch (msg.type) {
    case "sidebar-state":
      sendResponse({ open: sidePorts.size > 0 });
      return false;
    case "sidebar-play":
      if (!sidePorts.size) {
        // The panel is on its way (opened by the click) or will be opened by hand: hold the album for it.
        pendingPlay = { payload: msg.payload, tabId: sender.tab && sender.tab.id, t: Date.now() };
        sendResponse({ handled: true, pending: true });
        return false;
      }
      for (const port of sidePorts) {
        port.postMessage({ type: "play", payload: msg.payload, tabId: sender.tab && sender.tab.id });
      }
      sendResponse({ handled: true });
      return false;
    case "open-panel": {
      // Must run synchronously in this handler: the page's click is the user gesture that allows opening.
      if (sidePorts.size) {
        sendResponse({ open: true });
        return false;
      }
      let p = null;
      try {
        if (api.sidePanel && api.sidePanel.open && sender.tab) p = api.sidePanel.open({ tabId: sender.tab.id });
        else if (api.sidebarAction && api.sidebarAction.open) p = api.sidebarAction.open();
      } catch {
        p = null;
      }
      if (!p) {
        sendResponse({ open: false });
        return false;
      }
      Promise.resolve(p)
        .then(() => sendResponse({ open: true }))
        .catch(() => sendResponse({ open: false }));
      return true;
    }
    case "rating-changed":
      for (const port of sidePorts) port.postMessage({ type: "rating", id: msg.id, rating: msg.rating });
      sendResponse({});
      return false;
    case "to-rym":
      rymTask({ tabId: msg.tabId, msg: msg.msg, seq: msg.seq || 0 }).then(sendResponse);
      return true;
    case "rate": // from the panel: any RYM tab can carry it out (RYM's own rating request)
      rymTask({ tabId: msg.tabId, msg: { type: "rate", id: msg.id, rating: msg.rating } }).then((r) => sendResponse(r.error ? { ok: false, error: r.error } : r));
      return true;
  }
  return false;
}

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && ["sidebar-state", "sidebar-play", "open-panel", "rating-changed", "rate", "to-rym"].includes(msg.type)) {
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
  if (msg && msg.type === "media-key" && ["toggle", "next", "prev"].includes(msg.cmd)) {
    mediaKey(msg.cmd);
    return false;
  }
  if (msg && msg.type === "eng-close") {
    // The panel took over playback: make sure the offscreen player can't keep playing alongside it.
    if (api.offscreen && api.offscreen.closeDocument) api.offscreen.closeDocument().catch(() => {});
    sendResponse({});
    return false;
  }
  if (msg && msg.type === "open-release") {
    openRelease(msg.href, !!(_sender.tab && helperTabs.has(_sender.tab.id)), msg.seq || 0).then((ok) => sendResponse({ ok }));
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
// Two routes deliver the same key press: the extension shortcut (chrome.commands) and the OS media session the
// offscreen document registers (volume overlay, headset buttons). Whichever arrives first wins; a repeat within
// 600 ms is the same press arriving by the other route and is ignored.
const mediaSeen = {};
async function mediaKey(cmd) {
  const now = Date.now();
  if (now - (mediaSeen[cmd] || 0) < 600) return;
  mediaSeen[cmd] = now;
  try {
    await ensureOffscreen();
  } catch {}
  api.runtime.sendMessage({ type: "eng-cmd", cmd }).catch(() => {});
}
if (api.commands && api.commands.onCommand) {
  api.commands.onCommand.addListener((name) => {
    const cmd = { "media-play-pause": "toggle", "media-next": "next", "media-prev": "prev" }[name];
    if (cmd) mediaKey(cmd);
  });
}
