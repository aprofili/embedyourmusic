// Finds Spotify and Bandcamp links on RateYourMusic and adds inline players.

(() => {
  const api = globalThis.browser ?? globalThis.chrome;

  const SPOTIFY_RE =
    /^https?:\/\/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(album|track|playlist|artist|episode|show)\/([A-Za-z0-9]+)/;

  function classify(href) {
    if (!href) return null;

    const sp = href.match(SPOTIFY_RE);
    if (sp) {
      const [, type, id] = sp;
      const compact = type === "track" || type === "episode";
      return {
        key: `spotify:${type}:${id}`,
        kind: "spotify",
        src: `https://open.spotify.com/embed/${type}/${id}`,
        height: compact ? 152 : 352,
      };
    }

    try {
      const u = new URL(href);
      if (
        u.hostname.endsWith(".bandcamp.com") &&
        /^\/(album|track)\//.test(u.pathname)
      ) {
        const clean = `https://${u.hostname}${u.pathname}`;
        return { key: `bandcamp:${clean}`, kind: "bandcamp", url: clean };
      }
    } catch {
      /* not a URL */
    }
    return null;
  }

  function makeFrame(src, height, title) {
    const frame = document.createElement("iframe");
    frame.className = "rym-embed-frame";
    frame.title = title;
    frame.height = String(height);
    frame.loading = "lazy";
    frame.allow = "autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture";
    frame.referrerPolicy = "strict-origin-when-cross-origin";
    frame.src = src;
    return frame;
  }

  const seen = new Set();
  const lazy = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        lazy.unobserve(entry.target);
        entry.target.__load();
      }
    },
    { rootMargin: "300px" }
  );

  function place(link, wrapper) {
    // Put the embed after the link's container, keeping several embeds in link order.
    let ref = link.parentElement || link;
    while (
      ref.nextElementSibling &&
      ref.nextElementSibling.classList.contains("rym-embed")
    ) {
      ref = ref.nextElementSibling;
    }
    ref.after(wrapper);
  }

  function embed(link, info) {
    if (seen.has(info.key)) return;
    seen.add(info.key);

    const wrapper = document.createElement("div");
    wrapper.className = "rym-embed";
    wrapper.style.minHeight = `${info.height || 120}px`;

    wrapper.__load = async () => {
      if (info.kind === "spotify") {
        wrapper.append(makeFrame(info.src, info.height, "Spotify player"));
        return;
      }
      try {
        const res = await api.runtime.sendMessage({
          type: "resolve-bandcamp",
          url: info.url,
        });
        if (res && res.embed) {
          wrapper.style.minHeight = `${res.embed.height}px`;
          wrapper.append(
            makeFrame(res.embed.src, res.embed.height, "Bandcamp player")
          );
        } else {
          wrapper.remove();
        }
      } catch {
        wrapper.remove();
      }
    };

    place(link, wrapper);
    lazy.observe(wrapper);
  }

  function scan(root) {
    const links = root.querySelectorAll
      ? root.querySelectorAll("a[href]")
      : [];
    for (const link of links) {
      if (link.closest(".rym-embed")) continue;
      const info = classify(link.href);
      if (info) embed(link, info);
    }
  }

  scan(document);

  // RYM injects links dynamically (media popups, lazy sections).
  let pending = false;
  new MutationObserver(() => {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      scan(document);
    }, 300);
  }).observe(document.body, { childList: true, subtree: true });

  globalThis.__embedYourMusic = { classify };
})();
