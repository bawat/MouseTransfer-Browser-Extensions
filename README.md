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
