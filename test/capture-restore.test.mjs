// Capturing a window's tabs (concurrent, bounded, frame-aware) and restoring them on the receiver
// (already-loaded tabs, pages still growing, the video in the right frame only).
import test from "node:test";
import assert from "node:assert/strict";
import { loadBackground, pending } from "./harness.mjs";

const RECT = { wl: 0, wt: 0, ww: 800, wh: 600 };
const capEnv = { v: 1, kind: "capture-window", ...RECT };
const win = (tabs) => [{ id: 1, left: 0, top: 0, width: 800, height: 600, tabs }];
const sentOpen = (h) => h.fetched("/send").map((r) => JSON.parse(r.body)).find((e) => e.kind === "open");
const frameResult = (frameId, result) => ({ frameId, result });
const topState = (o = {}) => ({ top: true, frame: "https://site.example/page", scrollX: 0, scrollY: 0, video: null, ...o });

test("capture: tabs are read concurrently and keep the window's order", async () => {
  const h = await loadBackground({
    windows: win([{ id: 11, url: "https://a/" }, { id: 12, url: "https://b/" }, { id: 13, url: "https://c/" }]),
    executeScript: (inj, t) => t.delay(600, [frameResult(0, topState({ scrollY: inj.target.tabId }))]),
  });
  const p = h.fn("handleEnvelope")(capEnv);
  const start = h.clock.now;
  await h.tick(5000); await p;
  const send = h.fetched("/send")[0];
  assert.ok(send, "sent");
  assert.ok(send.at - start < 1000, `captured 3 tabs in ${send.at - start} ms (sequential would be 1800)`);
  const env = JSON.parse(send.body);
  assert.deepEqual(env.tabs.map((t) => [t.url, t.scrollY]), [["https://a/", 11], ["https://b/", 12], ["https://c/", 13]]);
});

test("capture: a tab that never answers goes as URL only after the timeout; the rest still go", async () => {
  const h = await loadBackground({
    windows: win([{ id: 11, url: "https://hung/" }, { id: 12, url: "https://b/" }]),
    executeScript: (inj) => (inj.target.tabId === 11 ? pending() : [frameResult(0, topState({ scrollY: 70 }))]),
  });
  const p = h.fn("handleEnvelope")(capEnv);
  const start = h.clock.now;
  await h.tick(5000); await p;
  const send = h.fetched("/send")[0];
  assert.ok(send, "sent despite the hung tab");
  assert.ok(send.at - start >= 1000 && send.at - start < 1500, `after ${send.at - start} ms`);
  const env = JSON.parse(send.body);
  assert.deepEqual(env.tabs.map((t) => [t.url, t.scrollY]), [["https://hung/", 0], ["https://b/", 70]]);
});

test("capture: a discarded tab is not injected (URL only)", async () => {
  const h = await loadBackground({
    windows: win([{ id: 11, url: "https://sleeping/", discarded: true }, { id: 12, url: "https://b/" }]),
    executeScript: () => [frameResult(0, topState({ scrollY: 5 }))],
  });
  const p = h.fn("handleEnvelope")(capEnv); await h.tick(2000); await p;
  assert.deepEqual(h.called("scripting.executeScript").map((c) => c.args[0].tabId), [12]);
  assert.deepEqual(sentOpen(h).tabs.map((t) => t.url), ["https://sleeping/", "https://b/"]);
});

test("capture: the playing video in an embedded frame is carried with its frame; a paused advert is not", async () => {
  const h = await loadBackground({
    windows: win([{ id: 11, url: "https://blog.example/post?x=1" }]),
    executeScript: () => [
      frameResult(0, topState({ frame: "https://blog.example/post", scrollY: 900 })),
      frameResult(4, { top: false, frame: "https://ads.example/slot", scrollX: 0, scrollY: 0, video: { time: 3, paused: true } }),
      frameResult(7, { top: false, frame: "https://www.youtube-nocookie.com/embed/ID", scrollX: 0, scrollY: 0, video: { time: 42.5, paused: false } }),
    ],
  });
  const p = h.fn("handleEnvelope")(capEnv); await h.tick(2000); await p;
  const t = sentOpen(h).tabs[0];
  assert.equal(t.videoTime, 42.5);
  assert.equal(t.videoFrame, "https://www.youtube-nocookie.com/embed/ID");
  assert.equal(t.scrollY, 900);
  assert.equal(t.url, "https://blog.example/post?x=1", "time is baked only for a top-frame YouTube video");
  assert.equal(h.called("scripting.executeScript")[0].args[0].allFrames, true);
});

