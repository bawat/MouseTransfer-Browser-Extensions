#!/usr/bin/env node
// smoke-edge.mjs — OPT-IN end-to-end check of the BUILT chrome/ extension in a real browser.
// Not part of `npm test`: it needs Microsoft Edge (Windows) and takes about two minutes.
//
//   node tools/smoke-edge.mjs                       (npm run smoke) — against a fake bridge in Node
//   node tools/smoke-edge.mjs --go <bridgerig.exe>  — against the REAL Go bridge, run by the wrapper
//                                                     repo's testing/tools/bridgerig (build it with
//                                                     `go build ./testing/tools/bridgerig` there)
//   EDGE_PATH=<msedge.exe> to use another Edge.
//
// What it does, and why it is safe on a machine somebody is using:
//   - a bridge on a free loopback port: the Node fake (implements every endpoint the extension calls,
//     logs every request, serves the test pages), or bridgerig (the product's handler + a recorder);
//   - copies chrome/ to a temporary folder and points BOTH endpoint constants at that bridge — the real
//     bridge (24817 / 24812) is never contacted; the copy is checked before launch;
//   - launches Edge HEADLESS with a throw-away --user-data-dir (no window, never the user's profile)
//     and loads the copy with --load-extension (Edge honours it; branded Chrome 137+ does not);
//   - kills the WHOLE browser tree afterwards (profile-matched roots plus descendants), verifies
//     nothing is left, and deletes the temporary folders.
// Each check prints PASS/FAIL with the evidence from the bridge's request log; exit 1 on any FAIL.

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { ROOT, preflight, sleep, waitFor, copyExtension, launchEdge, treePids, cpuSeconds, killTrees, tempRoot, checker } from "./edge-lib.mjs";

preflight();
const goIdx = process.argv.indexOf("--go");
const goExe = goIdx >= 0 ? process.argv[goIdx + 1] : null;

// ---------------- bridge adapters ----------------
// Both expose: base, pageBase, deliver(envOrString), log() -> [{t, method, path, query, body}],
// polling() -> bool, close().

async function nodeBridge() {
  const TOKEN = "smoke-token-" + Math.random().toString(36).slice(2, 10);
  const log = [], queue = [], parked = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      log.push({ t: Date.now(), method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body });
      const json = (code, o) => { res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }); res.end(JSON.stringify(o)); };
      const empty = (code) => { res.writeHead(code, { "Access-Control-Allow-Origin": "*" }); res.end(); };
      if (u.pathname.startsWith("/page")) { res.writeHead(200, { "Content-Type": "text/html" }); res.end("<!doctype html><title>smoke</title><p style='height:3000px'>smoke page</p>"); return; }
      if (u.pathname === "/hello") { if (req.headers["x-teleport-client"] !== "merged-tab-teleporter") return empty(403); return json(200, { token: TOKEN }); }
      if (u.searchParams.get("token") !== TOKEN) return empty(403);
      switch (u.pathname) {
        case "/events": {
          if (queue.length) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(queue.shift()); return; }
          parked.push(res);
          setTimeout(() => { const i = parked.indexOf(res); if (i >= 0) { parked.splice(i, 1); empty(204); } }, 25000); // the real bridge's pollTimeout
          return;
        }
        case "/profile-role": return json(200, { role: "normal" });
        case "/carryback-drain": return json(200, u.searchParams.get("peek") === "1" ? { peek: true, windows: [] } : { windows: [] });
        case "/coldlaunch": return json(200, { cold: false });
        default: return empty(204);
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + server.address().port;
  return {
    name: "Node fake bridge", base, pageBase: base,
    deliver(env) {
      const s = typeof env === "string" ? env : JSON.stringify(env);
      const res = parked.shift();
      if (res) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(s); } else queue.push(s);
    },
    log: async () => log,
    polling: async () => parked.length > 0,
    close() { for (const r of parked.splice(0)) { try { r.end(); } catch (e) {} } server.close(); },
  };
}

// A tiny page server for the Go mode (the real bridge does not serve test pages).
async function pageServer() {
  const s = http.createServer((req, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end("<!doctype html><title>smoke</title><p style='height:3000px'>smoke page</p>"); });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  return { base: "http://127.0.0.1:" + s.address().port, close: () => s.close() };
}

