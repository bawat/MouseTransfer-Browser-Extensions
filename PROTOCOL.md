# Tab Teleporter wire protocol

This repo holds the **browser-side plugins** for teleporting a tab to another computer.
The cross-machine transport and the encrypted link between computers are handled by
**Merged** (`merged.exe`), which exposes a small loopback HTTP bridge that a browser
extension talks to. Merged relays whatever the extension sends, **verbatim and opaque**,
to the Merged instance on the other computer, which hands it to *its* local extension.

So adding a new browser is a **JavaScript-only** job: implement this protocol against the
loopback bridge. You never touch Go or the network between machines.

## Folder layout

- `chrome/` — Chrome / Edge / Brave / any Chromium browser (MV3).
- _your browser here_ — e.g. `firefox/`, `safari/`. Open a PR.

## The loopback bridge

Merged listens on `http://127.0.0.1:24812` (loopback only) and authenticates every
request with a per-install token (the user pastes the endpoint + token into the
extension's options; Merged logs both on startup and stores the token in
`browserlink-token` in its config folder).

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
  "tabs": [
    { "url": "https://…", "active": true, "scrollX": 0, "scrollY": 1280, "videoTime": 87.5 }
  ]
}
```

- `moveId` — unique per teleport; echoed back in the `ack` so the sender knows which tab to close.
- `tabs` — one or more tabs (v1 senders may send just one). Fields beyond `url` are
  best-effort restore hints; a receiver restores what it can and ignores the rest.
- `videoTime` — seconds into the first `<video>`. (Chrome also bakes YouTube time into
  the URL via `&t=Ns` since that restores most reliably.)

### `ack` — "I opened it; you may close yours"

```json
{ "v": 1, "kind": "ack", "moveId": "f1c2…" }
```

The receiver sends this once the tab is open (and after a best-effort state restore).
The original sender then closes the source tab. If no `ack` arrives, the sender keeps
its tab (nothing is lost).

## Fidelity

What carries: the URL, the set of tabs, scroll position, and `<video>` time. What does
**not** (Chrome doesn't expose it to extensions): back/forward history, unsubmitted form
fields, and sub-frame / ephemeral JS state. Don't promise more than the achievable set.
