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
const EXTENSION_ID = chrome.runtime.id;
async function ensureToken() {
  if (cfg.token) return true;
  try {
    const res = await fetch(`${cfg.endpoint}/hello`, {
      method: "POST",
      headers: { "X-Teleport-Client": EXTENSION_ID },
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

// Injected into the page to read restorable state.
function readPageState() {
  let videoTime = 0;
  try { const v = document.querySelector("video"); if (v && v.currentTime > 0) videoTime = v.currentTime; } catch (e) {}
  return { scrollX: window.scrollX || 0, scrollY: window.scrollY || 0, videoTime };
}

async function teleportTab(tab) {
  if (!tab || !tab.url || !/^https?:/i.test(tab.url)) {
    console.warn("Teleporter: only http(s) tabs can be teleported");
    return;
  }
  let state = { scrollX: 0, scrollY: 0, videoTime: 0 };
  try {
    const out = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readPageState });
    if (out && out[0] && out[0].result) state = out[0].result;
  } catch (e) { /* e.g. a restricted page; fall back to no state */ }

  // For YouTube the &t= param is the most reliable restore, so bake the time into the URL.
  let url = tab.url;
  if (state.videoTime > 0 && isYouTube(url)) {
    url = url.replace(/([?&])t=\d+s?(&|$)/, "$1").replace(/[?&]$/, "");
    url += (url.includes("?") ? "&" : "?") + `t=${Math.floor(state.videoTime)}s`;
  }

  const moveId = crypto.randomUUID();
  pendingClose.set(moveId, tab.id);
  const env = { v: 1, kind: "open", moveId, tabs: [{ url, active: true, scrollX: state.scrollX, scrollY: state.scrollY, videoTime: state.videoTime }] };
  const ok = await sendEnvelope(env);
  if (!ok) pendingClose.delete(moveId);
  else console.log("Teleporter: sent", url);
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

async function handleEnvelope(env) {
  if (!env || env.v !== 1) return;

  if (env.kind === "open") {
    const t = (env.tabs && env.tabs[0]) || null;
    if (!t || !t.url) return;
    const newTab = await chrome.tabs.create({ url: t.url, active: true });
    // Restore page state once the tab finishes loading, then ack so the source closes its tab.
    const onUpdated = (tabId, info) => {
      if (tabId !== newTab.id || info.status !== "complete") return;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.scripting.executeScript({ target: { tabId: newTab.id }, func: restorePageState, args: [{ scrollX: t.scrollX || 0, scrollY: t.scrollY || 0, videoTime: t.videoTime || 0 }] })
        .catch(() => {})
        .finally(() => sendEnvelope({ v: 1, kind: "ack", moveId: env.moveId }));
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    // Safety: ack after 8s even if the page never reports "complete", so the source tab
    // is still closed (the move succeeded; only the late restore was best-effort).
    setTimeout(() => { chrome.tabs.onUpdated.removeListener(onUpdated); sendEnvelope({ v: 1, kind: "ack", moveId: env.moveId }); }, 8000);
    return;
  }

  if (env.kind === "ack") {
    const tabId = pendingClose.get(env.moveId);
    if (tabId !== undefined) {
      pendingClose.delete(env.moveId);
      chrome.tabs.remove(tabId).catch(() => {});
    }
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

// ---------------- boot ----------------

// Keep the long-poll alive across MV3 worker eviction: an alarm wakes the worker, which
// re-enters pollLoop (idempotent). startup/installed cover the normal launches. Guarded so
// a missing "alarms" permission degrades gracefully instead of aborting worker registration.
if (chrome.alarms) {
  chrome.alarms.create("keepalive", { periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener(() => pollLoop());
}
chrome.runtime.onStartup.addListener(() => boot());
chrome.runtime.onInstalled.addListener(() => boot());

async function boot() { await loadConfig(); await ensureToken(); pollLoop(); }
boot();
