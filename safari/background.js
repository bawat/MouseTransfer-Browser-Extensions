// Cross-engine shim: Firefox/Safari expose promise-based APIs on `browser`; their `chrome`
// namespace is callback-style, which the promise/await code below would break on. Point
// `chrome` at `browser` so the identical code runs unchanged. No-op on Chromium (no `browser`).
if (typeof browser !== "undefined") { globalThis.chrome = browser; }

// background.js — Tab Teleporter (Merged)
//
// Talks to the LOCAL Merged bridge over loopback HTTP (no separate server, no off-box
// port): merged.exe relays our envelopes to the peer machine over its encrypted channel.
//   - POST {endpoint}/send?token=...   to send an envelope to the other computer
//   - GET  {endpoint}/events?token=... long-poll for envelopes from the other computer
//
// Envelope protocol (see PROTOCOL.md) — the Go side treats this as opaque:
//   open: { v:1, kind:"open", moveId, tabs:[{url, active, scrollX, scrollY, videoTime}] }
//   ack : { v:1, kind:"ack",  moveId }
// The receiver opens+restores the tab and replies "ack"; the sender then closes its tab.

const DEFAULT_ENDPOINT = "http://127.0.0.1:24812";

let cfg = { endpoint: DEFAULT_ENDPOINT, token: "" };

// moveId -> source tabId, so an incoming ack closes exactly the tab we teleported.
const pendingClose = new Map();

// ---------------- config ----------------

async function loadConfig() {
  const local = await chrome.storage.local.get(["endpoint", "token"]);
  cfg.endpoint = (local.endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, "");
  cfg.token = local.token || "";
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.endpoint || changes.token)) loadConfig();
});

// ensureToken auto-fetches the per-install token from the local Merged bridge so the user
// never has to paste it. /hello only answers our extension (it requires the custom
// X-Teleport-Client header, which a web page can't send without a CORS preflight the
// bridge refuses; our host_permissions for 127.0.0.1 let us send it directly). If this
// can't reach the bridge, the user can still set the token manually in Options.
// Fixed protocol token the bridge's /hello requires (NOT the extension id — so it works
// whether we're load-unpacked or Web-Store-published with a store-assigned id).
const HELLO_CLIENT = "merged-tab-teleporter";
// When this worker started — used to ignore a stale "reload" right after we just reloaded
// (prevents a reload loop if the command is redelivered to the fresh worker).
const STARTED_AT = Date.now();
async function ensureToken() {
  if (cfg.token) return true;
  try {
    const res = await fetch(`${cfg.endpoint}/hello`, {
      method: "POST",
      headers: { "X-Teleport-Client": HELLO_CLIENT },
    });
    if (res.ok) {
      const j = await res.json();
      if (j && j.token) {
        cfg.token = j.token;
        await chrome.storage.local.set({ token: j.token, endpoint: cfg.endpoint });
        console.log("Teleporter: auto-configured from the Merged bridge");
        return true;
      }
    }
  } catch (e) { /* bridge not up yet; pollLoop will retry via ensureToken */ }
  return false;
}

function q(path) {
  return `${cfg.endpoint}${path}?token=${encodeURIComponent(cfg.token)}`;
}

// ---------------- transport ----------------

async function sendEnvelope(env) {
  if (!cfg.token) await ensureToken();
  if (!cfg.token) { console.warn("Teleporter: no token (is merged running?)"); return false; }
  try {
    const res = await fetch(q("/send"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(env),
    });
    if (!res.ok) { console.warn("Teleporter: send failed", res.status); return false; }
    return true;
  } catch (e) {
    console.warn("Teleporter: bridge unreachable (is merged running?)", e);
    return false;
  }
}

