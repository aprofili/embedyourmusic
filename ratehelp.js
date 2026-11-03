// "Help me decide" for a rating: a few better / worse comparisons against albums you have already rated, then the
// rating that fits your answers best. Pure logic (no DOM), used by sidepanel.js; ratings are RYM's 1-10 (half stars).
(() => {
  const LEVELS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const MAX_Q = 10;

  // How badly a candidate rating x disagrees with the answers. ans: [{ r, cmp }] with cmp +1 better, 0 same, -1 worse.
  function cost(x, ans) {
    let c = 0;
    for (const { r, cmp } of ans) {
      if (cmp > 0 && x <= r) c += r - x + 1;
      else if (cmp < 0 && x >= r) c += x - r + 1;
      else if (cmp === 0) c += Math.abs(x - r) * 1.5;
    }
    return c;
  }
  // The ratings that fit best (all tied ones).
  function bestSet(ans) {
    const costs = LEVELS.map((x) => cost(x, ans));
    const min = Math.min(...costs);
    return LEVELS.filter((x, i) => costs[i] === min);
  }
  // The final answer: the middle of the best-fitting range.
  function estimate(ans) {
    const S = bestSet(ans);
    return S[Math.floor((S.length - 1) / 2)];
  }

  // Next comparison level: halve the range that still fits; once it is narrow, double-check its edges with other albums.
  function nextLevel(ans, available) {
    const have = LEVELS.filter((l) => available(l));
    if (!have.length) return 0;
    const S = bestSet(ans);
    const lo = S[0];
    const hi = S[S.length - 1];
    const near = (t) => have.slice().sort((a, b) => Math.abs(a - t) - Math.abs(b - t) || a - b)[0];
    if (hi - lo >= 2) return near((lo + hi) / 2);
    const asked = (l) => ans.filter((a) => a.r === l).length;
    const probes = (lo === hi ? [lo, lo + 1, lo - 1] : [lo, hi, lo - 1, hi + 1]).filter((l) => l >= 1 && l <= 10 && available(l));
    if (!probes.length) return near(lo);
    return probes.sort((a, b) => asked(a) - asked(b))[0];
  }

  // Enough said? Ten questions, or (after five) a single best rating backed by answers on both sides of it.
  function done(ans) {
    if (ans.length >= MAX_Q) return true;
    if (ans.length < 5) return false;
    const S = bestSet(ans);
    if (S.length !== 1) return false;
    const x = S[0];
    const below = ans.some((a) => (a.cmp > 0 && a.r >= x - 1) || (a.cmp === 0 && a.r === x));
    const above = ans.some((a) => (a.cmp < 0 && a.r <= x + 1) || (a.cmp === 0 && a.r === x));
    return below && above && cost(x, ans) === 0;
  }

  globalThis.__eymRateHelp = { cost, bestSet, estimate, nextLevel, done, MAX_Q };
})();
