# Tab Teleporter

Drag/send a browser tab to your **other computer** — preserving the YouTube/video
timestamp and scroll position — when both machines run [Merged](https://github.com/bawat/Merged)
(the KVM + cross-machine drag tool).

These are the **browser plugins**. The cross-machine transport, the encrypted link, and
(eventually) the drag-across-the-screen gesture all live in Merged. The plugin just talks
to a small loopback bridge Merged exposes on `127.0.0.1`; Merged relays it to the peer.
That means **adding a new browser is a JavaScript-only PR** — see [PROTOCOL.md](PROTOCOL.md).

## Browsers

| Folder | Browsers |
|---|---|
| [`chrome/`](chrome/) | Chrome, Edge, Brave, and other Chromium browsers (Manifest V3) |

Want Firefox/Safari/etc.? Implement [PROTOCOL.md](PROTOCOL.md) in a new folder and open a PR.

## Install (Chrome)

1. Run Merged on **both** computers (`merged serve` on one, `merged connect <host>` on the
   other). On startup each logs a line like:
   `browser-tab teleport ready  endpoint=http://127.0.0.1:24812  token=<hex>`
   (the token is also saved as `browserlink-token` in the Merged config folder).
2. On each computer: open `chrome://extensions`, enable **Developer mode**, click
   **Load unpacked**, and select this repo's `chrome/` folder.
3. Right-click the extension → **Options**. Enter that computer's bridge endpoint and
   token, then **Save**. (Each computer uses its own local token.)

## Use

Open a tab, then **teleport it** via any of:
- click the extension's toolbar icon,
- the **Ctrl+Shift+Y** shortcut, or
- right-click the page → **Teleport this tab to the other computer**.

The tab opens on the other computer (restored to the same video time / scroll) and closes
here. A future Merged release will add the physical "drag the tab across the screen edge"
gesture on top of this same protocol.

## What carries (and what doesn't)

Carries: URL, the tab, scroll position, `<video>` time. Does **not** (Chrome doesn't
expose it to extensions): back/forward history, unsubmitted form fields, sub-frame state.
