# Tab Teleporter

Drag/send a browser tab to your **other computer** — preserving the YouTube/video
timestamp and scroll position — when both machines run [Merged](https://github.com/bawat/Merged)
(the KVM + cross-machine drag tool).

These are the **browser plugins**. The cross-machine transport, the encrypted link, and
(eventually) the drag-across-the-screen gesture all live in Merged. The plugin just talks
to a small loopback bridge Merged exposes on `127.0.0.1`; Merged relays it to the peer.
That means **adding a new browser is a JavaScript-only PR** — see [PROTOCOL.md](PROTOCOL.md).

## Browsers

| Folder | Engine | Browsers |
|---|---|---|
| [`chrome/`](chrome/) | Chromium (MV3) | Chrome, Edge, Brave, Opera, Vivaldi, Yandex, Samsung Internet, … |
| [`firefox/`](firefox/) | Gecko (MV3) | Firefox (desktop + Android) and forks |
| [`safari/`](safari/) | WebKit | Safari (macOS/iOS) — built via Xcode |

Three engine builds cover the top browsers — see [BROWSERS.md](BROWSERS.md) for the full
per-browser mapping and per-store submission notes. Adding another engine is a JS-only PR
against [PROTOCOL.md](PROTOCOL.md).

## Editing: `src/` is the source, the browser folders are generated

`chrome/`, `firefox/` and `safari/` are **build output**. Edit only `src/`:

| In `src/` | What it is |
|---|---|
| `background.js` | the whole extension logic, shared by every engine |
| `options.html`, `options.js`, `icon*.png` | the options page and icons, shared |
| `manifest.base.json` | the manifest every engine shares — **the one version number** lives here |
| `manifest.chrome.json`, `manifest.firefox.json`, `manifest.safari.json` | per-engine overrides, merged over the base |

An override replaces a value, deletes a key with `null`, and removes array elements with
`{"$remove": [...]}` (Firefox swaps `background.service_worker` for `background.scripts`;
Safari drops the `bookmarks` permission). Behaviour that differs per engine goes in
`background.js` as a runtime feature check (as it already does for `tabs.move` and
`bookmarks`), never in a per-engine copy.

After editing (Node 18+, no `npm install` needed — there are no dependencies):

```sh
node tools/build.mjs          # regenerate chrome/, firefox/, safari/   (npm run build)
npm test                      # node --test test/*.test.mjs — includes the --check below
node tools/build.mjs --check  # fails, naming the file, if a generated folder differs from src/
```

Commit `src/` **and** the regenerated folders together: the folders stay in git so the
extension can be loaded unpacked straight from the repo with no build step. Each generated
`background.js` starts with a "GENERATED" header. The build only writes the files it
generates (it never deletes, so `safari/README.md` is safe). Bump `version` in
`src/manifest.base.json` for a release.

`test/harness.mjs` runs the real `src/background.js` in Node with a fake `chrome`, `fetch`
and clock, so behaviour can be tested without a browser.

**Real-browser smoke test (opt-in, Windows + Edge, ~2 min):** `npm run smoke`
(`node tools/smoke-edge.mjs`). It starts a fake bridge on a free loopback port, loads a copy
of the built `chrome/` folder whose endpoints point at it (the real bridge on 24817/24812 is
never contacted) into **headless** Edge with a throw-away profile, drives the extension
through the bridge (boot, open, a refused non-http open, a malformed envelope, a whole-window
capture and close, idle keep-alive), prints PASS/FAIL with the evidence from the bridge's
request log, then kills the browser tree and checks nothing is left. Not part of `npm test`.

`node tools/smoke-edge.mjs --go <bridgerig.exe>` runs the same checks against the **real** Go bridge,
and `npm run integration -- <bridgerig.exe>` (`tools/integration-edge.mjs`) drives several
extensions at once against it: two profiles (per-client delivery, focus, ack routing,
broadcasts), a foreign extension refused by `/hello`, an older extension version (`OLD_REF=<git
ref>`, default `80d861c`), and carry-back peek/ack. `bridgerig` lives in the wrapper repo
(`go build -o bridgerig.exe ./testing/tools/bridgerig`). Both are opt-in and Windows + Edge only.

## Install (Chrome / Chromium, unpacked)

1. Run Merged on **both** computers (`merged serve` on one, `merged connect <host>` on the
   other). It exposes the local bridge automatically.
2. On each computer: open `chrome://extensions`, enable **Developer mode**, click
   **Load unpacked**, and select this repo's `chrome/` folder.

That's it — the extension **auto-configures** itself from the local Merged bridge (no token to
paste). For Firefox use `about:debugging` → *Load Temporary Add-on* → `firefox/manifest.json`;
for Safari see [safari/README.md](safari/README.md). Once the Chrome Web Store listing is live,
Merged can force-install it for you (`merged browser-install`, or automatically on launch).

## Use

**Drag a browser window across the screen seam** to the other computer — it teleports there
(all its tabs, restored to the same video time / scroll) and closes here, riding the cursor
until you drop it. You can also teleport the active tab via the toolbar icon, the
**Ctrl+Shift+Y** shortcut, or right-click → **Teleport this tab to the other computer**.

## What carries (and what doesn't)

Carries: URL, the tab, scroll position, `<video>` time. Does **not** (Chrome doesn't
expose it to extensions): back/forward history, unsubmitted form fields, sub-frame state.
