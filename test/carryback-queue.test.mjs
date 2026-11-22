// Carry-back must not lose windows: the bookmark folder exists before anything is drained, each
// window is let go only once stored/opened (peek + ack on a new wrapper, put back on an old one),
// and restore removes only what it opened.
import test from "node:test";
import assert from "node:assert/strict";
import { loadBackground, defaultRoute, response } from "./harness.mjs";

const W1 = { tabs: ["https://one.example/a", "https://one.example/b"], at: 1700000000000000001 };
const W2 = { tabs: ["https://two.example/"], at: 1700000000000000002 };
const body = (r) => JSON.parse(r.body);
const folderOf = (h) => Object.values(h.world.bookmarks).find((n) => n.title === "mousetransfer-toopen" && !n.url);
const childrenOf = (h, id) => Object.values(h.world.bookmarks).filter((n) => n.parentId === id);

// route serves the queue: legacy = remove on read (no "peek"), peek = keep until acked.
function queueRoute(mode, queue) {
  return (req) => {
    if (req.path === "/carryback-drain") {
      if (mode === "peek") {
        assert.equal(new URL(req.url).searchParams.get("peek"), "1");
        return response(200, { peek: true, windows: queue.slice() });
      }
      const out = queue.splice(0);
      return response(200, { windows: out });
    }
    if (req.path === "/carryback-ack") { const ids = body(req).ids; for (let i = queue.length - 1; i >= 0; i--) if (ids.includes(queue[i].id)) queue.splice(i, 1); return response(204); }
    if (req.path === "/carryback") { queue.push({ tabs: body(req).tabs, at: 9 }); return response(204); }
    return defaultRoute(req);
  };
}

test("stage: the bookmark folder is made BEFORE anything is drained; no folder -> no drain", async () => {
  const queue = [W1];
  const h = await loadBackground({ fetch: queueRoute("legacy", queue), bookmarksCreate: () => Promise.reject(new Error("bookmarks are managed by policy")) });
  await h.tick(3000);
  assert.equal(h.fetched("/carryback-drain").length, 0);
  assert.equal(queue.length, 1, "the queue is untouched");
});

test("stage, old wrapper (destructive drain): a window that fails to store is put back", async () => {
  const queue = [W1, W2];
  const h = await loadBackground({
    fetch: queueRoute("legacy", queue),
    bookmarksCreate: (b) => (b.url === "https://two.example/" ? Promise.reject(new Error("quota")) : undefined),
  });
  await h.tick(3000);
  const folder = folderOf(h);
  const subs = childrenOf(h, folder.id);
  assert.equal(subs.length, 1, "W1 stored, no half-stored W2 subfolder left behind");
  assert.deepEqual(childrenOf(h, subs[0].id).map((n) => n.url), W1.tabs);
  assert.deepEqual(h.fetched("/carryback").map((r) => body(r).tabs), [W2.tabs], "W2 put back");
  assert.deepEqual(queue.map((w) => w.tabs), [W2.tabs]);
});

test("stage, new wrapper (peek): only the stored windows are acknowledged", async () => {
  const queue = [{ ...W1, id: "w1" }, { ...W2, id: "w2" }, { tabs: ["https://x/"], at: 3 } /* no id */];
  const h = await loadBackground({
    fetch: queueRoute("peek", queue),
    bookmarksCreate: (b) => (b.url === "https://two.example/" ? Promise.reject(new Error("quota")) : undefined),
  });
  await h.tick(3000);
  const acks = h.fetched("/carryback-ack").map(body);
  assert.deepEqual(acks, [{ ids: ["w1"] }]);
  assert.equal(h.fetched("/carryback").length, 0, "nothing is put back in peek mode");
  assert.deepEqual(queue.map((w) => w.id || "(no id)"), ["w2", "(no id)"]);
  assert.equal(childrenOf(h, folderOf(h).id).length, 1, "the id-less window was not stored");
});

test("restore: only subfolders whose window opened are removed; the root goes once empty", async () => {
  let fail = true;
  const h = await loadBackground({
    bookmarks: {
      "50": { id: "50", parentId: "1", title: "mousetransfer-toopen" },
      "51": { id: "51", parentId: "50", title: "window-1" },
      "52": { id: "52", parentId: "51", title: "a", url: "https://one.example/a" },
      "53": { id: "53", parentId: "50", title: "window-2" },
      "54": { id: "54", parentId: "53", title: "b", url: "https://two.example/" },
    },
    windowsCreate: (p) => (fail && p.url === "https://two.example/" ? Promise.reject(new Error("too many windows")) : undefined),
  });
  await h.tick(100);
  await h.fn("restoreCarryback")();
  assert.ok(h.world.bookmarks["50"], "root kept");
  assert.equal(h.world.bookmarks["51"], undefined, "opened subfolder removed");
  assert.ok(h.world.bookmarks["53"] && h.world.bookmarks["54"], "failed subfolder kept");
  fail = false;
  await h.fn("restoreCarryback")();
  assert.equal(h.world.bookmarks["50"], undefined, "root removed once empty");
  assert.deepEqual(h.called("windows.create").map((c) => c.args[0].url), ["https://one.example/a", "https://two.example/", "https://two.example/"]);
});

test("restore without bookmarks (Safari), old wrapper: a window that fails to open is put back", async () => {
  const queue = [W1, W2];
  const h = await loadBackground({
    omitApis: ["bookmarks"],
    fetch: queueRoute("legacy", queue),
    windowsCreate: (p) => (p.url === "https://two.example/" ? Promise.reject(new Error("no")) : undefined),
  });
  await h.tick(100);
  await h.fn("restoreCarryback")();
  assert.deepEqual(h.fetched("/carryback").map((r) => body(r).tabs), [W2.tabs]);
  assert.deepEqual(queue.map((w) => w.tabs), [W2.tabs]);
});

test("restore without bookmarks (Safari), new wrapper: only opened windows are acknowledged", async () => {
  const queue = [{ ...W1, id: "w1" }, { ...W2, id: "w2" }];
  const h = await loadBackground({
    omitApis: ["bookmarks"],
    fetch: queueRoute("peek", queue),
    windowsCreate: (p) => (p.url === "https://two.example/" ? Promise.reject(new Error("no")) : undefined),
  });
  await h.tick(100);
  await h.fn("restoreCarryback")();
  assert.deepEqual(h.fetched("/carryback-ack").map(body), [{ ids: ["w1"] }]);
  assert.deepEqual(queue.map((w) => w.id), ["w2"]);
});
