// Storage writes: the pending-close registry's read-modify-write updates are serialised, and a
// failing storage call is reported, never left as an unhandled rejection.
import test from "node:test";
import assert from "node:assert/strict";
import { loadBackground } from "./harness.mjs";

test("pending-close registry: concurrent updates are not lost", async () => {
  const h = await loadBackground();
  const pcSet = h.fn("pcSet"), pcMark = h.fn("pcMark"), pcDel = h.fn("pcDel");
  // Fire-and-forget, as the code's own call sites do, then let everything settle.
  pcSet("a", { type: "tab", id: 1, acked: false });
  pcSet("b", { type: "tab", id: 2, acked: false });
  pcSet("c", { type: "tab", id: 3, acked: false });
  pcMark("a", { acked: true });
  pcDel("b");
  await h.flush();
  assert.deepEqual(h.chrome.storage.session.data.mtPendClose, {
    a: { type: "tab", id: 1, acked: true },
    c: { type: "tab", id: 3, acked: false },
  });
});

test("a rejected storage write is reported with dbg, not left unhandled", async () => {
  const unhandled = [];
  const onUnhandled = (r) => unhandled.push(r);
  process.on("unhandledRejection", onUnhandled);
  try {
    const h = await loadBackground({ storageHook: (area, op) => (area === "session" && op === "set" ? new Error("QUOTA_BYTES quota exceeded") : undefined) });
    h.fn("setLastTeleportWin")(5);
    h.fn("persistWinTabs")();
    await h.fn("pcSet")("x", { type: "tab", id: 1, acked: false });
    await h.chrome.runtime.onSuspend.fire();
    await h.flush();
    await new Promise((r) => setTimeout(r, 20)); // let Node classify any rejection as unhandled
    assert.deepEqual(unhandled.map(String), []);
    const lines = h.dbgLines().filter((l) => l.includes("QUOTA_BYTES"));
    assert.ok(lines.length >= 4, lines.join("\n"));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("an ack whose moveId is __proto__ or constructor touches nothing (no prototype pollution)", async () => {
  const h = await loadBackground({ windows: [{ id: 1, tabs: [{ id: 11, url: "https://a/" }] }] });
  await h.tick(100);
  for (const moveId of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
    const p = h.fn("handleEnvelope")({ v: 1, kind: "ack", moveId });
    await h.tick(1000); await p;
  }
  assert.equal(h.get("({}).acked"), undefined, "Object.prototype untouched");
  assert.equal(h.get("Object.acked"), undefined);
  assert.equal(h.called("tabs.remove").length, 0);
  assert.equal(h.world.windows[0].tabs.length, 1);
});
