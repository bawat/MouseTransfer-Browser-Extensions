// GENERATED from src/background.js by tools/build.mjs. Do not edit this copy: edit src/ and run
// `node tools/build.mjs` (CI/tests run `node tools/build.mjs --check`). See README.md.

// Cross-engine shim: point `chrome` at the promise-based `browser` namespace so the identical
// promise/await code below runs unchanged. REQUIRED on Firefox, whose `chrome.*` alias is
// callback-style. On Safari it is a harmless normalization rather than a requirement: per Apple,
// "Safari web extensions support both the `chrome.*` and `browser.*` namespaces" and "both the
// callback and `Promise` approaches for asynchronous APIs"
// (https://developer.apple.com/documentation/safariservices/assessing-your-safari-web-extension-s-browser-compatibility)
// — we still normalize onto `browser` so all three builds execute the same object paths.
// No-op on Chromium (no `browser` global).
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

// ---------------- the bridge's address ----------------
//
// The wrapper's loopback bridge moved from port 24812 to 24817 (wrapper WP-1.4,
// internal/browserlink DefaultPort): 24812 is also the wrapper's audio port, and on Linux/BSD the
// two could not both bind it. For one release window a Windows wrapper ALSO serves the bridge on
// 127.0.0.1:24812; a POSIX wrapper never does (there 24812 is the audio listener, which speaks
// TLS, so a plain-HTTP request to it fails). The wrapper's rollout matrix
// (internal/browserlink/server.go, bridgeListenAddrs):
//
//   wrapper \ extension | this extension (24817, falls back to 24812) | older extension (24812 only)
//   NEW wrapper, Windows | connects on 24817                            | connects on the 24812 legacy listener
//   NEW wrapper, POSIX   | connects on 24817                            | (no shipped case)
//   OLD wrapper, Windows | connects on the 24812 fallback               | connects on 24812
//
// So with NO user-set endpoint we try 24817 first and 24812 second. A user-set endpoint (Options)
// is used exactly as given: never rewritten, never swapped for another port.
const DEFAULT_ENDPOINT = "http://127.0.0.1:24817";
const LEGACY_ENDPOINT = "http://127.0.0.1:24812";
// The pause between two bridge probes (and the poll loop's wait after a failed one). Every switch
// between the two ports goes through it, so two refusing ports can never become a tight loop.
// Same value as the poll loop's existing retry pause.
const BRIDGE_RETRY_MS = 2000;
// A probe that gets no answer is abandoned after this long. A loopback /hello answers at once; a
// port that accepts the connection but never answers HTTP (a TLS listener) must not hold us.
const BRIDGE_PROBE_TIMEOUT_MS = 3000;

// cfg.endpoint is the USER's endpoint, "" when they set none (then the defaults above apply).
// cfg.clientId names THIS install (this browser profile) to the bridge: several browsers or
// profiles can run the extension against one bridge, and the bridge needs to tell them apart
// (per-client queues, which browser gets an incoming teleport). Random, made once per profile and
// kept in storage.local; sent as the "client" query parameter on every bridge request. A bridge
// that does not know the parameter ignores it.
let cfg = { endpoint: "", token: "", clientId: "" };

// bridge is where requests go now. base = the endpoint that last answered /hello (or the first
// candidate before anything has); stale = a request to base failed to connect, so the next
// ensureBridge() re-probes; next = which candidate the next probe tries; notBefore = the earliest
// time of the next probe; probing = the probe in flight (shared by concurrent callers).
// Starts stale, so each worker confirms its base once before using it (a stored token says nothing
// about which port the wrapper serves today).
const bridge = { base: DEFAULT_ENDPOINT, stale: true, next: 0, notBefore: 0, probing: null };

function bridgeCandidates() { return cfg.endpoint ? [cfg.endpoint] : [DEFAULT_ENDPOINT, LEGACY_ENDPOINT]; }
function normEndpoint(e) { return ((e || "") + "").trim().replace(/\/+$/, ""); }

// moveId -> source tabId, so an incoming ack closes exactly the tab we teleported.
const pendingClose = new Map();

// ---------------- config ----------------

// loadConfig reads the user's endpoint and the token. MIGRATION: up to 2.17 every install wrote the
// then-default endpoint (24812) into storage the first time it fetched a token, so a stored
// LEGACY_ENDPOINT is not a user choice — it is removed, and the install behaves as "no endpoint set"
// (24817 first, 24812 second). Any other stored value is the user's and is kept as is. A stored
// value equal to DEFAULT_ENDPOINT is treated as "no endpoint set" too (Options saved the default).
async function loadConfig() {
  let local = {};
  try { local = (await chrome.storage.local.get(["endpoint", "token", "clientId"])) || {}; }
  catch (e) { dbg("config: storage.local.get failed: " + e); }
  let ep = normEndpoint(local.endpoint);
  if (ep === LEGACY_ENDPOINT) {
    try { await chrome.storage.local.remove("endpoint"); } catch (e) {}
    console.log("Teleporter: forgot the stored pre-2.18 default endpoint " + LEGACY_ENDPOINT);
    ep = "";
  }
  if (ep === DEFAULT_ENDPOINT) ep = "";
  if (ep !== cfg.endpoint) {
    cfg.endpoint = ep;
    bridge.base = bridgeCandidates()[0];
    bridge.next = 0;
    bridge.stale = true;
    bridge.notBefore = 0;
  }
  cfg.token = local.token || "";
  if (!cfg.clientId) {
    cfg.clientId = (typeof local.clientId === "string" && local.clientId) || crypto.randomUUID();
    if (local.clientId !== cfg.clientId) await storageSet("local", { clientId: cfg.clientId }, "client id");
  }
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.endpoint || changes.token)) loadConfig();
});

