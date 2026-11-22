// The committed chrome/, firefox/ and safari/ folders must be exactly what tools/build.mjs makes
// from src/, and the manifest merge must do what the per-browser overrides rely on.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { mergeManifest } from "../tools/build.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("generated folders match src/ (build --check)", () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, "tools", "build.mjs"), "--check"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("mergeManifest: replace, delete, $remove", () => {
  const base = { a: 1, bg: { service_worker: "b.js" }, perms: ["x", "bookmarks", "y"], keep: [1, 2] };
  const out = mergeManifest(base, { a: 2, bg: { service_worker: null, scripts: ["b.js"] }, perms: { $remove: ["bookmarks"] }, keep: [3], add: { z: 1 } });
  assert.deepEqual(out, { a: 2, bg: { scripts: ["b.js"] }, perms: ["x", "y"], keep: [3], add: { z: 1 } });
  assert.deepEqual(base.perms, ["x", "bookmarks", "y"], "base is not mutated");
  assert.throws(() => mergeManifest(base, { nope: null }), /does not have/);
  assert.throws(() => mergeManifest(base, { perms: { $remove: ["absent"] } }), /not in the base/);
});

test("per-browser manifests carry their engine's differences", () => {
  const m = (b) => JSON.parse(fs.readFileSync(path.join(ROOT, b, "manifest.json"), "utf8"));
  const c = m("chrome"), f = m("firefox"), s = m("safari");
  assert.equal(c.version, f.version); assert.equal(c.version, s.version);
  assert.ok(c.key && !f.key && !s.key);
  assert.deepEqual(c.background, { service_worker: "background.js" });
  assert.deepEqual(f.background, { scripts: ["background.js"] });
  assert.deepEqual(s.background, { service_worker: "background.js" });
  assert.ok(c.permissions.includes("bookmarks") && f.permissions.includes("bookmarks") && !s.permissions.includes("bookmarks"));
  assert.equal(f.browser_specific_settings.gecko.id, "tab-teleporter@mousetransfer");
  assert.equal(s.browser_specific_settings.safari.strict_min_version, "16.4");
});
