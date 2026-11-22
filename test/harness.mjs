// harness.mjs — loads the REAL src/background.js into a Node `vm` context with a fake `chrome`, a
// fake `fetch` and a fake clock, so the extension's behaviour can be tested without a browser.
//
//   const h = await loadBackground({ storage: { local: { endpoint: "..." } }, fetch: route });
//   await h.tick(2000);                // advance fake time, running due timers + pending promises
//   h.calls / h.requests               // what the code called / which URLs it fetched
//   h.fn("bakeYouTubeTime")(url, 30)   // call a top-level function
//   h.get("cfg")                       // read a top-level let/const
//   h.chrome.windows.onRemoved.fire(id)
//
// Nothing here is real I/O: timers live on a fake clock (only tick() runs them), fetch resolves
// from a router, and a never-answered long-poll is just a promise nobody settles. So a loaded
// background.js — with its boot(), poll loop, intervals and alarms — cannot keep the test process
// alive, and there is nothing to tear down beyond dropping the harness.
//
// Built to be extended by later phases: add APIs to makeChrome(), state to the world, routes to
// the fetch router.

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const BACKGROUND_SRC = path.join(ROOT, "src", "background.js");

// ---------------- fake clock + timers ----------------

// More timers than this firing at one instant means the code is looping without pausing. The
// extension sets a handful of timers per event at most, so any real burst is far below it.
const TIGHT_LOOP_TIMERS = 200;

class Clock {
  constructor(start) { this.now = start; this.timers = []; this.seq = 0; }
  setTimeout(fn, ms, ...args) {
    const id = ++this.seq;
    this.timers.push({ id, at: this.now + Math.max(0, Number(ms) || 0), fn, args, every: 0 });
    return id;
  }
  setInterval(fn, ms, ...args) {
    const id = ++this.seq, every = Math.max(1, Number(ms) || 0);
    this.timers.push({ id, at: this.now + every, fn, args, every });
    return id;
  }
  clear(id) { this.timers = this.timers.filter((t) => t.id !== id); }
  next(limit) {
    let best = null;
    for (const t of this.timers) if (t.at <= limit && (!best || t.at < best.at || (t.at === best.at && t.id < best.id))) best = t;
    return best;
  }
}

// flush lets every already-queued promise continuation run (several macrotask turns, because a
// chain of awaits across realms can need more than one).
export async function flush(turns = 20) {
  for (let i = 0; i < turns; i++) await new Promise((r) => setImmediate(r));
}

// ---------------- events ----------------

