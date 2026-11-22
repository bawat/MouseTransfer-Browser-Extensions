// One honest keep-alive: a 20 s storage.session heartbeat, plus the 30 s alarm as the backstop.
import test from "node:test";
import assert from "node:assert/strict";
import { loadBackground } from "./harness.mjs";

test("the heartbeat writes storage.session every 20 s, which also reaches this worker as an event", async () => {
  const h = await loadBackground();
  let events = 0;
  h.chrome.storage.onChanged.addListener((changes, area) => { if (area === "session" && changes.mtHeartbeat) events++; });
  await h.tick(65000);
  const beats = h.called("storage.session.set").filter((c) => "mtHeartbeat" in c.args[0]);
  assert.equal(beats.length, 3);
  assert.equal(events, 3);
});

test("no lifeline port and no getPlatformInfo polling", async () => {
  const h = await loadBackground();
  await h.tick(120000);
  assert.equal(h.called("runtime.connect").length, 0);
  assert.equal(h.called("runtime.getPlatformInfo").length, 0);
  assert.equal(h.chrome.runtime.onConnect.listenerCount, 0);
});

// GUARD: the backstop alarm is still created, and firing it does not start a second poll loop or
// a second heartbeat.
test("the 30 s backstop alarm exists and is idempotent", async () => {
  const h = await loadBackground();
  await h.tick(100);
  assert.deepEqual(h.called("alarms.create").map((c) => c.args), [["keepalive", { periodInMinutes: 0.5 }]]);
  const polls = h.fetched("/events").length;
  await h.chrome.alarms.onAlarm.fire({ name: "keepalive" });
  await h.chrome.alarms.onAlarm.fire({ name: "keepalive" });
  await h.tick(100);
  assert.equal(h.fetched("/events").length, polls, "still one parked poll");
  await h.tick(20000);
  assert.equal(h.called("storage.session.set").filter((c) => "mtHeartbeat" in c.args[0]).length, 1, "one heartbeat timer");
});
