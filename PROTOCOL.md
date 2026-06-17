# Tab Teleporter wire protocol

This repo holds the **browser-side plugins** for teleporting a tab to another computer.
The cross-machine transport and the encrypted link between computers are handled by
**Merged** (`merged.exe`), which exposes a small loopback HTTP bridge that a browser
extension talks to. Merged relays whatever the extension sends, **verbatim and opaque**,
to the Merged instance on the other computer, which hands it to *its* local extension.

So adding a new browser is a **JavaScript-only** job: implement this protocol against the
loopback bridge. You never touch Go or the network between machines.

## Folder layout

- `chrome/` — Chromium (MV3): Chrome, Edge, Brave, Opera, Vivaldi, Yandex, Samsung, …
- `firefox/` — Gecko (MV3): Firefox and forks.
- `safari/` — WebKit: Safari (built via Xcode — see `safari/README.md`).
- See [BROWSERS.md](BROWSERS.md) for the full per-browser → build → store mapping.

A new engine is a JS-only PR. The JS is identical across builds (a one-line shim at the top
of `background.js` points `chrome.*` at the promise-based `browser.*` on Firefox/Safari);
only the manifest and packaging differ.

## The loopback bridge

Merged listens on `http://127.0.0.1:24812` (loopback only). The extension fetches its
per-install token automatically from `POST /hello` (it sends a fixed `X-Teleport-Client:
merged-tab-teleporter` header, which a web page can't send — the CORS preflight is refused —
so only an extension with `127.0.0.1` host access can get the token). No manual paste; the
endpoint/token can still be overridden in the extension's options.

| Method & path | Purpose |
|---|---|
| `POST /send?token=<t>` | Body is one envelope (JSON). Merged relays it to the peer computer. `204` on success, `503` if no peer is currently connected. |
| `GET /events?token=<t>` | **Long-poll** for the next envelope the peer sent us. `200` + envelope JSON when one arrives; `204` after ~25s idle (just poll again). |

Use a token query param (not a header) to avoid a CORS preflight. Keep one `/events`
long-poll outstanding at all times.

## Envelopes

Merged does not parse these — both extensions must agree on them. Always include `v`.

### `open` — "please open this tab on your computer"

```json
{
  "v": 1,
  "kind": "open",
  "moveId": "f1c2…",
  "asWindow": true,
  "tabs": [
    { "url": "https://…", "active": true, "scrollX": 0, "scrollY": 1280, "videoTime": 87.5 }
  ]
}
```

- `moveId` — unique per teleport; echoed back in the `ack` so the sender knows what to close.
- `asWindow` — when true the receiver opens all `tabs` as a **new window** (a dragged
  browser window); when false/absent it opens `tabs[0]` as a single tab (a one-tab send).
- `tabs` — one or more tabs. Fields beyond `url` are best-effort restore hints; a receiver
  restores what it can and ignores the rest. `active` marks the tab to focus.
- `videoTime` — seconds into the first `<video>`. (Chrome also bakes YouTube time into
  the URL via `&t=Ns` since that restores most reliably.)

### `capture-window` — (Merged → its LOCAL extension only)

```json
{ "v": 1, "kind": "capture-window" }
```

Not a peer message: Merged pushes this to the extension on the *same* computer when it
detects a browser window dragged across the screen seam. The extension captures the
focused window's tabs and sends them to the peer as an `open` with `asWindow: true`.

### `ack` — "I opened it; you may close yours"

```json
{ "v": 1, "kind": "ack", "moveId": "f1c2…" }
```

The receiver sends this once the tab/window is open. The original sender then closes the
source tab (or whole window, for an `asWindow` move). If no `ack` arrives, the sender keeps
it (nothing is lost).

## Fidelity

What carries: the URL, the set of tabs, scroll position, and `<video>` time. What does
**not** (Chrome doesn't expose it to extensions): back/forward history, unsubmitted form
fields, and sub-frame / ephemeral JS state. Don't promise more than the achievable set.
