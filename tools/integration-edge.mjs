#!/usr/bin/env node
// integration-edge.mjs — OPT-IN integration run of real extensions against the REAL Go bridge.
// Windows + Microsoft Edge; needs the wrapper repo's bridgerig built:
//   (wrapper repo) go build -o <dir>\bridgerig.exe ./testing/tools/bridgerig
//   (here)         node tools/integration-edge.mjs <dir>\bridgerig.exe
// Same safety rules as smoke-edge.mjs (headless, throw-away profiles, the real bridge never
// contacted, every browser tree killed and verified). Scenarios (each prints PASS/FAIL + evidence):
//   A. two profiles at once: an `open` reaches exactly one; after the other reports focus the next
//      `open` reaches it; an `ack` for a move sent by one reaches it and never the other; a broadcast
//      reaches both.
//   B. an extension with a different id is refused by /hello; ours is accepted.
//   C. the extension version installed before this work (git 80d861c, endpoint swapped only) boots,
//      polls and acks an `open` against the new bridge (the legacy client).
//   D. carry-back: windows queued in the bridge are drained with peek, stored as bookmarks and
//      acknowledged by id.

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { ROOT, preflight, sleep, waitFor, copyExtension, launchEdge, killTrees, tempRoot, checker } from "./edge-lib.mjs";

preflight();
const exe = process.argv[2];
if (!exe || !fs.existsSync(exe)) { console.error("usage: node tools/integration-edge.mjs <bridgerig.exe>"); process.exit(2); }
const { results, check } = checker();
const tmp = tempRoot("tt-integ-");
const profiles = [];
const rigs = [];

async function startRig() {
  const child = spawn(exe, [], { stdio: ["pipe", "pipe", "ignore"] });
  const info = await new Promise((resolve, reject) => {
    let buf = "";
    child.stdout.on("data", (d) => { buf += d; const i = buf.indexOf("\n"); if (i >= 0) resolve(JSON.parse(buf.slice(0, i))); });
    child.on("exit", (c) => reject(new Error("bridgerig exited " + c)));
  });
  const ctl = (p, init) => fetch(info.control + p, init);
  const rig = {
    ...info, child,
    deliver: (env) => ctl("/deliver", { method: "POST", body: JSON.stringify(env) }),
    deliverTo: (ids, env) => ctl("/deliver-to?ids=" + encodeURIComponent(ids.join(",")), { method: "POST", body: JSON.stringify(env) }),
    // Go encodes an empty slice as null.
    log: async () => (await (await ctl("/log")).json()) || [],
    sent: async () => (await (await ctl("/sent")).json()) || [],
    clients: async () => (await (await ctl("/clients")).json()) || [],
    carrybackFile: async () => (await (await ctl("/carryback-file")).json()) || [],
    close() { try { child.stdin.end(); } catch (e) {} try { child.kill(); } catch (e) {} },
  };
  rigs.push(rig);
  return rig;
}
async function pageServer() {
  const s = http.createServer((req, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end("<!doctype html><title>page</title><p>page</p>"); });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  return { base: "http://127.0.0.1:" + s.address().port, close: () => s.close() };
}
function profileDir(name) { const p = path.join(tmp, "profile-" + name); profiles.push(p); return p; }
const eventsTo = (log, pred) => log.filter((e) => e.path === "/events" && e.status === 200 && pred(e.body || ""));
const helloClients = (log) => [...new Set(log.filter((e) => e.path === "/hello" && e.status === 200).map((e) => e.query.client || ""))];

