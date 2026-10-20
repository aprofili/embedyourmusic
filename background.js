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
    if (hit) return [{ service: "spotify", href: hit.href }];
  }
  return [];
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
    case "to-rym": {
      // Panel -> a rateyourmusic.com tab (it needs RYM's cookies / page): the given tab if it is
      // still open, else any RYM tab.
      (async () => {
        const rym = await api.tabs.query({ url: ["*://rateyourmusic.com/*", "*://*.rateyourmusic.com/*"] });
        const pool = msg.urlPart ? rym.filter((t) => (t.url || "").includes(msg.urlPart)) : rym;
        const tab = pool.find((t) => t.id === msg.tabId) || pool.find((t) => t.active) || pool[0];
        if (!tab) return { error: msg.urlPart === "/recommendations/" ? "open your recommendations page first" : msg.urlPart ? "open that album's RYM page first" : "open a rateyourmusic.com tab first" };
        try {
          const res = await api.tabs.sendMessage(tab.id, msg.msg);
          return { ...(res || { error: "no response (reload the RYM tab)" }), tabId: tab.id };
        } catch {
          return { error: "no response (reload the RYM tab)" };
        }
      })().then(sendResponse);
      return true;
    }
    case "rate": // from the panel: forward to the page that started playback
      api.tabs
        .sendMessage(msg.tabId, { type: "rate", id: msg.id, rating: msg.rating })
        .then((r) => sendResponse(r || { ok: false, error: "no response" }))
        .catch(() => sendResponse({ ok: false, error: "that tab is closed" }));
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
