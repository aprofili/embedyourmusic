// Tabbed player test: service URL mapping and tab switching on a mock media-link row.
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { JSDOM, VirtualConsole } = require("jsdom");

const root = path.join(__dirname, "..");
const css = fs.readFileSync(path.join(root, "content.css"), "utf8");
const js = fs.readFileSync(path.join(root, "content.js"), "utf8");

const LINKS = {
  apple: "https://geo.music.apple.com/ca/album/nothing-face/577219389",
  spotify: "https://open.spotify.com/album/49JPEgPvEaFp89xqzeQvF7",
  soundcloud: "https://soundcloud.com/voivod-official/sets/nothing-face-1",
  tidal: "https://tidal.com/album/35146920",
  deezer: "https://www.deezer.com/album/321120667",
  qobuz: "https://open.qobuz.com/album/uh7d6m8gd70jc",
  bandcamp: "https://voivod.bandcamp.com/album/nothingface",
  youtube: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
};

function page(names) {
  const anchors = names.map((n) => `<a id="${n}" href="${LINKS[n]}">${n}</a>`).join("");
  return `<!doctype html><html><head><style>${css}</style></head><body>
  <div id="media_link_button_container_top" class="media_link_container">
    <div><div class="ui_media_links">${anchors}</div></div>
  </div></body></html>`;
}

function load(names, sendMessage) {
  // Silence jsdom's "navigation not implemented" noise from deliberately unprevented link clicks.
  const dom = new JSDOM(page(names), {
    runScripts: "outside-only",
    pretendToBeVisual: true,
    virtualConsole: new VirtualConsole(),
  });
  const { window } = dom;
  // Fire visibility callbacks immediately so players load on selection.
  window.IntersectionObserver = class {
    constructor(cb) { this.cb = cb; }
    observe(t) { this.cb([{ isIntersecting: true, target: t }]); }
    unobserve() {}
  };
  window.chrome = { runtime: { sendMessage: sendMessage || (async () => ({ embed: null })) } };
  window.eval(js);
  return window;
}

const click = (window, el, init = {}) => {
  const ev = new window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
  el.dispatchEvent(ev);
  return ev;
};
const tick = () => new Promise((r) => setTimeout(r, 0));

