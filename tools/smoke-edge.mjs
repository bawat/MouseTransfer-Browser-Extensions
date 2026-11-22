#!/usr/bin/env node
// smoke-edge.mjs — OPT-IN end-to-end check of the BUILT chrome/ extension in a real browser.
// Not part of `npm test`: it needs Microsoft Edge (Windows) and takes about two minutes.
//
//   node tools/smoke-edge.mjs            (npm run smoke)
//   EDGE_PATH=<msedge.exe> node tools/smoke-edge.mjs
//
// What it does, and why it is safe on a machine somebody is using:
//   - starts a FAKE bridge in this process on a free loopback port. It implements every endpoint the
//     extension calls, logs every request, and also serves the test pages (so nothing goes to the
//     internet);
//   - copies chrome/ to a temporary folder and points BOTH endpoint constants at the fake bridge — the
//     real bridge (24817 / 24812) is never contacted; the copy is checked before launch;
//   - launches Edge HEADLESS with a throw-away --user-data-dir (no window, never the user's profile)
//     and loads the copy with --load-extension (Edge honours it; branded Chrome 137+ does not);
//   - kills the WHOLE browser tree afterwards (matched by the profile path in each command line, plus
//     descendants) and verifies nothing is left; deletes the temporary folders.
// Each check prints PASS/FAIL with the evidence from the fake bridge's log; exit code 1 on any FAIL.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EDGE = process.env.EDGE_PATH || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
if (process.platform !== "win32") { console.error("smoke-edge: Windows only (it drives headless Microsoft Edge)"); process.exit(2); }
if (!fs.existsSync(EDGE)) { console.error("smoke-edge: Edge not found at " + EDGE + " (set EDGE_PATH)"); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, evidence) {
  results.push({ name, ok });
  console.log((ok ? "PASS " : "FAIL ") + name + (evidence ? "\n       " + evidence : ""));
}

// ---------------- fake bridge ----------------
const TOKEN = "smoke-token-" + Math.random().toString(36).slice(2, 10);
const log = [];             // every request: {t, method, path, query, body}
const queue = [];           // envelopes waiting for /events
const parked = [];          // held /events responses
function deliver(env) {
  const s = JSON.stringify(env);
  const res = parked.shift();
  if (res) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(s); } else queue.push(s);
}
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const entry = { t: Date.now(), method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body };
    log.push(entry);
    const authed = u.searchParams.get("token") === TOKEN;
    const json = (code, o) => { res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }); res.end(JSON.stringify(o)); };
    const empty = (code) => { res.writeHead(code, { "Access-Control-Allow-Origin": "*" }); res.end(); };
    if (u.pathname.startsWith("/page")) { res.writeHead(200, { "Content-Type": "text/html" }); res.end("<!doctype html><title>smoke " + u.search + "</title><p style='height:3000px'>smoke page</p>"); return; }
    if (u.pathname === "/hello") { if (req.headers["x-teleport-client"] !== "merged-tab-teleporter") return empty(403); return json(200, { token: TOKEN }); }
    if (!authed) return empty(403);
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
      default: return empty(204); // /send /debug /focus /teleport-window /winstate /source-kept /carryback-ack ...
    }
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;
const BASE = "http://127.0.0.1:" + PORT;
console.log("fake bridge on " + BASE);

// ---------------- the extension copy ----------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-smoke-"));
const extDir = path.join(tmp, "ext");
const profile = path.join(tmp, "profile");
fs.cpSync(path.join(ROOT, "chrome"), extDir, { recursive: true });
const bgPath = path.join(extDir, "background.js");
let bg = fs.readFileSync(bgPath, "utf8");
const swap = (re, to) => { const n = (bg.match(re) || []).length; if (n !== 1) throw new Error("expected one match of " + re + ", found " + n); bg = bg.replace(re, to); };
swap(/const DEFAULT_ENDPOINT = "http:\/\/127\.0\.0\.1:24817";/, `const DEFAULT_ENDPOINT = "${BASE}";`);
swap(/const LEGACY_ENDPOINT = "http:\/\/127\.0\.0\.1:24812";/, `const LEGACY_ENDPOINT = "${BASE}";`);
fs.writeFileSync(bgPath, bg);
// Code only: drop whole-line comments and trailing " // ..." comments before looking.
const leftovers = bg.split("\n").map((l) => (l.trim().startsWith("//") ? "" : l.replace(/\s\/\/\s.*$/, ""))).filter((l) => /2481[27]/.test(l));
if (leftovers.length) {
  fs.rmSync(tmp, { recursive: true, force: true });
  console.error("smoke-edge: the copy still names a real bridge port in code — not launching:\n" + leftovers.join("\n"));
  process.exit(2);
}
console.log("extension copy: " + extDir + " (both endpoints -> " + BASE + ")");