// ensureBridge makes sure we have a token and (with no user-set endpoint) a base that answers. It
// auto-fetches the per-install token from the local Merged bridge so the user never has to paste
// it. /hello only answers our extension (it requires the custom X-Teleport-Client header, which a
// web page can't send without a CORS preflight the bridge refuses; our host_permissions for
// 127.0.0.1 let us send it directly). If this can't reach the bridge, the user can still set the
// token manually in Options.
// Fixed protocol token the bridge's /hello requires (NOT the extension id — so it works
// whether we're load-unpacked or Web-Store-published with a store-assigned id).
const HELLO_CLIENT = "merged-tab-teleporter";
// When this worker started — used to ignore a stale "reload" right after we just reloaded
// (prevents a reload loop if the command is redelivered to the fresh worker).
const STARTED_AT = Date.now();
function bridgeNeedsProbe() { return !cfg.token || (!cfg.endpoint && bridge.stale); }
// ensureBridge probes at most ONE candidate per call and at most one per BRIDGE_RETRY_MS overall;
// it returns false at once while that pause is running. Concurrent callers share one probe.
// With {tryAll: true} (boot) it keeps going — pausing BRIDGE_RETRY_MS between probes — until every
// candidate has had one try, so a worker that boots against an old wrapper reaches 24812 before it
// asks the bridge anything else.
async function ensureBridge(opts) {
  const tries = opts && opts.tryAll ? bridgeCandidates().length : 1;
  for (let i = 0; i < tries; i++) {
    if (!bridgeNeedsProbe()) return true;
    if (!bridge.probing) {
      const wait = bridge.notBefore - Date.now();
      if (wait > 0) {
        if (!(opts && opts.tryAll)) return false;
        await sleep(wait);
        if (!bridgeNeedsProbe()) return true;
      }
    }
    if (!bridge.probing) bridge.probing = probeBridge().finally(() => { bridge.probing = null; });
    if (await bridge.probing) return true;
  }
  return !bridgeNeedsProbe();
}
async function probeBridge() {
  const cands = bridgeCandidates();
  const idx = bridge.next % cands.length;
  const base = cands[idx];
  let token = "";
  const ac = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ac ? setTimeout(() => ac.abort(), BRIDGE_PROBE_TIMEOUT_MS) : null;
  try {
    const res = await fetch(`${base}/hello` + (cfg.clientId ? "?client=" + encodeURIComponent(cfg.clientId) : ""), {
      method: "POST",
      headers: { "X-Teleport-Client": HELLO_CLIENT },
      signal: ac ? ac.signal : undefined,
    });
    if (res.ok) {
      const j = await res.json();
      if (j && j.token) token = String(j.token);
    }
  } catch (e) { /* refused, timed out, or not the bridge (e.g. the TLS audio port) */ }
  if (timer) clearTimeout(timer);
  if (!token) {
    // Not the bridge (or not up yet): the next probe tries the next candidate, after the pause.
    bridge.next = (idx + 1) % cands.length;
    bridge.notBefore = Date.now() + BRIDGE_RETRY_MS;
    return false;
  }
  const moved = bridge.base !== base;
  bridge.base = base;
  bridge.stale = false;
  bridge.next = 0; // a later re-probe starts again from the preferred port
  // The bridge's /hello is the authority on the token: adopt it when we have none, AND when ours
  // differs (the wrapper's token changed; ours would only earn 403s).
  if (cfg.token !== token) {
    const changed = !!cfg.token;
    cfg.token = token;
    if (changed) dbg("bridge: token changed — adopted the bridge's current token");
    await storageSet("local", { token }, "token"); // the token only: storing the endpoint is what pinned old installs to 24812
    console.log("Teleporter: auto-configured from the Merged bridge at " + base);
  }
  if (moved || base !== cands[0]) dbg("bridge: using " + base + (base === LEGACY_ENDPOINT ? " (legacy port — an older wrapper)" : ""));
  return true;
}

function q(path) {
  return `${bridge.base}${path}?token=${encodeURIComponent(cfg.token)}` + (cfg.clientId ? "&client=" + encodeURIComponent(cfg.clientId) : "");
}

// bridgeFetch is every request to the bridge except the /hello probe. A request that cannot
// CONNECT (fetch rejects) marks the base stale, so the next ensureBridge() — the poll loop calls
// it every turn — finds the port that answers now. An HTTP error status is an answer from the
// bridge and changes nothing. A user-set endpoint is never re-probed (there is nothing else to try).
// The fetch starts synchronously, before the first await (sendCarryback relies on that).
// A 403 is the bridge saying our TOKEN is wrong (its token changed: a reinstall, a new profile of
// the wrapper). Every authenticated bridge handler answers a bad token with 403 "bad token", so the
// token is dropped (here and in storage) and the next ensureBridge() fetches the current one — the
// poll loop's pause paces that, so a bridge that keeps refusing cannot cause a tight loop. Only the
// token the request USED is dropped: a request still in flight with an old token must not throw
// away a new one fetched meanwhile.
async function bridgeFetch(path, init, extraQuery) {
  const usedToken = cfg.token;
  let res;
  try {
    res = await fetch(q(path) + (extraQuery || ""), init);
  } catch (e) {
    if (!cfg.endpoint) bridge.stale = true;
    throw e;
  }
  if (res.status === 403 && usedToken && cfg.token === usedToken) dropToken(path);
  return res;
}
function dropToken(path) {
  dbg("bridge: token rejected (403 on " + path + ") — fetching the current one");
  cfg.token = "";
  bridge.notBefore = Date.now() + BRIDGE_RETRY_MS; // the re-probe waits the usual pause, whoever triggers it
  try { chrome.storage.local.remove("token").catch((e) => dbg("storage.local.remove(token) failed: " + e)); }
  catch (e) { dbg("storage.local.remove(token) threw: " + e); }
}

// ---------------- transport ----------------

