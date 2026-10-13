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

const shown = (id) => window.getComputedStyle(document.getElementById(id)).display !== "none";

// Always hidden
for (const id of ["issues", "third", "discussion"]) {
  assert.ok(!shown(id), `${id} should be hidden`);
}
// Collapsed by default
for (const id of ["comments", "credits", "tracklist", "lists", "catalog"]) {
  assert.ok(!shown(id), `${id} should start collapsed`);
}
// Untouched
for (const id of ["info", "art", "keep", "links"]) {
  assert.ok(shown(id), `${id} should stay visible`);
}

// A toggle exists directly before each collapsible, and none for hidden sections
const toggleFor = (id) => {
  const prev = document.getElementById(id).previousElementSibling;
  return prev && prev.classList.contains("rym-collapse-toggle") ? prev : null;
};
for (const id of ["comments", "credits", "tracklist", "lists", "catalog"]) {
  assert.ok(toggleFor(id), `${id} should have a toggle`);
}
assert.strictEqual(document.querySelectorAll(".rym-collapse-toggle").length, 5);
assert.ok(!document.querySelector("#issues").previousElementSibling, "no toggle for hidden section");

// Toggle expands and re-collapses
const t = toggleFor("comments");
t.click();
assert.ok(shown("comments"), "comments expands on click");
assert.strictEqual(t.getAttribute("aria-expanded"), "true");
t.click();
assert.ok(!shown("comments"), "comments collapses again");

// Re-running does not duplicate toggles
window.__embedYourMusic.run();
assert.strictEqual(document.querySelectorAll(".rym-collapse-toggle").length, 5);

// Embed was inserted, as a non-div, so div:nth-of-type(3) is still #third
const embeds = document.querySelectorAll(".rym-embed");
assert.strictEqual(embeds.length, 1);
assert.notStrictEqual(embeds[0].tagName, "DIV");
assert.strictEqual(
  document.querySelector(".release_page > div:nth-of-type(3)").id,
  "third"
);

console.log("dom tests passed");
