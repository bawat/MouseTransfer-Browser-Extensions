// Receiving an `open`: only http(s) URLs are ever opened; nothing left -> no ack.
import test from "node:test";
import assert from "node:assert/strict";
import { loadBackground, defaultRoute, response } from "./harness.mjs";

// Every URL handed to the browser to open, in call order.
const opened = (h) => h.calls.flatMap((c) =>
  c.api === "tabs.create" || c.api === "windows.create" ? [c.args[0].url]
    : c.api === "tabs.update" && c.args[1] && c.args[1].url ? [c.args[1].url] : []);
// deliver runs the handler while advancing fake time (the cold path polls on timers).
async function deliver(h, env) { const p = h.fn("handleEnvelope")(env); await h.tick(5000); await p; }
const acks = (h) => h.fetched("/send").map((r) => JSON.parse(r.body)).filter((e) => e.kind === "ack");

const hostile = [
  { url: "file:///C:/Users/secret.txt" },
  { url: "chrome://settings/passwords" },
  { url: "javascript:alert(document.cookie)" },
  { url: " data:text/html,<script>1</script>" },
  { url: "" },
  { url: 42 },
  null,
];

test("single tab: a non-http URL is never opened and never acked", async () => {
  for (const bad of hostile) {
    const h = await loadBackground({ windows: [{ id: 1, focused: true, tabs: [{ id: 2, url: "https://home/" }] }] });
    await deliver(h, { v: 1, kind: "open", moveId: "m1", tabs: [bad] });
    await h.flush();
    assert.deepEqual(opened(h), [], JSON.stringify(bad));
    assert.equal(acks(h).length, 0, JSON.stringify(bad));
  }
});

test("window: only the http(s) tabs are opened; the log names schemes, not URLs", async () => {
  const h = await loadBackground();
  await deliver(h, { v: 1, kind: "open", moveId: "m2", asWindow: true,
    tabs: [{ url: "file:///C:/Users/secret.txt" }, { url: "https://a.example/x?q=1" }, { url: "chrome://settings/" }, { url: "http://b.example/" }] });
  await h.flush();
  assert.deepEqual(opened(h), ["https://a.example/x?q=1", "http://b.example/"]);
  assert.equal(acks(h).length, 1);
  const line = h.dbgLines().find((l) => l.includes("dropped"));
  assert.ok(line, h.dbgLines().join("\n"));
  assert.match(line, /dropped 2 of 4/);
  assert.match(line, /file:/);
  assert.doesNotMatch(line, /secret|settings/);
});

test("window, cold launch: the adopted window is matched and filled from http(s) tabs only", async () => {
  // The wrapper cold-launched the browser with the http tabs; the envelope's first entry is hostile.
  const h = await loadBackground({
    windows: [{ id: 1, tabs: [{ id: 10, url: "https://a.example/" }] }],
    fetch: (req) => (req.path === "/coldlaunch" ? response(200, { cold: true }) : defaultRoute(req)),
  });
  await deliver(h, { v: 1, kind: "open", moveId: "m3", asWindow: true,
    tabs: [{ url: "file:///etc/passwd" }, { url: "https://a.example/" }, { url: "https://b.example/" }] });
  await h.flush();
  assert.equal(h.called("windows.create").length, 0, "adopted, not created");
  assert.deepEqual(opened(h), ["https://b.example/"]);
  assert.equal(acks(h).length, 1);
});

test("window: nothing http(s) -> nothing opened, no ack", async () => {
  const h = await loadBackground();
  await deliver(h, { v: 1, kind: "open", moveId: "m4", asWindow: true, tabs: [{ url: "file:///x" }, { url: "about:blank" }] });
  await h.flush();
  assert.deepEqual(opened(h), []);
  assert.equal(acks(h).length, 0);
});