async function sendEnvelope(env) {
  if (bridgeNeedsProbe()) await ensureBridge();
  if (!cfg.token) { console.warn("Teleporter: no token (is merged running?)"); return false; }
  try {
    const res = await bridgeFetch("/send", {
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
    if (bridgeNeedsProbe() && !(await ensureBridge())) { await sleep(BRIDGE_RETRY_MS); continue; }
    // TRANSPORT: only the request and its body. A failure here is "bridge down / not answering"
    // and keeps its backoff.
    let env;
    try {
      const askedAt = Date.now();
      const res = await bridgeFetch("/events");
      if (res.status === 200) {
        env = await res.json();
      } else if (res.status === 403) {
        // bridgeFetch has dropped the rejected token; the next turn re-probes for the current one.
        await sleep(BRIDGE_RETRY_MS);
        continue;
      } else if (res.status !== 204) {
        await sleep(2000);
        continue;
      } else {
        // A 204 is the bridge's idle timeout and normally arrives after a long hold. One that
        // comes back at once means the bridge is not holding the request, and re-asking with no
        // pause would be a tight loop.
        if (Date.now() - askedAt < 1000) await sleep(1000);
        continue;
      }
    } catch (e) {
      await sleep(3000); // bridge down; back off and retry
      continue;
    }
    // HANDLER: a failure here says nothing about the bridge. Report it and poll again at once (the
    // bridge has already handed this envelope over, so nothing is gained by waiting).
    try {
      await handleEnvelope(env);
    } catch (e) {
      dbg("handler failed: kind=" + (env && env.kind) + (env && env.moveId ? " moveId=" + env.moveId : "") + ": " + (e && e.stack ? String(e.stack).split("\n").slice(0, 3).join(" | ") : e));
    }
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------------- capture (this machine -> peer) ----------------

function isYouTube(url) {
  return url.includes("youtube.com/watch") || url.includes("youtu.be/");
}

// For YouTube the &t= param is the most reliable restore, so bake the time into the URL.
// The query ends at a #fragment, so the fragment is set aside first: otherwise the time landed
// INSIDE the fragment (".../watch?v=X#comments&t=95s", which YouTube ignores) and an existing
// "t=30" right before the "#" was not recognised and stayed.
function bakeYouTubeTime(url, seconds) {
  const hash = url.indexOf("#");
  const frag = hash >= 0 ? url.slice(hash) : "";
  url = hash >= 0 ? url.slice(0, hash) : url;
  url = url.replace(/([?&])t=\d+s?(&|$)/, "$1").replace(/[?&]$/, "");
  return url + (url.includes("?") ? "&" : "?") + `t=${Math.floor(seconds)}s` + frag;
}

// A frame is named across machines by its URL without query or fragment (origin + pathname: an
// embedded player's own page, e.g. https://www.youtube-nocookie.com/embed/ID). readPageState and
// restorePageState each compute it themselves: they run inside the PAGE, where nothing from this
// file is in scope.

// Injected into EVERY frame of the tab (allFrames) to read restorable state. Runs in the page.
// The video reported for a frame is a PLAYING one if there is one (an advert that has stopped
// loses to the film), else the first with a position.
function readPageState() {
  let video = null;
  try {
    for (const v of document.querySelectorAll("video")) {
      if (!(v.currentTime > 0)) continue;
      if (!video || (video.paused && !v.paused)) video = { time: v.currentTime, paused: v.paused };
    }
  } catch (e) {}
  let frame = "";
  try { frame = location.origin + location.pathname; } catch (e) {}
  return { top: window === window.top, frame, scrollX: window.scrollX || 0, scrollY: window.scrollY || 0, video };
}

// CAPTURE_INJECT_TIMEOUT_MS bounds the wait for one tab's state. The injected function is trivial,
// so a tab that has not answered by then is hung, busy or still loading (executeScript waits for
// the document to be ready), and the tab goes as URL-only. 1 s is half of the wrapper's 2 s grace
// before it starts force-closing a teleported-away source window on close-confirm browsers
// (cmd/filedrag_windows.go watchDoomedSourceClose), so a capture that hits the timeout still has
// time to be sent. Tabs are captured concurrently, so this is also the bound for a whole window.
const CAPTURE_INJECT_TIMEOUT_MS = 1000;

function withTimeout(promise, ms, what) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(what + ": no answer within " + ms + " ms")), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// captureTab snapshots one tab into a transferable payload (url + restore hints), or null for a
// non-http(s) tab (e.g. chrome://, where we can't inject and that wouldn't restore). Any failure to
// read the page — refused injection, timeout, a discarded tab — still sends the URL.
// A DISCARDED tab is not injected at all: measured 2026-11-22 (headless Edge 125 probe), executeScript
// on a discarded tab rejects at once ("Cannot access contents of the page") without reloading it,
// so asking would only add a failed call; other engines were not measured, and skipping covers them.
async function captureTab(tab) {
  if (!tab || !isWebUrl(tab.url)) return null;
  let frames = [];
  if (!tab.discarded) {
    try {
      const out = await withTimeout(
        chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: readPageState }),
        CAPTURE_INJECT_TIMEOUT_MS, "capture tab " + tab.id);
      if (Array.isArray(out)) frames = out.filter((r) => r && r.result).map((r) => Object.assign({}, r.result, { top: r.frameId === 0 || !!r.result.top }));
    } catch (e) { dbg("capture: tab " + tab.id + " sent as URL only (" + (e && e.message ? e.message : e) + ")"); }
  }
  const top = frames.find((f) => f.top) || { scrollX: 0, scrollY: 0 };
  // The video to carry: a playing one beats a paused one, and the top frame wins a tie.
  const vids = frames.filter((f) => f.video);
  const vf = vids.find((f) => !f.video.paused && f.top) || vids.find((f) => !f.video.paused) || vids.find((f) => f.top) || vids[0] || null;
  const videoTime = vf ? vf.video.time : 0;
  let url = tab.url;
  if (videoTime > 0 && vf.top && isYouTube(url)) url = bakeYouTubeTime(url, videoTime);
  const out = { url, active: !!tab.active, scrollX: top.scrollX || 0, scrollY: top.scrollY || 0, videoTime };
  if (vf && !vf.top && vf.frame) out.videoFrame = vf.frame; // absent = the video is in the top frame
  return out;
}

// ---- durable pending-close registry ----
// pendingClose alone is IN-MEMORY: if the MV3 worker suspends mid closeWhenPossible retry loop
// (or between the send and the ack), the close is orphaned FOREVER — the acked, already-teleported
// source window then lingers where its drag ended (the "chrome tab left at the seam edge" report,
// 2026-07-03). Mirror every pending close to chrome.storage.session (acked flag included) so a
// resurrected worker — or a "recheck-closes" nudge from the wrapper, which watches the doomed
// window by hwnd — can re-drive it to completion.
//
// Every update is a read-modify-write of ONE storage key, so updates are SERIALISED through pcChain:
// two unordered updates (an ack's pcMark racing a pcDel, say) would otherwise each read the same
// old map and the second write would silently undo the first. Reads go through the same chain, so
// a read sees every update queued before it. A failed storage call is reported with dbg, never
// thrown into the caller.
let pcChain = Promise.resolve();
async function pcLoadNow() {
  try { const s = await chrome.storage.session.get("mtPendClose"); return (s && s.mtPendClose) || {}; }
  catch (e) { dbg("pending-close registry: read failed: " + e); return {}; }
}
function pcQueue(op) { const p = pcChain.then(op); pcChain = p.catch(() => {}); return p; }
function pcLoad() { return pcQueue(pcLoadNow); }
// pcUpdate runs fn(map) in the queue; fn returns false when it changed nothing (skip the write).
function pcUpdate(fn) {
  return pcQueue(async () => {
    const m = await pcLoadNow();
    if (fn(m) === false) return;
    try { await chrome.storage.session.set({ mtPendClose: m }); }
    catch (e) { dbg("pending-close registry: write failed: " + e); }
  });
}
function pcSet(moveId, entry) { return pcUpdate((m) => { m[moveId] = entry; }); }
function pcMark(moveId, patch) { return pcUpdate((m) => { if (!m[moveId]) return false; Object.assign(m[moveId], patch); }); }
function pcDel(moveId) { return pcUpdate((m) => { if (!(moveId in m)) return false; delete m[moveId]; }); }

// storageSet writes to storage.local/session without letting a rejection escape unhandled (an
// un-awaited set() inside try/catch catches nothing: the failure arrives later, as a rejection).
function storageSet(area, items, what) {
  try {
    return chrome.storage[area].set(items).catch((e) => dbg("storage." + area + ".set failed (" + what + "): " + e));
  } catch (e) {
    dbg("storage." + area + ".set threw (" + what + "): " + e);
    return Promise.resolve();
  }
}
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
  if (tab && tab.incognito) { dbg("teleport: refusing a private/incognito tab"); return; }
  const t = await captureTab(tab);
  if (!t) { console.warn("Teleporter: only http(s) tabs can be teleported"); return; }
  const moveId = crypto.randomUUID();
  // url = the page as it was when sent: if the tab has navigated elsewhere by the time the ack
  // arrives, it is a different page the user is now using, and it is kept (see closeWhenPossible).
  const entry = { type: "tab", id: tab.id, url: tab.url, acked: false };
  pendingClose.set(moveId, entry);
  await pcSet(moveId, entry);
  const ok = await sendEnvelope({ v: 1, kind: "open", moveId, tabs: [t] });
  if (!ok) { pendingClose.delete(moveId); pcDel(moveId); }
  else console.log("Teleporter: sent tab", t.url);
}

