// Request-reduction logic: cache, dedupe, serialisation, rate-limit pause.
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { JSDOM, VirtualConsole } = require("jsdom");

const src = fs.readFileSync(path.join(__dirname, "..", "release-data.js"), "utf8");

function make() {
  const dom = new JSDOM("<body></body>", { url: "https://rateyourmusic.com/recommendations/u/", runScripts: "outside-only", virtualConsole: new VirtualConsole() });
  const w = dom.window;
  w.__eymGapMs = 0;
  const log = [];
  let status = 200;
  let inFlight = 0, maxInFlight = 0;
  w.fetch = async (u) => {
    log.push(u);
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    const id = u.split("/").filter(Boolean).pop();
    return { ok: status === 200, status, text: async () => `<div data-links='{"spotify":{}}'></div>new RYMrating('l', ${id}, ${id === "7" ? 6 : 0} );` };
  };
  w.eval(src);
  return { w, log, setStatus: (s) => (status = s), maxInFlight: () => maxInFlight };
}

(async () => {
  const { w, log, setStatus, maxInFlight } = make();
  const rel = w.__eymRelease;

  // concurrent callers share one request; requests are serialised
  const [a, b] = await Promise.all([rel.get("7", "/release/x/7"), rel.get("7", "/release/x/7")]);
  assert.strictEqual(log.length, 1, "deduped");
  assert.strictEqual(a.rating, 6);
  assert.ok(a.ratingKnown && a.links.includes("spotify"));
  await Promise.all([rel.get("8", "/release/x/8"), rel.get("9", "/release/x/9")]);
  assert.strictEqual(maxInFlight(), 1, "one request at a time");

  // cache hit: no request
  await rel.get("7", "/release/x/7");
  assert.strictEqual(log.length, 3);

  // new instance (another tab/page load) reads the same localStorage
  const again = w.eval("globalThis.__eymRelease = undefined; 0");
  w.eval(src);
  await w.__eymRelease.get("7", "/release/x/7");
  assert.strictEqual(log.length, 3, "persisted across loads");

  // unrated entries expire (20 min); rated ones don't
  const k8 = JSON.parse(w.localStorage.getItem("eym:rel:8"));
  w.localStorage.setItem("eym:rel:8", JSON.stringify({ ...k8, t: Date.now() - 21 * 60000 }));
  const k7 = JSON.parse(w.localStorage.getItem("eym:rel:7"));
  w.localStorage.setItem("eym:rel:7", JSON.stringify({ ...k7, t: Date.now() - 21 * 60000 }));
  await w.__eymRelease.get("8", "/release/x/8");
  await w.__eymRelease.get("7", "/release/x/7");
  assert.strictEqual(log.length, 4, "unrated refetched, rated still cached");

  // rating something updates the cache
  w.__eymRelease.setRating("8", 9);
  assert.strictEqual((await w.__eymRelease.get("8", "/release/x/8")).rating, 9);
  assert.strictEqual(log.length, 4);

  // 429 pauses everything
  setStatus(429);
  await assert.rejects(() => w.__eymRelease.get("10", "/release/x/10"), /rate-limiting/);
  assert.ok(w.__eymRelease.blocked());
  const n = log.length;
  await assert.rejects(() => w.__eymRelease.get("11", "/release/x/11"), /rate-limiting/);
  assert.strictEqual(log.length, n, "no requests while paused");
  console.log("release-data tests passed");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