async function goBridge(exe) {
  const child = spawn(exe, [], { stdio: ["pipe", "pipe", "inherit"] });
  const info = await new Promise((resolve, reject) => {
    let buf = "";
    child.stdout.on("data", (d) => { buf += d; const i = buf.indexOf("\n"); if (i >= 0) resolve(JSON.parse(buf.slice(0, i))); });
    child.on("exit", (c) => reject(new Error("bridgerig exited " + c)));
  });
  const pages = await pageServer();
  const ctl = (p, init) => fetch(info.control + p, init);
  return {
    name: "real Go bridge (bridgerig)", base: info.bridge, pageBase: pages.base, control: info.control,
    deliver: (env) => ctl("/deliver", { method: "POST", body: typeof env === "string" ? env : JSON.stringify(env) }),
    log: async () => (await (await ctl("/log")).json()) || [],
    polling: async () => (await (await ctl("/polling")).json()).polling,
    close() { pages.close(); try { child.stdin.end(); } catch (e) {} try { child.kill(); } catch (e) {} },
  };
}

// ---------------- the run ----------------
const { results, check } = checker();
const bridge = goExe ? await goBridge(goExe) : await nodeBridge();
console.log("bridge: " + bridge.name + " at " + bridge.base);
const tmp = tempRoot("tt-smoke-");
const extDir = copyExtension(path.join(ROOT, "chrome"), bridge.base, tmp);
const profile = path.join(tmp, "profile");
console.log("extension copy: " + extDir + " (endpoints -> " + bridge.base + ")");
launchEdge(extDir, profile);

const since = async (t) => (await bridge.log()).filter((e) => e.t >= t);
const sends = async (t) => (await since(t)).filter((e) => e.path === "/send").map((e) => { try { return JSON.parse(e.body); } catch (x) { return {}; } });
const dbgs = async (t) => (await since(t)).filter((e) => e.path === "/debug").map((e) => e.body);

