// DOM-level test: hide rules, collapse toggles, and embed placement on a mock RYM page.
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { JSDOM } = require("jsdom");

const root = path.join(__dirname, "..");
const css = fs.readFileSync(path.join(root, "content.css"), "utf8");
const js = fs.readFileSync(path.join(root, "content.js"), "utf8");

const html = `<!doctype html><html><head><style>${css}</style></head><body>
<div class="release_page">
  <div id="info">info</div>
  <div id="art">art</div>
  <div id="third">third div (hidden)</div>
  <div class="hide-for-small">
    <div class="section_outer section_issues" id="issues">issues</div>
    <div class="section_credits" id="credits">credits</div>
    <div class="section_tracklisting" id="tracklist">tracklist</div>
    <div class="section_outer section_catalog" id="catalog">catalog</div>
    <div class="ui_stream_links" id="links">
      <a href="https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy">spotify</a>
    </div>
  </div>
  <div class="section_comments" id="comments">comments</div>
  <div class="section_lists" id="lists">lists</div>
  <div class="page_object_section_discussion page_object_section" id="discussion">discussion</div>
  <div class="section_outer section_reviews" id="reviews">reviews</div>
  <div class="section_suggestions" id="suggestions">suggestions</div>
  <table class="album_info_outer"><tbody><tr><td id="infocell">Label text <b id="infobold">bold</b></td></tr></tbody></table>
  <div id="keep">always visible</div>
</div>
</body></html>`;

const dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true });
const { window } = dom;
const { document } = window;

window.IntersectionObserver = class {
  observe() {}
  unobserve() {}
};
window.chrome = { runtime: { sendMessage: async () => ({}) } };
window.eval(js);

// Visible = no element from itself up to <body> has display:none.
const shown = (id) => {
  for (let n = document.getElementById(id); n && n !== document.body; n = n.parentElement) {
    if (window.getComputedStyle(n).display === "none") return false;
  }
  return true;
};

const COLLAPSED = ["issues", "third", "discussion", "comments", "credits", "tracklist", "lists", "catalog"];
for (const id of COLLAPSED) {
  assert.ok(!shown(id), `${id} should start collapsed`);
}
// Open by default
for (const id of ["reviews", "suggestions", "infocell", "infobold"]) {
  assert.ok(shown(id), `${id} should start open`);
}
// Untouched
for (const id of ["info", "art", "keep", "links"]) {
  assert.ok(shown(id), `${id} should stay visible`);
}

// A toggle exists directly before each collapsible
const toggleFor = (id) => {
  const prev = document.getElementById(id).previousElementSibling;
  return prev && prev.classList.contains("rym-collapse-toggle") ? prev : null;
};
for (const id of COLLAPSED) {
  assert.ok(toggleFor(id), `${id} should have a toggle`);
}
assert.strictEqual(document.querySelectorAll(".rym-collapse-toggle").length, 11);

// Open-by-default sections collapse on click and reopen
for (const id of ["reviews", "suggestions"]) {
  const tg = toggleFor(id);
  assert.strictEqual(tg.getAttribute("aria-expanded"), "true");
  tg.click();
  assert.ok(!shown(id), `${id} collapses on click`);
  assert.strictEqual(tg.getAttribute("aria-expanded"), "false");
  tg.click();
  assert.ok(shown(id), `${id} reopens`);
}

// Table cell: toggle inside the cell, contents wrapped and preserved
const cell = document.getElementById("infocell");
assert.ok(cell.firstElementChild.classList.contains("rym-collapse-toggle"));
assert.ok(cell.textContent.includes("Label text"));
assert.strictEqual(cell.querySelector("#infobold").textContent, "bold");
const cellToggle = cell.firstElementChild;
cellToggle.click();
assert.ok(!shown("infobold"), "cell contents hide on click");
assert.ok(shown("infocell"), "cell itself stays");
cellToggle.click();
assert.ok(shown("infobold"), "cell contents return");

// Toggle expands and re-collapses
const t = toggleFor("comments");
t.click();
assert.ok(shown("comments"), "comments expands on click");
assert.strictEqual(t.getAttribute("aria-expanded"), "true");
t.click();
assert.ok(!shown("comments"), "comments collapses again");

// Re-running does not duplicate toggles
window.__embedYourMusic.run();
assert.strictEqual(document.querySelectorAll(".rym-collapse-toggle").length, 11);

// Embed and toggles are non-divs, so div:nth-of-type(3) is still #third
const embeds = document.querySelectorAll(".rym-embed");
assert.strictEqual(embeds.length, 1);
assert.notStrictEqual(embeds[0].tagName, "DIV");
assert.strictEqual(
  document.querySelector(".release_page > div:nth-of-type(3)").id,
  "third"
);

console.log("dom tests passed");
