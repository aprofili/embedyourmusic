// Recommendations page (/recommendations/...): play buttons on cover art, a sticky player on the
// right, and the playlists/settings/affinities sections moved below the lists.
// Loaded after content.js in the same isolated world; reuses its embed helpers.
(() => {
  const eym = globalThis.__embedYourMusic;
  const container = document.getElementById("page_sections_recommendations");
  if (!eym || !container) return;

  const { classifyAny, makeFrame, resolveBandcamp, trackList, sidebarOpen, sidebarPlay, parseLinks, scrapeReleases, saveSidebarData, rememberId, LABELS } = eym;
  // Phone layout: no sticky side panel; the player opens inline under the tapped row.
  const mobile = matchMedia("(max-width: 59.99em)").matches;
  // The iOS userscript has no page-world script, so it reads ratings itself (see ratedScan).
  const standalone = !!globalThis.__eymBridge;
  const rel = globalThis.__eymRelease;
  // Streaming links for a release, from the shared cache or one throttled request.
  function linksFor(path, id, want) {
    return rel
      .getLinks(id, path)
      .then((r) => (r.links ? parseLinks(r.links) : []))
      .catch((e) => {
        if (!want) throw e;
        return [];
      })
      .then(async (entries) => {
        if (entries.length || !want) return entries;
        // RYM unavailable (blocked, 403) or no links listed: look the release up by name.
        const found = await searchLinks(want);
        if (!found.length && rel.blocked()) throw new Error("RYM is blocking requests");
        return found;
      });
  }

  const searched = new Map();
  function searchLinks(want) {
    const key = `${want.artist}|${want.title}`;
    if (!searched.has(key)) {
      searched.set(
        key,
        (globalThis.__eymBridge || globalThis.browser || globalThis.chrome).runtime
          .sendMessage({ type: "find-album", want })
          .then((res) =>
            ((res && res.links) || [])
              .map((l) => ({ ...l, info: classifyAny(l.href) }))
              .filter((l) => l.info && l.info.service === l.service)
          )
          .catch(() => [])
      );
    }
    return searched.get(key);
  }

  // ---- Player panel ----
  const panel = document.createElement("aside");
  panel.id = "rym-reco-player";
  const sticky = document.createElement("div");
  sticky.className = "rym-reco-sticky";
  const title = document.createElement("div");
  title.className = "rym-reco-title";
  const tabs = document.createElement("div");
  tabs.className = "rym-reco-tabs";
  const body = document.createElement("div");
  body.className = "rym-reco-body";
  sticky.append(title, tabs, body);
  const host = document.createElement("li"); // mobile: holds the player under the playing row
  host.className = "rym-reco-inline";
  host.hidden = true;
  if (mobile) {
    host.append(sticky);
  } else {
    panel.append(sticky);
    container.append(panel);
  }
  container.classList.add("rym-reco");
  if (mobile) container.classList.add("rym-reco-mobile");
  body.textContent = mobile ? "" : "Click ▶ on a cover to preview it here.";
  body.classList.add("rym-reco-hint");

  let token = 0;
  let currentLi = null;

  function message(text, href) {
    body.textContent = "";
    body.classList.add("rym-reco-hint");
    body.append(text);
    if (href) {
      body.append(" ");
      const a = document.createElement("a");
      a.href = href;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = "Open release page";
      body.append(a);
    }
    if (rel.blocked()) {
      body.append(" · ");
      const retry = document.createElement("a");
      retry.href = "#";
      retry.textContent = "Retry now";
      retry.title = "Clear the pause (repeated failures just extend RYM's block)";
      retry.addEventListener("click", (e) => {
        e.preventDefault();
        rel.clearBlock();
        if (currentLi) play(currentLi);
      });
      body.append(retry);
    }
  }

  function show(entries, releaseHref, my) {
    tabs.textContent = "";
    body.textContent = "";
    body.classList.remove("rym-reco-hint");
    if (!entries.length) return message("No streaming links on this release.", releaseHref);

    const slots = new Map();
    let active = null;
    const buttons = new Map();

    function load(entry, slot) {
      const { info, service } = entry;
      if (info.kind !== "bandcamp") {
        if (info.maxWidth) slot.style.maxWidth = `${info.maxWidth}px`;
        // Taller than the default so more of the tracklist shows.
        const tall = !mobile && service === "spotify" && /\/embed\/(album|playlist)\//.test(info.src);
        const frame = makeFrame(info.src, tall ? 560 : info.height, `${LABELS[service]} player`);
        slot.append(frame);
        const tracks = service === "spotify" && trackList(info, frame);
        if (tracks) slot.append(tracks);
        return;
      }
      slot.textContent = "Loading…";
      resolveBandcamp(info.url).then((res) => {
        if (my !== token) return;
        slot.textContent = "";
        if (res) slot.append(makeFrame(res.src, res.height, "Bandcamp player"));
        else slot.append(`Couldn't load the Bandcamp player. `, Object.assign(document.createElement("a"), { href: entry.href, target: "_blank", rel: "noopener", textContent: "Open on Bandcamp" }));
      });
    }

    function select(entry) {
      if (active === entry) return;
      active = entry;
      for (const [e, b] of buttons) {
        b.classList.toggle("rym-tab-active", e === entry);
        b.setAttribute("aria-pressed", String(e === entry));
      }
      for (const s of slots.values()) s.hidden = true;
      let slot = slots.get(entry);
      if (!slot) {
        slot = document.createElement("div");
        slot.className = "rym-embed-slot";
        slots.set(entry, slot);
        body.append(slot);
        load(entry, slot);
      }
      slot.hidden = false;
    }

    for (const entry of entries) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "rym-reco-tab";
      b.textContent = LABELS[entry.service];
      b.setAttribute("aria-pressed", "false");
      b.addEventListener("click", () => select(entry));
      buttons.set(entry, b);
      tabs.append(b);
    }
    select(entries.find((e) => e.service === "spotify") || entries[0]);
  }

  // The cover URL, whether or not RYM has lazy-loaded it yet; 300px version.
  function artSrc(img) {
    const pic = (() => {
      const p = img && img.closest && img.closest("picture");
      const src = p && [...p.querySelectorAll("source")].find((x) => x.getAttribute("type") === "image/jpeg");
      const set = src && (src.getAttribute("srcset") || src.getAttribute("data-srcset"));
      return (set && set.trim().split(",")[0].trim().split(/\s+/)[0]) || "";
    })();
    let s = img && (img.currentSrc || img.getAttribute("src") || img.getAttribute("data-src") || "");
    if (!s || s.startsWith("data:")) s = (img && img.getAttribute("data-src")) || pic;
    if (!s) return "";
    if (s.startsWith("//")) s = "https:" + s;
    return /\/i\/\d+\/w\//.test(s) ? s : s.replace(/\/i\/\d+\//, "/i/300/");
  }

  function play(li) {
    const link = li.querySelector("a.component_discography_item_link.release");
    if (!link) return Promise.resolve();
    const my = ++token;
    if (currentLi) currentLi.classList.remove("rym-reco-current");
    currentLi = li;
    li.classList.add("rym-reco-current");
    if (mobile) {
      li.after(host);
      host.hidden = false;
    }

    const artist = li.querySelector("a.artist");
    title.textContent = `${artist ? artist.textContent.trim() : ""} — ${link.textContent.trim()}`;
    tabs.textContent = "";
    body.textContent = "Loading…";
    body.classList.add("rym-reco-hint");

    const yearEl = li.querySelector(".component_discography_item_details > span");
    const want = {
      artist: artist ? artist.textContent.trim() : "",
      title: link.textContent.trim(),
      year: yearEl ? parseInt(yearEl.textContent, 10) || 0 : 0,
    };
    return linksFor(link.getAttribute("href"), li.id.replace("component_discography_item_", ""), want)
      .then(async (entries) => {
        if (my !== token) return;
        // Side panel open: play there (nothing is embedded in the page).
        const art = li.querySelector("img.ui_image_img");
        const rec = rel.peek(li.id.replace("component_discography_item_", ""));
        const handled =
          entries.length &&
          (await sidebarPlay({
            id: li.id.replace("component_discography_item_", ""),
            title: link.textContent.trim(),
            artist: artist ? artist.textContent.trim() : "",
            artUrl: artSrc(art),
            href: link.href,
            rating: rec && rec.ratingKnown ? rec.rating : 0,
            ratingKnown: !!(rec && rec.ratingKnown),
            entries: entries.map((e) => ({ service: e.service, href: e.href })),
          }));
        if (my !== token) return;
        if (handled) {
          tabs.textContent = "";
          body.textContent = "Playing in the sidebar.";
          body.classList.add("rym-reco-hint");
        } else show(entries, link.href, my);
      })
      .catch((e) => {
        if (my === token) message(`Couldn't load streaming links (${e.message}).`, link.href);
      });
  }

  // ---- List decoration ----
  function decorate() {
    for (const li of container.querySelectorAll("li.component_discography_item:not([data-rym-reco])")) {
      li.setAttribute("data-rym-reco", "");
      const art = li.querySelector("a.component_discography_item_image_link");
      if (art) {
        const btn = document.createElement("span");
        btn.className = "rym-play";
        btn.setAttribute("role", "button");
        btn.setAttribute("aria-label", "Preview");
        btn.textContent = "▶";
        // The whole cover is the click target; modified clicks (new tab etc.) still navigate.
        art.addEventListener("click", (e) => {
          if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          if (mobile && li === currentLi && !host.hidden) {
            // Tapping the playing cover again closes the player.
            host.hidden = true;
            li.classList.remove("rym-reco-current");
            currentLi = null;
            token++;
            return;
          }
          play(li);
        });
        art.append(btn);
      }
      // Compact stats replace the Avg / Ratings / Reviews columns.
      const avg = li.querySelector(".component_discography_item_details_average");
      const ratings = li.querySelector(".component_discography_item_details_ratings .full");
      const info = li.querySelector(".component_discography_item_info_inner");
      if (avg && info) {
        const s = document.createElement("div");
        s.className = "rym-reco-stats";
        s.textContent = `★ ${avg.textContent.trim()}` + (ratings ? ` · ${ratings.textContent.trim()} ratings` : "");
        info.append(s);
      }
    }
  }

  // Save the Recommends / Challenge lists for the side panel (rated rows are flagged so it can dim them).
  let listTimer;
  function publishLists() {
    if (standalone) return;
    clearTimeout(listTimer);
    listTimer = setTimeout(() => {
      const grab = (sel) => {
        const ol = container.querySelector(sel);
        if (!ol) return [];
        const out = [];
        for (const li of ol.querySelectorAll("li.component_discography_item")) {
          const [item] = scrapeReleases(li, 1);
          if (!item) continue;
          item.id = (li.id || "").replace("component_discography_item_", "");
          if (rememberId) rememberId(item.href, item.id);
          item.rated = li.classList.contains("rym-rated") || (!!li.dataset.eymRating && li.dataset.eymRating !== "0");
          out.push(item);
          if (out.length >= 80) break;
        }
        return out;
      };
      const t = Date.now();
      saveSidebarData("sidebar:lists", {
        recommended: { t, items: grab("#page_recommendations_list_main") },
        challenge: { t, items: grab("#page_recommendations_list_non_affinity") },
      });
    }, 600);
  }
  document.addEventListener("eym-scan-done", publishLists);
  document.addEventListener("eym-first-unrated", publishLists);

  // Reveal the page (content.css covers it with a spinner until then).
  const ready = () => document.documentElement.classList.add("eym-ready");
  setTimeout(ready, 7000); // never leave the page covered

  // The first row you haven't rated (found by reco-ratings.js) loads into the player on its own.
  // reco-ratings.js signals "eym-scan-done" once it has looked; the page is revealed after that
  // album's player is up. If that script can't run, the timeout above reveals the page.
  let autoStarted = false;
  const auto = () => {
    const li = container.querySelector("li[data-eym-first-unrated]");
    if (li && !currentLi && !autoStarted) {
      autoStarted = true;
      const done = sidebarOpen().then((open) => (open ? null : play(li))); // sidebar open: don't change what's playing there
      if (mobile && li.getBoundingClientRect().top > 300) {
        window.scrollTo(0, li.getBoundingClientRect().top + window.scrollY - 80);
      }
      return done;
    }
    return Promise.resolve();
  };
  document.addEventListener("eym-first-unrated", auto);
  document.addEventListener("eym-scan-done", () => auto().then(ready));

  // ---- iOS userscript: read your ratings from the release pages (same logic as reco-ratings.js) ----
  function ratedScan() {
    const NET_BUDGET = 3; // network requests the walk may make per page load
    let netUsed = 0;
    const idOf = (li) => li.id.replace("component_discography_item_", "");
    const mark = (li, rating) => {
      li.dataset.eymRating = String(rating);
      li.classList.toggle("rym-rated", rating > 0);
    };

    // Rows already in the cache are dimmed for free; nothing is fetched just because a row is visible.
    for (const li of container.querySelectorAll("li.component_discography_item")) {
      const rec = rel.peek(idOf(li));
      if (rec && rec.ratingKnown) mark(li, rec.rating);
    }

    // In-order walk from the top to the first unrated row, bounded.
    (async () => {
      let looked = 0;
      for (const li of container.querySelectorAll("li.component_discography_item")) {
        if (looked++ >= 40 || rel.blocked()) break;
        const id = idOf(li);
        const link = li.querySelector("a.component_discography_item_link.release");
        if (!link) continue;
        let rec = rel.peek(id);
        if (!rec) {
          if (netUsed >= NET_BUDGET) break;
          netUsed++;
          try {
            rec = await rel.get(id, link.getAttribute("href"));
          } catch {
            break;
          }
        }
        if (!rec.ratingKnown) continue;
        mark(li, rec.rating);
        if (rec.rating === 0) {
          li.dataset.eymFirstUnrated = "";
          break;
        }
      }
      document.dispatchEvent(new Event("eym-scan-done"));
    })();
  }

  decorate();
  publishLists();
  if (standalone) ratedScan();
  let timer;
  new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(decorate, 300);
  }).observe(container, { childList: true, subtree: true });
})();
