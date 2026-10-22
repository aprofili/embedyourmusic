// Reviews: detection on release pages, saving through RYM's own form, and the panel's Add / Read Review button.
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { JSDOM, VirtualConsole } = require("jsdom");
const root = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ---- content side: a release page with my_review, unreviewed then "saved" by a simulated RYM form ----
  const page = (inner, body = "") => `<body><div id="my_review" class="my_review edit_mode"><div id="saved_review"><div id="saved_review_inner">${inner}</div></div>
    <div id="review_edit"><textarea id="review_body">${body}</textarea><input type="checkbox" id="review_publish"><input type="button" id="review_save_btn" disabled value="Save review"></div></div>
    <div id="my_catalog_rating_l_55"></div></body>`;
  const mk = async (html, url) => {
    const dom = new JSDOM(html, { url, runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: new VirtualConsole() });
    const w = dom.window;
    w.IntersectionObserver = class { observe() {} unobserve() {} };
    const store = {};
    let handler;
    w.chrome = { runtime: { sendMessage: async () => ({}), onMessage: { addListener: (f) => (handler = f) } }, storage: { local: { get: async (k) => ({ [k]: store[k] }), set: async (o) => Object.assign(store, o) } } };
    w.eval(read("content.js"));
    const ask = (m) => new Promise((r) => handler(m, {}, r));
    return { w, store, ask };
  };
  const url = "https://rateyourmusic.com/release/album/band/album/";
  const a = await mk(page(`<div class="review_body my_review"><span class="rendered_text"></span></div>`), url);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(await a.ask({ type: "check-review", href: url }))), { reviewed: false, url: "" });
  await tick(20);
  assert.strictEqual(a.store["sidebar:reviews"]["/release/album/band/album/"].reviewed, false, "page visit records 'not reviewed'");

  // saving: the page world (main-bridge.js) is simulated: it fills the saved text when asked
  a.w.document.addEventListener("eym-main", (e) => {
    const d = JSON.parse(e.detail);
    if (d.action !== "review") return;
    a.w.document.getElementById("review_body").value = d.text;
    setTimeout(() => {
      a.w.document.querySelector("#saved_review_inner .rendered_text").textContent = d.text;
      a.w.document.querySelector("#saved_review_inner").insertAdjacentHTML("beforeend", `<span class="review_date"><a href="/music-review/me/band/album/9">today</a></span>`);
    }, 300);
  });
  const saved = await a.ask({ type: "save-review", href: url, id: "55", text: "Great record.", publish: false });
  assert.ok(saved.ok, JSON.stringify(saved));
  assert.strictEqual(saved.url, "https://rateyourmusic.com/music-review/me/band/album/9");
  assert.deepStrictEqual(JSON.parse(JSON.stringify(await a.ask({ type: "save-review", href: url, id: "55", text: "  " }))), { error: "nothing to save" });

  const b = await mk(page(`<div class="review_body my_review"><span class="rendered_text">So good</span></div>`), url);
  const rb = JSON.parse(JSON.stringify(await b.ask({ type: "check-review", href: url })));
  assert.strictEqual(rb.reviewed, true);
  assert.strictEqual(rb.url, "https://rateyourmusic.com/release/album/band/album/#my_review", "private review: the page's own #my_review");

  // ---- the real release page (no review of mine on it) ----
  const real = "/root/.claude/uploads/9f0b7094-47c7-58f0-bb8e-5a0c55e1425f/e657e977-attachment.txt";
  if (!process.env.EYM_NO_REAL && fs.existsSync(real)) {
    const r = await mk(fs.readFileSync(real, "utf8"), "https://rateyourmusic.com/release/album/voivod/nothingface/");
    assert.strictEqual((await r.ask({ type: "check-review", href: url })).reviewed, false);
  }

  // ---- panel: button states ----
  const dom = new JSDOM(read("sidepanel.html").replace(/<script[^>]*><\/script>/g, ""), { runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: new VirtualConsole() });
  const w = dom.window;
  w.IntersectionObserver = class { observe() {} unobserve() {} };
  let onMsg;
  const sent = [];
  const store = { "sidebar:reviews": { "/release/album/band/done/": { reviewed: true, url: "https://rateyourmusic.com/music-review/me/band/done/1", t: Date.now() }, "/release/album/band/todo/": { reviewed: false, url: "", t: Date.now() } } };
  let opened = null;
  w.open = (u) => (opened = u);
  w.chrome = {
    runtime: {
      connect: () => ({ onMessage: { addListener: (fn) => (onMsg = fn) }, onDisconnect: { addListener() {} }, postMessage() {} }),
      sendMessage: async (m) => {
        sent.push(m);
        if (m.type === "rate") return { ok: true };
        if (m.type === "to-rym" && m.msg.type === "save-review") return { ok: true, url: "https://rateyourmusic.com/release/album/band/fresh/#my_review" };
        if (m.type === "to-rym" && m.msg.type === "check-review") return { reviewed: false, url: "" };
        return {};
      },
    },
    storage: { local: { get: async (k) => ({ [k]: store[k] }), set: async (o) => Object.assign(store, o) }, onChanged: { addListener() {} } },
  };
  w.eval(read("content.js"));
  w.eval(read("sidepanel.js"));
  await tick(20);
  const d = w.document;
  const play = (slug, rating) => onMsg({ type: "play", tabId: 7, payload: { id: "9", title: slug, artist: "Band", artUrl: "", href: `https://rateyourmusic.com/release/album/band/${slug}/`, rating, ratingKnown: true, entries: [{ service: "tidal", href: "https://tidal.com/album/35146920" }] } });
  const btn = d.getElementById("review-btn");

  play("none", 0);
  await tick(20);
  assert.ok(btn.hidden, "unrated and unreviewed: no button");
  play("done", 8);
  await tick(20);
  assert.ok(!btn.hidden && btn.textContent === "Read Review");
  btn.click();
  assert.strictEqual(opened, "https://rateyourmusic.com/music-review/me/band/done/1");
  play("todo", 8);
  await tick(20);
  assert.ok(!btn.hidden && btn.textContent === "Add Review", "rated, not reviewed");
  assert.ok(d.getElementById("review-box").hidden);
  btn.click();
  assert.ok(!d.getElementById("review-box").hidden, "button opens the box");
  d.getElementById("review-text").value = "Lovely.";
  d.getElementById("review-pub").checked = true;
  d.getElementById("review-send").click();
  await tick(30);
  const sv = sent.find((m) => m.type === "to-rym" && m.msg.type === "save-review");
  assert.ok(sv && sv.msg.text === "Lovely." && sv.msg.publish === true);
  assert.ok(d.getElementById("review-box").hidden, "box closes after saving");
  assert.strictEqual(btn.textContent, "Read Review");
  assert.ok(store["sidebar:reviews"]["/release/album/band/todo/"].reviewed);

  // first rating of an album opens the box
  play("fresh", 0);
  await tick(20);
  d.querySelectorAll("#rating .star")[3].querySelector("button.r").click();
  await tick(30);
  assert.ok(!d.getElementById("review-box").hidden, "rating an album for the first time opens the review box");
  console.log("review tests passed");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
