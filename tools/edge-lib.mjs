// edge-lib.mjs — shared helpers for the opt-in real-browser scripts (smoke-edge.mjs,
// integration-edge.mjs). Windows + Microsoft Edge only. Everything here is built to be safe on a
// machine somebody is using: HEADLESS browsers, throw-away profiles, never the user's profile, and a
// cleanup that kills the whole browser tree (matched by profile path + descendants) and verifies it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const EDGE = process.env.EDGE_PATH || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function preflight() {
  if (process.platform !== "win32") { console.error("Windows only (drives headless Microsoft Edge)"); process.exit(2); }
  if (!fs.existsSync(EDGE)) { console.error("Edge not found at " + EDGE + " (set EDGE_PATH)"); process.exit(2); }
}

export async function waitFor(pred, ms, step = 200) {
  const end = Date.now() + ms;
  for (;;) { const v = await pred(); if (v) return v; if (Date.now() > end) return null; await sleep(step); }
}

// copyExtension copies an extension folder to a fresh temp dir and points its endpoint constant(s)
// at base. It refuses (exit 2, after deleting the copy) if any CODE line of the copy still names a
// real bridge port (24812/24817), so the real bridge is never contacted.
export function copyExtension(srcDir, base, tmpRoot) {
  const dir = fs.mkdtempSync(path.join(tmpRoot, "ext-"));
  fs.cpSync(srcDir, dir, { recursive: true });
  const bgPath = path.join(dir, "background.js");
  let bg = fs.readFileSync(bgPath, "utf8");
  let n = 0;
  bg = bg.replace(/const (DEFAULT_ENDPOINT|LEGACY_ENDPOINT) = "http:\/\/127\.0\.0\.1:248(12|17)";/g, (m, name) => { n++; return `const ${name} = "${base}";`; });
  if (!n) throw new Error("no endpoint constant found in " + bgPath);
  fs.writeFileSync(bgPath, bg);
  const leftovers = bg.split("\n").map((l) => (l.trim().startsWith("//") ? "" : l.replace(/\s\/\/\s.*$/, ""))).filter((l) => /2481[27]/.test(l));
  if (leftovers.length) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    console.error("the copy still names a real bridge port in code — not launching:\n" + leftovers.join("\n"));
    process.exit(2);
  }
  return dir;
}

export function launchEdge(extDir, profile) {
  const args = ["--headless=new", "--user-data-dir=" + profile, "--no-first-run", "--no-default-browser-check",
    "--disable-features=DisableLoadExtensionCommandLineSwitch", "--load-extension=" + extDir, "about:blank"];
  spawn(EDGE, args, { detached: true, stdio: "ignore" }).unref();
}

function psJson(script) {
  const out = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" }).trim();
  return out ? JSON.parse(out) : [];
}

// treePids: msedge processes whose command line names one of the profiles, plus every descendant.
export function treePids(profiles) {
  const all = psJson(`@(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Select-Object ProcessId,ParentProcessId,CommandLine) | ConvertTo-Json -Compress`);
  const list = (Array.isArray(all) ? all : [all]).filter(Boolean);
  const ids = new Set(list.filter((p) => p.CommandLine && profiles.some((pr) => p.CommandLine.includes(pr))).map((p) => p.ProcessId));
  for (let grew = true; grew;) { grew = false; for (const p of list) if (ids.has(p.ParentProcessId) && !ids.has(p.ProcessId)) { ids.add(p.ProcessId); grew = true; } }
  return { pids: [...ids], extensionProcs: list.filter((p) => ids.has(p.ProcessId) && /--extension-process/.test(p.CommandLine || "")).length };
}

export function cpuSeconds(pids) {
  if (!pids.length) return 0;
  const r = psJson(`@(Get-Process -Id ${pids.join(",")} -ErrorAction SilentlyContinue | Select-Object @{n='s';e={$_.TotalProcessorTime.TotalSeconds}}) | ConvertTo-Json -Compress`);
  return (Array.isArray(r) ? r : [r]).reduce((a, x) => a + ((x && x.s) || 0), 0);
}

export async function killTrees(profiles) {
  const { pids } = treePids(profiles);
  if (pids.length) { try { execFileSync("taskkill", ["/F", ...pids.flatMap((p) => ["/PID", String(p)])], { stdio: "ignore" }); } catch (e) {} }
  await sleep(2000);
  return { killed: pids.length, left: treePids(profiles).pids.length };
}

export function tempRoot(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

export function checker() {
  const results = [];
  const check = (name, ok, evidence) => {
    results.push({ name, ok: !!ok });
    console.log((ok ? "PASS " : "FAIL ") + name + (evidence ? "\n       " + evidence : ""));
  };
  return { results, check };
}
