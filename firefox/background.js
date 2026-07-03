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

// ---- durable pending-close registry ----
// pendingClose alone is IN-MEMORY: if the MV3 worker suspends mid closeWhenPossible retry loop
// (or between the send and the ack), the close is orphaned FOREVER — the acked, already-teleported
// source window then lingers where its drag ended (the "chrome tab left at the seam edge" report,
// 2026-07-03). Mirror every pending close to chrome.storage.session (acked flag included) so a
// resurrected worker — or a "recheck-closes" nudge from the wrapper, which watches the doomed
// window by hwnd — can re-drive it to completion.
async function pcLoad() { try { const s = await chrome.storage.session.get("mtPendClose"); return (s && s.mtPendClose) || {}; } catch (e) { return {}; } }
function pcSave(m) { try { chrome.storage.session.set({ mtPendClose: m }); } catch (e) {} }
async function pcSet(moveId, entry) { const m = await pcLoad(); m[moveId] = entry; pcSave(m); }
async function pcMark(moveId, patch) { const m = await pcLoad(); if (m[moveId]) { Object.assign(m[moveId], patch); pcSave(m); } }
async function pcDel(moveId) { const m = await pcLoad(); if (moveId in m) { delete m[moveId]; pcSave(m); } }
const closingNow = new Set(); // moveIds with a live closeWhenPossible loop (avoid duplicate loops per worker)

// recheckCloses re-drives every ACKED pending close — from boot (worker resurrection) or a
// wrapper "recheck-closes" nudge (it sees the doomed source window still open). Un-acked entries
// are left alone: without the peer's ack the tabs may exist ONLY here, so closing would lose them.
async function recheckCloses(reason) {
  const m = await pcLoad();
  for (const id in m) {
    if (m[id].acked && !closingNow.has(id)) {
      dbg("recheck-closes(" + reason + "): re-driving close for " + id + " (" + m[id].type + " " + m[id].id + ")");
      closeWhenPossible(m[id], id);
    }
  }
}

// teleportTab sends a single tab (the Phase-1 shortcut/context-menu path).
async function teleportTab(tab) {
  const t = await captureTab(tab);
  if (!t) { console.warn("Teleporter: only http(s) tabs can be teleported"); return; }
  const moveId = crypto.randomUUID();
  pendingClose.set(moveId, { type: "tab", id: tab.id });
  await pcSet(moveId, { type: "tab", id: tab.id, acked: false });
  const ok = await sendEnvelope({ v: 1, kind: "open", moveId, tabs: [t] });
  if (!ok) { pendingClose.delete(moveId); pcDel(moveId); }
  else console.log("Teleporter: sent tab", t.url);
}

// findWindowByPxRect matches one of our windows to a screen-pixel rect the wrapper measured
// (Win32, px), trying each standard Windows scale factor (Settings > Display offers 100-250%)
// to map px -> our DIP bounds. Returns null when nothing is plausibly close — the caller must
// then ABORT rather than guess.
async function findWindowByPxRect(wl, wt, ww, wh) {
  let wins = [];
  try { wins = await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] }); } catch (e) { return null; }
  let best = null, bestD = Infinity;
  for (const s of [1, 1.25, 1.5, 1.75, 2, 2.25, 2.5]) {
    const want = { left: wl / s, top: wt / s, width: ww / s, height: wh / s };
    for (const w of wins) {
      if (typeof w.left !== "number") continue;
      const d = Math.abs(w.left - want.left) + Math.abs(w.top - want.top) + Math.abs(w.width - want.width) + Math.abs(w.height - want.height);
      if (d < bestD) { bestD = d; best = w; }
    }
  }
  if (!best || bestD > 200) { dbg("capture-window: no window matches the dragged rect (bestD=" + Math.round(bestD) + ")"); return null; }
  dbg("capture-window: matched window #" + best.id + " (" + (best.tabs ? best.tabs.length : 0) + " tabs, bestD=" + Math.round(bestD) + ")");
  return best;
}

