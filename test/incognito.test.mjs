// Incognito/private windows are never captured, and capture-window's `lone:false` turns off the
// single-window fallback (which would otherwise grab the one normal window when the user dragged
// a private one the extension cannot see).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBackground } from "./harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const normal = { id: 1, left: 0, top: 0, width: 800, height: 600, tabs: [{ id: 11, url: "https://normal.example/" }] };
const priv = { id: 2, left: 900, top: 100, width: 700, height: 500, incognito: true, tabs: [{ id: 21, url: "https://private.example/", incognito: true }] };
const sends = (h) => h.fetched("/send").map((r) => JSON.parse(r.body));
async function capture(h, env) { const p = h.fn("handleEnvelope")({ v: 1, kind: "capture-window", ...env }); await h.tick(2000); await p; }

test("a private window is never captured, even when its rect matches exactly", async () => {
  const h = await loadBackground({ windows: [normal, priv] });
  await capture(h, { wl: 900, wt: 100, ww: 700, wh: 500 });
  assert.equal(sends(h).length, 0);
});

test("a visible private window beside the lone normal one disables the single-window fallback", async () => {
  const h = await loadBackground({ windows: [normal, priv] });
  await capture(h, { wl: 3000, wt: 2000, ww: 400, wh: 300 });
  assert.equal(sends(h).length, 0, "the normal window was NOT taken by the fallback");
});

test("lone:false: one normal window whose bounds do not match -> abort", async () => {
  const h = await loadBackground({ windows: [normal] });
  await capture(h, { wl: 3000, wt: 2000, ww: 400, wh: 300, lone: false });
  assert.equal(sends(h).length, 0);
  assert.ok(h.dbgLines().some((l) => l.includes("lone:false")));
});

test("lone:false still captures an exact match", async () => {
  const h = await loadBackground({ windows: [normal] });
  await capture(h, { wl: 0, wt: 0, ww: 800, wh: 600, lone: false });
  assert.deepEqual(sends(h)[0].tabs.map((t) => t.url), ["https://normal.example/"]);
});

// GUARD: without "lone" the QQ-style fallback works as before.
test("lone absent: the single-window fallback still applies", async () => {
  const h = await loadBackground({ windows: [normal] });
  await capture(h, { wl: 3000, wt: 2000, ww: 400, wh: 300 });
  assert.equal(sends(h).length, 1);
});

test("the toolbar/shortcut path refuses a private tab", async () => {
  const h = await loadBackground({ windows: [{ ...priv, focused: true, tabs: [{ id: 21, url: "https://private.example/", incognito: true, active: true }] }] });
  await h.chrome.action.onClicked.fire();
  await h.tick(2000);
  assert.equal(sends(h).length, 0);
});

test("manifests: chrome and firefox are not allowed in incognito; safari has no such key", () => {
  const m = (b) => JSON.parse(fs.readFileSync(path.join(ROOT, b, "manifest.json"), "utf8"));
  assert.equal(m("chrome").incognito, "not_allowed");
  assert.equal(m("firefox").incognito, "not_allowed");
  assert.equal(m("safari").incognito, undefined);
});