// pollLoop long-polls the bridge forever, handling each envelope from the peer. A 204
// (idle timeout) or a transient error just re-polls; the MV3 worker is kept alive by the
// in-flight fetch, and onMessage/alarms restart this if the worker was ever evicted.
let polling = false;
async function pollLoop() {
  if (polling) return;
  polling = true;
  for (;;) {
    if (!cfg.token) { await ensureToken(); if (!cfg.token) { await sleep(2000); continue; } }
    try {
      const res = await fetch(q("/events"));
      if (res.status === 200) {
        const env = await res.json();
        await handleEnvelope(env);
      } else if (res.status !== 204) {
        await sleep(2000);
      }
    } catch (e) {
      await sleep(3000); // bridge down; back off and retry
    }
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------------- capture (this machine -> peer) ----------------

function isYouTube(url) {
  return url.includes("youtube.com/watch") || url.includes("youtu.be/");
}

// For YouTube the &t= param is the most reliable restore, so bake the time into the URL.
function bakeYouTubeTime(url, seconds) {
  url = url.replace(/([?&])t=\d+s?(&|$)/, "$1").replace(/[?&]$/, "");
  return url + (url.includes("?") ? "&" : "?") + `t=${Math.floor(seconds)}s`;
}

// Injected into the page to read restorable state.
function readPageState() {
  let videoTime = 0;
  try { const v = document.querySelector("video"); if (v && v.currentTime > 0) videoTime = v.currentTime; } catch (e) {}
  return { scrollX: window.scrollX || 0, scrollY: window.scrollY || 0, videoTime };
}

// captureTab snapshots one tab into a transferable payload (url + restore hints), or null
// for a non-http(s) tab (e.g. chrome://, where we can't inject and that wouldn't restore).
async function captureTab(tab) {
  if (!tab || !tab.url || !/^https?:/i.test(tab.url)) return null;
  let state = { scrollX: 0, scrollY: 0, videoTime: 0 };
  try {
    const out = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readPageState });
    if (out && out[0] && out[0].result) state = out[0].result;
  } catch (e) { /* restricted/unloaded tab; carry just the url */ }
  let url = tab.url;
  if (state.videoTime > 0 && isYouTube(url)) url = bakeYouTubeTime(url, state.videoTime);
  return { url, active: !!tab.active, scrollX: state.scrollX, scrollY: state.scrollY, videoTime: state.videoTime };
}

// teleportTab sends a single tab (the Phase-1 shortcut/context-menu path).
async function teleportTab(tab) {
  const t = await captureTab(tab);
  if (!t) { console.warn("Teleporter: only http(s) tabs can be teleported"); return; }
  const moveId = crypto.randomUUID();
  pendingClose.set(moveId, { type: "tab", id: tab.id });
  const ok = await sendEnvelope({ v: 1, kind: "open", moveId, tabs: [t] });
  if (!ok) pendingClose.delete(moveId);
  else console.log("Teleporter: sent tab", t.url);
}

// teleportFocusedWindow sends EVERY http(s) tab of the focused window as one window-move.
// Invoked when Merged reports a Chrome window was dragged across the seam (capture-window).
// The dragged window is the focused one, so getLastFocused identifies it.
async function teleportFocusedWindow() {
  const win = await chrome.windows.getLastFocused({ populate: true });
  if (!win || !win.tabs || !win.tabs.length) return;
  const tabs = [];
  for (const tab of win.tabs) {
    const t = await captureTab(tab);
    if (t) tabs.push(t);
  }
  if (!tabs.length) { console.warn("Teleporter: no http(s) tabs in the dragged window"); return; }
  const moveId = crypto.randomUUID();
  pendingClose.set(moveId, { type: "window", id: win.id });
  const ok = await sendEnvelope({ v: 1, kind: "open", moveId, asWindow: true, tabs });
  if (!ok) pendingClose.delete(moveId);
  else console.log("Teleporter: sent window with", tabs.length, "tab(s)");
}

// ---------------- receive (peer -> this machine) ----------------

