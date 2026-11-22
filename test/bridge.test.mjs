// The bridge address: 24817 first, the legacy 24812 for an older wrapper, a user endpoint as is,
// the stored-default migration, and no tight loop when nothing answers.
import test from "node:test";
import assert from "node:assert/strict";
import { loadBackground, defaultRoute, refused, pending, response } from "./harness.mjs";

const NEW = "24817", OLD = "24812";

// route builds a fetch router: ports in `up` behave like a healthy bridge, any other port is refused
// (or handled by `other`).
function route(up, other) {
  return (req) => (up.includes(req.port) ? defaultRoute(req) : (other ? other(req) : refused()));
}
const hellos = (h) => h.requests.filter((r) => r.path === "/hello");
const nonHello = (h) => h.requests.filter((r) => r.path !== "/hello");

test("default: reaches the bridge on 24817 and uses it for everything", async () => {
  const h = await loadBackground({ fetch: route([NEW, OLD]) });
  await h.tick(100);
  assert.deepEqual(hellos(h).map((r) => r.port), [NEW]);
  assert.ok(h.fetched("/events", NEW).length >= 1, "polls on 24817");
  assert.equal(h.requests.filter((r) => r.port === OLD).length, 0, "never touches 24812");
  assert.equal(h.get("cfg.token"), "tok");
  assert.equal(h.chrome.storage.local.data.token, "tok");
  assert.equal("endpoint" in h.chrome.storage.local.data, false, "the endpoint is not written to storage");
});

test("default: 24817 refused, 24812 answers -> after a pause, everything goes to 24812", async () => {
  const h = await loadBackground({ fetch: route([OLD]) });
  await h.tick(5000);
  const hs = hellos(h);
  assert.deepEqual(hs.slice(0, 2).map((r) => r.port), [NEW, OLD]);
  assert.ok(hs[1].at - hs[0].at >= 2000, `pause between the ports: ${hs[1].at - hs[0].at} ms`);
  // boot waited for the fallback before asking anything else, so the one-shot role query went to 24812
  const roles = h.fetched("/profile-role");
  assert.equal(roles.length, 1);
  assert.equal(roles[0].port, OLD);
  assert.ok(h.fetched("/events", OLD).length >= 1, "polls on 24812");
  assert.equal(nonHello(h).filter((r) => r.port === NEW).length, 0, "nothing but the probe went to 24817");
});

test("default: both ports refused -> probes alternate with a pause, no tight loop", async () => {
  const h = await loadBackground({ fetch: route([]) });
  await h.tick(60000);
  const hs = hellos(h);
  assert.ok(hs.length >= 10, `keeps retrying (${hs.length} probes)`);
  assert.ok(hs.length <= 31, `at most one probe per 2 s (${hs.length} in 60 s)`);
  for (let i = 1; i < hs.length; i++) {
    assert.ok(hs[i].at - hs[i - 1].at >= 2000, `probe ${i} came ${hs[i].at - hs[i - 1].at} ms after the previous one`);
    assert.notEqual(hs[i].port, hs[i - 1].port, "alternates between the two ports");
  }
  assert.ok(h.requests.length < 200, `total requests bounded (${h.requests.length})`);
});

test("default: 24817 refused and 24812 is a non-HTTP (TLS) listener that never answers -> abandoned, paced", async () => {
  const h = await loadBackground({ fetch: route([], (req) => (req.port === OLD ? pending() : refused())) });
  await h.tick(60000);
  const hs = hellos(h);
  assert.ok(hs.filter((r) => r.port === OLD).length >= 3, "the hanging port is retried");
  const hung = hs.filter((r) => r.port === OLD && h.clock.now - r.at >= 3000); // older than the probe timeout
  assert.ok(hung.length >= 3 && hung.every((r) => r.aborted), "each hanging probe was aborted by the timeout");
  for (let i = 1; i < hs.length; i++) assert.ok(hs[i].at - hs[i - 1].at >= 2000);
  assert.equal(h.get("cfg.token"), "");
});

test("default: 24817 answers a non-bridge error (garbage, not ok) -> treated as not the bridge", async () => {
  const h = await loadBackground({ fetch: route([OLD], (req) => (req.port === NEW ? response(400, "Client sent an HTTP request to an HTTPS server.") : refused())) });
  await h.tick(5000);
  assert.ok(h.fetched("/events", OLD).length >= 1);
});

