// Top albums section: chart picker (this year by default), random button follows the pick, chart pages are read and remembered.
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { JSDOM, VirtualConsole } = require("jsdom");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ---- content side: a chart page is read; a filtered chart and the saved charts are remembered ----
  {
    const html = `<head><title>Best shoegaze albums of 2026 - Rate Your Music</title></head><body>
      <div class="chart_item"><a class="release" href="/release/album/a/one/">One Album</a><a class="artist" href="/artist/a">A</a></div>
      <div class="chart_item"><a class="release" href="/release/album/b/two/">Two Album</a><a class="artist" href="/artist/b">B</a></div>
      <div class="chart_item"><a class="release" href="/release/ep/c/three/">Three EP</a><a class="artist" href="/artist/c">C</a></div>
      <span class="navlinkcurrent">1</span><a class="navlinknum" href="x">2</a><a class="navlinknum" href="x">38</a>
      <div><h3>Saved charts</h3><div><a href="/charts/top/album/2026/g:slowcore/">Slowcore 2026</a></div></div></body>`;
    const dom = new JSDOM(html, { url: "https://rateyourmusic.com/charts/top/album/2026/g:shoegaze/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: new VirtualConsole() });
    const w = dom.window;
    w.IntersectionObserver = class { observe() {} unobserve() {} };
    const store = {};
    let handler;
    w.chrome = { runtime: { sendMessage: async () => ({}), onMessage: { addListener: (f) => (handler = f) } }, storage: { local: { get: async (k) => Object.fromEntries([].concat(k).map((x) => [x, store[x]])), set: async (o) => Object.assign(store, o) } } };
    w.eval(read("content.js"));
    await tick(30);
    const r = await new Promise((res) => handler({ type: "fetch-chart", path: "/charts/top/album/2026/g:shoegaze/" }, {}, res));
    assert.deepStrictEqual(JSON.parse(JSON.stringify(r.items)).map((i) => i.title), ["One Album", "Two Album"], "albums only");
    assert.strictEqual(r.pages, 38);
    assert.strictEqual(store["sidebar:charts-seen"][0].path, "/charts/top/album/2026/g:shoegaze/");
    assert.strictEqual(store["sidebar:charts-seen"][0].label, "Best shoegaze albums of 2026");
    assert.deepStrictEqual(JSON.parse(JSON.stringify(store["sidebar:charts-saved"])), [{ path: "/charts/top/album/2026/g:slowcore/", label: "Slowcore 2026" }]);
  }

  // ---- panel ----
  const dom = new JSDOM(read("sidepanel.html").replace(/<script[^>]*><\/script>/g, ""), { runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: new VirtualConsole() });
  const w = dom.window;
  w.IntersectionObserver = class { observe() {} unobserve() {} };
  const year = new Date().getFullYear();
  const sent = [];
  const store = { "sidebar:charts-saved": [{ path: "/charts/top/album/2026/g:slowcore/", label: "Slowcore 2026" }] };
  const albums = (tag, n = 10) => Array.from({ length: n }, (_, i) => ({ title: `${tag} Album ${i}`, artist: "Band", href: `https://rateyourmusic.com/release/album/${tag}/a${i}/`, artUrl: "" }));
  w.open = () => {};
  w.chrome = {
    runtime: {
      connect: () => ({ onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, postMessage() {} }),
      sendMessage: async (m) => {
        sent.push(m);
        if (m.type === "to-rym" && m.msg.type === "fetch-chart") {
          const p = m.msg.path;
          return { items: albums(p.includes("all-time") ? "all" : p.includes("/2/") ? "page2" : "year"), pages: 3 };
        }
        if (m.type === "to-rym" && m.msg.type === "load-release") return { tabId: 9, payload: { id: "7", title: m.msg.item.title, artist: "Band", href: m.msg.item.href, artUrl: "", rating: 0, ratingKnown: true, entries: [{ service: "tidal", href: "https://tidal.com/album/35146920" }] } };
        return {};
      },
    },
    storage: { local: { get: async (k) => ({ [k]: store[k] }), set: async (o) => Object.assign(store, o) }, onChanged: { addListener() {} } },
  };
  w.eval(read("content.js"));
  w.eval(read("sidepanel.js"));
  await tick(20);
  const d = w.document;
  const acc = d.querySelector('.acc[data-kind="charts"]');
  assert.ok(acc, "Top albums section exists");
  acc.querySelector(".acc-head").click();
  await tick(30);
  const sel = acc.querySelector("select.chart-pick");
  assert.ok(sel, "picker shown");
  assert.strictEqual(sel.value, `/charts/top/album/${year}/`, "this year by default");
  const labels = [...sel.options].map((o) => o.textContent);
  for (const l of ["All time", String(year - 1), "1990s", "Slowcore 2026"]) assert.ok(labels.includes(l), `option ${l}`);
  assert.ok(sent.some((m) => m.type === "to-rym" && m.msg.type === "fetch-chart" && m.msg.path === `/charts/top/album/${year}/`));
  assert.ok(acc.querySelectorAll(".item").length > 0);

  // pick another chart: it is read, and random plays from it
  sel.value = "/charts/top/album/all-time/";
  sel.dispatchEvent(new w.Event("change"));
  await tick(30);
  assert.ok(sent.some((m) => m.type === "to-rym" && m.msg.type === "fetch-chart" && m.msg.path === "/charts/top/album/all-time/"));
  assert.ok([...acc.querySelectorAll(".item .t")].every((t) => t.textContent.startsWith("all")), "list is the picked chart");
  assert.strictEqual(store["sidebar:chartsel"], "/charts/top/album/all-time/", "choice remembered");
  acc.querySelector(".dice").click();
  await tick(30);
  const loaded = sent.filter((m) => m.type === "to-rym" && m.msg.type === "load-release").pop();
  assert.ok(loaded && loaded.msg.item.href.includes("/release/album/all/"), "random follows the picked chart");

  // more pages
  acc.querySelector(".acc-head").click(); // close
  acc.querySelector(".acc-head").click();
  await tick(30);
  const more = acc.querySelector(".more");
  more.click(); // shows the rest of page 1 (10 albums fit already)... then loads the next chart page
  await tick(30);
  if (!acc.querySelector(".more").hidden) acc.querySelector(".more").click();
  await tick(30);
  assert.ok(sent.some((m) => m.type === "to-rym" && m.msg.type === "fetch-chart" && m.msg.path === "/charts/top/album/all-time/2/"), "next page requested");
  console.log("charts tests passed");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