// Injected after the teleported tab loads, to restore scroll/video position.
function restorePageState(state) {
  try {
    if (state.scrollX || state.scrollY) window.scrollTo(state.scrollX || 0, state.scrollY || 0);
    if (state.videoTime > 0) {
      const v = document.querySelector("video");
      if (v) { try { v.currentTime = state.videoTime; } catch (e) {} }
    }
  } catch (e) {}
}

// scheduleRestore re-applies a tab's scroll/video state once it finishes loading,
// independently of the ack (so the source side never waits on it).
function scheduleRestore(tabId, t) {
  if (!tabId || !(t.scrollX || t.scrollY || t.videoTime)) return;
  const onUpdated = (id, info) => {
    if (id !== tabId || info.status !== "complete") return;
    chrome.tabs.onUpdated.removeListener(onUpdated);
    chrome.scripting.executeScript({ target: { tabId: id }, func: restorePageState, args: [{ scrollX: t.scrollX || 0, scrollY: t.scrollY || 0, videoTime: t.videoTime || 0 }] }).catch(() => {});
  };
  chrome.tabs.onUpdated.addListener(onUpdated);
  setTimeout(() => chrome.tabs.onUpdated.removeListener(onUpdated), 20000); // stop listening eventually
}

// isBlankTabUrl reports whether a URL is a blank / new-tab page (a startup window's idle tab).
function isBlankTabUrl(u) {
  u = ((u || "") + "").toLowerCase();
  return u === "" || u === "about:blank" || u.startsWith("chrome://newtab") || u.startsWith("chrome://new-tab-page");
}

// blankWindows returns the normal windows that are a lone blank / new-tab startup window. On a COLD
// launch (the browser was just launched FOR this teleport) these are safe to reuse or close — there
// are no real user windows yet. (Used only on the cold path, which is gated on /coldlaunch.)
async function blankWindows() {
  const out = [];
  try {
    const wins = await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] });
    for (const w of wins) {
      if (w.tabs && w.tabs.length === 1 && isBlankTabUrl(w.tabs[0].url || w.tabs[0].pendingUrl)) out.push(w);
    }
  } catch (e) { /* fall through */ }
  return out;
}

// findLaunchedWindow locates the window the wrapper opened for a cold teleport — it launches Chrome with
// the WHOLE window in one shot (`chrome.exe url1 url2 …`). We must NOT require it to be the ONLY window:
// a fresh teleport profile can pop a stray blank / welcome window alongside it, and requiring "exactly
// one window" then failed → the extension built a SECOND window (two windows, same tabs). Instead we
// identify the launched window robustly, ignoring strays, by (in order): (a) a window with >= the
// expected tab count — unambiguous on a cold launch, where only the launched window holds multiple tabs;
// (b) a window whose first tab is (loading) the launched first URL; (c) the lone NON-blank window. We
// wait until it has all its tabs (so a tab still opening from the launch isn't seen as missing and
// re-created), returning the best match at timeout. Strays are closed by closeStrayBlankWindows after.
async function findLaunchedWindow(tabs, timeoutMs) {
  const want = (((tabs[0] && tabs[0].url) || "") + "").split("#")[0];
  const deadline = Date.now() + timeoutMs;
  let best = null;
  for (;;) {
    let wins = [];
    try { wins = await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] }); } catch (e) {}
    let match = null;
    if (tabs.length > 1) match = wins.find((w) => w.tabs && w.tabs.length >= tabs.length);
    if (!match) match = wins.find((w) => {
      if (!w.tabs || !w.tabs.length) return false;
      const u = ((w.tabs[0].url || w.tabs[0].pendingUrl || "") + "").split("#")[0];
      return u && want && (u === want || u.startsWith(want) || want.startsWith(u));
    });
    if (!match) {
      const nonBlank = wins.filter((w) => w.tabs && !(w.tabs.length === 1 && isBlankTabUrl(w.tabs[0].url || w.tabs[0].pendingUrl)));
      if (nonBlank.length === 1) match = nonBlank[0];
    }
    if (match) {
      best = match;
      if (match.tabs.length >= tabs.length) return match; // all launched tabs present
    }
    if (Date.now() >= deadline) return best;
    await sleep(80);
  }
}