// GUARD: the frame-aware capture must keep the old top-frame behaviour (fails against the old code
// only because the injected function's result shape changed).
test("capture: a top-frame YouTube video still bakes &t= and sends no videoFrame", async () => {
  const h = await loadBackground({
    windows: win([{ id: 11, url: "https://www.youtube.com/watch?v=ID" }]),
    executeScript: () => [frameResult(0, topState({ frame: "https://www.youtube.com/watch", video: { time: 61.2, paused: false } }))],
  });
  const p = h.fn("handleEnvelope")(capEnv); await h.tick(2000); await p;
  const t = sentOpen(h).tabs[0];
  assert.equal(t.url, "https://www.youtube.com/watch?v=ID&t=61s");
  assert.equal(t.videoFrame, undefined);
});

// ---- restore ----

test("scheduleRestore: a tab that is ALREADY complete is restored (no future 'complete' is needed)", async () => {
  const h = await loadBackground({ windows: win([{ id: 11, url: "https://a/", status: "complete" }]) });
  h.fn("scheduleRestore")(11, { url: "https://a/", scrollY: 500 });
  await h.tick(100);
  const calls = h.called("scripting.executeScript").filter((c) => c.args[0].func === "restorePageState");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[0].allFrames, true);
});

// GUARD (passes against the old code): checking the current status must not add a second restore.
test("scheduleRestore: a loading tab is restored once, on its 'complete'", async () => {
  const h = await loadBackground({ windows: win([{ id: 11, url: "https://a/", status: "loading" }]) });
  h.fn("scheduleRestore")(11, { url: "https://a/", scrollY: 500 });
  await h.tick(100);
  const restores = () => h.called("scripting.executeScript").filter((c) => c.args[0].func === "restorePageState").length;
  assert.equal(restores(), 0);
  h.world.windows[0].tabs[0].status = "complete";
  await h.chrome.tabs.onUpdated.fire(11, { status: "complete" }, h.world.windows[0].tabs[0]);
  await h.chrome.tabs.onUpdated.fire(11, { status: "complete" }, h.world.windows[0].tabs[0]);
  await h.tick(100);
  assert.equal(restores(), 1);
});

// A fake page for the injected restore function: a window whose scrollable height grows over time.
function fakePage(h, { top = true, frame = "https://site.example/page", maxY = () => 10000 } = {}) {
  const win = { scrollX: 0, scrollY: 0 };
  win.scrollTo = (x, y) => { win.scrollX = x; win.scrollY = Math.min(y, maxY()); };
  win.top = top ? win : {};
  const video = { currentTime: 0 };
  const u = new URL(frame);
  h.ctx.window = win;
  h.ctx.document = { querySelector: (s) => (s === "video" ? video : null), querySelectorAll: () => [video] };
  h.ctx.location = { origin: u.origin, pathname: u.pathname, href: frame };
  return { win, video };
}

test("restorePageState: keeps re-applying the scroll while a script-built page is still growing", async () => {
  const h = await loadBackground();
  const t0 = h.clock.now;
  const page = fakePage(h, { maxY: () => (h.clock.now - t0 < 600 ? 400 : 5000) });
  const p = h.fn("restorePageState")({ scrollX: 0, scrollY: 1500, videoTime: 0, windowMs: 3000, stepMs: 100 });
  await h.tick(4000);
  assert.equal(await p, true);
  assert.equal(page.win.scrollY, 1500);
});

// GUARD for the new retry loop: it ends, and leaves no timer behind.
test("restorePageState: gives up after its window on a page that never grows", async () => {
  const h = await loadBackground();
  const page = fakePage(h, { maxY: () => 400 });
  const start = h.clock.now;
  const p = h.fn("restorePageState")({ scrollX: 0, scrollY: 1500, videoTime: 0, windowMs: 3000, stepMs: 100 });
  await h.tick(10000);
  assert.equal(await p, false);
  assert.equal(page.win.scrollY, 400);
  assert.ok(h.clock.timers.length < 10, "no retry timer left running");
  assert.ok(h.clock.now - start >= 3000);
});

test("restorePageState: the video is sought only in the frame the sender named", async () => {
  const state = { scrollX: 0, scrollY: 0, videoTime: 42.5, videoFrame: "https://www.youtube-nocookie.com/embed/ID", windowMs: 0, stepMs: 100 };
  const cases = [
    [{ top: true, frame: "https://blog.example/post" }, 0],
    [{ top: false, frame: "https://ads.example/slot" }, 0],
    [{ top: false, frame: "https://www.youtube-nocookie.com/embed/ID" }, 42.5],
  ];
  for (const [where, want] of cases) {
    const h = await loadBackground();
    const page = fakePage(h, where);
    await h.fn("restorePageState")(state);
    assert.equal(page.video.currentTime, want, JSON.stringify(where));
  }
  // No videoFrame (top-frame video, or an older sender): only the top frame seeks.
  for (const [where, want] of [[{ top: true }, 7], [{ top: false, frame: "https://ads.example/slot" }, 0]]) {
    const h = await loadBackground();
    const page = fakePage(h, where);
    await h.fn("restorePageState")({ scrollX: 0, scrollY: 0, videoTime: 7, windowMs: 0 });
    assert.equal(page.video.currentTime, want, JSON.stringify(where));
  }
});