// teleportFocusedWindow sends EVERY http(s) tab of the dragged window as one window-move.
// Invoked when Merged reports a Chrome window was dragged across the seam (capture-window).
// The wrapper includes the dragged window's on-screen rect; capture THAT window, matched by
// bounds — NOT getLastFocused: this worker can be slow/cold, and by the time it runs the
// source drag may have ended (or a tear been reverted), moving focus — focus-based capture
// then teleported AND CLOSED the whole original window or a completely unrelated one (the
// 2026-07-03 YouTube-tab reports). No bounds match -> ABORT: better no teleport (the window
// just stays put) than the wrong window leaving the machine. Legacy envelopes without a rect
// keep the focus capture.
async function teleportFocusedWindow(env) {
  let win = null;
  if (env && typeof env.ww === "number") {
    // A rect-aware wrapper sent this. NEVER fall back to focus capture here — even for a
    // zero/unusable rect: focus at capture time can name the original multi-tab window (or an
    // unrelated one) after a lost tear race, and capturing it teleports+closes the wrong thing.
    if (!(env.ww > 0 && env.wh > 0)) { dbg("capture-window: no usable rect — ABORTING (never guess by focus)"); return; }
    win = await findWindowByPxRect(env.wl, env.wt, env.ww, env.wh);
    if (!win) { dbg("capture-window: ABORTING teleport — dragged window not found (drag reverted/closed?)"); return; }
  } else {
    win = await chrome.windows.getLastFocused({ populate: true }); // legacy wrapper without a rect
  }
  if (!win || !win.tabs || !win.tabs.length) return;
  const tabs = [];
  for (const tab of win.tabs) {
    const t = await captureTab(tab);
    if (t) tabs.push(t);
  }
  if (!tabs.length) { console.warn("Teleporter: no http(s) tabs in the dragged window"); return; }
  const moveId = crypto.randomUUID();
  pendingClose.set(moveId, { type: "window", id: win.id });
  await pcSet(moveId, { type: "window", id: win.id, acked: false });
  const ok = await sendEnvelope({ v: 1, kind: "open", moveId, asWindow: true, tabs });
  if (!ok) { pendingClose.delete(moveId); pcDel(moveId); }
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

// lastTeleportWin remembers the window created/adopted for the most recent teleport open, so a
// follow-up "merge-drop" (the user released a TAB tear-off over another window's tab strip) knows
// which window's tabs to move. Mirrored to storage.session: the MV3 worker can be suspended between
// the open and the drop, and a resurrected worker must still resolve it.
let lastTeleportWin = null; // {id, at}
function setLastTeleportWin(id) {
  lastTeleportWin = { id, at: Date.now() };
  try { chrome.storage.session.set({ mtTeleWin: lastTeleportWin }); } catch (e) {}
}
async function getLastTeleportWin() {
  if (lastTeleportWin) return lastTeleportWin;
  try { const s = await chrome.storage.session.get("mtTeleWin"); return (s && s.mtTeleWin) || null; } catch (e) { return null; }
}

// mergeTeleportDrop merges the teleported window's tab(s) into an existing window — the wrapper
// detected the ride's release landing on that window's tab strip (Chrome-style tab-drag merge).
// The wrapper sends both rects in SCREEN PIXELS; our bounds are in DIPs — the teleport window
// itself is the scale reference (we know it in both spaces: env.r* is its px rect at drop, and
// chrome.windows.get gives its DIP bounds), so the target rect is mapped px->DIP and matched to
// our nearest window. Best-effort: any miss leaves the standalone window (never a lost tab).
async function mergeTeleportDrop(env) {
  const tp = await getLastTeleportWin();
  if (!tp || Date.now() - tp.at > 60000) { dbg("merge-drop: no recent teleport window to merge"); return; }
  let tw;
  try { tw = await chrome.windows.get(tp.id, { populate: true }); } catch (e) { dbg("merge-drop: teleport window gone"); return; }
  if (!tw || !tw.tabs || !tw.tabs.length) return;
  const sx = env.rw && tw.width ? tw.width / env.rw : 1; // DIP per px
  const sy = env.rh && tw.height ? tw.height / env.rh : (env.rw && tw.width ? tw.width / env.rw : 1);
  const want = { left: env.tl * sx, top: env.tt * sy, width: env.tw * sx, height: env.th * sy };
  let wins = [];
  try { wins = await chrome.windows.getAll({ windowTypes: ["normal"] }); } catch (e) { return; }
  let best = null, bestD = Infinity;
  for (const w of wins) {
    if (w.id === tw.id || typeof w.left !== "number") continue;
    const d = Math.abs(w.left - want.left) + Math.abs(w.top - want.top) + Math.abs(w.width - want.width) + Math.abs(w.height - want.height);
    if (d < bestD) { bestD = d; best = w; }
  }
  // Reject a wild match: the wrapper picked a REAL window at those bounds, so the true match is
  // close; anything further than ~a window-width off means our window list doesn't contain it.
  if (!best || bestD > Math.max(200, want.width)) { dbg("merge-drop: no window matched the target rect (bestD=" + bestD + ")"); return; }
  try {
    const ids = tw.tabs.map((t) => t.id);
    await chrome.tabs.move(ids, { windowId: best.id, index: -1 }); // teleport window auto-closes when its last tab leaves
    await chrome.windows.update(best.id, { focused: true });
    await chrome.tabs.update(ids[ids.length - 1], { active: true });
    dbg("merge-drop: merged " + ids.length + " tab(s) into window #" + best.id);
  } catch (e) { dbg("merge-drop: move failed: " + e); }
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

  // Merged tells us a Chrome window was dragged across the seam: capture+send it
  // (env carries the dragged window's px rect — see teleportFocusedWindow).
  if (env.kind === "capture-window") { await teleportFocusedWindow(env); return; }

  // Merged saw a tab tear-off ride released over another browser window's tab strip:
  // merge the teleported tab(s) into that window, like Chrome's native tab-drag merge.
  if (env.kind === "merge-drop") { await mergeTeleportDrop(env); return; }

  // Merged sees an acked teleport's doomed source window STILL OPEN: re-drive its close
  // (covers a worker suspended mid retry-loop, whose in-memory close was lost).
  if (env.kind === "recheck-closes") { await recheckCloses("wrapper nudge"); return; }

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
      setLastTeleportWin(win.id); // so a tab tear-off's merge-drop knows which window's tabs to move
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
    let target = pendingClose.get(env.moveId);
    pendingClose.delete(env.moveId);
    if (!target) { const m = await pcLoad(); target = m[env.moveId]; } // a resurrected worker: recover from the durable registry
    if (target) {
      await pcMark(env.moveId, { acked: true }); // durably acked BEFORE closing, so a re-drive is allowed to finish it
      closeWhenPossible(target, env.moveId);
    }
  }
}

