// Builds browser-specific packages into dist/.
// manifest.json is the Chromium (Edge/Chrome) manifest and also loads directly from the repo root.
// Firefox needs background.scripts instead of a service worker, plus a gecko id.
const fs = require("fs");
const path = require("path");

const root = __dirname;
const FILES = ["background.js", "content.js", "content.css", "artist-ratings.js", "rules.json"];
const base = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

const firefox = {
  ...base,
  background: { scripts: ["background.js"] },
  browser_specific_settings: {
    gecko: {
      id: "embedyourmusic@aprofili",
      strict_min_version: "140.0",
      data_collection_permissions: { required: ["none"] },
    },
  },
};

function emit(name, manifest) {
  const dir = path.join(root, "dist", name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const f of FILES) fs.copyFileSync(path.join(root, f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`built dist/${name}`);
}

emit("chromium", base);
emit("firefox", firefox);

// ---- iOS / Safari userscript (Userscripts app) ----
// No background script exists there, so Bandcamp lookups go through GM_xmlhttpRequest.
const bg = fs.readFileSync(path.join(root, "background.js"), "utf8");
const shared = bg.match(/\/\/ <shared:bandcamp>([\s\S]*?)\/\/ <\/shared:bandcamp>/);
if (!shared) throw new Error("shared:bandcamp markers missing in background.js");
let content = fs.readFileSync(path.join(root, "content.js"), "utf8");
const API_LINE = "const api = globalThis.browser ?? globalThis.chrome;";
if (!content.includes(API_LINE)) throw new Error("api line missing in content.js");
content = content.replace(API_LINE, "const api = globalThis.__eymBridge;");
const css = fs.readFileSync(path.join(root, "content.css"), "utf8");

const header = `// ==UserScript==
// @name         EmbedYourMusic
// @description  Inline players, tabs and collapsed sections on rateyourmusic.com
// @version      ${base.version}
// @match        *://rateyourmusic.com/*
// @match        *://*.rateyourmusic.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @connect      bandcamp.com
// @connect      *.bandcamp.com
// @run-at       document-end
// @inject-into  content
// @noframes
// ==/UserScript==
`;

const prelude = `(() => {
const CACHE_PREFIX = "bc:";
${shared[1]}
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
      return {};
    },
  },
};
const style = document.createElement("style");
style.textContent = ${JSON.stringify(css)};
(document.head || document.documentElement).appendChild(style);
})();
`;

const outDir = path.join(root, "dist", "userscript");
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "embedyourmusic.user.js"), header + prelude + content + "\n");
console.log("built dist/userscript");
