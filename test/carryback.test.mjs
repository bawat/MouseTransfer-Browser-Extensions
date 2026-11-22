// sendCarryback: sendBeacon where the engine has it (Firefox event page), keepalive fetch otherwise
// (Chromium/Safari service worker, whose WorkerNavigator has no sendBeacon).
import test from "node:test";
import assert from "node:assert/strict";
import { loadBackground } from "./harness.mjs";

test("sendCarryback: no sendBeacon (service worker) -> keepalive fetch", async () => {
  const h = await loadBackground({ navigator: {} });
  h.fn("sendCarryback")(["https://a/", "https://b/"], 5);
  await h.flush();
  const posts = h.fetched("/carryback");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].method, "POST");
  assert.equal(posts[0].opts.keepalive, true);
  assert.deepEqual(JSON.parse(posts[0].body), { tabs: ["https://a/", "https://b/"] });
  assert.ok(h.dbgLines().some((l) => l.includes("via keepalive fetch")));
});

test("sendCarryback: sendBeacon present and queued -> no fetch", async () => {
  const beacons = [];
  const h = await loadBackground({ navigator: { sendBeacon: (url, body) => { beacons.push({ url, body }); return true; } } });
  h.fn("sendCarryback")(["https://a/"], 5);
  await h.flush();
  assert.equal(beacons.length, 1);
  assert.match(beacons[0].url, /\/carryback\?token=tok&client=[0-9a-f-]+$/);
  assert.equal(h.fetched("/carryback").length, 0);
  assert.ok(h.dbgLines().some((l) => l.includes("via sendBeacon")));
});

test("sendCarryback: sendBeacon refuses (returns false) -> keepalive fetch", async () => {
  const h = await loadBackground({ navigator: { sendBeacon: () => false } });
  h.fn("sendCarryback")(["https://a/"], 5);
  await h.flush();
  assert.equal(h.fetched("/carryback").length, 1);
});