// findWindowByPxRect matches one of our windows to a screen-pixel rect the wrapper measured
// (Win32, px), trying each standard Windows scale factor (Settings > Display offers 100-250%)
// to map px -> our DIP bounds. Returns null when nothing is plausibly close — the caller must
// then ABORT rather than guess.
// allowLone=false forbids the single-window fallback below (capture-window "lone": false).
async function findWindowByPxRect(wl, wt, ww, wh, allowLone = true) {
  let wins = [];
  try { wins = await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] }); } catch (e) { return null; }
  // Ignore DEGENERATE zero-size windows: a real dragged top-level window always has a positive
  // width/height, and some skinned forks (QQ Browser) split a multi-URL launch into the visible
  // window PLUS a phantom 0x0 window holding the remaining tabs (rig-observed 2026-07-13: a 3-tab
  // launch became #A[150,110,1000x700 tabs=1] + #B[52,52,0x0 tabs=2]). Counting that 0x0 window as a
  // real candidate makes normals.length===2, which defeats BOTH the strict rect match (its bounds
  // match nothing) AND the single-window fallback below (which needs exactly one), so the whole-window
  // capture aborts. A 0x0 window is never what the user dragged — drop it so the visible window is the
  // lone candidate and the fallback can capture it.
  const real = wins.filter(w => typeof w.left === "number" && w.width > 0 && w.height > 0);
  // NEVER capture an incognito/private window. The manifest keeps the extension out of incognito
  // where the engine supports that (Chrome, Firefox: "incognito": "not_allowed"), so such windows
  // are not even listed there; Safari has no "not_allowed" and lists them (spanning mode), so this
  // filter is what stops them there.
  const normals = real.filter(w => !w.incognito);
  // Instrumentation (surfaces into the wrapper's btrace via /debug): the wrapper measured
  // wl,wt,ww,wh from Win32 GetWindowRect of the dragged top-level window. Log every candidate's
  // chrome.windows bounds so a QQ-vs-360-vs-Chrome frame-bounds divergence is READABLE from a single
  // trace line. For stock Chromium frames (Chrome/Edge) AND 360 Safe's custom `360se6_Frame`,
  // chrome.windows bounds == GetWindowRect (bestD≈0). QQ Browser's skinned `QQBrowser_WidgetWin_1`
  // frame reports chrome.windows bounds that STATICALLY diverge from GetWindowRect (~the skin/panel
  // offset), so bestD lands ~389-409 even AT REST and with a REAL physical mouse — proven by 360
  // teleporting cleanly on the identical physical gesture while QQ aborts (which rules out the older
  // "the post-cross warp drags the still-held window off the latched rect" theory: 360's window warps
  // the same and still matches). See the single-window fallback below.
  dbg("capture-window: want(px)=" + wl + "," + wt + "," + ww + "," + wh + " candidates=" +
      (normals.map(w => "#" + w.id + "[" + w.left + "," + w.top + "," + w.width + "," + w.height +
        " tabs=" + (w.tabs ? w.tabs.length : 0) + "]").join(" ") || "(none)"));
  let best = null, bestD = Infinity;
  for (const s of [1, 1.25, 1.5, 1.75, 2, 2.25, 2.5]) {
    const want = { left: wl / s, top: wt / s, width: ww / s, height: wh / s };
    for (const w of normals) {
      const d = Math.abs(w.left - want.left) + Math.abs(w.top - want.top) + Math.abs(w.width - want.width) + Math.abs(w.height - want.height);
      if (d < bestD) { bestD = d; best = w; }
    }
  }
  if (best && bestD <= 200) {
    dbg("capture-window: matched window #" + best.id + " (" + (best.tabs ? best.tabs.length : 0) + " tabs, bestD=" + Math.round(bestD) + ")");
    return best;
  }
  // Strict rect match FAILED. The rect is ONLY EVER a disambiguator among multiple windows — when
  // this browser has exactly ONE normal window there is nothing to disambiguate, so a frame whose
  // chrome.windows bounds statically diverge from GetWindowRect (QQ) still resolves unambiguously to
  // that one window. This is NOT a tolerance bump: the ≤200 gate above is untouched, so multi-window
  // matching stays strict (a wrong-window grab remains impossible) and the Chrome/Edge/360 fast path
  // is byte-identical (their single window already matches at bestD≈0, never reaching here). The
  // wrapper pushes capture-window ONLY on a CONFIRMED browser-window seam crossing, so the lone
  // window IS the one the user dragged; capturing it is the intended whole-window teleport.
  // The fallback needs the lone window to be the ONLY window we can see: a visible private window
  // beside it (Safari) means the user may have dragged that one. And it is off altogether when the
  // wrapper says so (lone:false — a stock-frame browser, whose bounds always match when the window
  // is ours: a miss there means the dragged window is one we cannot see, e.g. incognito on Chrome).
  if (!allowLone && normals.length === 1) {
    dbg("capture-window: strict rect match failed (bestD=" + Math.round(bestD) + ") and the single-window fallback is off (lone:false) — ABORTING");
    return null;
  }
  if (normals.length === 1 && real.length === 1) {
    dbg("capture-window: strict rect match failed (bestD=" + Math.round(bestD) + ") but exactly ONE window exists — capturing it (custom-frame bounds divergence, e.g. QQ) window #" +
        normals[0].id + " bounds=" + normals[0].left + "," + normals[0].top + "," + normals[0].width + "," + normals[0].height);
    return normals[0];
  }
  dbg("capture-window: no window matches the dragged rect (bestD=" + Math.round(bestD) + "; " + normals.length + " candidate windows — cannot disambiguate a divergent-frame browser with multiple open windows)");
  return null;
}