// closeWhenPossible removes the source tab/window once Chrome lets it. If the window was
// dragged by a TAB (rather than the title bar), Chrome holds a tab-drag session with the
// mouse captured and silently refuses windows.remove until the user releases — so a single
// remove no-ops and the window lingers. Retry until it's actually gone (verified via
// get() throwing), which naturally succeeds the moment the drag is released. The durable
// mtPendClose entry is cleared only on confirmed-gone, so a worker suspension mid-loop can
// be recovered by recheckCloses (boot / the wrapper's recheck-closes nudge).
async function closeWhenPossible(target, moveId) {
  if (moveId) {
    if (closingNow.has(moveId)) return; // a loop for this close is already running in this worker
    closingNow.add(moveId);
  }
  if (target.type === "window") suppressCarryback.add(target.id); // a teleport-AWAY close — don't carry it back
  for (let i = 0; i < 30; i++) { // ~15s ceiling
    try {
      if (target.type === "window") await chrome.windows.remove(target.id);
      else await chrome.tabs.remove(target.id);
    } catch (e) {
      // Refused (may be mid tab-drag) — surface WHY into the wrapper's btrace so a lingering
      // source window is diagnosable (first few attempts + every 5th).
      if (i < 3 || i % 5 === 0) dbg("close refused (attempt " + (i + 1) + ") for " + target.type + " " + target.id + ": " + (e && e.message ? e.message : e));
    }
    try {
      if (target.type === "window") await chrome.windows.get(target.id);
      else await chrome.tabs.get(target.id);
    } catch (e) { // get() threw → it's gone → done
      if (moveId) { closingNow.delete(moveId); pcDel(moveId); }
      return;
    }
    await sleep(500);
  }
  if (moveId) closingNow.delete(moveId); // ceiling hit — keep the durable entry so a later re-drive can finish it
  dbg("close GAVE UP after ~15s for " + target.type + " " + target.id + " (still open; awaiting a re-drive)");
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

// ---------------- carry-back (teleport-profile windows -> normal profile) ----------------
//
// The wrapper lands closed-browser teleports in a DEDICATED, isolated "MouseTransfer" Chrome profile
// that is WIPED on each cold launch. So tabs the user accumulates there would be lost. Carry-back saves
// a WHOLE window (not individual tabs) the user closes in the teleport profile, and re-homes it into the
// user's NORMAL profile as a `mousetransfer-toopen/<window>` bookmark subfolder, which the normal profile
// opens as a window (and clears) on its next launch. The wrapper's /carryback queue is the cross-profile,
// cross-restart bridge; /profile-role tells each profile which side it's on (only the teleport profile
// saves; only the normal profile restores).
const CARRYBACK_FOLDER = "mousetransfer-toopen"; // MUST match the wrapper's carrybackBookmarkFolder
let PROFILE_ROLE = null;                          // "teleport" | "normal" (cached per worker session)
const winTabs = new Map();                        // windowId -> Map(tabId -> url) — last-known http(s) tabs per window
const suppressCarryback = new Set();              // windowIds closed by a teleport-AWAY (not a user close)

// MV3 service workers are EPHEMERAL — they suspend when idle and a later event (e.g. a window close)
// resurrects a FRESH worker with empty in-memory state. So PROFILE_ROLE and the per-window tab cache are
// mirrored to chrome.storage.session (survives suspension, cleared on browser close), and onWindowClosed
// recovers them from there when the in-memory copies are empty (the close event woke a fresh worker).
async function persistRole() { try { await chrome.storage.session.set({ mtRole: PROFILE_ROLE }); } catch (e) {} }
function winTabsToObj() {
  const o = {};
  for (const [wid, m] of winTabs) { o[wid] = {}; for (const [tid, url] of m) o[wid][tid] = url; }
  return o;
}
function persistWinTabs() { try { chrome.storage.session.set({ mtWinTabs: winTabsToObj() }); } catch (e) {} }

// resolveProfileRole asks the wrapper which profile we're in. /profile-role is ONE-SHOT on the wrapper
// side, so it MUST be queried exactly once: boot() is invoked 3x at launch (bare + onStartup +
// onInstalled), and concurrent queries would consume the claim with one (teleport) and get "normal" with
// the others (the bug). Single-flight via roleInFlight + cache in storage.session so a resurrected worker
// reads the role instead of re-querying after the claim is gone.
let roleInFlight = null;
function resolveProfileRole() {
  if (PROFILE_ROLE) return Promise.resolve(PROFILE_ROLE);
  if (roleInFlight) return roleInFlight;
  roleInFlight = (async () => {
    try { const s = await chrome.storage.session.get("mtRole"); if (s && s.mtRole) { PROFILE_ROLE = s.mtRole; return PROFILE_ROLE; } } catch (e) {}
    try { const res = await fetch(q("/profile-role")); PROFILE_ROLE = (res.ok && (await res.json()).role) || "normal"; }
    catch (e) { PROFILE_ROLE = "normal"; }
    await persistRole();
    dbg("profile role = " + PROFILE_ROLE);
    return PROFILE_ROLE;
  })();
  return roleInFlight;
}

function recordTab(windowId, tabId, url) {
  if (windowId == null || tabId == null || !url || !/^https?:/i.test(url)) return;
  let m = winTabs.get(windowId);
  if (!m) { m = new Map(); winTabs.set(windowId, m); }
  m.set(tabId, url);
  persistWinTabs();
}
async function initWinTabs() {
  try { // recover a resurrected worker's cache first (the close event may have woken us)
    const s = await chrome.storage.session.get("mtWinTabs");
    if (s && s.mtWinTabs) for (const wid in s.mtWinTabs) { const m = new Map(); for (const tid in s.mtWinTabs[wid]) m.set(tid, s.mtWinTabs[wid][tid]); winTabs.set(Number(wid), m); }
  } catch (e) {}
  try { for (const t of await chrome.tabs.query({})) recordTab(t.windowId, t.id, t.url || t.pendingUrl); } catch (e) {}
}
chrome.tabs.onCreated.addListener((t) => recordTab(t.windowId, t.id, t.url || t.pendingUrl));
chrome.tabs.onUpdated.addListener((tabId, info, t) => { if (t && (info.url || t.url)) recordTab(t.windowId, tabId, t.url); });
chrome.tabs.onAttached.addListener(async (tabId, info) => { try { const t = await chrome.tabs.get(tabId); recordTab(info.newWindowId, tabId, t.url); } catch (e) {} });
chrome.tabs.onRemoved.addListener((tabId, info) => {
  if (info.isWindowClosing) return;                 // whole window closing — KEEP the set for carry-back
  const m = winTabs.get(info.windowId); if (m) { m.delete(tabId); persistWinTabs(); } // single tab closed — don't carry it back
});
chrome.runtime.onSuspend.addListener(() => { try { chrome.storage.session.set({ mtWinTabs: winTabsToObj(), mtRole: PROFILE_ROLE }); } catch (e) {} });
chrome.windows.onRemoved.addListener((windowId) => { onWindowClosed(windowId); });

// onWindowClosed carries a whole closed window back to the normal profile — ONLY in the teleport profile,
// ONLY for a genuine user close (not a teleport-away), and only if it had http(s) tabs. Robust against a
// fresh (resurrected) worker: role + tabs are recovered from storage.session when the in-memory copies are
// empty (the close event woke THIS worker, so boot()/initWinTabs hasn't repopulated them yet).
async function onWindowClosed(windowId) {
  if (suppressCarryback.delete(windowId)) return;   // a teleport-away close — skip
  // FAST PATH: in-memory state present (worker alive). Closing the teleport browser's LAST window makes
  // Chrome EXIT, killing any in-flight async work — so send SYNCHRONOUSLY here, before any await, via
  // sendCarryback (navigator.sendBeacon, which is designed to survive a context teardown).
  if (PROFILE_ROLE === "teleport") {
    const m = winTabs.get(windowId);
    if (m && m.size) { sendCarryback(Array.from(m.values()), windowId); winTabs.delete(windowId); persistWinTabs(); return; }
  }
  // SLOW PATH: a resurrected worker (the close event woke us) — recover role + tabs from storage.session.
  // Best-effort: the awaits may not finish if the browser is also exiting (the keep-alive normally keeps
  // the worker alive so the fast path runs instead).
  let role = PROFILE_ROLE, m = winTabs.get(windowId);
  if (!role || !m) {
    try {
      const s = await chrome.storage.session.get(["mtRole", "mtWinTabs"]);
      if (!role && s && s.mtRole) role = s.mtRole;
      if (!m && s && s.mtWinTabs && s.mtWinTabs[windowId]) { m = new Map(); for (const tid in s.mtWinTabs[windowId]) m.set(tid, s.mtWinTabs[windowId][tid]); }
    } catch (e) {}
  }
  winTabs.delete(windowId); persistWinTabs();
  if (role !== "teleport" || !m || m.size === 0) { dbg("carryback: skipped window " + windowId + " (role=" + role + " tabs=" + (m ? m.size : 0) + ")"); return; }
  sendCarryback(Array.from(m.values()), windowId);
}

// sendCarryback POSTs a closed window's tabs to the wrapper so it survives the browser/worker teardown
// that closing the last window triggers: navigator.sendBeacon queues the request in the network stack and
// is delivered even as the context dies (a plain fetch is cut off). keepalive-fetch is the fallback.
function sendCarryback(tabs, windowId) {
  const url = q("/carryback"), body = JSON.stringify({ tabs });
  let ok = false;
  try { ok = navigator.sendBeacon(url, body); } catch (e) {}
  if (!ok) { try { fetch(url, { method: "POST", body, keepalive: true }); } catch (e) {} }
  dbg("carryback: queued closed window " + windowId + " (" + tabs.length + " tabs, beacon=" + ok + ")");
}

async function findCarrybackFolder() {
  try { for (const h of await chrome.bookmarks.search({ title: CARRYBACK_FOLDER })) if (!h.url) return h; } catch (e) {}
  return null;
}
async function ensureCarrybackFolder() {
  const f = await findCarrybackFolder(); if (f) return f;
  try { return await chrome.bookmarks.create({ parentId: "1", title: CARRYBACK_FOLDER }); } catch (e) { return null; } // "1" = bookmark bar
}
// stageCarryback drains the wrapper queue into mousetransfer-toopen bookmark subfolders (one per window).
// No windows are opened — so a worker resurrection mid-session never pops windows; it just persists them.
async function stageCarryback() {
  let pending = [];
  try { const res = await fetch(q("/carryback-drain")); pending = (res.ok && (await res.json()).windows) || []; } catch (e) { return; }
  if (!pending.length) return;
  const folder = await ensureCarrybackFolder(); if (!folder) return;
  for (const win of pending) {
    const urls = (win.tabs || []).filter((u) => /^https?:/i.test(u));
    if (!urls.length) continue;
    try {
      const sub = await chrome.bookmarks.create({ parentId: folder.id, title: "window-" + (win.at || "") });
      for (const url of urls) await chrome.bookmarks.create({ parentId: sub.id, title: url, url });
    } catch (e) {}
  }
  dbg("carryback: staged " + pending.length + " window(s) as bookmarks");
}
// restoreCarryback opens each staged subfolder as a window, then deletes the whole folder. Called ONLY on
// a real browser startup (chrome.runtime.onStartup), so carried-back windows appear alongside the user's
// own session-resume — never mid-session.
async function restoreCarryback() {
  const folder = await findCarrybackFolder(); if (!folder) return;
  let subs = [];
  try { subs = await chrome.bookmarks.getChildren(folder.id); } catch (e) { return; }
  let opened = 0;
  for (const sub of subs) {
    if (sub.url) continue; // only subfolders
    let urls = [];
    try { urls = (await chrome.bookmarks.getChildren(sub.id)).filter((k) => k.url).map((k) => k.url); } catch (e) { continue; }
    if (!urls.length) continue;
    try {
      const w = await chrome.windows.create({ url: urls[0] });
      for (let i = 1; i < urls.length; i++) await chrome.tabs.create({ windowId: w.id, url: urls[i], active: false });
      opened++;
    } catch (e) {}
  }
  try { await chrome.bookmarks.removeTree(folder.id); } catch (e) {} // clear after restoring
  dbg("carryback: restored + cleared " + opened + " window(s)");
}

// ---------------- boot ----------------

if (chrome.alarms) {
  chrome.alarms.create("keepalive", { periodInMinutes: 0.5 }); // backstop if the worker ever dies
  chrome.alarms.onAlarm.addListener(() => { startKeepAlive(); pollLoop(); });
}
// On a real browser STARTUP (not a worker resurrection): boot, then in the NORMAL profile open the staged
// carry-back windows alongside the user's own session-resume and clear them.
chrome.runtime.onStartup.addListener(async () => { await boot(); if (PROFILE_ROLE === "normal") { await stageCarryback(); await restoreCarryback(); } });
chrome.runtime.onInstalled.addListener(() => boot());

// boot() runs at most ONCE per worker (single-flight): it's called from the bare invocation below AND
// onStartup AND onInstalled, which would otherwise run loadConfig/ensureToken/resolveProfileRole/pollLoop
// concurrently and race (notably the one-shot /profile-role query — see resolveProfileRole).
let bootPromise = null;
function boot() { if (!bootPromise) bootPromise = doBoot(); return bootPromise; }
async function doBoot() {
  startKeepAlive();
  await loadConfig();
  await ensureToken();
  await resolveProfileRole();
  await initWinTabs();
  recheckCloses("boot"); // a resurrected worker finishes any acked close it lost mid-retry
  pollLoop();
  // NORMAL profile: surface any windows closed while it was offline as bookmarks now (no windows opened
  // here — restoreCarryback on a real startup does that). Idempotent: the wrapper queue drain is one-shot.
  if (PROFILE_ROLE === "normal") await stageCarryback();
}
boot();
