#!/usr/bin/env node
// build.mjs — generates the loadable chrome/, firefox/ and safari/ folders from src/.
//
// src/ is the ONLY place the extension is edited. The three engine folders are build OUTPUT, but
// they stay committed: "Load unpacked from the repo folder, no build step" is how the extension is
// installed by hand and how the MouseTransfer wrapper's rig loads it (testing/rig/load_ext.py zips
// <repo>/chrome or <repo>/firefox as-is). Before this existed the three folders were hand-synced
// copies, and they drifted: firefox/ and safari/ ran months-old versions of chrome/'s logic.
//
//   node tools/build.mjs           regenerate chrome/, firefox/, safari/ from src/
//   node tools/build.mjs --check   exit 1 (naming each file) if a committed generated file differs
//                                  from what the build would write; writes nothing
//
// Zero dependencies (Node >= 18). Text files are generated with LF line endings and compared with
// CRLF folded to LF, so the check gives the same answer in an LF checkout and in a Windows
// core.autocrlf=true (CRLF) checkout. Binary files (the icons) are compared byte for byte.
//
// Manifests: src/manifest.base.json deep-merged with src/manifest.<browser>.json. Merge rules:
//   - an object merges key by key, recursively;
//   - any other value (string, number, array) REPLACES the base value;
//   - null DELETES the key (firefox: background.service_worker -> null, then background.scripts);
//   - {"$remove": [...]} applied to a base ARRAY removes those elements and keeps the rest
//     (safari: permissions minus "bookmarks", so a permission added to the base still reaches it).
//
// The build only writes the files it generates; anything else in an output folder (e.g.
// safari/README.md) is never touched or deleted.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");
export const BROWSERS = ["chrome", "firefox", "safari"];

// Copied verbatim (text files get their line endings normalised to LF).
const TEXT_FILES = ["options.html", "options.js"];
const BINARY_FILES = ["icon16.png", "icon48.png", "icon128.png"];

const GENERATED_HEADER =
  "// GENERATED from src/background.js by tools/build.mjs. Do not edit this copy: edit src/ and run\n" +
  "// `node tools/build.mjs` (CI/tests run `node tools/build.mjs --check`). See README.md.\n";

// Key order for generated manifests, so they read like the hand-written ones did. Keys not listed
// keep their merge order after these.
const MANIFEST_KEY_ORDER = ["manifest_version", "name", "version", "description", "key",
  "browser_specific_settings", "action", "icons", "permissions", "host_permissions", "background",
  "options_ui", "commands"];

const lf = (s) => s.replace(/\r\n/g, "\n");
const readText = (p) => lf(fs.readFileSync(p, "utf8"));
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export function mergeManifest(base, over) {
  if (isPlainObject(over) && Array.isArray(over.$remove)) {
    if (!Array.isArray(base)) throw new Error("$remove applied to a non-array: " + JSON.stringify(base));
    const drop = new Set(over.$remove.map((x) => JSON.stringify(x)));
    for (const x of over.$remove) {
      if (!base.some((b) => JSON.stringify(b) === JSON.stringify(x))) throw new Error("$remove: " + JSON.stringify(x) + " is not in the base array");
    }
    return base.filter((x) => !drop.has(JSON.stringify(x)));
  }
  if (!isPlainObject(over) || !isPlainObject(base)) return structuredClone(over);
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(over)) {
    if (v === null) {
      if (!(k in out)) throw new Error("override deletes key '" + k + "' that the base does not have");
      delete out[k];
    } else if (k in out) {
      out[k] = mergeManifest(out[k], v);
    } else {
      out[k] = structuredClone(v);
    }
  }
  return out;
}

function orderKeys(m) {
  const out = {};
  for (const k of MANIFEST_KEY_ORDER) if (k in m) out[k] = m[k];
  for (const k of Object.keys(m)) if (!(k in out)) out[k] = m[k];
  return out;
}

// expected() returns { "<browser>/<file>": {text|bytes} } for every generated file.
export function expected() {
  const base = JSON.parse(readText(path.join(SRC, "manifest.base.json")));
  const bg = GENERATED_HEADER + "\n" + readText(path.join(SRC, "background.js"));
  const files = {};
  for (const b of BROWSERS) {
    const over = JSON.parse(readText(path.join(SRC, `manifest.${b}.json`)));
    files[`${b}/manifest.json`] = { text: JSON.stringify(orderKeys(mergeManifest(base, over)), null, 2) + "\n" };
    files[`${b}/background.js`] = { text: bg };
    for (const f of TEXT_FILES) files[`${b}/${f}`] = { text: readText(path.join(SRC, f)) };
    for (const f of BINARY_FILES) files[`${b}/${f}`] = { bytes: fs.readFileSync(path.join(SRC, f)) };
  }
  return files;
}

function matches(abs, want) {
  if (!fs.existsSync(abs)) return false;
  if (want.bytes) return fs.readFileSync(abs).equals(want.bytes);
  return readText(abs) === want.text;
}

export function check() {
  const bad = [];
  for (const [rel, want] of Object.entries(expected())) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) bad.push(rel + " (missing)");
    else if (!matches(abs, want)) bad.push(rel);
  }
  return bad;
}

function build() {
  let wrote = 0;
  for (const [rel, want] of Object.entries(expected())) {
    const abs = path.join(ROOT, rel);
    if (matches(abs, want)) continue; // leave an up-to-date file (and its line endings) alone
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, want.bytes || want.text);
    console.log("wrote " + rel);
    wrote++;
  }
  console.log(wrote ? `build: ${wrote} file(s) written` : "build: everything already up to date");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--check")) {
    const bad = check();
    if (bad.length) {
      console.error("build --check: generated files are out of date with src/ (run `node tools/build.mjs`):");
      for (const f of bad) console.error("  " + f);
      process.exit(1);
    }
    console.log("build --check: chrome/, firefox/, safari/ match src/");
  } else {
    build();
  }
}