// teleportFocusedWindow sends EVERY http(s) tab of the dragged window as one window-move.
// Invoked when Merged reports a Chrome window was dragged across the seam (capture-window).
// The wrapper includes the dragged window's on-screen rect; capture THAT window, matched by
// bounds — NOT getLastFocused: this worker can be slow/cold, and by the time it runs the
// source drag may have ended (or a tear been reverted), moving focus — focus-based capture
// then teleported AND CLOSED the whole original window or a completely unrelated one (the
// 2026-07-03 YouTube-tab reports). No bounds match -> ABORT: better no teleport (the window
// just stays put) than the wrong window leaving the machine.
// There is NO focus-based fallback any more, not even for an envelope without a rect: the only
// sender (the wrapper's teleportFocusedBrowserWindow) has put wl/wt/ww/wh in every capture-window
// since 2026-07-03, so a rect-less envelope can only be malformed or from a wrapper older than
// that — and focus capture is exactly the thing that closed the wrong window.
function hasUsableRect(env) {
  return !!env && ["wl", "wt", "ww", "wh"].every((k) => typeof env[k] === "number" && isFinite(env[k])) && env.ww > 0 && env.wh > 0;
}
async function teleportFocusedWindow(env) {
  if (!hasUsableRect(env)) {
    dbg("capture-window: no usable rect (wl=" + (env && env.wl) + " wt=" + (env && env.wt) + " ww=" + (env && env.ww) + " wh=" + (env && env.wh) + ") — ABORTING (never guess by focus)");
    return;
  }
  const win = await findWindowByPxRect(env.wl, env.wt, env.ww, env.wh, env.lone !== false);
  if (!win) { dbg("capture-window: ABORTING teleport — dragged window not found (drag reverted/closed?)"); return; }
  if (!win.tabs || !win.tabs.length) return;
  // All tabs at once (each bounded by CAPTURE_INJECT_TIMEOUT_MS); Promise.all keeps the window's
  // tab order in the envelope.
  const caps = await Promise.all(win.tabs.map((tab) => captureTab(tab)));
  const tabs = caps.filter(Boolean);
  if (!tabs.length) { console.warn("Teleporter: no http(s) tabs in the dragged window"); return; }
  const moveId = crypto.randomUUID();
  // The close after the ack removes ONLY the tabs sent here (plus blank new-tab pages) — never a
  // chrome:// page, a local file, an extension page or a tab opened after this moment.
  const sent = win.tabs.filter((tab, i) => caps[i]).map((tab) => ({ id: tab.id, url: tab.url }));
  const kept = win.tabs.filter((tab, i) => !caps[i] && !isBlankTabUrl(tab.url || tab.pendingUrl)).length;
  const cid = env.cid === undefined ? null : env.cid;
  const entry = { type: "window", id: win.id, tabs: sent, cid, acked: false };
  pendingClose.set(moveId, entry);
  await pcSet(moveId, entry);
  // Tell the wrapper BEFORE the open goes out that this window will survive the teleport, so it
  // does not force-close it (it does that for close-confirm browsers). Optional endpoint.
  if (kept > 0) reportSourceKept({ phase: "captured", moveId, cid, sent: sent.length, kept });
  const ok = await sendEnvelope({ v: 1, kind: "open", moveId, asWindow: true, tabs });
  if (!ok) { pendingClose.delete(moveId); pcDel(moveId); }
  else console.log("Teleporter: sent window with", tabs.length, "tab(s)");
}

// ---------------- receive (peer -> this machine) ----------------

// RESTORE_SCROLL_WINDOW_MS bounds how long the restore keeps re-applying the scroll position. A
// page built by script is often still growing when it reports "complete", so a single scrollTo is
// clamped short of the target; re-trying every RESTORE_SCROLL_STEP_MS until the position is reached
// (or this window ends) lands it. Chosen, not sourced: no standard says how long a page keeps
// growing; 3 s covers a page's own post-load rendering without fighting the user for long.
const RESTORE_SCROLL_WINDOW_MS = 3000;
const RESTORE_SCROLL_STEP_MS = 100;

// Injected into EVERY frame of the new tab (allFrames) once it has loaded. Runs in the page.
// Video: with state.videoFrame (the sender found the video in an embedded frame) only a frame whose
// URL minus query/fragment equals it seeks — an advert in another frame is never touched; without
// it (the video was in the top frame, or an older sender) only the top frame seeks, as before.
// Scroll: top frame only, re-applied until reached or the window ends.
function restorePageState(state) {
  const isTop = window === window.top;
  try {
    if (state.videoTime > 0) {
      let frame = "";
      try { frame = location.origin + location.pathname; } catch (e) {}
      const mine = state.videoFrame ? (!isTop && frame === state.videoFrame) : isTop;
      if (mine) {
        const v = document.querySelector("video");
        if (v) { try { v.currentTime = state.videoTime; } catch (e) {} }
      }
    }
  } catch (e) {}
  if (!isTop || !(state.scrollX || state.scrollY)) return;
  const x = state.scrollX || 0, y = state.scrollY || 0;
  const deadline = Date.now() + (state.windowMs || 0);
  return new Promise((resolve) => {
    const step = () => {
      try { window.scrollTo(x, y); } catch (e) { resolve(false); return; }
      if ((Math.abs((window.scrollX || 0) - x) <= 1 && Math.abs((window.scrollY || 0) - y) <= 1)) { resolve(true); return; }
      if (Date.now() >= deadline) { resolve(false); return; }
      setTimeout(step, state.stepMs || 100);
    };
    step();
  });
}

// scheduleRestore re-applies a tab's scroll/video state once it has loaded, independently of the
// ack (so the source side never waits on it). It listens for "complete" AND checks the tab's
// current status, because a tab that is already complete (an adopted cold-launch tab, a fast page)
// sends no further "complete" — listening alone missed it. The listener goes first so a "complete"
// landing between the two cannot fall through the gap; the restore runs once either way.
function scheduleRestore(tabId, t) {
  if (!tabId || !(t.scrollX || t.scrollY || t.videoTime)) return;
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    chrome.tabs.onUpdated.removeListener(onUpdated);
    clearTimeout(stop);
    const state = { scrollX: t.scrollX || 0, scrollY: t.scrollY || 0, videoTime: t.videoTime || 0,
      videoFrame: typeof t.videoFrame === "string" ? t.videoFrame : "", windowMs: RESTORE_SCROLL_WINDOW_MS, stepMs: RESTORE_SCROLL_STEP_MS };
    chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: restorePageState, args: [state] }).catch(() => {});
  };
  const onUpdated = (id, info) => { if (id === tabId && info.status === "complete") run(); };
  chrome.tabs.onUpdated.addListener(onUpdated);
  const stop = setTimeout(() => chrome.tabs.onUpdated.removeListener(onUpdated), 20000); // stop listening eventually
  chrome.tabs.get(tabId).then((tab) => { if (tab && tab.status === "complete" && isWebUrl(tab.url)) run(); }, () => {});
}

// isWebUrl reports whether u parses as an absolute http: or https: URL (a real parse, so
// " javascript:…", "HTTP:" spellings and relative junk are judged as the browser would judge them).
function isWebUrl(u) {
  if (typeof u !== "string" || !u) return false;
  try { const p = new URL(u); return p.protocol === "http:" || p.protocol === "https:"; } catch (e) { return false; }
}
// urlScheme names a URL's scheme for a log line without revealing the rest of it.
function urlScheme(u) {
  if (typeof u !== "string" || !u) return "(empty)";
  try { return new URL(u).protocol; } catch (e) { return "(unparsable)"; }
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
    const res = await bridgeFetch("/coldlaunch");
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
  storageSet("session", { mtTeleWin: lastTeleportWin }, "teleport window");
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
  // Safari cannot merge: `tabs.move` is unsupported there (Apple, "Assessing your Safari web
  // extension's browser compatibility": "tabs.move — Not supported."; MDN BCD safari:false agrees).
  // Leave the teleported window standalone — the documented any-miss fallback, never a lost tab.
  if (!chrome.tabs.move) { dbg("merge-drop: tabs.move unsupported on this browser — leaving standalone window"); return; }
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
      bridgeFetch("/teleport-window", undefined, "&left=" + Math.round(w.left) + "&top=" + Math.round(w.top) +
        "&width=" + Math.round(w.width) + "&height=" + Math.round(w.height)).catch(() => {});
    }
  } catch (e) { /* best-effort */ }
}

