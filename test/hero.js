// Hero layout test on a mock release page shaped like RYM's real markup.
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { JSDOM } = require("jsdom");

const root = path.join(__dirname, "..");
const css = fs.readFileSync(path.join(root, "content.css"), "utf8");
const js = fs.readFileSync(path.join(root, "content.js"), "utf8");

const html = `<!doctype html><html><head><style>.media_link_container{min-height:2.9em;margin:.5em 0;display:flex;justify-content:center}.ui_media_links{display:flex;max-width:31rem}${css}</style></head><body>
<div class="release_page">
  <div id="agg"></div>
  <meta itemprop="name" content="x" />
  <div id="wrapper" style="max-width:1700px"><div class="row">
    <div id="column_container_right" class="large-8 push-4 columns release_right_column">
      <div class="section_main_info section_outer" id="maininfo">info</div>
      <div class="hide-for-small"><div class="section_outer section_issues" id="issues">issues</div></div>
      <div class="section_outer section_reviews" id="reviews">reviews</div>
    </div>
    <div id="column_container_left" class="large-4 pull-8 columns release_left_column">
      <div class="page_release_art_frame" id="frame">
        <div class="hide-for-small" id="frameinner">
          <a href="buy/" id="art"><div class="coverart_1"><img src="x.jpg"></div></a>
          <div id="media_link_button_container_top" class="media_link_container">
            <div id="mlinner"><div class="ui_media_links"><a id="splink" href="https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy">spotify</a></div></div>
          </div>
          <div id="submit">Submit media links</div>
        </div>
      </div>
      <table class="color_bar"><tr><td>.</td></tr></table>
      <div class="hide-for-small"><div class="section_tracklisting" id="tracklist">tracks</div></div>
      <div class="section_comments" id="comments">comments</div>
      <a name="suggestions" class="anchor"></a>
      <div class="section_suggestions" id="suggestions"><div class="release_page_header" id="sug_hdr"><h2>Suggestions</h2></div><ul class="suggestions" id="sugglist"><li>one</li><li>two</li></ul></div>
      <div class="column_filler" id="column_filler_left"></div>
    </div>
  </div></div>
  <div id="contrib">Contributions</div>
</div>
</body></html>`;

function load() {
  const dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  window.IntersectionObserver = class { observe() {} unobserve() {} };
  window.chrome = { runtime: { sendMessage: async () => ({}) } };
  window.eval(js);
  return window;
}

const window = load();
const { document } = window;
const $ = (s) => document.querySelector(s);

// No separate band: the art stays in the left column, the player block tops the right column.
assert.ok(!$(".rym-hero"), "no hero band");
const main = $(".rym-hero-main");
assert.ok(main, "player block created");
assert.strictEqual(main.tagName, "ASIDE");
assert.strictEqual($("#column_container_right").firstElementChild, main, "tops the right column");
assert.ok(main.querySelector("#media_link_button_container_top"), "player container moved");
assert.ok(main.querySelector("#submit"), "submit link moved with it");
assert.ok(main.querySelector("#suggestions"), "suggestions moved");
assert.ok(main.querySelector(".rym-embed"), "our player panel is inside it");

// Art stays at the top of the left column and nothing else is left in its block
const left = $("#column_container_left");
const frame = $("#frame");
assert.strictEqual(left.firstElementChild, frame, "art frame is first in the left column");
assert.ok(frame.contains($("#art")));
assert.deepStrictEqual([...$("#frameinner").children].map((n) => n.id), ["art"]);
assert.notStrictEqual(window.getComputedStyle(frame).display, "none", "art frame stays visible");
// Nothing sits between the art and the rest of the left column (no leftover empty block)
assert.strictEqual(frame.nextElementSibling.tagName, "TABLE", "color bar directly follows the art");
assert.ok(!left.contains($("#suggestions")), "suggestions left the left column");
assert.ok(left.contains($("#tracklist")) && left.contains($("#comments")), "other left sections stay");
assert.ok($("#column_container_right").contains($("#reviews")), "right sections stay");

// Suggestions toggle moved with it and sits directly above it
const sug = $("#suggestions");
assert.ok(sug.previousElementSibling.classList.contains("rym-collapse-toggle"));
assert.ok(main.contains(sug.previousElementSibling));

// Player fills the available width instead of shrink-wrapping to the icon row
const cs = (sel) => window.getComputedStyle($(sel));
assert.strictEqual(cs("#media_link_button_container_top").display, "block");
assert.strictEqual(cs("#mlinner").width, "100%");
assert.strictEqual(cs(".rym-embed").maxWidth, "none");
assert.ok($("#mlinner").contains($(".rym-embed")), "panel sits inside the full-width wrapper");
assert.strictEqual($(".ui_media_links").nextElementSibling, $(".rym-embed"));

// Title reused in the toggle; original header hidden
assert.strictEqual(sug.previousElementSibling.textContent, "\u25BE Suggestions");
assert.ok($("#sug_hdr").classList.contains("rym-title-hidden"));

// Order inside the block: player, then suggestions
const order = [...main.querySelectorAll("#media_link_button_container_top, .rym-embed, #suggestions")].map((n) => n.id || "embed");
assert.deepStrictEqual(order, ["media_link_button_container_top", "embed", "suggestions"]);

// Contributions is still the third div under .release_page
assert.strictEqual($(".release_page > div:nth-of-type(3)").id, "contrib");

// Two-column suggestions style is present
assert.ok(css.includes("column-count: 2"));

// Idempotent
window.__embedYourMusic.run();
assert.strictEqual(document.querySelectorAll(".rym-hero-main").length, 1);
assert.strictEqual(document.querySelectorAll(".rym-embed").length, 1);

// Narrow screens: leave the page alone
const dom2 = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true });
dom2.window.matchMedia = () => ({ matches: false });
dom2.window.IntersectionObserver = class { observe() {} unobserve() {} };
dom2.window.chrome = { runtime: { sendMessage: async () => ({}) } };
dom2.window.eval(js);
assert.ok(!dom2.window.document.querySelector(".rym-hero-main"), "left alone on small screens");
assert.ok(dom2.window.document.querySelector("#column_container_left").contains(dom2.window.document.querySelector("#suggestions")), "suggestions untouched on small screens");

console.log("hero tests passed");
