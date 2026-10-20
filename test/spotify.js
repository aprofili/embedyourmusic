// Spotify per-track saves: background OAuth/API logic and the content-side track list.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const { JSDOM, VirtualConsole } = require("jsdom");

const root = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");

(async () => {
  // ---- background ----
  let listener;
  const store = {};
  const calls = [];
  let authState;
  const saved = new Set(["t2"]);
  let legacy = false; // when true, /me/tracks* return 404 so the /me/library fallback is used
  const json = (o, status = 200) => ({ ok: status < 300, status, json: async () => o });
  const bg = {
    chrome: {
      runtime: { onMessage: { addListener: (fn) => (listener = fn) }, onConnect: { addListener() {} } },
      storage: { local: { get: async (k) => (k in store ? { [k]: store[k] } : {}), set: async (o) => Object.assign(store, o) } },
      identity: {
        getRedirectURL: () => "https://abc.chromiumapp.org/",
        launchWebAuthFlow: async ({ url }) => {
          const u = new URL(url);
          assert.strictEqual(u.searchParams.get("client_id"), "c66c2741c3284f4eae7341cc156ca0e8");
          assert.strictEqual(u.searchParams.get("code_challenge_method"), "S256");
          assert.ok(u.searchParams.get("scope").includes("user-library-modify"));
          authState = u.searchParams.get("state");
          return `https://abc.chromiumapp.org/?code=CODE&state=${authState}`;
        },
      },
    },
    fetch: async (url, opts = {}) => {
      const u = new URL(url);
      const method = opts.method || "GET";
      calls.push(`${method} ${u.pathname}${u.search}`);
      if (u.hostname === "accounts.spotify.com") {
        const body = new URLSearchParams(String(opts.body));
        if (body.get("grant_type") === "authorization_code") {
          assert.ok(body.get("code_verifier").length >= 43 && body.get("code") === "CODE");
          return json({ access_token: "A1", refresh_token: "R1", expires_in: 3600 });
        }
        assert.strictEqual(body.get("refresh_token"), "R1");
        return json({ access_token: "A2", expires_in: 3600 });
      }
      assert.ok(/^Bearer A\d$/.test(opts.headers.Authorization));
      if (u.pathname === "/v1/albums/alb/tracks") {
        return u.searchParams.get("offset")
          ? json({ items: [{ id: "t2", name: "Two", track_number: 2, duration_ms: 5000 }], next: null })
          : json({ items: [{ id: "t1", name: "One", track_number: 1, duration_ms: 61000 }], next: "https://api.spotify.com/v1/albums/alb/tracks?offset=1&limit=1" });
      }
      if (u.pathname.startsWith("/v1/me/tracks") && legacy) return json({}, 404);
      if (u.pathname === "/v1/me/tracks/contains") return json(u.searchParams.get("ids").split(",").map((i) => saved.has(i)));
      if (u.pathname === "/v1/me/library/contains") return json(u.searchParams.get("uris").split(",").map((i) => saved.has(i.split(":")[2])));
      if (u.pathname === "/v1/me/tracks" || u.pathname === "/v1/me/library") {
        const id = (u.searchParams.get("ids") || u.searchParams.get("uris")).split(":").pop();
        method === "PUT" ? saved.add(id) : saved.delete(id);
        return json({});
      }
      return json({}, 500);
    },
    crypto: require("crypto").webcrypto,
    btoa,
    TextEncoder,
    URL,
    URLSearchParams,
    Date,
  };
  bg.globalThis = bg;
  vm.createContext(bg);
  vm.runInContext(read("background.js"), bg);
  const ask = (msg) => new Promise((resolve) => assert.strictEqual(listener(msg, {}, resolve), true));

  let r = await ask({ type: "spotify-status" });
  assert.strictEqual(JSON.stringify(r), '{"connected":false,"redirectUri":"https://abc.chromiumapp.org/"}');
  r = await ask({ type: "spotify-tracks", kind: "album", id: "alb" });
  assert.ok(r.error, "tracks require login");

  r = await ask({ type: "spotify-connect" });
  assert.ok(r.ok);
  assert.strictEqual((await ask({ type: "spotify-status" })).connected, true);

  r = await ask({ type: "spotify-tracks", kind: "album", id: "alb" });
  assert.strictEqual(JSON.stringify(r.tracks.map((t) => [t.id, t.saved])), '[["t1",false],["t2",true]]', "paginated + saved flags");

  assert.ok((await ask({ type: "spotify-save", id: "t1", save: true })).ok);
  assert.ok(saved.has("t1"));
  assert.ok((await ask({ type: "spotify-save", id: "t1", save: false })).ok);
  assert.ok(!saved.has("t1"));

  // expired token refreshes
  store["sp:auth"].expires = 0;
  await ask({ type: "spotify-save", id: "t3", save: true });
  assert.strictEqual(store["sp:auth"].access, "A2");
  assert.strictEqual(store["sp:auth"].refresh, "R1", "refresh token kept");

  // newer /me/library endpoints used when /me/tracks is gone
  legacy = true;
  r = await ask({ type: "spotify-tracks", kind: "album", id: "alb" });
  assert.strictEqual(r.tracks[1].saved, true);
  await ask({ type: "spotify-save", id: "t9", save: true });
  assert.ok(saved.has("t9"));
  assert.ok(calls.some((c) => c.includes("/v1/me/library?uris=spotify%3Atrack%3At9")));

  // ---- content: track list ----
  const dom = new JSDOM("<body></body>", { runScripts: "outside-only", virtualConsole: new VirtualConsole() });
  const w = dom.window;
  w.IntersectionObserver = class { observe() {} unobserve() {} };
  let connected = false;
  const sent = [];
  w.chrome = {
    runtime: {
      sendMessage: async (m) => {
        sent.push(m);
        if (m.type === "spotify-status") return { connected, redirectUri: "https://x.example/" };
        if (m.type === "spotify-connect") return (connected = true), { ok: true };
        if (m.type === "spotify-tracks") return { tracks: [{ id: "a", name: "A", number: 1, ms: 65000, saved: false }, { id: "b", name: "B", number: 2, ms: 1000, saved: true }] };
        if (m.type === "spotify-save") return m.id === "a" ? { error: "Spotify API 403" } : { ok: true };
        return {};
      },
    },
  };
  w.eval(read("content.js"));
  const { trackList, classifyAny } = w.__embedYourMusic;
  assert.strictEqual(trackList(classifyAny("https://open.spotify.com/playlist/xyz")), null);
  const frame = w.document.createElement("iframe");
  w.document.body.append(frame);
  const box = trackList(classifyAny("https://open.spotify.com/album/alb123"), frame);
  w.document.body.append(box);
  const tick = () => new Promise((r) => setTimeout(r, 10));
  await tick(); // open by default: loads without a click
  assert.ok(!box.querySelector(".rym-tracks-list").hidden);
  assert.ok(box.textContent.includes("https://x.example/"), "shows redirect URI when not connected");
  [...box.querySelectorAll("button")].find((b) => b.textContent === "Connect Spotify").click();
  await tick();
  await tick();
  const hearts = [...box.querySelectorAll(".rym-heart")];
  assert.strictEqual(hearts.map((h) => h.textContent).join(""), "♡♥");
  assert.ok(box.textContent.includes("1. A  1:05"));
  hearts[1].click();
  assert.strictEqual(hearts[1].textContent, "♡", "optimistic unsave");
  await tick();
  assert.strictEqual(JSON.stringify(sent.filter((m) => m.type === "spotify-save").pop()), '{"type":"spotify-save","id":"b","save":false}');
  hearts[0].click();
  await tick();
  assert.strictEqual(hearts[0].textContent, "♡", "reverted after API error");

  // playing track is bolded, by URI or by duration; other origins are ignored
  const post = (data, origin = "https://open.spotify.com") =>
    w.dispatchEvent(new w.MessageEvent("message", { data, origin, source: frame.contentWindow }));
  const playing = () => [...box.querySelectorAll(".rym-track")].map((r) => r.classList.contains("rym-track-playing") ? 1 : 0).join("");
  post({ type: "playback_update", payload: { playingURI: "spotify:track:b" } }, "https://evil.example");
  assert.strictEqual(playing(), "00");
  post({ type: "playback_update", payload: { playingURI: "spotify:track:b", isPaused: false } });
  assert.strictEqual(playing(), "01");
  post({ type: "playback_update", payload: { duration: 65000, position: 5 } });
  assert.strictEqual(playing(), "10");
  console.log("spotify tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