// closeStrayBlankWindows closes every lone blank startup window EXCEPT keepWinId. Belt-and-suspenders
// cleanup on a cold launch: whether we reused the blank window or had to create a fresh one, this
// guarantees no orphaned blank window is left behind beside the teleported one.
async function closeStrayBlankWindows(keepWinId) {
  try {
    for (const w of await blankWindows()) {
      if (w.id !== keepWinId) chrome.windows.remove(w.id).catch(() => {});
    }
  } catch (e) { /* best-effort */ }
}

// wasColdLaunch asks the bridge whether MouseTransfer just launched this browser for the current
// teleport (browser was closed). One-shot + TTL on the bridge side. A reliable signal for whether to
// reuse the lone blank startup window — false when the browser was already open. Defaults to false
// (create a fresh window) if the bridge can't be reached.
async function wasColdLaunch() {
  try {
    const res = await fetch(q("/coldlaunch"));
    if (res.ok) { const j = await res.json(); return !!(j && j.cold); }
  } catch (e) { /* bridge unreachable — treat as not a cold launch */ }
  return false;
}

// reportTeleportWindow tells the wrapper the bounds of the window we just created/reused for a
// whole-window teleport, so its ride grabs THIS window — not a restored-session or chrome://extensions
// window that also opened on a cold launch. Best-effort.
async function reportTeleportWindow(winId) {
  try {
    const w = await chrome.windows.get(winId);
    if (w && typeof w.left === "number") {
      fetch(q("/teleport-window") + "&left=" + Math.round(w.left) + "&top=" + Math.round(w.top) +
        "&width=" + Math.round(w.width) + "&height=" + Math.round(w.height)).catch(() => {});
    }
  } catch (e) { /* best-effort */ }
}

// dbg surfaces a diagnostic line into the wrapper's btrace log (POST /debug) so we can see the
// extension's own view of the windows from a remote machine. Best-effort; the wrapper logs it only when
// its browser-teleport trace toggle is on.
function dbg(m) { try { fetch(q("/debug"), { method: "POST", body: String(m) }).catch(() => {}); } catch (e) {} }

// winSummary renders the current normal windows + tab counts + first URLs for a dbg line.
async function winSummary() {
  try {
    const ws = await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] });
    return ws.map((w) => "#" + w.id + "(" + (w.tabs ? w.tabs.length : 0) + "t:" + (((w.tabs && w.tabs[0] && (w.tabs[0].url || w.tabs[0].pendingUrl)) || "") + "").slice(0, 32) + ")").join(", ") || "(none)";
  } catch (e) { return "(getAll failed: " + e + ")"; }
}

