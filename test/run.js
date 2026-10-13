// Loads the extension scripts in a stubbed sandbox and checks core logic.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const root = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");

// manifest sanity
const manifest = JSON.parse(read("manifest.json"));
assert.strictEqual(manifest.manifest_version, 3);
for (const f of ["background.js", "content.js", "content.css", "rules.json"]) {
  assert.ok(fs.existsSync(path.join(root, f)), `${f} missing`);
}
JSON.parse(read("rules.json"));

(async () => {
  // ---- content.js: classify ----
  const ctx = {
    document: {
      body: {},
      querySelectorAll: () => [],
    },
    IntersectionObserver: class {
      observe() {}
      unobserve() {}
    },
    MutationObserver: class {
      observe() {}
    },
    chrome: { runtime: { sendMessage: async () => ({}) } },
    URL,
    setTimeout,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(read("content.js"), ctx);
  const { classify } = ctx.__embedYourMusic;

  let r = classify("https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy?si=abc");
  assert.strictEqual(r.src, "https://open.spotify.com/embed/album/4aawyAB9vmqN3uQ7FjRGTy");
  assert.strictEqual(r.height, 352);

  r = classify("https://open.spotify.com/intl-de/track/11dFghVXANMlKmJXsNCbNl");
  assert.strictEqual(r.src, "https://open.spotify.com/embed/track/11dFghVXANMlKmJXsNCbNl");
  assert.strictEqual(r.height, 152);

  r = classify("https://someband.bandcamp.com/album/some-album?from=x");
  assert.strictEqual(r.kind, "bandcamp");
  assert.strictEqual(r.url, "https://someband.bandcamp.com/album/some-album");

  assert.strictEqual(classify("https://bandcamp.com/"), null);
  assert.strictEqual(classify("https://someband.bandcamp.com/"), null);
  assert.strictEqual(classify("https://example.com/album/1"), null);
  assert.strictEqual(classify(""), null);

  // ---- background.js: bandcamp resolution ----
  let listener;
  const store = {};
  const fetched = [];
  const bg = {
    chrome: {
      runtime: { onMessage: { addListener: (fn) => (listener = fn) } },
      storage: {
        local: {
          get: async (k) => (k in store ? { [k]: store[k] } : {}),
          set: async (o) => Object.assign(store, o),
        },
      },
    },
    fetch: async (url) => {
      fetched.push(url);
      const html = url.includes("fallback")
        ? `<meta name="bc-page-properties" content='{"item_type":"a","item_id":12345}'>`
        : url.includes("nothing")
        ? "<html></html>"
        : `<meta property="og:video" content="https://bandcamp.com/EmbeddedPlayer/v=2/album=999/size=large/tracklist=false/artwork=small/&amp;t=1">`;
      return { ok: true, text: async () => html };
    },
    URL,
  };
  bg.globalThis = bg;
  vm.createContext(bg);
  vm.runInContext(read("background.js"), bg);

  const ask = (url) =>
    new Promise((resolve) => {
      const keep = listener({ type: "resolve-bandcamp", url }, {}, resolve);
      assert.strictEqual(keep, true);
    });

  let res = await ask("https://a.bandcamp.com/album/x");
  assert.ok(res.embed.src.includes("album=999"));
  assert.ok(res.embed.src.includes("&t=1"), "entities decoded");
  assert.strictEqual(res.embed.height, 120);

  await ask("https://a.bandcamp.com/album/x");
  assert.strictEqual(fetched.length, 1, "second lookup served from cache");

  res = await ask("https://a.bandcamp.com/album/fallback");
  assert.ok(res.embed.src.includes("album=12345"));

  res = await ask("https://a.bandcamp.com/album/nothing");
  assert.strictEqual(res.embed, null);

  res = await ask("https://evil.example.com/album/x");
  assert.strictEqual(res.embed, null);
  assert.ok(!fetched.some((u) => u.includes("evil.example.com")), "non-bandcamp host never fetched");

  console.log("all tests passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