test("default: the working port goes away later -> re-probed, 24817 first", async () => {
  let up = [OLD];
  const held = []; // reject functions of the long-polls the bridge is holding
  const h = await loadBackground({ fetch: (req) => {
    if (!up.includes(req.port)) return refused();
    if (req.path === "/events") return new Promise((_, rej) => held.push(rej));
    return defaultRoute(req);
  } });
  await h.tick(5000);
  assert.ok(h.fetched("/events", OLD).length >= 1);
  // The old wrapper is replaced by a new one that serves only 24817 (as a POSIX wrapper would):
  // its held long-poll dies with the connection.
  up = [NEW];
  const before = h.requests.length;
  for (const rej of held.splice(0)) rej(new TypeError("Failed to fetch (connection reset)"));
  await h.tick(10000);
  const later = h.requests.slice(before);
  const firstHello = later.find((r) => r.path === "/hello");
  assert.equal(firstHello && firstHello.port, NEW, "re-probes 24817 first");
  assert.ok(later.some((r) => r.path === "/events" && r.port === NEW), "polls on 24817 again");
  assert.ok(later.every((r) => r.path === "/hello" || r.port === NEW || r.at === later[0].at), "nothing else goes to the dead port");
});

test("custom endpoint: refused -> retried on that endpoint only, never the defaults", async () => {
  const h = await loadBackground({ storage: { local: { endpoint: "http://127.0.0.1:30000/" } }, fetch: route([]) });
  await h.tick(30000);
  assert.ok(h.requests.length > 0);
  assert.deepEqual([...new Set(h.requests.map((r) => r.port))], ["30000"]);
  const hs = hellos(h);
  for (let i = 1; i < hs.length; i++) assert.ok(hs[i].at - hs[i - 1].at >= 2000);
  assert.equal(h.chrome.storage.local.data.endpoint, "http://127.0.0.1:30000/", "the user's value is not rewritten");
});

test("custom endpoint that answers is used as is", async () => {
  const h = await loadBackground({ storage: { local: { endpoint: "http://127.0.0.1:30000" } }, fetch: route(["30000"]) });
  await h.tick(100);
  assert.ok(h.fetched("/events", "30000").length >= 1);
  assert.equal(h.requests.filter((r) => r.port !== "30000").length, 0);
});

test("migration: a stored pre-2.18 default (24812) is forgotten and 24817 is tried first", async () => {
  for (const stored of ["http://127.0.0.1:24812", "http://127.0.0.1:24812/"]) {
    const h = await loadBackground({ storage: { local: { endpoint: stored, token: "tok" } }, fetch: route([NEW, OLD]) });
    await h.tick(100);
    assert.equal("endpoint" in h.chrome.storage.local.data, false, `removed ${stored}`);
    assert.equal(h.chrome.storage.local.data.token, "tok", "token kept");
    assert.equal(hellos(h)[0].port, NEW);
    assert.ok(h.fetched("/events", NEW).length >= 1);
  }
});

test("migration: a stored legacy default with only an old wrapper still falls back to 24812", async () => {
  const h = await loadBackground({ storage: { local: { endpoint: "http://127.0.0.1:24812", token: "tok" } }, fetch: route([OLD]) });
  await h.tick(5000);
  assert.ok(h.fetched("/events", OLD).length >= 1);
});

test("migration: a stored custom endpoint is left alone; nothing stored stays nothing", async () => {
  const h1 = await loadBackground({ storage: { local: { endpoint: "http://192.168.0.5:24812" } }, fetch: route([]) });
  await h1.tick(100);
  assert.equal(h1.chrome.storage.local.data.endpoint, "http://192.168.0.5:24812");
  assert.equal(h1.called("storage.local.remove").length, 0);

  const h2 = await loadBackground({ fetch: route([NEW]) });
  await h2.tick(100);
  assert.equal("endpoint" in h2.chrome.storage.local.data, false);
  assert.equal(h2.called("storage.local.remove").length, 0);
});

test("a stored endpoint equal to the new default behaves as the default (falls back)", async () => {
  const h = await loadBackground({ storage: { local: { endpoint: "http://127.0.0.1:24817" } }, fetch: route([OLD]) });
  await h.tick(5000);
  assert.ok(h.fetched("/events", OLD).length >= 1);
});