export function makeEvent(name, recorder) {
  const listeners = [];
  return {
    addListener(fn) { listeners.push(fn); recorder && recorder(name + ".addListener"); },
    removeListener(fn) { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
    hasListener(fn) { return listeners.includes(fn); },
    hasListeners() { return listeners.length > 0; },
    get listenerCount() { return listeners.length; },
    // fire calls every listener with args and resolves when every returned promise settles.
    fire(...args) { return Promise.allSettled(listeners.slice().map((fn) => fn(...args))); },
  };
}

// ---------------- fake fetch ----------------

export function response(status, body) {
  const text = body === undefined ? "" : (typeof body === "string" ? body : JSON.stringify(body));
  return {
    ok: status >= 200 && status < 300, status,
    json: async () => JSON.parse(text),
    text: async () => text,
  };
}

// A refused connection: what fetch does when nothing listens (a TypeError in every engine).
export function refused() { return Promise.reject(new TypeError("Failed to fetch (connection refused)")); }
// A request the bridge holds forever (an idle long-poll).
export function pending() { return new Promise(() => {}); }

// defaultRoute answers like a healthy bridge on whatever port is asked: /hello hands out "tok",
// /events is held, /profile-role says normal, /carryback-drain is empty, /coldlaunch says warm.
export function defaultRoute(req) {
  switch (req.path) {
    case "/hello": return response(200, { token: "tok" });
    case "/events": return pending();
    case "/profile-role": return response(200, { role: "normal" });
    case "/carryback-drain": return response(200, { windows: [] });
    case "/coldlaunch": return response(200, { cold: false });
    default: return response(204);
  }
}

// ---------------- fake chrome ----------------

function deepCopy(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

function makeStorageArea(areaName, data, onChanged, record) {
  const pick = (keys) => {
    if (keys == null) return deepCopy(data);
    const list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
    const out = {};
    for (const k of list) {
      if (k in data) out[k] = deepCopy(data[k]);
      else if (keys && typeof keys === "object" && !Array.isArray(keys)) out[k] = keys[k];
    }
    return out;
  };
  const changed = (changes) => { if (Object.keys(changes).length) onChanged.fire(changes, areaName); };
  return {
    data,
    get(keys, cb) { record(`storage.${areaName}.get`, keys); const r = pick(keys); if (cb) { cb(r); return undefined; } return Promise.resolve(r); },
    set(items, cb) {
      record(`storage.${areaName}.set`, items);
      const changes = {};
      for (const [k, v] of Object.entries(items)) { changes[k] = { oldValue: deepCopy(data[k]), newValue: deepCopy(v) }; data[k] = deepCopy(v); }
      changed(changes);
      if (cb) { cb(); return undefined; }
      return Promise.resolve();
    },
    remove(keys, cb) {
      record(`storage.${areaName}.remove`, keys);
      const changes = {};
      for (const k of (Array.isArray(keys) ? keys : [keys])) if (k in data) { changes[k] = { oldValue: data[k] }; delete data[k]; }
      changed(changes);
      if (cb) { cb(); return undefined; }
      return Promise.resolve();
    },
  };
}

// The window/tab world. windows: [{id, left, top, width, height, focused, type, tabs:[{id, url, active}]}]
function makeWorld(init) {
  const w = { windows: [], nextId: 1000 };
  for (const win of (init || [])) {
    const id = win.id ?? w.nextId++;
    w.windows.push({ left: 0, top: 0, width: 800, height: 600, type: "normal", focused: false, ...win, id,
      tabs: (win.tabs || []).map((t) => ({ active: false, ...t, id: t.id ?? w.nextId++, windowId: id })) });
  }
  return w;
}

function makeChrome(opts, record, world) {
  const ev = (name) => makeEvent(name, null);
  const storageChanged = ev("storage.onChanged");
  const winView = (win, populate) => {
    const o = { id: win.id, left: win.left, top: win.top, width: win.width, height: win.height, focused: !!win.focused, type: win.type };
    if (populate) o.tabs = win.tabs.map((t) => ({ ...t }));
    return o;
  };
  const findWin = (id) => world.windows.find((x) => x.id === id);
  const findTab = (id) => { for (const win of world.windows) { const t = win.tabs.find((x) => x.id === id); if (t) return { win, t }; } return null; };
  const noSuch = (what, id) => Promise.reject(new Error(`No ${what} with id: ${id}.`));
  const removeTab = (id) => {
    const f = findTab(id); if (!f) return false;
    f.win.tabs = f.win.tabs.filter((x) => x.id !== id);
    if (!f.win.tabs.length) world.windows = world.windows.filter((x) => x !== f.win);
    return true;
  };

  const chrome = {
    runtime: {
      id: "test-extension-id",
      lastError: undefined,
      onInstalled: ev("runtime.onInstalled"),
      onStartup: ev("runtime.onStartup"),
      onSuspend: ev("runtime.onSuspend"),
      onConnect: ev("runtime.onConnect"),
      onMessage: ev("runtime.onMessage"),
      getPlatformInfo: () => { record("runtime.getPlatformInfo"); return Promise.resolve({ os: "win", arch: "x86-64" }); },
      reload: () => record("runtime.reload"),
      // connect models the usual case: no other extension context, so the port is refused and
      // onDisconnect fires on the next turn.
      connect: (info) => {
        record("runtime.connect", info);
        const onDisconnect = ev("port.onDisconnect");
        const port = { name: info && info.name, onDisconnect, onMessage: ev("port.onMessage"), disconnect() {}, postMessage() {} };
        Promise.resolve().then(() => onDisconnect.fire(port));
        return port;
      },
    },
    storage: {
      onChanged: storageChanged,
      local: makeStorageArea("local", { ...(opts.storage && opts.storage.local) }, storageChanged, record),
      session: makeStorageArea("session", { ...(opts.storage && opts.storage.session) }, storageChanged, record),
    },
    alarms: {
      create: (name, info) => record("alarms.create", name, info),
      clear: (name) => { record("alarms.clear", name); return Promise.resolve(true); },
      onAlarm: ev("alarms.onAlarm"),
    },
    action: { onClicked: ev("action.onClicked") },
    commands: { onCommand: ev("commands.onCommand") },
    contextMenus: {
      create: (props, cb) => { record("contextMenus.create", props); if (cb) cb(); },
      onClicked: ev("contextMenus.onClicked"),
    },
    scripting: {
      executeScript: (inj) => {
        record("scripting.executeScript", { tabId: inj.target && inj.target.tabId, func: inj.func && inj.func.name, args: inj.args });
        const r = opts.executeScript ? opts.executeScript(inj) : [{ result: undefined }];
        return Promise.resolve(r);
      },
    },
    windows: {
      onCreated: ev("windows.onCreated"), onRemoved: ev("windows.onRemoved"),
      onFocusChanged: ev("windows.onFocusChanged"), onBoundsChanged: ev("windows.onBoundsChanged"),
      getAll: (q) => {
        record("windows.getAll", q);
        let ws = world.windows;
        if (q && q.windowTypes) ws = ws.filter((x) => q.windowTypes.includes(x.type));
        return Promise.resolve(ws.map((x) => winView(x, q && q.populate)));
      },
      get: (id, q) => { record("windows.get", id, q); const x = findWin(id); return x ? Promise.resolve(winView(x, q && q.populate)) : noSuch("window", id); },
      getLastFocused: (q) => {
        record("windows.getLastFocused", q);
        const x = world.windows.find((y) => y.focused) || world.windows[0];
        return x ? Promise.resolve(winView(x, q && q.populate)) : noSuch("window", "lastFocused");
      },
      create: (props) => {
        record("windows.create", props);
        const id = world.nextId++;
        const urls = props && props.url ? (Array.isArray(props.url) ? props.url : [props.url]) : ["chrome://newtab/"];
        const win = { id, left: 0, top: 0, width: 800, height: 600, type: "normal", focused: !!(props && props.focused),
          tabs: urls.map((u, i) => ({ id: world.nextId++, url: u, active: i === 0, windowId: id })) };
        world.windows.push(win);
        return Promise.resolve(winView(win, true));
      },
      update: (id, props) => { record("windows.update", id, props); const x = findWin(id); if (!x) return noSuch("window", id); Object.assign(x, props); return Promise.resolve(winView(x)); },
      remove: (id) => { record("windows.remove", id); const x = findWin(id); if (!x) return noSuch("window", id); world.windows = world.windows.filter((y) => y !== x); return Promise.resolve(); },
    },
    tabs: {
      onCreated: ev("tabs.onCreated"), onUpdated: ev("tabs.onUpdated"), onRemoved: ev("tabs.onRemoved"),
      onAttached: ev("tabs.onAttached"), onDetached: ev("tabs.onDetached"), onActivated: ev("tabs.onActivated"),
      query: (q) => {
        record("tabs.query", q);
        let out = [];
        for (const win of world.windows) for (const t of win.tabs) out.push({ ...t });
        if (q && q.active) out = out.filter((t) => t.active);
        if (q && q.currentWindow) { const fw = world.windows.find((y) => y.focused) || world.windows[0]; out = out.filter((t) => fw && t.windowId === fw.id); }
        return Promise.resolve(out);
      },
      get: (id) => { record("tabs.get", id); const f = findTab(id); return f ? Promise.resolve({ ...f.t }) : noSuch("tab", id); },
      create: (props) => {
        record("tabs.create", props);
        let win = props && props.windowId != null ? findWin(props.windowId) : (world.windows.find((y) => y.focused) || world.windows[0]);
        if (!win) { win = { id: world.nextId++, left: 0, top: 0, width: 800, height: 600, type: "normal", focused: true, tabs: [] }; world.windows.push(win); }
        const t = { id: world.nextId++, url: props && props.url, active: !!(props && props.active), windowId: win.id };
        win.tabs.push(t);
        return Promise.resolve({ ...t });
      },
      update: (id, props) => { record("tabs.update", id, props); const f = findTab(id); if (!f) return noSuch("tab", id); Object.assign(f.t, props); return Promise.resolve({ ...f.t }); },
      remove: (ids) => {
        record("tabs.remove", ids);
        const list = Array.isArray(ids) ? ids : [ids];
        if (opts.tabsRemove) { const r = opts.tabsRemove(list); if (r) return r; }
        for (const id of list) if (!findTab(id)) return noSuch("tab", id);
        for (const id of list) removeTab(id);
        return Promise.resolve();
      },
      move: (ids, props) => { record("tabs.move", ids, props); return Promise.resolve([]); },
    },
    bookmarks: {
      search: (q) => { record("bookmarks.search", q); return Promise.resolve([]); },
      create: (b) => { record("bookmarks.create", b); return Promise.resolve({ id: String(world.nextId++), ...b }); },
      getChildren: (id) => { record("bookmarks.getChildren", id); return Promise.resolve([]); },
      removeTree: (id) => { record("bookmarks.removeTree", id); return Promise.resolve(); },
    },
  };
  for (const omit of (opts.omitApis || [])) {
    const [ns, name] = omit.split(".");
    if (name) delete chrome[ns][name]; else delete chrome[ns];
  }
  return chrome;
}

// ---------------- loader ----------------

// loadBackground evaluates src/background.js (its top-level code runs boot()) and returns the
// handle. Options:
//   storage: {local:{...}, session:{...}}   initial storage
//   windows: [...]                          initial windows (see makeWorld)
//   fetch: (req) => Response|Promise         router; req = {url, path, port, method, headers, body, search, opts}
//   navigator: {...}                         the context's navigator (default: {} = a service worker
//                                            without sendBeacon, as measured in Chromium)
//   omitApis: ["bookmarks", "tabs.move"]     remove APIs to model an engine without them
//   start: <ms>                              initial fake time
//   settle: false                            skip the initial flush after load
export async function loadBackground(opts = {}) {
  const calls = [];
  const record = (api, ...args) => calls.push({ api, args: deepCopy(args) });
  const clock = new Clock(opts.start ?? 1_700_000_000_000);
  const world = makeWorld(opts.windows);
  const chrome = makeChrome(opts, record, world);
  const requests = [];
  const route = opts.fetch || defaultRoute;

  const fakeFetch = (url, init = {}) => {
    const u = new URL(String(url));
    const req = { url: String(url), path: u.pathname, port: u.port, host: u.host, origin: u.origin, search: u.search,
      method: (init.method || "GET").toUpperCase(), headers: init.headers || {}, body: init.body, opts: init, at: clock.now };
    requests.push(req);
    let p;
    try { p = Promise.resolve(route(req)); } catch (e) { p = Promise.reject(e); }
    // Honour an AbortSignal like a real fetch: an abort rejects with an AbortError (a held request
    // otherwise stays pending forever).
    const sig = init.signal;
    if (sig) {
      const abortErr = () => Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
      if (sig.aborted) return Promise.reject(abortErr());
      p = Promise.race([p, new Promise((_, rej) => sig.addEventListener("abort", () => { req.aborted = true; rej(abortErr()); }, { once: true }))]);
    }
    return p;
  };

  class FakeDate extends Date {
    constructor(...a) { super(...(a.length ? a : [clock.now])); }
    static now() { return clock.now; }
  }

  const logs = [];
  const sandbox = {
    chrome,
    fetch: fakeFetch,
    navigator: opts.navigator || {},
    console: { log: (...a) => logs.push(["log", ...a]), warn: (...a) => logs.push(["warn", ...a]), error: (...a) => logs.push(["error", ...a]), info: () => {}, debug: () => {} },
    setTimeout: (fn, ms, ...a) => clock.setTimeout(fn, ms, ...a),
    clearTimeout: (id) => clock.clear(id),
    setInterval: (fn, ms, ...a) => clock.setInterval(fn, ms, ...a),
    clearInterval: (id) => clock.clear(id),
    Date: FakeDate,
    crypto: { randomUUID: (() => { let n = 0; return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`; })() },
    AbortController, AbortSignal, URL, URLSearchParams, TextEncoder, TextDecoder,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  const ctx = vm.createContext(sandbox);
  const code = fs.readFileSync(opts.file || BACKGROUND_SRC, "utf8");
  vm.runInContext(code, ctx, { filename: opts.file || BACKGROUND_SRC });

  const h = {
    ctx, chrome, world, clock, calls, requests, logs,
    // fn returns a top-level function declared in background.js.
    fn: (name) => { const f = ctx[name]; if (typeof f !== "function") throw new Error("no top-level function " + name); return f; },
    // get evaluates an expression inside the context (reaches top-level let/const too).
    get: (expr) => vm.runInContext(expr, ctx),
    flush,
    // tick advances fake time by ms, firing due timers in time order and flushing promises between.
    // A run of timers that never lets time advance is a TIGHT LOOP in the code under test (e.g. a
    // retry with no pause): tick() fails loudly instead of spinning forever.
    async tick(ms) {
      const end = clock.now + ms;
      let sameTime = 0, lastAt = -1;
      await flush();
      for (;;) {
        const t = clock.next(end);
        if (!t) break;
        sameTime = t.at === lastAt ? sameTime + 1 : 0;
        lastAt = t.at;
        if (sameTime > TIGHT_LOOP_TIMERS) throw new Error(`tight loop: more than ${TIGHT_LOOP_TIMERS} timers fired at t=${t.at} without time advancing`);
        clock.now = t.at;
        if (t.every) t.at += t.every; else clock.clear(t.id);
        try { t.fn(...t.args); } catch (e) { logs.push(["timer-threw", String(e)]); }
        await flush();
      }
      clock.now = end;
      await flush();
    },
    called: (api) => calls.filter((c) => c.api === api),
    // fetched returns the requests to a path (optionally on one port).
    fetched: (p, port) => requests.filter((r) => r.path === p && (port === undefined || r.port === String(port))),
    // dbgLines returns the bodies POSTed to /debug.
    dbgLines: () => requests.filter((r) => r.path === "/debug").map((r) => String(r.body)),
  };
  if (opts.settle !== false) await flush();
  return h;
}
