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
  await assert.rejects(() => w.__eymRelease.get("10", "/release/x/10"), /HTTP 429; paused/);
  assert.ok(w.__eymRelease.blocked());
  const n = log.length;
  await assert.rejects(() => w.__eymRelease.get("11", "/release/x/11"), /HTTP 429; paused/);
  assert.strictEqual(log.length, n, "no requests while paused");
  // repeated failures back off: 5 min -> 15 min -> 30 min -> 1 h; a success resets the ladder
  const until = () => Number(w.localStorage.getItem("eym:blocked-until")) - Date.now();
  assert.ok(until() > 4 * 60e3 && until() <= 5 * 60e3);
  w.localStorage.setItem("eym:blocked-until", "0");
  await assert.rejects(() => w.__eymRelease.get("12", "/release/x/12"), /paused/);
  assert.ok(until() > 14 * 60e3 && until() <= 15 * 60e3, "second failure: 15 min");
  w.localStorage.setItem("eym:blocked-until", "0");
  await assert.rejects(() => w.__eymRelease.get("13", "/release/x/13"), /paused/);
  assert.ok(until() > 29 * 60e3 && until() <= 30 * 60e3, "third failure: 30 min");
  w.__eymRelease.clearBlock();
  assert.ok(!w.__eymRelease.blocked(), "manual retry clears the pause");
  setStatus(200);
  await w.__eymRelease.get("14", "/release/x/14");
  assert.strictEqual(w.localStorage.getItem("eym:block-count"), "0", "success resets the ladder");
  // peek never touches the network
  const before = log.length;
  assert.strictEqual(w.__eymRelease.peek("999"), null);
  assert.strictEqual(log.length, before);
  // ---- Extra savings ----
  {
    const m = make();
    const R = m.w.__eymRelease;
    // a release page you open yourself fills the cache: later lookups cost nothing
    R.put("50", { rating: 8, ratingKnown: true, links: '{"spotify":{}}' });
    await R.get("50", "/release/x/50");
    assert.strictEqual(m.log.length, 0, "put fills the cache");
    // links survive the 20 min unrated expiry
    R.put("51", { rating: 0, ratingKnown: true, links: '{"spotify":{}}' });
    m.w.localStorage.setItem("eym:rel:51", JSON.stringify({ t: Date.now() - 3 * 3600e3, rating: 0, ratingKnown: true, links: '{"spotify":{}}' }));
    const l = await R.getLinks("51", "/release/x/51");
    assert.strictEqual(m.log.length, 0, "stale links reused for playing");
    assert.ok(l.links.includes("spotify"));
    // by-URL lookups dedupe and are remembered
    const [x, y] = await Promise.all([R.getByHref("/release/a/b/7"), R.getByHref("/release/a/b/7")]);
    assert.strictEqual(m.log.length, 1);
    assert.strictEqual(x.id, "7");
    await R.getByHref("/release/a/b/7");
    assert.strictEqual(m.log.length, 1, "second click costs nothing");
    // a failing page isn't re-requested for 5 minutes
    m.setStatus(404);
    await assert.rejects(() => R.get("60", "/release/x/60"));
    const n2 = m.log.length;
    await assert.rejects(() => R.get("60", "/release/x/60"));
    assert.strictEqual(m.log.length, n2, "failure remembered");
    // other requests to RYM can trip the same pause
    R.noteStatus(429);
    assert.ok(R.blocked());
  }
  // 403 on a script fetch: fall back to a background tab, whose page records itself in the cache
  {
    const m = make();
    const R = m.w.__eymRelease;
    m.setStatus(403);
    const asked = [];
    m.w.chrome = {
      runtime: {
        id: "x",
        sendMessage: async (msg) => {
          asked.push(msg);
          m.w.localStorage.setItem("eym:rel:555", JSON.stringify({ t: Date.now(), rating: 0, ratingKnown: true, links: '{"spotify":{}}', title: "T" }));
          m.w.localStorage.setItem("eym:href:/release/album/a/t/", "555");
          return { ok: true };
        },
      },
    };
    const rec = await R.getByHref("https://rateyourmusic.com/release/album/a/t/");
    assert.strictEqual(asked[0].type, "open-release");
    assert.strictEqual(rec.id, "555");
    assert.ok(!R.blocked(), "tab success means no pause");
  }
  console.log("release-data tests passed");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