try {
  // 1. boot: token fetched, a poll parked
  const hello = await waitFor(async () => (await bridge.log()).find((e) => e.path === "/hello" && (e.status === undefined || e.status === 200)), 30000);
  const tree = treePids([profile]);
  check("the extension loaded (an extension process exists)", tree.extensionProcs > 0, `${tree.pids.length} browser processes, ${tree.extensionProcs} extension process(es)`);
  check("boot fetched the token (/hello)", !!hello, hello ? `POST /hello client=${hello.query.client}` + (hello.header ? ` Origin=${hello.header.Origin} status=${hello.status}` : "") : "no accepted /hello within 30 s");
  check("a /events long-poll is parked", await waitFor(() => bridge.polling(), 15000), "");

  // 2. an `open` for an http page -> the page is loaded and acked
  let t0 = Date.now();
  await bridge.deliver({ v: 1, kind: "open", moveId: "smoke-open-1", tabs: [{ url: bridge.pageBase + "/page?n=1", active: true }] });
  const ack1 = await waitFor(async () => (await sends(t0)).find((e) => e.kind === "ack" && e.moveId === "smoke-open-1"), 15000);
  check("open (http) -> acked", !!ack1, `ack=${JSON.stringify(ack1)}`);

  // 3. an `open` with only non-http URLs -> refused: no ack, a dbg line naming schemes only
  t0 = Date.now();
  await bridge.deliver({ v: 1, kind: "open", moveId: "smoke-open-bad", tabs: [{ url: "file:///C:/Windows/win.ini" }, { url: "chrome://settings/" }] });
  await sleep(4000);
  const badAck = (await sends(t0)).find((e) => e.moveId === "smoke-open-bad");
  const dropLine = (await dbgs(t0)).find((l) => l.includes("dropped"));
  check("open (non-http) -> refused, not acked", !badAck && !!dropLine && !/win\.ini|settings/.test(dropLine), `ack=${JSON.stringify(badAck)} dbg=${JSON.stringify(dropLine)}`);

  // 4. a malformed envelope (not JSON) -> the loop keeps polling
  // (The extension backs off 3 s on an unreadable body, then polls again: a poll parked again some
  // seconds later is the evidence. bridgerig logs an /events only when it ENDS, so the hand-out of
  // the malformed body shows up there as its own entry.)
  t0 = Date.now();
  await bridge.deliver("{not json");
  await sleep(1000);
  const handedOut = (await since(t0)).find((e) => e.path === "/events" && e.body === "{not json");
  const repolled = await waitFor(() => bridge.polling(), 10000);
  check("a malformed envelope does not stop polling", !!repolled, `poll parked again ${Date.now() - t0} ms after the malformed body` + (handedOut ? " (bridge log: the malformed body was handed to a poll, status " + handedOut.status + ")" : ""));

  // 5. whole-window open -> made, reported, acked; capture that rect -> its tabs sent; ack -> closed
  t0 = Date.now();
  await bridge.deliver({ v: 1, kind: "open", moveId: "smoke-win-1", asWindow: true, tabs: [{ url: bridge.pageBase + "/page?w=a", active: true }, { url: bridge.pageBase + "/page?w=b" }] });
  const tw = await waitFor(async () => (await since(t0)).find((e) => e.path === "/teleport-window"), 15000);
  const winAck = await waitFor(async () => (await sends(t0)).find((e) => e.kind === "ack" && e.moveId === "smoke-win-1"), 15000);
  check("open (asWindow) -> window made, reported and acked", !!tw && !!winAck, tw ? `teleport-window ${JSON.stringify({ left: tw.query.left, top: tw.query.top, width: tw.query.width, height: tw.query.height })}` : "no /teleport-window");
  if (tw) {
    await sleep(3000);
    t0 = Date.now();
    const rect = { wl: +tw.query.left, wt: +tw.query.top, ww: +tw.query.width, wh: +tw.query.height };
    await bridge.deliver({ v: 1, kind: "capture-window", ...rect, lone: false, cid: "smoke-cid" });
    const out = await waitFor(async () => (await sends(t0)).find((e) => e.kind === "open" && e.asWindow), 10000);
    const urls = out ? out.tabs.map((t) => t.url) : [];
    const lines = (await dbgs(t0)).filter((l) => /capture-window/.test(l));
    // Edge's headless default windows can share identical bounds: then the tie rule must either take
    // the focused one or abort — never silently take the first listed.
    if (out) check("capture-window (exact rect, lone:false) -> the window's tabs are sent in order", urls.length === 2 && urls[0].endsWith("w=a") && urls[1].endsWith("w=b"), `open tabs=${JSON.stringify(urls)} | ${lines.join(" | ").slice(0, 300)}`);
    else check("capture-window: no send means the tie rule aborted (identical bounds, none focused)", lines.some((l) => /match the dragged rect equally/.test(l)), lines.join(" | ").slice(0, 400));
    if (out) {
      t0 = Date.now();
      await bridge.deliver({ v: 1, kind: "ack", moveId: out.moveId });
      const done = await waitFor(async () => (await dbgs(t0)).find((l) => l.startsWith("close: done")), 10000);
      check("ack -> the captured window's tabs were closed and nothing was kept", !!done && /kept 0, window closed/.test(done) && !(await since(t0)).some((e) => e.path === "/source-kept"),
        (await dbgs(t0)).filter((l) => /close/.test(l)).join(" | ").slice(0, 400));
    }
  }

  // 6. every request carried the same client id
  const bridgeReqs = (await bridge.log()).filter((e) => !e.path.startsWith("/page") && e.path !== "/favicon.ico");
  const ids = new Set(bridgeReqs.map((e) => e.query.client));
  const without = bridgeReqs.filter((e) => !e.query.client).map((e) => e.method + " " + e.path);
  check("every bridge request carries one client id", ids.size === 1 && !ids.has(undefined), `client ids seen: ${JSON.stringify([...ids])}; ${bridgeReqs.length} requests` + (without.length ? "; without: " + JSON.stringify(without) : ""));

  // 7. idle: the worker stays the same worker (a new worker would probe /hello again) and the browser is quiet
  const hellos = async () => (await bridge.log()).filter((e) => e.path === "/hello").length;
  const hellosBefore = await hellos();
  const { pids } = treePids([profile]);
  const c0 = cpuSeconds(pids);
  const idleMs = 75000;
  await sleep(idleMs);
  const c1 = cpuSeconds(pids);
  const hellosAfter = await hellos();
  check(`idle ${idleMs / 1000} s: same worker (no new /hello) and low CPU`, hellosAfter === hellosBefore && c1 - c0 < 3,
    `/hello ${hellosBefore} -> ${hellosAfter}; browser-tree CPU ${(c1 - c0).toFixed(2)} s over ${idleMs / 1000} s`);
} catch (e) {
  check("smoke run", false, String((e && e.stack) || e));
} finally {
  const k = await killTrees([profile]);
  check("browser tree cleaned up", k.left === 0, `killed ${k.killed}, left ${k.left}`);
  bridge.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { console.log("note: could not delete " + tmp + ": " + e.message); }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
