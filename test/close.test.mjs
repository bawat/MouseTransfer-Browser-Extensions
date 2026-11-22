// After the ack, the source closes ONLY what was sent (plus blank new-tab pages).
import test from "node:test";
import assert from "node:assert/strict";
import { loadBackground } from "./harness.mjs";

const RECT = { wl: 0, wt: 0, ww: 800, wh: 600 };
const one = (tabs) => [{ id: 1, left: 0, top: 0, width: 800, height: 600, focused: true, tabs }];
const sends = (h) => h.fetched("/send").map((r) => JSON.parse(r.body));
const kepts = (h) => h.fetched("/source-kept").map((r) => JSON.parse(r.body));
const tabIds = (h) => h.world.windows.flatMap((w) => w.tabs.map((t) => t.id));
const removed = (h) => h.called("tabs.remove").map((c) => c.args[0]);

// teleportWindow captures window 1 (as the wrapper's capture-window would) and returns its moveId.
async function teleportWindow(h, extra = {}) {
  const p = h.fn("handleEnvelope")({ v: 1, kind: "capture-window", ...RECT, ...extra });
  await h.tick(2000); await p;
  const open = sends(h).find((e) => e.kind === "open");
  assert.ok(open, "an open was sent");
  return open;
}
async function ack(h, moveId) {
  const p = h.fn("handleEnvelope")({ v: 1, kind: "ack", moveId });
  await h.tick(20000); await p;
}

test("window: only the sent web tabs close; chrome:// and file:// tabs keep the window", async () => {
  const h = await loadBackground({ windows: one([
    { id: 11, url: "https://a.example/" }, { id: 12, url: "chrome://settings/" },
    { id: 13, url: "https://b.example/" }, { id: 14, url: "file:///C:/notes.txt" }]) });
  const open = await teleportWindow(h, { cid: "w-77" });
  assert.deepEqual(open.tabs.map((t) => t.url), ["https://a.example/", "https://b.example/"]);
  // The wrapper is told BEFORE the open that this window will survive.
  const captured = kepts(h).find((k) => k.phase === "captured");
  assert.deepEqual({ ...captured }, { phase: "captured", moveId: open.moveId, cid: "w-77", sent: 2, kept: 2 });
  assert.ok(h.fetched("/source-kept")[0].at <= h.fetched("/send")[0].at, "reported before the open");
  await ack(h, open.moveId);
  assert.deepEqual(tabIds(h).sort(), [12, 14]);
  assert.equal(h.called("windows.remove").length, 0);
  const closed = kepts(h).find((k) => k.phase === "closed");
  assert.deepEqual({ ...closed }, { phase: "closed", moveId: open.moveId, cid: "w-77", kept: 2 });
  assert.deepEqual(h.chrome.storage.session.data.mtPendClose, {}, "the pending entry is cleared");
});

test("window: a tab opened after the capture is not closed", async () => {
  const h = await loadBackground({ windows: one([{ id: 11, url: "https://a.example/" }]) });
  const open = await teleportWindow(h);
  h.world.windows[0].tabs.push({ id: 99, url: "https://opened-later.example/", windowId: 1, status: "complete" });
  await ack(h, open.moveId);
  assert.deepEqual(tabIds(h), [99]);
  assert.equal(kepts(h).find((k) => k.phase === "closed").kept, 1);
});

test("window: a sent tab that navigated elsewhere before the ack is kept", async () => {
  const h = await loadBackground({ windows: one([{ id: 11, url: "https://a.example/" }, { id: 12, url: "https://b.example/" }]) });
  const open = await teleportWindow(h);
  h.world.windows[0].tabs[1].url = "https://somewhere-else.example/";
  await ack(h, open.moveId);
  assert.deepEqual(tabIds(h), [12]);
});

// GUARD (the old code closed these windows too): web pages + a blank new-tab page -> the window goes.
test("window: web tabs plus a blank new-tab page -> the whole window disappears, N-1 then the last", async () => {
  const h = await loadBackground({ windows: one([
    { id: 11, url: "https://a.example/" }, { id: 12, url: "https://b.example/" }, { id: 13, url: "chrome://newtab/" }]) });
  const open = await teleportWindow(h);
  assert.equal(kepts(h).length, 0, "nothing kept, nothing reported");
  await ack(h, open.moveId);
  assert.equal(h.world.windows.length, 0);
  assert.deepEqual(removed(h), [[11, 12], 13]);
  assert.equal(kepts(h).length, 0);
});

// GUARD: a refused remove (a live tab drag) is retried until it lands.
test("window: a refused remove is retried", async () => {
  let refusals = 2;
  const h = await loadBackground({
    windows: one([{ id: 11, url: "https://a.example/" }]),
    tabsRemove: () => (refusals-- > 0 ? Promise.reject(new Error("Tabs cannot be edited right now (user may be dragging a tab).")) : undefined),
  });
  const open = await teleportWindow(h);
  await ack(h, open.moveId);
  assert.equal(h.world.windows.length, 0);
});

// GUARD: an entry written by an older version (no tab list) keeps the old whole-window close.
test("window: a pre-2.19 pending entry still closes the whole window", async () => {
  const h = await loadBackground({
    windows: one([{ id: 11, url: "https://a.example/" }, { id: 12, url: "chrome://settings/" }]),
    storage: { session: { mtPendClose: { old1: { type: "window", id: 1, acked: true } } } },
  });
  await h.tick(20000);
  assert.equal(h.world.windows.length, 0);
  assert.deepEqual(h.chrome.storage.session.data.mtPendClose, {});
});

test("single tab: navigated elsewhere between send and ack -> kept", async () => {
  const h = await loadBackground({ windows: one([{ id: 11, url: "https://a.example/", active: true }]) });
  await h.chrome.action.onClicked.fire();
  await h.tick(2000);
  const open = sends(h).find((e) => e.kind === "open");
  h.world.windows[0].tabs[0].url = "https://b.example/";
  await ack(h, open.moveId);
  assert.deepEqual(tabIds(h), [11]);
  assert.deepEqual(h.chrome.storage.session.data.mtPendClose, {});
});

// GUARD: a fragment change is the same page -> closed as before.
test("single tab: same page (only the #fragment changed) -> closed", async () => {
  const h = await loadBackground({ windows: one([{ id: 11, url: "https://a.example/", active: true }, { id: 12, url: "https://keep.example/" }]) });
  await h.chrome.action.onClicked.fire();
  await h.tick(2000);
  const open = sends(h).find((e) => e.kind === "open");
  h.world.windows[0].tabs[0].url = "https://a.example/#section-2";
  await ack(h, open.moveId);
  assert.deepEqual(tabIds(h), [12]);
});
