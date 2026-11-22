// The poll loop: a failing handler is reported and polling continues at once; a 403 (our token is
// wrong) drops the token and re-probes, paced.
import test from "node:test";
import assert from "node:assert/strict";
import { loadBackground, defaultRoute, response, pending } from "./harness.mjs";

const tokenOf = (req) => new URL(req.url).searchParams.get("token");

test("a handler error is reported with dbg and the next poll goes out at once", async () => {
  let served = 0;
  const h = await loadBackground({
    fetch: (req) => {
      if (req.path === "/events") {
        served++;
        if (served === 1) return response(200, { v: 1, kind: "open", moveId: "m-boom", tabs: [{ url: "https://example.com/" }] });
        return pending();
      }
      return defaultRoute(req);
    },
    tabsCreate: () => Promise.reject(new Error("Tabs cannot be edited right now")),
  });
  await h.tick(100);
  const polls = h.fetched("/events");
  assert.ok(polls.length >= 2, "polling continued");
  assert.ok(polls[1].at - polls[0].at < 1000, `next poll ${polls[1].at - polls[0].at} ms later`);
  const line = h.dbgLines().find((l) => l.startsWith("handler failed"));
  assert.ok(line, h.dbgLines().join("\n"));
  assert.match(line, /kind=open/);
  assert.match(line, /moveId=m-boom/);
  assert.match(line, /Tabs cannot be edited right now/);
});

test("403: the stale token is dropped, the current one fetched, polling resumes", async () => {
  let bridgeToken = "old";
  const h = await loadBackground({
    fetch: (req) => {
      if (req.path === "/hello") return response(200, { token: bridgeToken });
      if (tokenOf(req) !== bridgeToken) return response(403, "bad token");
      if (req.path === "/events") return response(204); // idle timeouts, so the loop keeps asking
      return defaultRoute(req);
    },
  });
  await h.tick(1000);
  assert.equal(h.get("cfg.token"), "old");
  bridgeToken = "new"; // the wrapper restarted with a new token
  const switchedAt = h.clock.now;
  await h.tick(30000);
  assert.equal(h.chrome.storage.local.data.token, "new");
  assert.equal(h.get("cfg.token"), "new");
  assert.ok(h.fetched("/events").some((r) => tokenOf(r) === "new"), "polls with the new token");
  const rejected = h.requests.find((r) => r.at >= switchedAt && tokenOf(r) === "old");
  const reHello = h.requests.find((r) => r.path === "/hello" && r.at >= rejected.at);
  assert.ok(reHello.at - rejected.at >= 2000, `re-probe ${reHello.at - rejected.at} ms after the 403`);
});

test("a /hello that hands out a different token replaces the stored one (no 403 round needed)", async () => {
  const h = await loadBackground({ storage: { local: { token: "old" } }, fetch: (req) => (req.path === "/hello" ? response(200, { token: "new" }) : defaultRoute(req)) });
  await h.tick(100);
  assert.equal(h.chrome.storage.local.data.token, "new");
  assert.ok(h.requests.filter((r) => r.path !== "/hello").every((r) => tokenOf(r) === "new"));
});

// GUARD (passes on the old code too, which slept 2 s on any non-204): the new re-probe path must not
// turn a bridge that keeps refusing into a tight loop.
test("403 forever (the bridge keeps refusing the token it hands out): paced, no tight loop", async () => {
  const h = await loadBackground({
    fetch: (req) => (req.path === "/hello" ? response(200, { token: "tok" }) : response(403, "bad token")),
  });
  await h.tick(60000);
  const polls = h.fetched("/events");
  assert.ok(polls.length >= 5 && polls.length <= 31, `${polls.length} polls in 60 s`);
  for (let i = 1; i < polls.length; i++) assert.ok(polls[i].at - polls[i - 1].at >= 2000);
});