// ---------------- browser ----------------
const args = ["--headless=new", "--user-data-dir=" + profile, "--no-first-run", "--no-default-browser-check",
  "--disable-features=DisableLoadExtensionCommandLineSwitch", "--load-extension=" + extDir, "about:blank"];
spawn(EDGE, args, { detached: true, stdio: "ignore" }).unref();

function psJson(script) {
  const out = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" }).trim();
  return out ? JSON.parse(out) : [];
}
function treePids() {
  // Roots = msedge processes whose command line names our profile; then every descendant.
  const esc = profile.replace(/'/g, "''");
  const all = psJson(`@(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Select-Object ProcessId,ParentProcessId,CommandLine) | ConvertTo-Json -Compress`);
  const list = Array.isArray(all) ? all : [all];
  const ids = new Set(list.filter((p) => p && p.CommandLine && p.CommandLine.includes(esc)).map((p) => p.ProcessId));
  for (let grew = true; grew;) { grew = false; for (const p of list) if (p && ids.has(p.ParentProcessId) && !ids.has(p.ProcessId)) { ids.add(p.ProcessId); grew = true; } }
  return { pids: [...ids], extensionProcs: list.filter((p) => p && ids.has(p.ProcessId) && /--extension-process/.test(p.CommandLine || "")).length };
}
function cpuSeconds(pids) {
  if (!pids.length) return 0;
  const r = psJson(`@(Get-Process -Id ${pids.join(",")} -ErrorAction SilentlyContinue | Select-Object @{n='s';e={$_.TotalProcessorTime.TotalSeconds}}) | ConvertTo-Json -Compress`);
  return (Array.isArray(r) ? r : [r]).reduce((a, x) => a + (x && x.s || 0), 0);
}
async function waitFor(pred, ms, step = 200) { const end = Date.now() + ms; for (;;) { const v = pred(); if (v) return v; if (Date.now() > end) return null; await sleep(step); } }
const since = (t) => log.filter((e) => e.t >= t);
const sends = (t) => since(t).filter((e) => e.path === "/send").map((e) => { try { return JSON.parse(e.body); } catch (x) { return {}; } });
const dbgs = (t) => since(t).filter((e) => e.path === "/debug").map((e) => e.body);

let exitCode = 0;
try {
  // 1. boot: token fetched, a poll parked, a client id on every request
  const hello = await waitFor(() => log.find((e) => e.path === "/hello"), 30000);
  const tree = treePids();
  check("the extension loaded (an extension process exists)", tree.extensionProcs > 0, `${tree.pids.length} browser processes, ${tree.extensionProcs} extension process(es)`);
  check("boot fetched the token (/hello)", !!hello, hello ? `POST /hello client=${hello.query.client}` : "no /hello within 30 s");
  const parkedPoll = await waitFor(() => parked.length > 0, 15000);
  check("a /events long-poll is parked", !!parkedPoll, `parked polls: ${parked.length}`);

  // 2. an `open` for an http page -> a tab opens (the page is fetched) and an ack comes back
  let t0 = Date.now();
  deliver({ v: 1, kind: "open", moveId: "smoke-open-1", tabs: [{ url: BASE + "/page?n=1", active: true }] });
  const ack1 = await waitFor(() => sends(t0).find((e) => e.kind === "ack" && e.moveId === "smoke-open-1"), 15000);
  const page1 = since(t0).find((e) => e.path === "/page" && e.query.n === "1");
  check("open (http) -> the page is loaded and acked", !!ack1 && !!page1, `ack=${JSON.stringify(ack1)} page GET=${!!page1}`);

  // 3. an `open` with only non-http URLs -> refused: no ack, a dbg line naming schemes only
  t0 = Date.now();
  deliver({ v: 1, kind: "open", moveId: "smoke-open-bad", tabs: [{ url: "file:///C:/Windows/win.ini" }, { url: "chrome://settings/" }] });
  await sleep(4000);
  const badAck = sends(t0).find((e) => e.moveId === "smoke-open-bad");
  const dropLine = dbgs(t0).find((l) => l.includes("dropped"));
  check("open (non-http) -> refused, not acked", !badAck && !!dropLine && !/win\.ini|settings/.test(dropLine), `ack=${JSON.stringify(badAck)} dbg=${JSON.stringify(dropLine)}`);

  // 4. a malformed envelope body (not JSON) -> the loop keeps polling
  t0 = Date.now();
  const res = parked.shift();
  if (res) { res.writeHead(200, { "Content-Type": "application/json" }); res.end("{not json"); }
  const repoll = await waitFor(() => since(t0).find((e) => e.path === "/events"), 10000);
  check("a malformed envelope does not stop polling", !!repoll, repoll ? `next /events ${repoll.t - t0} ms later` : "no /events after the malformed body");

  // 5. whole-window open -> the extension reports the window it made; capture that rect -> it sends
  //    the window back as an open; ack it -> the window closes (a second capture finds nothing)
  t0 = Date.now();
  deliver({ v: 1, kind: "open", moveId: "smoke-win-1", asWindow: true, tabs: [{ url: BASE + "/page?w=a", active: true }, { url: BASE + "/page?w=b" }] });
  const tw = await waitFor(() => since(t0).find((e) => e.path === "/teleport-window"), 15000);
  const winAck = await waitFor(() => sends(t0).find((e) => e.kind === "ack" && e.moveId === "smoke-win-1"), 15000);
  check("open (asWindow) -> window made, reported and acked", !!tw && !!winAck, tw ? `teleport-window ${JSON.stringify(tw.query)}` : "no /teleport-window");
  if (tw) {
    await sleep(3000); // let both pages load
    t0 = Date.now();
    const rect = { wl: +tw.query.left, wt: +tw.query.top, ww: +tw.query.width, wh: +tw.query.height };
    deliver({ v: 1, kind: "capture-window", ...rect, lone: false, cid: "smoke-cid" });
    const out = await waitFor(() => sends(t0).find((e) => e.kind === "open" && e.asWindow), 10000);
    const urls = out ? out.tabs.map((t) => t.url) : [];
    check("capture-window (exact rect, lone:false) -> the window's tabs are sent in order", urls.length === 2 && urls[0].endsWith("w=a") && urls[1].endsWith("w=b"), `open tabs=${JSON.stringify(urls)}`);
    if (out) {
      t0 = Date.now();
      deliver({ v: 1, kind: "ack", moveId: out.moveId });
      const done = await waitFor(() => dbgs(t0).find((l) => l.startsWith("close: done")), 10000);
      check("ack -> the captured window's tabs were closed and nothing was kept", !!done && /kept 0, window closed/.test(done) && !since(t0).some((e) => e.path === "/source-kept"),
        dbgs(t0).filter((l) => /close/.test(l)).join(" | ").slice(0, 400));
    }
  }

  // 6. every request carried the same client id
  // The test pages' own requests (the page, its favicon) are the browser's, not the extension's.
  const bridgeReqs = log.filter((e) => !e.path.startsWith("/page") && e.path !== "/favicon.ico");
  const ids = new Set(bridgeReqs.map((e) => e.query.client));
  const without = bridgeReqs.filter((e) => !e.query.client).map((e) => e.method + " " + e.path + " " + e.body.slice(0, 80));
  check("every bridge request carries one client id", ids.size === 1 && !ids.has(undefined), `client ids seen: ${JSON.stringify([...ids])}; ${bridgeReqs.length} requests` + (without.length ? "; without: " + JSON.stringify(without) : ""));

  // 7. idle: the worker stays the same worker (a new worker would probe /hello again) and the browser is quiet
  const hellosBefore = log.filter((e) => e.path === "/hello").length;
  const { pids } = treePids();
  const c0 = cpuSeconds(pids);
  const idleMs = 75000;
  await sleep(idleMs);
  const c1 = cpuSeconds(pids);
  const hellosAfter = log.filter((e) => e.path === "/hello").length;
  check(`idle ${idleMs / 1000} s: same worker (no new /hello) and low CPU`, hellosAfter === hellosBefore && c1 - c0 < 3,
    `/hello ${hellosBefore} -> ${hellosAfter}; browser-tree CPU ${(c1 - c0).toFixed(2)} s over ${idleMs / 1000} s; parked polls ${parked.length}`);
} catch (e) {
  check("smoke run", false, String(e && e.stack || e));
} finally {
  const { pids } = treePids();
  if (pids.length) { try { execFileSync("taskkill", ["/F", ...pids.flatMap((p) => ["/PID", String(p)])], { stdio: "ignore" }); } catch (e) {} }
  await sleep(2000);
  const left = treePids().pids.length;
  check("browser tree cleaned up", left === 0, `killed ${pids.length}, left ${left}`);
  for (const r of parked.splice(0)) { try { r.end(); } catch (e) {} }
  server.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { console.log("note: could not delete " + tmp + ": " + e.message); }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  exitCode = failed ? 1 : 0;
  process.exit(exitCode);
}
