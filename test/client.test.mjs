// This install names itself to the bridge (client id on every request) and reports which of its
// windows has focus.
import test from "node:test";
import assert from "node:assert/strict";
import { loadBackground, response, defaultRoute } from "./harness.mjs";

const clientOf = (r) => new URL(r.url).searchParams.get("client");

test("a client id is made once, stored, and sent on every bridge request", async () => {
  const h = await loadBackground({ windows: [{ id: 1, focused: true, tabs: [{ id: 11, url: "https://a/", active: true }] }] });
  await h.chrome.action.onClicked.fire(); // adds a /send and /debug lines to the mix
  await h.tick(3000);
  const id = h.chrome.storage.local.data.clientId;
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.ok(h.requests.length >= 4);
  const paths = new Set(h.requests.map((r) => r.path));
  for (const p of ["/hello", "/events", "/profile-role", "/send"]) assert.ok(paths.has(p), p);
  for (const r of h.requests) assert.equal(clientOf(r), id, r.path);
  assert.equal(h.called("storage.local.set").filter((c) => "clientId" in c.args[0]).length, 1, "written once");
});

test("the stored id is reused by a later worker (not regenerated, not rewritten)", async () => {
  const h1 = await loadBackground({ storage: { local: { clientId: "11111111-2222-4333-8444-555555555555" } } });
  await h1.tick(100);
  assert.ok(h1.requests.length > 0);
  assert.ok(h1.requests.every((r) => clientOf(r) === "11111111-2222-4333-8444-555555555555"));
  assert.equal(h1.called("storage.local.set").filter((c) => "clientId" in c.args[0]).length, 0);
});


const wins = [
  { id: 1, left: 0, top: 0, width: 800, height: 600, tabs: [{ id: 11, url: "https://a/" }] },
  { id: 2, left: 0, top: 0, width: 800, height: 600, tabs: [{ id: 21, url: "https://b/" }] },
  { id: 3, left: 0, top: 0, width: 300, height: 300, type: "popup", tabs: [{ id: 31, url: "https://p/" }] },
];

test("focus: a burst of focus changes sends ONE /focus, with the client id", async () => {
  const h = await loadBackground({ windows: wins });
  await h.tick(100);
  h.chrome.windows.onFocusChanged.fire(1);
  await h.tick(30);
  h.chrome.windows.onFocusChanged.fire(2);
  await h.tick(30);
  h.chrome.windows.onFocusChanged.fire(1);
  await h.tick(1000);
  const f = h.fetched("/focus");
  assert.equal(f.length, 1);
  assert.equal(f[0].method, "POST");
  assert.equal(clientOf(f[0]), h.chrome.storage.local.data.clientId);
  assert.ok(!f[0].body);
});

// GUARD (nothing was sent before either): focus leaving the browser or landing on a popup must not report.
test("focus: leaving the browser, or a popup window, sends nothing", async () => {
  const h = await loadBackground({ windows: wins });
  await h.tick(100);
  h.chrome.windows.onFocusChanged.fire(-1);
  await h.tick(1000);
  h.chrome.windows.onFocusChanged.fire(3);
  await h.tick(1000);
  assert.equal(h.fetched("/focus").length, 0);
});

test("focus: a 404 from a bridge without /focus changes nothing", async () => {
  const h = await loadBackground({ windows: wins, fetch: (req) => (req.path === "/focus" ? response(404, "404 page not found") : defaultRoute(req)) });
  await h.tick(100);
  h.chrome.windows.onFocusChanged.fire(1);
  await h.tick(5000);
  assert.equal(h.fetched("/focus").length, 1);
  assert.equal(h.get("cfg.token"), "tok");
  assert.ok(h.fetched("/events").length >= 1);
});
