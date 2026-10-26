// Builds browser-specific packages into dist/.
// manifest.json is the Chromium (Edge/Chrome) manifest and also loads directly from the repo root.
// Firefox needs background.scripts instead of a service worker, plus a gecko id.
const fs = require("fs");
const path = require("path");

const root = __dirname;
const FILES = ["background.js", "content.js", "content.css", "artist-ratings.js", "recommendations.js", "reco-ratings.js", "main-bridge.js", "release-data.js", "sidepanel.html", "spengine.js", "offscreen.html", "offscreen.js", "spplayer.js", "sidepanel.js", "sidepanel.css", "rules.json", "referer-rules.json"];
const base = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
// Releases set EYM_VERSION from the git tag.
if (process.env.EYM_VERSION) base.version = process.env.EYM_VERSION;

const { key: _key, ...baseNoKey } = base; // `key` pins the Chromium extension id (stable OAuth redirect URI)
// Firefox has a sidebar instead of a side panel.
const { side_panel: _sp, ...baseNoPanel } = baseNoKey;
const firefox = {
  ...baseNoPanel,
  permissions: base.permissions.filter((p) => p !== "sidePanel" && p !== "offscreen"),
  // (Firefox's media keys are already system-wide; it doesn't know the Chromium-only "global" flag)
  commands: Object.fromEntries(Object.entries(base.commands || {}).map(([k, { global: _g, ...c }]) => [k, c])),
  sidebar_action: {
    default_panel: "sidepanel.html",
    default_title: "EmbedYourMusic player",
    default_icon: base.icons,
    open_at_install: false,
  },
  background: { scripts: ["background.js"] },
  browser_specific_settings: {
    gecko: {
      id: "embedyourmusic@aprofili",
      strict_min_version: "140.0",
      data_collection_permissions: { required: ["none"] },
    },
  },
};

function emit(name, manifest, files = FILES) {
  const dir = path.join(root, "dist", name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const f of files) fs.copyFileSync(path.join(root, f), path.join(dir, f));
  fs.cpSync(path.join(root, "icons"), path.join(dir, "icons"), { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`built dist/${name}`);
}

emit("chromium", base);
// Edge Add-ons assigns its own extension id, so the store package must not carry the pinned `key`.
{
  // The CSP-stripping ruleset is disabled by default and only for manual use, so the store build
  // leaves out declarativeNetRequest (store review rejects permissions the extension doesn't need).
  const { key: _k, ...storeManifest } = base;
  storeManifest.declarative_net_request = { rule_resources: base.declarative_net_request.rule_resources.filter((r) => r.id !== "strip_csp") };
  emit("edge-store", storeManifest, FILES.filter((f) => f !== "rules.json"));
}
emit("firefox", firefox);

// ---- iOS / Safari userscript (Userscripts app) ----
// No background script exists there, so Bandcamp lookups go through GM_xmlhttpRequest.
const bg = fs.readFileSync(path.join(root, "background.js"), "utf8");
const shared = bg.match(/\/\/ <shared:bandcamp>([\s\S]*?)\/\/ <\/shared:bandcamp>/);
if (!shared) throw new Error("shared:bandcamp markers missing in background.js");
const sharedFind = bg.match(/\/\/ <shared:find>([\s\S]*?)\/\/ <\/shared:find>/);
if (!sharedFind) throw new Error("shared:find markers missing in background.js");
let content = fs.readFileSync(path.join(root, "content.js"), "utf8");
const API_LINE = "const api = globalThis.browser ?? globalThis.chrome;";
if (!content.includes(API_LINE)) throw new Error("api line missing in content.js");
content = content.replace(API_LINE, "const api = globalThis.__eymBridge;");
const css = fs.readFileSync(path.join(root, "content.css"), "utf8");

const header = `// ==UserScript==
// @name         EmbedYourMusic
// @description  Inline players, tabs and collapsed sections on rateyourmusic.com
// @version      ${base.version}
// @updateURL    https://github.com/aprofili/embedyourmusic/releases/latest/download/embedyourmusic.user.js
// @downloadURL  https://github.com/aprofili/embedyourmusic/releases/latest/download/embedyourmusic.user.js
// @match        *://rateyourmusic.com/*
// @match        *://*.rateyourmusic.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @connect      bandcamp.com
// @connect      *.bandcamp.com
// @connect      itunes.apple.com
// @connect      api.deezer.com
// @run-at       document-start
// @inject-into  content
// @noframes
// ==/UserScript==
`;

const prelude = `(() => {
const CACHE_PREFIX = "bc:";
${shared[1]}
${sharedFind[1]}
function gmGet(url) {
  return new Promise((resolve, reject) => {
    const opts = {
      method: "GET",
      url,
      anonymous: true,
      onload: (r) => resolve(r.responseText),
      onerror: reject,
      ontimeout: reject,
    };
    if (typeof GM_xmlhttpRequest === "function") GM_xmlhttpRequest(opts);
    else if (typeof GM !== "undefined" && GM.xmlHttpRequest) GM.xmlHttpRequest(opts);
    else reject(new Error("no GM_xmlhttpRequest"));
  });
}
async function resolveBandcamp(url) {
  if (!isBandcampItemUrl(url)) return null;
  const key = CACHE_PREFIX + url;
  try {
    const hit = localStorage.getItem(key);
    if (hit) return JSON.parse(hit);
  } catch {}
  const embed = parseBandcampEmbed(await gmGet(url));
  if (embed) {
    try { localStorage.setItem(key, JSON.stringify(embed)); } catch {}
  }
  return embed;
}
globalThis.__eymBridge = {
  runtime: {
    sendMessage: async (msg) => {
      if (msg && msg.type === "resolve-bandcamp") {
        try { return { embed: await resolveBandcamp(msg.url) }; } catch { return { embed: null }; }
      }
      if (msg && msg.type === "find-album") {
        try { return { links: await findAlbumLinks(msg.want, gmGet) }; } catch { return { links: [] }; }
      }
      return { unsupported: true };
    },
  },
};
// Styles go in immediately (document-start) so the loading cover appears before first paint.
const style = document.createElement("style");
style.textContent = ${JSON.stringify(css)};
document.documentElement.appendChild(style);
})();
`;

const outDir = path.join(root, "dist", "userscript");
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
const reco =
  fs.readFileSync(path.join(root, "release-data.js"), "utf8") + "\n" + fs.readFileSync(path.join(root, "recommendations.js"), "utf8");
// The DOM scripts wait for the document (the userscript starts at document-start).
const main = `function __eymMain() {\n${content}\n${reco}\n}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", __eymMain);
else __eymMain();
`;
fs.writeFileSync(path.join(outDir, "embedyourmusic.user.js"), header + prelude + main);
console.log("built dist/userscript");