async function handleEnvelope(env) {
  if (!env || env.v !== 1) return;

  // Dev auto-reload: Merged watches the extension folder and sends this when it changes
  // (e.g. after a git pull), so we re-read the new files from disk. Ignore for the first
  // few seconds after a reload so a redelivered command can't loop.
  if (env.kind === "reload") {
    if (Date.now() - STARTED_AT > 3000) { console.log("Teleporter: reloading (source changed)"); chrome.runtime.reload(); }
    return;
  }

  // Merged tells us a Chrome window was dragged across the seam: capture+send it.
  if (env.kind === "capture-window") { await teleportFocusedWindow(); return; }

  if (env.kind === "open") {
    const tabs = (env.tabs || []).filter((t) => t && t.url);
    if (!tabs.length) return;

    if (env.asWindow) {
      // Whole-window teleport. COLD path: MouseTransfer just LAUNCHED the browser for this teleport (it
      // was closed) and opened the window WITH ALL THE TABS already (`chrome.exe url1 url2 …`, in order).
      // So we ADOPT that lone startup window and RESTORE STATE IN PLACE — creating NOTHING — instead of
      // building a second window (the duplicate-window bug). /coldlaunch is the authoritative signal (NOT
      // a worker-uptime guess, which also fires on a reload/resurrection and made warm teleports wrongly
      // reuse a window). WARM (browser already open): /coldlaunch is false → create a fresh window the
      // wrapper's ride can grab and follow.
      const cold = await wasColdLaunch();
      dbg("asWindow open: cold=" + cold + " tabs=" + tabs.length + " | windows: " + (await winSummary()));
      // Wait for the launched window to have all its tabs before touching it (else we'd "fill in" a tab
      // that's still opening from the launch → a duplicate). Tabs the wrapper opened are already loading
      // the right URLs, so we DON'T re-navigate them (no reload — the page keeps loading while the window
      // rides the cursor); we only navigate a blank fallback tab and create any tab that didn't open.
      const adopt = cold ? await findLaunchedWindow(tabs, 2500) : null;
      dbg("adopt=" + (adopt ? ("win#" + adopt.id + " tabs=" + (adopt.tabs ? adopt.tabs.length : 0)) : "NULL -> creating a NEW window") + " | windows now: " + (await winSummary()));
      let win, firstId = null, activeId = null;
      if (adopt) {
        win = adopt;
        const wtabs = win.tabs || [];
        for (let i = 0; i < tabs.length; i++) {
          let tabId;
          if (i < wtabs.length) {
            tabId = wtabs[i].id;
            // Navigate ONLY if this slot is a blank fallback tab; a launched tab already holds the URL.
            if (isBlankTabUrl(wtabs[i].url || wtabs[i].pendingUrl)) await chrome.tabs.update(tabId, { url: tabs[i].url });
          } else {
            const nt = await chrome.tabs.create({ windowId: win.id, url: tabs[i].url, active: false });
            tabId = nt.id;
          }
          scheduleRestore(tabId, tabs[i]);
          if (tabs[i].active) activeId = tabId;
        }
        try { await chrome.windows.update(win.id, { focused: true }); } catch (e) {}
      } else {
        // WARM (or cold with no startup window found): create the window with all tabs as before.
        win = await chrome.windows.create({ url: tabs[0].url, focused: true });
        firstId = win.tabs && win.tabs[0] && win.tabs[0].id;
        scheduleRestore(firstId, tabs[0]);
        if (tabs[0].active) activeId = firstId;
        for (let i = 1; i < tabs.length; i++) {
          const nt = await chrome.tabs.create({ windowId: win.id, url: tabs[i].url, active: false });
          scheduleRestore(nt.id, tabs[i]);
          if (tabs[i].active) activeId = nt.id;
        }
      }
      if (activeId) chrome.tabs.update(activeId, { active: true }).catch(() => {});
      // Cold-launch cleanup: close any stray blank startup window beside the teleport one.
      if (cold) await closeStrayBlankWindows(win.id);
      reportTeleportWindow(win.id); // tell the wrapper WHICH window to ride
    } else {
      const newTab = await chrome.tabs.create({ url: tabs[0].url, active: true });
      scheduleRestore(newTab.id, tabs[0]);
    }

    // Ack IMMEDIATELY: the tab(s) exist, so the move has succeeded — the source should close
    // now rather than wait for pages to load (that wait was the ~5s lag).
    sendEnvelope({ v: 1, kind: "ack", moveId: env.moveId });
    return;
  }

  if (env.kind === "ack") {
    const target = pendingClose.get(env.moveId);
    if (target) {
      pendingClose.delete(env.moveId);
      closeWhenPossible(target);
    }
  }
}

