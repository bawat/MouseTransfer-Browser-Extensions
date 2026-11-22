// The window-state push (/winstate) is sent only by Yandex, and only on events that change it.
import test from "node:test";
import assert from "node:assert/strict";
import { loadBackground } from "./harness.mjs";

const YANDEX_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 YaBrowser/24.6.0.0 Safari/537.36";
const CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const windows = [{ id: 1, left: 0, top: 0, width: 1920, height: 1040, tabs: [{ id: 11, url: "https://a/" }, { id: 12, url: "https://b/" }] }];

async function exercise(h) {
  await h.tick(500);
  await h.chrome.tabs.onCreated.fire({ id: 13, windowId: 1, url: "https://c/" });
  await h.tick(500);
  await h.chrome.windows.onBoundsChanged.fire({ id: 1 });
  await h.tick(500);
}

test("not Yandex: no /winstate at all", async () => {
  const h = await loadBackground({ windows, navigator: { userAgent: CHROME_UA } });
  await exercise(h);
  assert.equal(h.fetched("/winstate").length, 0);
});

// GUARD: Yandex keeps getting the push it relies on.
test("Yandex: pushed at boot and on changes, with bounds and tab counts", async () => {
  const h = await loadBackground({ windows, navigator: { userAgent: YANDEX_UA } });
  await exercise(h);
  const posts = h.fetched("/winstate");
  assert.equal(posts.length, 3, "boot + tab created + bounds changed");
  assert.deepEqual(JSON.parse(posts[0].body), { windows: [{ l: 0, t: 0, w: 1920, h: 1040, tabs: 2 }] });
});

test("Yandex: a focus change is not a trigger", async () => {
  const h = await loadBackground({ windows, navigator: { userAgent: YANDEX_UA } });
  await h.tick(500);
  const before = h.fetched("/winstate").length;
  await h.chrome.windows.onFocusChanged.fire(1);
  await h.tick(500);
  assert.equal(h.fetched("/winstate").length, before);
});
