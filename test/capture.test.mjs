// capture-window: the dragged window is found by its rect, never by focus.
import test from "node:test";
import assert from "node:assert/strict";
import { loadBackground } from "./harness.mjs";

const windows = [
  { id: 1, left: 0, top: 0, width: 800, height: 600, focused: true, tabs: [{ id: 11, url: "https://focused.example/", active: true }] },
  { id: 2, left: 900, top: 100, width: 700, height: 500, tabs: [{ id: 21, url: "https://dragged.example/a", active: true }, { id: 22, url: "https://dragged.example/b" }] },
];

async function sent(h) { await h.flush(); return h.fetched("/send").map((r) => JSON.parse(r.body)); }

for (const [name, env] of [
  ["no rect at all", { v: 1, kind: "capture-window" }],
  ["zero-size rect", { v: 1, kind: "capture-window", wl: 0, wt: 0, ww: 0, wh: 0 }],
  ["partial rect", { v: 1, kind: "capture-window", ww: 700, wh: 500 }],
]) {
  test(`capture-window with ${name}: aborts, never captures by focus`, async () => {
    const h = await loadBackground({ windows });
    await h.fn("handleEnvelope")(env);
    assert.equal(h.called("windows.getLastFocused").length, 0);
    assert.equal((await sent(h)).length, 0);
    assert.ok(h.dbgLines().some((l) => l.includes("no usable rect")), h.dbgLines().join("\n"));
  });
}

test("capture-window with a rect: sends the window at that rect, not the focused one", async () => {
  const h = await loadBackground({ windows });
  await h.fn("handleEnvelope")({ v: 1, kind: "capture-window", wl: 900, wt: 100, ww: 700, wh: 500 });
  const out = await sent(h);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "open");
  assert.equal(out[0].asWindow, true);
  assert.deepEqual(out[0].tabs.map((t) => t.url), ["https://dragged.example/a", "https://dragged.example/b"]);
  assert.equal(h.called("windows.getLastFocused").length, 0);
});