// closeWhenPossible removes the source tab/window once Chrome lets it. If the window was
// dragged by a TAB (rather than the title bar), Chrome holds a tab-drag session with the
// mouse captured and silently refuses windows.remove until the user releases — so a single
// remove no-ops and the window lingers. Retry until it's actually gone (verified via
// get() throwing), which naturally succeeds the moment the drag is released.
async function closeWhenPossible(target) {
  for (let i = 0; i < 30; i++) { // ~15s ceiling
    try {
      if (target.type === "window") await chrome.windows.remove(target.id);
      else await chrome.tabs.remove(target.id);
    } catch (e) { /* may be mid tab-drag; verify below and retry */ }
    try {
      if (target.type === "window") await chrome.windows.get(target.id);
      else await chrome.tabs.get(target.id);
    } catch (e) { return; } // get() threw → it's gone → done
    await sleep(500);
  }
}

// ---------------- triggers ----------------

async function teleportActive() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) teleportTab(tab);
}

chrome.action.onClicked.addListener(() => teleportActive());
chrome.commands.onCommand.addListener((cmd) => { if (cmd === "teleport-tab") teleportActive(); });

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: "teleport-tab", title: "Teleport this tab to the other computer", contexts: ["page"] }, () => void chrome.runtime.lastError);
});
chrome.contextMenus.onClicked.addListener((info, tab) => { if (info.menuItemId === "teleport-tab") teleportTab(tab); });

// ---------------- keep-alive ----------------
//
// The whole feature depends on the service worker continuously polling /events so a pushed
// command (capture-window) and incoming opens are received instantly. But MV3 suspends the
// worker after ~30s idle — even with a pending fetch — which stalls delivery until the worker
// wakes (commands/opens pile up in the bridge). On a fast machine a periodic API-ping kept it
// alive; on a SLOW/OLD box (the Win8 laptop runs at most Chrome 109, MV3-transition era) a
// setInterval-based ping is NOT reliable — a setInterval is silently lost the moment the worker
// is suspended, so the worker died and only the 30s alarm resurrected it, leaving a dead window
// of up to ~30s where teleports "took ages". Three layers, strongest first:
//   1) a PORT LIFELINE — an open runtime port continuously holds the worker alive (a connection,
//      not a timer that can be lost). This is Google's documented MV3-transition workaround and
//      is the reliable one on Chrome 109. Chrome force-disconnects ports at ~5 min, so we
//      reconnect well before that for a fresh lease.
//   2) an AWAITED getPlatformInfo loop (every 15s) as a secondary timer-based reset.
//   3) a coarse alarm (0.5 min) that survives an actual eviction and re-enters pollLoop.
let lifelinePort = null;
function startLifeline() {
  if (lifelinePort) return;
  try {
    lifelinePort = chrome.runtime.connect({ name: "keepalive" });
    lifelinePort.onDisconnect.addListener(() => {
      void chrome.runtime.lastError; // swallow "port closed" on reconnect
      lifelinePort = null;
      startLifeline(); // immediately re-establish for the next ~5-min lease
    });
  } catch (e) { lifelinePort = null; }
}
// The other end of the lifeline lives in THIS same worker (a self-connect): holding the port
// open keeps the worker alive. Drop it just before Chrome's ~5-min hard port limit so the
// onDisconnect above reconnects (a fresh lease) rather than Chrome killing the worker.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "keepalive") return;
  setTimeout(() => { try { port.disconnect(); } catch (e) {} }, 250000); // ~4m10s < 5m cap
});

let keepAliveTimer = null;
function startKeepAlive() {
  startLifeline();
  if (keepAliveTimer) return;
  // AWAITED (not fire-and-forget): the response coming back is what resets the idle timer.
  keepAliveTimer = setInterval(async () => {
    try { await chrome.runtime.getPlatformInfo(); } catch (e) {}
  }, 15000);
}

// ---------------- boot ----------------

if (chrome.alarms) {
  chrome.alarms.create("keepalive", { periodInMinutes: 0.5 }); // backstop if the worker ever dies
  chrome.alarms.onAlarm.addListener(() => { startKeepAlive(); pollLoop(); });
}
chrome.runtime.onStartup.addListener(() => boot());
chrome.runtime.onInstalled.addListener(() => boot());

async function boot() { startKeepAlive(); await loadConfig(); await ensureToken(); pollLoop(); }
boot();
