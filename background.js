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
  port.onDisconnect.addListener(() => sidePorts.delete(port));
});

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
  if (msg && ["sidebar-state", "sidebar-play", "rating-changed", "rate"].includes(msg.type)) {
    return handleSidebar(msg, sender, sendResponse);
  }
  return false;
});

api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && typeof msg.type === "string" && msg.type.startsWith("spotify-")) {
    handleSpotify(msg).then(sendResponse);
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