// dbg surfaces a diagnostic line into the wrapper's btrace log (POST /debug) so we can see the
// extension's own view of the windows from a remote machine. Best-effort; the wrapper logs it only when
// its browser-teleport trace toggle is on.
function dbg(m) { try { bridgeFetch("/debug", { method: "POST", body: String(m) }).catch(() => {}); } catch (e) {} }

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
    // Open ONLY http(s) pages. A sender captures nothing else, so anything else in an envelope is
    // malformed or hostile (file://, chrome://, javascript:, data: …) and is dropped here, before
    // ANY path below (adopt, create, single tab) can see it. Nothing survives -> no ack, so the
    // sender keeps its tabs.
    const all = Array.isArray(env.tabs) ? env.tabs : [];
    const tabs = all.filter((t) => t && isWebUrl(t.url));
    if (tabs.length < all.length) {
      const schemes = all.filter((t) => !(t && isWebUrl(t.url))).map((t) => urlScheme(t && t.url));
      dbg("open " + env.moveId + ": dropped " + (all.length - tabs.length) + " of " + all.length + " tab(s) that are not http(s) (" + schemes.join(", ") + ")");
    }
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

// sameDoc reports whether two URLs name the same document (a #fragment change is the same page).
function sameDoc(a, b) {
  const strip = (u) => ((u || "") + "").split("#")[0];
  return strip(a) === strip(b);
}

// reportSourceKept tells the wrapper that a teleported-away source window will stay open because it
// holds tabs that were not sent (phase "captured": predicted at capture; phase "closed": what was
// actually left after the close). The wrapper watches the source window after a whole-window
// teleport and, on close-confirm browsers (360, QQ, Opera, Vivaldi), FORCE-CLOSES it after ~2 s
// (cmd/filedrag_windows.go watchDoomedSourceClose) — which would destroy the kept tabs. cid echoes
// the capture-window envelope's "cid" so the wrapper can tell which window. POST /source-kept is
// OPTIONAL: a wrapper that does not know it answers 404, which is ignored.
function reportSourceKept(info) {
  dbg("source-kept: " + info.phase + " moveId=" + info.moveId + " kept=" + info.kept + (info.sent !== undefined ? " sent=" + info.sent : ""));
  try {
    bridgeFetch("/source-kept", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(info) }).catch(() => {});
  } catch (e) {}
}

// planClose works out what is left to close for a pending-close entry, from the browser's CURRENT
// state (re-read on every attempt: tabs close, move and navigate while the close is retried).
//   { done: true }                      nothing of ours is left
//   { done: false, remove: [tabIds] }   close these (the window closes with its last tab if nothing is kept)
// and kept = the tabs that will keep the window open.
// Entries come in three shapes:
//   - window with tabs:[{id,url}] (2.19+): only those tabs (each still on the page it was sent
//     from) plus blank/new-tab pages of that window; any other tab is kept and keeps the window.
//   - window without tabs (written by an older version): every tab of the window, as before.
//   - tab: that tab, unless it has navigated to another page since it was sent (url, 2.19+).
async function planClose(target) {
  if (target.type !== "window") {
    let t;
    try { t = await chrome.tabs.get(target.id); } catch (e) { return { done: true, kept: 0 }; }
    if (target.url && !sameDoc(t.pendingUrl || t.url, target.url)) return { done: true, kept: 1, navigated: 1 };
    return { done: false, remove: [t.id], kept: 0 };
  }
  if (!Array.isArray(target.tabs)) {
    let w;
    try { w = await chrome.windows.get(target.id, { populate: true }); } catch (e) { return { done: true, kept: 0 }; }
    const ids = (w.tabs || []).map((t) => t.id);
    return ids.length ? { done: false, remove: ids, kept: 0, legacy: true } : { done: true, kept: 0 };
  }
  const mine = [];
  let navigated = 0;
  for (const c of target.tabs) {
    let t;
    try { t = await chrome.tabs.get(c.id); } catch (e) { continue; } // already gone
    if (!sameDoc(t.pendingUrl || t.url, c.url)) { navigated++; continue; } // a different page now: not ours to close
    mine.push(t.id);
  }
  let others = [];
  let windowOpen = true;
  try {
    const w = await chrome.windows.get(target.id, { populate: true });
    const ids = new Set(mine);
    others = (w.tabs || []).filter((t) => !ids.has(t.id));
  } catch (e) { windowOpen = false; }
  const blanks = others.filter((t) => isBlankTabUrl(t.url || t.pendingUrl)).map((t) => t.id);
  const kept = others.length - blanks.length;
  // Blank pages go with the window (a window that held web pages and a new-tab page still
  // disappears). Once nothing of ours is left they are closed only if they are ALL that is left.
  const remove = mine.length ? mine.concat(blanks) : (kept === 0 ? blanks : []);
  if (!remove.length) return { done: true, kept, navigated, windowOpen };
  return { done: false, remove, kept, navigated, windowOpen };
}

// closeWhenPossible removes what a teleport sent away, once the ack says it arrived and the browser
// lets us. It NEVER uses windows.remove: that is a QUIT-ALL which trips a native "Quit Opera? closing
// N tabs" modal on Opera-family (owner-observed 2026-07-14; the wrapper cannot dismiss it, since
// Opera shares Chrome's window class) — and it would also take tabs that were never sent. Instead the
// tabs to close are removed ALL-BUT-ONE in one bulk tabs.remove (a subset close is not a quit-all, so
// no modal), then the LAST; when nothing is kept the window closes with that last tab. tabs.remove is
// not gated by Brave's window-closing confirm either (rig-verified 2026-07-10 while the dialog was
// up). Two refusal shapes, both retried every 500 ms for ~15 s:
//   - remove THROWS ("Tabs cannot be edited right now"): a live tab-drag session holds Chrome's
//     move loop; it succeeds once the user releases.
//   - remove RESOLVES but the tab survives: a close-confirm interception. Progress is therefore
//     judged only by re-reading the state (planClose), never by remove's own resolution.
// The durable mtPendClose entry is cleared only once nothing of ours is left, so a worker suspended
// mid-loop is recovered by recheckCloses (boot / the wrapper's recheck-closes nudge). If the window
// stays open because it holds kept tabs, the wrapper is told (reportSourceKept) and the window is a
// normal window again (a later user close of it is carried back as usual).
async function closeWhenPossible(target, moveId) {
  if (moveId) {
    if (closingNow.has(moveId)) return; // a loop for this close is already running in this worker
    closingNow.add(moveId);
  }
  if (target.type === "window") suppressCarryback.add(target.id); // a teleport-AWAY close — don't carry it back
  const finish = (plan) => {
    if (moveId) { closingNow.delete(moveId); pcDel(moveId); }
    if (plan.navigated) dbg("close: " + plan.navigated + " sent tab(s) navigated to another page before the ack — left open");
    if (target.type === "window" && plan.windowOpen && plan.kept > 0) {
      suppressCarryback.delete(target.id);
      reportSourceKept({ phase: "closed", moveId, cid: target.cid === undefined ? null : target.cid, kept: plan.kept });
    }
  };
  for (let i = 0; i < 30; i++) { // ~15s ceiling
    let plan;
    try { plan = await planClose(target); } catch (e) { plan = null; dbg("close: could not read state for " + target.type + " " + target.id + ": " + e); }
    if (plan && plan.done) { finish(plan); return; }
    if (plan) {
      try {
        if (i < 3 || i % 5 === 0) dbg("close (attempt " + (i + 1) + "): " + target.type + " " + target.id + " — removing " + plan.remove.length + " tab(s), keeping " + plan.kept + (plan.legacy ? " (pre-2.19 entry: whole window)" : ""));
        const ids = plan.remove;
        if (ids.length > 1) await chrome.tabs.remove(ids.slice(0, -1)); // all-but-one in ONE bulk call (a subset, NOT a quit-all)
        await chrome.tabs.remove(ids[ids.length - 1]);                  // the last -> the window closes if nothing is kept
      } catch (e) {
        // Refused (may be mid tab-drag) — surface WHY into the wrapper's btrace (first few + every 5th).
        if (i < 3 || i % 5 === 0) dbg("close refused (attempt " + (i + 1) + ") for " + target.type + " " + target.id + ": " + (e && e.message ? e.message : e));
      }
      let after = null;
      try { after = await planClose(target); } catch (e) {}
      if (after && after.done) { finish(after); return; }
    }
    await sleep(500);
  }
  if (moveId) closingNow.delete(moveId); // ceiling hit — keep the durable entry so a later re-drive can finish it
  dbg("close GAVE UP after ~15s for " + target.type + " " + target.id + " (still open; awaiting a re-drive)");
}

