// Cloud backup: login (incl. 2FA), merge on restore, upload, 401 handling.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let listener;
  const store = {};
  const calls = [];
  let remote = null; // the account's backup blob
  let twofa = false;
  let expired = false;
  const json = (o, status = 200) => ({ ok: status < 300, status, json: async () => o });
  const bg = {
    chrome: {
      runtime: { onMessage: { addListener: (fn) => (listener = fn) }, onConnect: { addListener() {} }, sendMessage: async () => ({}) },
      storage: {
        local: {
          get: async (k) => {
            const keys = Array.isArray(k) ? k : [k];
            const o = {};
            for (const x of keys) if (x in store) o[x] = JSON.parse(JSON.stringify(store[x]));
            return o;
          },
          set: async (o) => Object.assign(store, JSON.parse(JSON.stringify(o))),
          remove: async (k) => delete store[k],
        },
        onChanged: { addListener() {} },
      },
    },
    fetch: async (url, opts = {}) => {
      const u = new URL(url);
      calls.push(`${opts.method} ${u.pathname}`);
      assert.strictEqual(u.origin, "https://jkprilfools.com");
      assert.strictEqual(opts.headers["x-eym-client"], "1");
      const body = opts.body ? JSON.parse(opts.body) : {};
      if (u.pathname === "/api/auth/login") {
        if (body.password !== "pw") return json({ error: "invalid username or password" }, 401);
        return twofa ? json({ requires2fa: true, challenge: "CH" }) : json({ username: body.username, token: "TOK" });
      }
      if (u.pathname === "/api/auth/2fa/verify") {
        return body.code === "123456" && body.challenge === "CH" ? json({ username: "adam", token: "TOK" }) : json({ error: "incorrect code" }, 401);
      }
      if (u.pathname === "/api/eym/backup") {
        if (expired || opts.headers.authorization !== "Bearer TOK") return json({ error: "log in required" }, 401);
        if (opts.method === "GET") return json({ t: "x", data: remote });
        remote = body.data;
        return json({ t: "now" });
      }
      return json({}, 404);
    },
    URL, Date, JSON, setTimeout, clearTimeout,
  };
  bg.globalThis = bg;
  vm.createContext(bg);
  vm.runInContext(read("background.js"), bg);
  const ask = (msg) => new Promise((resolve) => listener(msg, {}, resolve));

  assert.strictEqual((await ask({ type: "backup-status" })).loggedIn, false);
  assert.ok((await ask({ type: "backup-login", username: "adam", password: "bad" })).error);

  // a reinstalled browser: empty local storage, the account already has a backup -> everything comes back
  remote = {
    "sidebar:played": [{ href: "/release/b/", title: "B", at: 9 }, { href: "/release/a/", title: "A", at: 5 }],
    "sidebar:reviews": { "/release/a/": { reviewed: true, t: 5 } },
    "sidebar:ratings": { "p:/release/a/": 8 },
  };
  let r = await ask({ type: "backup-login", username: "adam", password: "pw" });
  assert.ok(r.ok && r.sync.ok, JSON.stringify(r));
  assert.deepStrictEqual(store["sidebar:played"].map((p) => p.title), ["B", "A"]);
  assert.strictEqual(store["sidebar:ratings"]["p:/release/a/"], 8);
  const st = await ask({ type: "backup-status" });
  assert.ok(st.loggedIn && st.username === "adam" && st.last > 0);

  // local has new things -> merged both ways and uploaded; secrets never included
  store["sidebar:played"] = [{ href: "/release/c/", title: "C", at: 20 }, ...store["sidebar:played"]];
  store["sidebar:reviews"] = { "/release/a/": { reviewed: false, t: 1 }, "/release/z/": { reviewed: true, t: 3 } };
  store["sp:auth"] = { access: "SECRET" };
  r = await ask({ type: "backup-sync" });
  assert.ok(r.ok);
  assert.deepStrictEqual(remote["sidebar:played"].map((p) => p.title), ["C", "B", "A"]);
  assert.strictEqual(remote["sidebar:reviews"]["/release/a/"].reviewed, true, "newer review wins");
  assert.ok(remote["sidebar:reviews"]["/release/z/"]);
  assert.ok(!JSON.stringify(remote).includes("SECRET"));
  const n = calls.filter((c) => c.startsWith("PUT")).length;
  const again = await ask({ type: "backup-sync" });
  assert.strictEqual(again.restored, 0, "a second sync restores nothing (no reload loop)");
  assert.strictEqual(calls.filter((c) => c.startsWith("PUT")).length, n, "nothing changed, nothing uploaded");

  // session expired
  expired = true;
  r = await ask({ type: "backup-sync" });
  assert.ok(!r.ok);
  assert.ok(/log in again/i.test((await ask({ type: "backup-status" })).error) || !(await ask({ type: "backup-status" })).loggedIn);
  await ask({ type: "backup-logout" });
  assert.strictEqual((await ask({ type: "backup-status" })).loggedIn, false);

  // 2FA account
  expired = false;
  twofa = true;
  r = await ask({ type: "backup-login", username: "adam", password: "pw" });
  assert.ok(r.requires2fa && r.challenge === "CH");
  assert.ok((await ask({ type: "backup-login", code: "000000", challenge: "CH" })).error);
  r = await ask({ type: "backup-login", code: "123456", challenge: "CH" });
  assert.ok(r.ok, JSON.stringify(r));
  console.log("backup tests passed");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