(async () => {
  // ---- URL mapping ----
  const { classifyAny, classify } = load(["spotify"]).__embedYourMusic;
  const c = (k) => classifyAny(LINKS[k]);

  assert.strictEqual(c("spotify").src, "https://open.spotify.com/embed/album/49JPEgPvEaFp89xqzeQvF7");
  assert.strictEqual(c("apple").src, "https://embed.music.apple.com/ca/album/nothing-face/577219389");
  assert.strictEqual(c("apple").height, 450);
  assert.strictEqual(classifyAny("https://music.apple.com/us/song/x/123").height, 175);
  const sc = new URL(c("soundcloud").src);
  assert.strictEqual(sc.origin + sc.pathname, "https://w.soundcloud.com/player/");
  assert.strictEqual(sc.searchParams.get("url"), "https://soundcloud.com/voivod-official/sets/nothing-face-1");
  assert.strictEqual(c("soundcloud").height, 450);
  assert.strictEqual(c("tidal").src, "https://embed.tidal.com/albums/35146920");
  assert.strictEqual(classifyAny("https://tidal.com/browse/track/99").src, "https://embed.tidal.com/tracks/99");
  assert.strictEqual(c("deezer").src, "https://widget.deezer.com/widget/auto/album/321120667");
  assert.strictEqual(classifyAny("https://www.deezer.com/en/album/5").src, "https://widget.deezer.com/widget/auto/album/5");
  assert.strictEqual(c("youtube").src, "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
  assert.strictEqual(
    classifyAny("https://www.youtube.com/playlist?list=PLabc123").src,
    "https://www.youtube-nocookie.com/embed/videoseries?list=PLabc123"
  );
  assert.strictEqual(c("bandcamp").kind, "bandcamp");
  assert.strictEqual(c("qobuz"), null, "no embed for Qobuz");
  assert.strictEqual(classifyAny("https://example.com/x"), null);
  assert.strictEqual(classifyAny("https://tidal.com/artist/1"), null);
  // Loose links elsewhere on the page stay Spotify/Bandcamp only
  assert.ok(classify(LINKS.spotify) && classify(LINKS.bandcamp));
  assert.strictEqual(classify(LINKS.youtube), null);
  assert.strictEqual(classify(LINKS.apple), null);

  // ---- Tabs ----
  const bc = { src: "https://bandcamp.com/EmbeddedPlayer/album=1/size=large/", height: 120 };
  const w = load(
    ["apple", "spotify", "soundcloud", "tidal", "deezer", "qobuz", "bandcamp", "youtube"],
    async () => ({ embed: bc })
  );
  const d = w.document;
  const $ = (s) => d.querySelector(s);
  const frames = () => [...d.querySelectorAll(".rym-embed-panel iframe")].map((f) => f.src);

  assert.strictEqual(d.querySelectorAll(".rym-tab").length, 7);
  assert.ok(!$("#qobuz").classList.contains("rym-tab"), "Qobuz stays a plain link");
  assert.strictEqual($(".ui_media_links").nextElementSibling, $(".rym-embed-panel"));
  assert.strictEqual($(".rym-embed-panel").tagName, "ASIDE");

  // Defaults to Spotify even though Apple Music is listed first
  assert.ok($("#spotify").classList.contains("rym-tab-active"));
  assert.ok(!$("#apple").classList.contains("rym-tab-active"));
  assert.deepStrictEqual(frames(), ["https://open.spotify.com/embed/album/49JPEgPvEaFp89xqzeQvF7"]);

  // Switching
  let ev = click(w, $("#apple"));
  assert.ok(ev.defaultPrevented, "tab click does not navigate");
  assert.ok($("#apple").classList.contains("rym-tab-active"));
  assert.ok(!$("#spotify").classList.contains("rym-tab-active"));
  assert.strictEqual($("#apple").getAttribute("aria-pressed"), "true");
  assert.strictEqual(frames().length, 2);
  const slots = [...d.querySelectorAll(".rym-embed-slot")];
  assert.ok(slots[0].hidden, "spotify slot hidden");
  assert.ok(!slots[1].hidden, "apple slot shown");
  assert.ok(slots[1].querySelector("iframe").src.startsWith("https://embed.music.apple.com/"));

  // Modified clicks behave like normal links
  ev = click(w, $("#tidal"), { ctrlKey: true });
  assert.ok(!ev.defaultPrevented);
  assert.ok($("#apple").classList.contains("rym-tab-active"), "ctrl-click does not switch");
  ev = click(w, $("#tidal"), { button: 1 });
  assert.ok(!ev.defaultPrevented);

  // Back to Spotify reuses the already-loaded player
  click(w, $("#spotify"));
  assert.strictEqual(frames().length, 2, "no reload when switching back");
  assert.ok(!slots[0].hidden && slots[1].hidden);

  // Qobuz is not intercepted
  assert.ok(!click(w, $("#qobuz")).defaultPrevented);

  // Every embeddable service gets a working tab
  for (const id of ["soundcloud", "tidal", "deezer", "youtube"]) click(w, $(`#${id}`));
  assert.strictEqual(frames().length, 6);
  const yt = [...d.querySelectorAll(".rym-embed-slot")].find((s) => s.querySelector("iframe").src.includes("youtube"));
  assert.strictEqual(yt.style.maxWidth, "720px");

  // Bandcamp resolves asynchronously
  click(w, $("#bandcamp"));
  const bcSlot = [...d.querySelectorAll(".rym-embed-slot")].pop();
  assert.strictEqual(bcSlot.textContent, "Loading…");
  await tick();
  assert.strictEqual(bcSlot.querySelector("iframe").src, bc.src);

  // Idempotent
  w.__embedYourMusic.run();
  assert.strictEqual(d.querySelectorAll(".rym-embed-panel").length, 1);

  // ---- No Spotify: first embeddable tab is the default ----
  const w2 = load(["qobuz", "tidal", "deezer"]);
  assert.ok(w2.document.querySelector("#tidal").classList.contains("rym-tab-active"));

  // ---- Bandcamp failure shows a fallback link ----
  const w3 = load(["bandcamp"], async () => ({ embed: null }));
  await tick();
  const msg = w3.document.querySelector(".rym-embed-msg");
  assert.ok(msg && msg.textContent.includes("Couldn't load the Bandcamp player"));
  assert.strictEqual(msg.querySelector("a").href, LINKS.bandcamp);

  // ---- Only non-embeddable links: nothing changes ----
  const w4 = load(["qobuz"]);
  assert.ok(!w4.document.querySelector(".rym-embed-panel"));

  console.log("tab tests passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
