// Carry-back tab tracking runs only in the teleport profile.
import test from "node:test";
import assert from "node:assert/strict";
import { loadBackground, defaultRoute, response } from "./harness.mjs";

const roleRoute = (role) => (req) => (req.path === "/profile-role" ? response(200, { role }) : defaultRoute(req));
const winTabWrites = (h) => h.called("storage.session.set").filter((c) => "mtWinTabs" in c.args[0]);
const windows = [{ id: 1, tabs: [{ id: 11, url: "https://a.example/" }] }];

test("normal profile: tab events record and write nothing", async () => {
  const h = await loadBackground({ windows, fetch: roleRoute("normal") });
  await h.tick(500);
  await h.chrome.tabs.onCreated.fire({ id: 12, windowId: 1, url: "https://b.example/" });
  await h.chrome.tabs.onUpdated.fire(11, { url: "https://a.example/2" }, { id: 11, windowId: 1, url: "https://a.example/2" });
  await h.chrome.runtime.onSuspend.fire();
  await h.tick(100);
  assert.equal(winTabWrites(h).length, 0);
  assert.equal(h.get("winTabs.size"), 0);
  // closing a window in the normal profile sends nothing and reads nothing
  await h.chrome.windows.onRemoved.fire(1);
  await h.tick(100);
  assert.equal(h.fetched("/carryback").length, 0);
  assert.equal(h.called("storage.session.get").filter((c) => JSON.stringify(c.args).includes("mtWinTabs")).length, 0);
});

// GUARD: the teleport profile still tracks, persists and carries a closed window back.
test("teleport profile: tabs are tracked and a closed window is carried back", async () => {
  const h = await loadBackground({ windows, fetch: roleRoute("teleport") });
  await h.tick(500);
  await h.chrome.tabs.onCreated.fire({ id: 12, windowId: 1, url: "https://b.example/" });
  await h.tick(10);
  assert.ok(winTabWrites(h).length >= 1);
  await h.chrome.windows.onRemoved.fire(1);
  await h.tick(10);
  const cb = h.fetched("/carryback");
  assert.equal(cb.length, 1);
  assert.deepEqual(JSON.parse(cb[0].body).tabs.sort(), ["https://a.example/", "https://b.example/"]);
});

// GUARD: a worker woken BY the close (fresh, nothing in memory) recovers role + tabs from storage.
test("teleport profile, resurrected worker: the close that woke it is still carried back", async () => {
  const h = await loadBackground({
    windows: [],
    storage: { session: { mtRole: "teleport", mtWinTabs: { 7: { 70: "https://x.example/", 71: "https://y.example/" } } } },
    fetch: roleRoute("teleport"),
    settle: false,
  });
  h.chrome.windows.onRemoved.fire(7);
  await h.tick(500);
  const cb = h.fetched("/carryback");
  assert.equal(cb.length, 1);
  assert.deepEqual(JSON.parse(cb[0].body).tabs.sort(), ["https://x.example/", "https://y.example/"]);
});

test("teleport profile, resurrected worker: a tab closed after recovery is not carried back", async () => {
  // Recovered entries used to keep their storage (string) keys, so removing tab 70 (a number) missed.
  const h = await loadBackground({
    windows: [{ id: 7, tabs: [{ id: 70, url: "https://x.example/" }, { id: 71, url: "https://y.example/" }] }],
    storage: { session: { mtRole: "teleport", mtWinTabs: { 7: { 70: "https://x.example/", 71: "https://y.example/" } } } },
    fetch: roleRoute("teleport"),
  });
  await h.tick(500);
  await h.chrome.tabs.onRemoved.fire(70, { windowId: 7, isWindowClosing: false });
  await h.chrome.windows.onRemoved.fire(7);
  await h.tick(10);
  assert.deepEqual(JSON.parse(h.fetched("/carryback")[0].body).tabs, ["https://y.example/"]);
});
