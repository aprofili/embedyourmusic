// Playlists: background reads saved playlists and dedupes a playlist's tracks to albums; the built-in essential list.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

(async () => {
  let listener;
  const store = { "sp:auth": { access: "A", refresh: "R", expires: Date.now() + 1e6, scope: "user-library-read playlist-read-private" } };
  const json = (o, status = 200) => ({ ok: status < 300, status, json: async () => o });
  let itemsGone = false;
  const bg = {
    chrome: {
      runtime: { onMessage: { addListener: (fn) => (listener = fn) }, onConnect: { addListener() {} } },
      storage: { local: { get: async (k) => (k in store ? { [k]: store[k] } : {}), set: async (o) => Object.assign(store, o) } },
      identity: { getRedirectURL: () => "https://x.chromiumapp.org/" },
    },
    fetch: async (url) => {
      const u = new URL(url);
      if (u.pathname === "/v1/me/playlists")
        return json({ items: [{ id: "p1", name: "Mine", images: [{ url: "big" }, { url: "mid" }, { url: "small" }], tracks: { total: 5 }, owner: { display_name: "me" } }, { id: "p2", name: "Bare", images: [], tracks: { total: 0 } }], next: null });
      if (u.pathname === "/v1/playlists/p1/tracks" && itemsGone) return json({}, 404);
      if (u.pathname === "/v1/playlists/p1/tracks" || u.pathname === "/v1/playlists/p1/items") {
        const al = (id, name, extra = {}) => ({ id, name, album_type: "album", total_tracks: 10, images: [{ url: `${id}-big` }, { url: `${id}-mid` }], artists: [{ name: "Art" }], ...extra });
        return json({ items: [
          { track: { id: "t1", album: al("a1", "One") } },
          { track: { id: "t2", album: al("a1", "One") } },
          { track: { id: "t3", is_local: true, album: al("a9", "Local") } },
          { track: { id: "t4", album: al("a2", "Lone single", { album_type: "single", total_tracks: 1 }) } },
          { item: { id: "t5", album: al("a3", "Three") } },
          { track: null },
        ], next: null });
      }
      return json({}, 500);
    },
    URL, URLSearchParams, Date, btoa, TextEncoder, crypto: require("crypto").webcrypto,
  };
  bg.globalThis = bg;
  vm.createContext(bg);
  vm.runInContext(read("background.js"), bg);
  const ask = (msg) => new Promise((resolve) => listener(msg, {}, resolve));

  assert.ok(/playlist-read-private/.test(read("background.js").match(/const SPOTIFY_SCOPES = "([^"]*)"/)[1]), "scope requested");
  let r = await ask({ type: "spotify-playlists" });
  assert.strictEqual(r.scopeOk, true);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r.playlists)), [
    { id: "p1", name: "Mine", image: "mid", total: 5, owner: "me" },
    { id: "p2", name: "Bare", image: "", total: 0, owner: "" },
  ]);
  r = await ask({ type: "spotify-playlist-items", id: "p1" });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r.items)), [
    { spotifyId: "a1", title: "One", artist: "Art", artUrl: "a1-mid" },
    { spotifyId: "a3", title: "Three", artist: "Art", artUrl: "a3-mid" },
  ]);
  itemsGone = true; // renamed endpoint: falls back to /items
  assert.strictEqual((await ask({ type: "spotify-playlist-items", id: "p1" })).items.length, 2);
  store["sp:auth"].scope = "user-library-read";
  r = await ask({ type: "spotify-playlists" });
  assert.strictEqual(r.scopeOk, false, "old connection needs to reconnect");

  const g = {};
  vm.runInNewContext(read("essential.js"), { globalThis: g });
  const ess = g.EYM_ESSENTIAL;
  assert.ok(ess.length >= 100 && ess.length <= 200, `essential size ${ess.length}`);
  assert.ok(ess.every((x) => x.length === 2 && x[0] && x[1]));
  assert.strictEqual(new Set(ess.map((x) => x.join("|"))).size, ess.length, "no duplicates");
  console.log("playlists tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