// ---------------- focus report (which browser the user is in) ----------------
// When a normal window of this profile gains focus, tell the bridge (POST /focus, the client id in
// the query, no body), so it can deliver an incoming teleport to the browser the user is actually
// using. A burst of focus changes (Alt+Tab cycling) sends one report, for the window focused last:
// FOCUS_DEBOUNCE_MS is the same burst window the window-state push uses. Optional endpoint: a bridge
// that does not know it answers 404, which is ignored.
const FOCUS_DEBOUNCE_MS = 120;
let focusTimer = null;
let focusWinId = null;
function onFocusChangedReport(windowId) {
  const none = chrome.windows.WINDOW_ID_NONE === undefined ? -1 : chrome.windows.WINDOW_ID_NONE;
  if (typeof windowId !== "number" || windowId === none || windowId < 0) return; // focus left the browser
  focusWinId = windowId;
  clearTimeout(focusTimer);
  focusTimer = setTimeout(sendFocusReport, FOCUS_DEBOUNCE_MS);
}
async function sendFocusReport() {
  focusTimer = null;
  let w;
  try { w = await chrome.windows.get(focusWinId); } catch (e) { return; }
  if (!w || w.type !== "normal" || w.incognito) return;
  if (!cfg.token) return;
  try { bridgeFetch("/focus", { method: "POST" }).catch(() => {}); } catch (e) {}
}
chrome.windows.onFocusChanged.addListener(onFocusChangedReport);

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
//   1) a PORT LIFELINE — a runtime port this worker opens to its own extension. With another
//      extension context present the port stays open and holds the worker alive (Chrome
//      force-disconnects ports at ~5 min, so it is renewed before that). With none — the usual
//      case — the browser refuses it at once, and the lifeline is then a slow retry whose refusal
//      events are what keep the worker awake. See startLifeline for why it must never retry fast.
//   2) an AWAITED getPlatformInfo loop (every 15s) as a secondary timer-based reset.
//   3) a coarse alarm (0.5 min) that survives an actual eviction and re-enters pollLoop.
// DO NOT RECONNECT A REFUSED PORT AT ONCE (2026-11-22). A browser delivers runtime.connect only to
// OTHER contexts of the extension, never to the one that called it, and this worker is usually the
// extension's only context. So the connect below is refused on the spot and onDisconnect fires
// immediately. Reconnecting from that handler with no delay was a tight loop: measured, it held
// the BROWSER process at a full CPU core for as long as the extension ran (a probe extension with
// nothing but that code: 10.4 s of browser CPU per 10 s; without it: 0.02 s), and a browser main
// thread that busy loses mouse clicks meant for Chrome's native title-bar menu.
// A refused attempt is still an event delivered to this worker, and a delivered event is what
// resets the worker's idle timer, so retrying on a SLOW beat keeps the keep-alive effect.
const LIFELINE_RETRY_MS = 20000;   // comfortably inside the ~30s idle limit named above
const LIFELINE_REFUSED_MS = 5000;  // a port that closed sooner than this was never really open
let lifelinePort = null;
let lifelineRetry = null;
function startLifeline() {
  if (lifelinePort || lifelineRetry) return;
  const openedAt = Date.now();
  try {
    lifelinePort = chrome.runtime.connect({ name: "keepalive" });
    lifelinePort.onDisconnect.addListener(() => {
      void chrome.runtime.lastError; // swallow "port closed" / "receiving end does not exist"
      lifelinePort = null;
      if (Date.now() - openedAt >= LIFELINE_REFUSED_MS) { startLifeline(); return; } // a real lease ended: renew it
      lifelineRetry = setTimeout(() => { lifelineRetry = null; startLifeline(); }, LIFELINE_RETRY_MS);
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
function persistRole() { return storageSet("session", { mtRole: PROFILE_ROLE }, "profile role"); }
function winTabsToObj() {
  const o = {};
  for (const [wid, m] of winTabs) { o[wid] = {}; for (const [tid, url] of m) o[wid][tid] = url; }
  return o;
}
function persistWinTabs() { storageSet("session", { mtWinTabs: winTabsToObj() }, "window tabs"); }

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
    try { const res = await bridgeFetch("/profile-role"); PROFILE_ROLE = (res.ok && (await res.json()).role) || "normal"; }
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
chrome.runtime.onSuspend.addListener(() => { storageSet("session", { mtWinTabs: winTabsToObj(), mtRole: PROFILE_ROLE }, "suspend"); });
chrome.windows.onRemoved.addListener((windowId) => { onWindowClosed(windowId); });

// ---- window/tab state push (for the wrapper's Yandex drag-from-maximize tab-blacklist) ----
// The wrapper's pollMaximizeRestore needs a maximized window's tab COUNT to compute where the tab strip
// ends: a custom-frame browser (Yandex) draws an HTCLIENT title bar that can't be told from a tab by
// hit-test, so the count + the strip layout is how the wrapper knows which part of the title is a tab
// (blacklist) vs the empty caption (restore). An MV3 worker can't be polled synchronously, so we PUSH
// the state to the bridge on load and whenever it changes. Bounds are chrome.windows DIP bounds (a
// worker has no px access); the wrapper matches its px window rect tolerantly. Best-effort — a failed
// push just leaves the wrapper on its move-loop fallback.
async function emitWinState() {
  let wins;
  try { wins = await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] }); } catch (e) { return; }
  const windows = wins.map((w) => ({ l: w.left | 0, t: w.top | 0, w: w.width | 0, h: w.height | 0,
    tabs: (w.tabs ? w.tabs.length : 0) }));
  try {
    if (bridgeNeedsProbe()) await ensureBridge();
    if (!cfg.token) return;
    await bridgeFetch("/winstate", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ windows }) });
  } catch (e) {}
}
let _winStateTimer = null;
function pushWinState() { clearTimeout(_winStateTimer); _winStateTimer = setTimeout(emitWinState, 120); } // debounce a burst
chrome.tabs.onCreated.addListener(() => pushWinState());
chrome.tabs.onRemoved.addListener(() => pushWinState());
chrome.tabs.onAttached.addListener(() => pushWinState());
chrome.tabs.onDetached.addListener(() => pushWinState());
chrome.windows.onCreated.addListener(() => pushWinState());
chrome.windows.onRemoved.addListener(() => pushWinState());
chrome.windows.onFocusChanged.addListener(() => pushWinState());
if (chrome.windows.onBoundsChanged) chrome.windows.onBoundsChanged.addListener(() => pushWinState()); // newer Chromium; guarded