// ONLY=CD (env) runs just some scenario groups.
const ONLY = process.env.ONLY || "ABCD";
// OLD_REF (env): the git ref of the extension version scenario C runs (default 80d861c = 2.17).
const OLD_REF = process.env.OLD_REF || "80d861c";
const pages = await pageServer();
try {
  // ---------------- A + B: two profiles, and a foreign extension ----------------
  if (/[AB]/.test(ONLY)) {
    const rig = await startRig();
    const ext = copyExtension(path.join(ROOT, "chrome"), rig.bridge, tmp);
    launchEdge(ext, profileDir("A"));
    launchEdge(ext, profileDir("B"));
    const two = await waitFor(async () => { const c = helloClients(await rig.log()); return c.length >= 2 ? c : null; }, 40000);
    check("A0. two profiles booted against one bridge with two different client ids", !!two, JSON.stringify(two));
    if (two) {
      await waitFor(async () => (await rig.clients()).length >= 2, 15000);
      let t0 = Date.now();
      await rig.deliver({ v: 1, kind: "open", moveId: "int-open-1", tabs: [{ url: pages.base + "/p?1", active: true }] });
      await waitFor(async () => (await rig.sent()).some((s) => s.env.kind === "ack" && s.env.moveId === "int-open-1"), 15000);
      await sleep(27000); // let every parked poll end once (bridgerig logs an /events when it ends)
      let log = await rig.log();
      const got = [...new Set(eventsTo(log, (b) => b.includes("int-open-1")).map((e) => e.query.client))];
      const ackFrom = log.filter((e) => e.path === "/send" && (e.body || "").includes('"ack"') && e.body.includes("int-open-1")).map((e) => e.query.client);
      check("A1. a peer `open` reaches exactly ONE profile, and that profile acks it", got.length === 1 && ackFrom.length === 1 && ackFrom[0] === got[0], `delivered to ${JSON.stringify(got)}, ack sent by ${JSON.stringify(ackFrom)}`);
      const first = got[0], other = two.find((c) => c !== first);

      // The OTHER profile gets a window of its own (DeliverTo it), which takes focus there; its
      // extension should report /focus. Then the next peer `open` must go to it.
      t0 = Date.now();
      await rig.deliverTo([other], { v: 1, kind: "open", moveId: "int-win-other", asWindow: true, tabs: [{ url: pages.base + "/p?w", active: true }] });
      const tw = await waitFor(async () => (await rig.log()).find((e) => e.t >= t0 && e.path === "/teleport-window" && e.query.client === other), 15000);
      const focus = await waitFor(async () => (await rig.log()).find((e) => e.t >= t0 && e.path === "/focus" && e.query.client === other), 8000);
      check("A2. the other profile reports /focus when its window takes focus (headless)", !!focus, focus ? `POST /focus client=${other} status=${focus.status}` : "no /focus within 8 s — focus events may not fire in headless Edge");
      if (focus) {
        t0 = Date.now();
        await rig.deliver({ v: 1, kind: "open", moveId: "int-open-2", tabs: [{ url: pages.base + "/p?2", active: true }] });
        await waitFor(async () => (await rig.sent()).some((s) => s.env.kind === "ack" && s.env.moveId === "int-open-2"), 15000);
        await sleep(27000);
        log = await rig.log();
        const got2 = [...new Set(eventsTo(log, (b) => b.includes("int-open-2")).map((e) => e.query.client))];
        check("A3. after it reported focus, the next `open` reaches that profile only", got2.length === 1 && got2[0] === other, `delivered to ${JSON.stringify(got2)} (focused: ${other})`);
      }

      // An ack for a move sent by `other`: have it capture its own window (exact rect from its report).
      if (tw) {
        t0 = Date.now();
        const rect = { wl: +tw.query.left, wt: +tw.query.top, ww: +tw.query.width, wh: +tw.query.height };
        await sleep(2000);
        await rig.deliverTo([other], { v: 1, kind: "capture-window", ...rect, lone: false, cid: "int-cid" });
        const openSent = await waitFor(async () => (await rig.log()).find((e) => e.t >= t0 && e.path === "/send" && e.query.client === other && (e.body || "").includes('"open"')), 10000);
        if (!openSent) {
          const lines = (await rig.log()).filter((e) => e.t >= t0 && e.path === "/debug").map((e) => e.body).join(" | ");
          check("A4. the other profile sent an `open` for its captured window", false, lines.slice(0, 400));
        } else {
          const moveId = JSON.parse(openSent.body).moveId;
          t0 = Date.now();
          await rig.deliver({ v: 1, kind: "ack", moveId });
          await sleep(27000);
          log = await rig.log();
          const ackTo = [...new Set(eventsTo(log, (b) => b.includes(moveId) && b.includes('"ack"')).map((e) => e.query.client))];
          check("A4. an `ack` for a move sent by one profile reaches it and never the other", ackTo.length === 1 && ackTo[0] === other, `move ${moveId} sent by ${other}; ack delivered to ${JSON.stringify(ackTo)}`);
        }
      }

      // A broadcast kind reaches both.
      t0 = Date.now();
      await rig.deliver({ v: 1, kind: "recheck-closes" });
      await sleep(27000);
      log = await rig.log();
      const bc = [...new Set(eventsTo(log, (b) => b.includes("recheck-closes")).map((e) => e.query.client))].sort();
      check("A5. a broadcast kind (recheck-closes) reaches both profiles", bc.length === 2, `delivered to ${JSON.stringify(bc)}`);
    }

    // B. a foreign extension (no manifest key -> a random id) asks /hello the same way ours does.
    const probe = path.join(tmp, "probe");
    fs.mkdirSync(probe);
    fs.writeFileSync(path.join(probe, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "foreign probe", version: "1.0", host_permissions: ["http://127.0.0.1/*"], background: { service_worker: "bg.js" } }));
    fs.writeFileSync(path.join(probe, "bg.js"), `fetch(${JSON.stringify(rig.bridge + "/hello?client=foreign-probe")}, { method: "POST", headers: { "X-Teleport-Client": "merged-tab-teleporter" } }).catch(() => {});`);
    launchEdge(probe, profileDir("foreign"));
    const refused = await waitFor(async () => (await rig.log()).find((e) => e.path === "/hello" && e.query.client === "foreign-probe"), 30000);
    const ours = (await rig.log()).find((e) => e.path === "/hello" && e.status === 200);
    check("B. /hello refuses another extension's origin (403) and accepts ours (200)",
      refused && refused.status === 403 && ours && ours.status === 200 && /fggfgcnldlnknodemngelbmceoadpoll/.test(ours.header.Origin || ""),
      `foreign: status ${refused && refused.status} Origin=${refused && refused.header.Origin}; ours: status ${ours && ours.status} Origin=${ours && ours.header.Origin}`);
    const k = await killTrees(profiles.splice(0));
    check("A/B browser trees cleaned up", k.left === 0, `killed ${k.killed}, left ${k.left}`);
    rig.close();
  }

  // ---------------- C: the extension version installed before this work ----------------
  if (ONLY.includes("C")) {
    const rig = await startRig();
    const oldSrc = path.join(tmp, "old-src");
    fs.mkdirSync(oldSrc);
    fs.mkdirSync(path.join(oldSrc, "chrome"));
    for (const name of execFileSync("git", ["-C", ROOT, "ls-tree", "--name-only", OLD_REF, "chrome/"], { encoding: "utf8" }).split(/\r?\n/).filter(Boolean)) {
      fs.writeFileSync(path.join(oldSrc, name), execFileSync("git", ["-C", ROOT, "show", OLD_REF + ":" + name])); // bytes, as committed
    }
    const oldVersion = JSON.parse(fs.readFileSync(path.join(oldSrc, "chrome", "manifest.json"), "utf8")).version;
    const ext = copyExtension(path.join(oldSrc, "chrome"), rig.bridge, tmp);
    launchEdge(ext, profileDir("old"));
    const hello = await waitFor(async () => (await rig.log()).find((e) => e.path === "/hello" && e.status === 200), 30000);
    const polling = await waitFor(async () => (await rig.log()).length && (await (await fetch(rig.control + "/polling")).json()).polling, 15000);
    let t0 = Date.now();
    await rig.deliver({ v: 1, kind: "open", moveId: "old-open-1", tabs: [{ url: pages.base + "/p?old", active: true }] });
    const ack = await waitFor(async () => (await rig.sent()).find((s) => s.env.kind === "ack" && s.env.moveId === "old-open-1"), 15000);
    const clientParams = [...new Set((await rig.log()).map((e) => e.query.client === undefined ? "(none)" : e.query.client))];
    check(`C. the extension as installed before this work (v${oldVersion}, git ${OLD_REF}) boots, polls and acks an open`,
      hello && polling && ack, `hello status ${hello && hello.status} Origin=${hello && hello.header.Origin}; polling=${polling}; ack=${JSON.stringify(ack && ack.env)}; client params seen: ${JSON.stringify(clientParams)}`);
    const k = await killTrees(profiles.splice(0));
    check("C browser tree cleaned up", k.left === 0, `killed ${k.killed}, left ${k.left}`);
    rig.close();
  }

  // ---------------- D: carry-back peek + ack ----------------
  if (ONLY.includes("D")) {
    const rig = await startRig();
    for (const tabs of [[pages.base + "/cb?a1", pages.base + "/cb?a2"], [pages.base + "/cb?b1"]]) {
      await fetch(rig.bridge + "/carryback?token=" + rig.token, { method: "POST", body: JSON.stringify({ tabs }) });
    }
    const queued = await rig.carrybackFile();
    const ext = copyExtension(path.join(ROOT, "chrome"), rig.bridge, tmp);
    launchEdge(ext, profileDir("cb"));
    const acked = await waitFor(async () => (await rig.log()).find((e) => e.path === "/carryback-ack"), 30000);
    const log = await rig.log();
    const drains = log.filter((e) => e.path === "/carryback-drain").map((e) => "peek=" + e.query.peek + " status=" + e.status);
    const left = await rig.carrybackFile();
    const ackIds = acked ? JSON.parse(acked.body).ids : [];
    check("D. carry-back: drained with peek=1, stored, acknowledged by string id, queue empty afterwards",
      acked && ackIds.length === 2 && queued.every((w) => ackIds.includes(w.id)) && left.length === 0,
      `queued ids ${JSON.stringify(queued.map((w) => w.id))}; drains ${JSON.stringify(drains)}; acked ${JSON.stringify(ackIds)}; left ${left.length}`);
    const k = await killTrees(profiles.splice(0));
    check("D browser tree cleaned up", k.left === 0, `killed ${k.killed}, left ${k.left}`);
    rig.close();
  }
} catch (e) {
  check("integration run", false, String((e && e.stack) || e));
} finally {
  if (profiles.length) { const k = await killTrees(profiles); check("remaining browser trees cleaned up", k.left === 0, `killed ${k.killed}, left ${k.left}`); }
  for (const r of rigs) r.close();
  pages.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { console.log("note: could not delete " + tmp + ": " + e.message); }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