// onWindowClosed carries a whole closed window back to the normal profile — ONLY in the teleport profile,
// ONLY for a genuine user close (not a teleport-away), and only if it had http(s) tabs. Robust against a
// fresh (resurrected) worker: role + tabs are recovered from storage.session when the in-memory copies are
// empty (the close event woke THIS worker, so boot()/initWinTabs hasn't repopulated them yet).
async function onWindowClosed(windowId) {
  if (suppressCarryback.delete(windowId)) return;   // a teleport-away close — skip
  // FAST PATH: in-memory state present (worker alive). Closing the teleport browser's LAST window makes
  // Chrome EXIT, killing any in-flight async work — so send SYNCHRONOUSLY here, before any await, via
  // sendCarryback (a keepalive fetch, or sendBeacon where the engine has one — see sendCarryback).
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

// sendCarryback POSTs a closed window's tabs to the wrapper in a form meant to outlive the
// browser/worker teardown that closing the last window triggers (a plain fetch can be cut off).
// Which form depends on the engine, because sendBeacon exists only on a window-like Navigator:
//   - Chromium (MV3 service worker): self.navigator is a WorkerNavigator with NO sendBeacon, so it is
//     always fetch(..., {keepalive: true}). Measured 2026-11-22, headless Edge 125 probe extension:
//     typeof navigator.sendBeacon === "undefined"; the keepalive fetch arrived.
//   - Firefox (MV3 background "scripts" = an event PAGE): a window Navigator, sendBeacon present and
//     used. Measured 2026-11-22, headless Firefox 127 temporary add-on: typeof === "function",
//     it returned true and the beacon arrived.
//   - Safari (manifest background.service_worker): a service worker per spec, so expected to take the
//     keepalive path like Chromium. NOT measured (no Safari to test on).
// Neither probe measured delivery DURING a browser exit — only that each path sends.
function sendCarryback(tabs, windowId) {
  const url = q("/carryback"), body = JSON.stringify({ tabs });
  let beacon = false;
  if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
    try { beacon = navigator.sendBeacon(url, body); } catch (e) {} // false = the beacon was not queued
  }
  if (!beacon) { try { bridgeFetch("/carryback", { method: "POST", body, keepalive: true }).catch(() => {}); } catch (e) {} }
  dbg("carryback: queued closed window " + windowId + " (" + tabs.length + " tabs, via " + (beacon ? "sendBeacon" : "keepalive fetch") + ")");
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
  // Safari has NO bookmarks API (Apple's compatibility page lists no bookmarks support; MDN BCD
  // webextensions/api/bookmarks: safari version_added=false). GET /carryback-drain is ONE-SHOT and
  // destructive — draining with nowhere to stage would silently lose the windows. Without bookmarks,
  // leave the queue with the wrapper (durable in carryback.json) and open it directly on the next
  // real startup instead (restoreCarryback's direct path).
  if (!(chrome.bookmarks && chrome.bookmarks.create)) { dbg("carryback: bookmarks API unavailable — leaving queue staged in the wrapper"); return; }
  let pending = [];
  try { const res = await bridgeFetch("/carryback-drain"); pending = (res.ok && (await res.json()).windows) || []; } catch (e) { return; }
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
  // No bookmarks API (Safari): open the wrapper's queued windows DIRECTLY. This runs only on a real
  // browser startup (runtime.onStartup) — exactly when opening windows is safe. The bookmark staging
  // exists solely to bridge MID-SESSION drains to the next startup, and without bookmarks we never
  // drain mid-session (see stageCarryback), so nothing is lost by skipping the staging medium.
  if (!(chrome.bookmarks && chrome.bookmarks.getChildren)) { await openCarrybackDirect(); return; }
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
// openCarrybackDirect drains the wrapper queue and opens each carried-back window immediately —
// the bookmarks-free (Safari) restore path. Only ever called from the real-startup context above,
// so the mid-session-window-popping hazard the bookmark staging guards against cannot occur here.
async function openCarrybackDirect() {
  let pending = [];
  try { const res = await bridgeFetch("/carryback-drain"); pending = (res.ok && (await res.json()).windows) || []; } catch (e) { return; }
  if (!pending.length) return;
  let opened = 0;
  for (const win of pending) {
    const urls = (win.tabs || []).filter((u) => /^https?:/i.test(u));
    if (!urls.length) continue;
    try {
      const w = await chrome.windows.create({ url: urls[0] });
      for (let i = 1; i < urls.length; i++) await chrome.tabs.create({ windowId: w.id, url: urls[i], active: false });
      opened++;
    } catch (e) {}
  }
  dbg("carryback: opened " + opened + "/" + pending.length + " window(s) directly (no bookmarks API)");
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
// onStartup AND onInstalled, which would otherwise run loadConfig/ensureBridge/resolveProfileRole/pollLoop
// concurrently and race (notably the one-shot /profile-role query — see resolveProfileRole).
let bootPromise = null;
function boot() { if (!bootPromise) bootPromise = doBoot(); return bootPromise; }
async function doBoot() {
  startKeepAlive();
  await loadConfig();
  await ensureBridge({ tryAll: true }); // reach 24812 (an older wrapper) before asking for the profile role
  await resolveProfileRole();
  await initWinTabs();
  recheckCloses("boot"); // a resurrected worker finishes any acked close it lost mid-retry
  pollLoop();
  emitWinState(); // push the initial window/tab state so the wrapper's tab-blacklist has it before any drag
  // NORMAL profile: surface any windows closed while it was offline as bookmarks now (no windows opened
  // here — restoreCarryback on a real startup does that). Idempotent: the wrapper queue drain is one-shot.
  if (PROFILE_ROLE === "normal") await stageCarryback();
}
boot();
