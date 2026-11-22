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
only the manifest and packaging differ. The three folders are generated from `src/` by
`node tools/build.mjs` — edit `src/`, never the folders (see the README).

## The loopback bridge

Merged listens on `http://127.0.0.1:24817` (loopback only). It used to listen on `24812`,
which is also its audio port; for one release window a Windows Merged still serves the bridge
on `127.0.0.1:24812` too, and a Linux/BSD Merged never does (there `24812` is the TLS audio
listener). So an extension with no endpoint configured tries `24817` first and `24812` second,
with a pause between attempts, and treats anything that does not answer `/hello` with a token
as "not the bridge". An endpoint the user sets in the options is used as is, with no fallback.

| Merged \ extension | 2.18+ (24817, then 24812) | before 2.18 (24812 only) |
|---|---|---|
| new, Windows | 24817 | 24812 (legacy listener) |
| new, Linux/BSD | 24817 | — |
| old, Windows | 24812 (fallback) | 24812 |

The extension fetches its per-install token automatically from `POST /hello`. No manual paste;
the endpoint/token can still be overridden in the extension's options. Merged hands the token out
only when all of these hold:

- the method is `POST`;
- the request carries the fixed header `X-Teleport-Client: merged-tab-teleporter` — a web page
  cannot send it (the CORS preflight is refused), an extension with `127.0.0.1` host access can;
- if an `Origin` header is present (measured: Chromium and Firefox send it on the extension's
  `POST` requests), it is `chrome-extension://<id>` for one of OUR ids — the unpacked id derived
  from the manifest `key` (`fggfgcnldlnknodemngelbmceoadpoll`) or the Chrome Web Store id — or
  any `moz-extension://` / `safari-web-extension://` origin (those ids are random per install
  and cannot be pinned). Any other origin — another extension, a web page — gets `403`.
  No `Origin` at all is accepted.

This raises the bar against another installed extension asking for the token; it is not a proof
of identity: an extension that can rewrite its own request headers can strip or forge `Origin`.
A build published under another store id must be added to Merged's allowlist first.

| Method & path | Purpose |
|---|---|
| `POST /send?token=<t>` | Body is one envelope (JSON). Merged relays it to the peer computer. `204` on success, `503` if no peer is currently connected. |
| `GET /events?token=<t>` | **Long-poll** for the next envelope the peer sent us. `200` + envelope JSON when one arrives; `204` after ~25s idle (just poll again). |

Use a token query param (not a header) to avoid a CORS preflight. Keep one `/events`
long-poll outstanding at all times. A `403` means the token is wrong (Merged's token changed):
drop it and fetch the current one from `/hello`, after a pause.

### Optional endpoints (2.19+)

The extension calls these on any Merged; one that does not know them answers `404`, which the
extension ignores, and every flow works without them.

**`client`** — every request (including `/hello`) also carries `&client=<id>`: a random UUID the
extension makes once per browser profile and keeps in `storage.local`. Several browsers or
profiles can run the extension against one Merged; this is how Merged tells them apart. A Merged
that does not use it ignores the unknown query parameter.

How a Merged that uses it delivers (each client has its own `/events` queue; a request with no
`client` is the *legacy* client and gets exactly the old single-queue behaviour):

| Envelope | Goes to |
|---|---|
| `open` (from the peer) | ONE live client: the one that reported `/focus` most recently, else the one that polled most recently |
| `ack` (from the peer) | the client that sent the matching `open` (Merged remembers `moveId` → client from `/send`); every live client if unknown |
| `capture-window` | the client(s) whose browser (by User-Agent) can own the dragged window; every live client if none |
| `merge-drop`, `recheck-closes`, `reload`, anything else | every live client |

A client is *live* while it has a poll parked or polled within the last poll period (~25 s).
An envelope that arrives while no client is live waits for the first client that polls (the
cold-launch case: Merged starts the browser, its extension polls, it gets the envelope). On a
machine with no extension at all, Merged's own extensionless receive path may claim an `open`
that no extension has taken — exactly one of the two ever gets it.

| Method & path | Body | Purpose |
|---|---|---|
| `POST /focus?token=<t>&client=<id>` | none | A normal window of this browser profile gained focus (a burst of focus changes sends one report, ~120 ms after the last). Lets Merged deliver an incoming teleport to the browser the user is in. |
| `GET /carryback-drain?token=<t>&peek=1` | — | The carry-back queue (whole windows closed in the teleport profile). The extension always asks with `peek=1`. A Merged that supports it answers `{"peek":true,"windows":[{"id":"<string>","tabs":["…"],"at":<ns>},…]}` and removes **nothing**; one that does not ignores `peek`, answers `{"windows":[…]}` without `"peek"` and empties its queue — the extension then puts back, with `POST /carryback {"tabs":[…]}`, every window it failed to store or open. |
| `POST /carryback-ack?token=<t>` | `{"ids":["<string>",…]}` | Only after a `peek` drain: remove these windows from the queue (they were stored as bookmarks or opened). Windows are named by the string `id`, never by `at`: a nanosecond timestamp does not survive a JavaScript number. A peek window without a string `id` is left queued. |
| `POST /source-kept?token=<t>` | `{"phase":"captured"\|"closed","moveId":"…","cid":<capture-window cid or null>,"kept":N,"sent":N}` (`sent` only with `captured`) | After a whole-window teleport the source window will **stay open** because it holds `kept` tabs that were not sent (browser-internal pages, local files, tabs opened after the capture). `captured` is sent — and its answer awaited (at most 1 s) — before the `open`; `closed` once the close has finished and the window is still open. Sent only when `kept > 0`. Merged then does not force-close that window, dismiss a close confirm on it, or nudge (`recheck-closes`) about it; and independently of this report it never force-closes a source window before the teleport was acked. |

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
- A receiver opens **only** `http:`/`https:` URLs (checked with a real URL parse) and drops
  every other entry. If no tab survives, it does not ack, so the sender keeps its tab(s).
- `videoTime` — seconds into the tab's video: a playing `<video>` if there is one, searched in
  every frame of the page. (When that video is in the top frame of a YouTube page, the sender
  also bakes the time into the URL via `&t=Ns`, since that restores most reliably.)
- `videoFrame` — *optional, since 2.19.* Present when the video was found in an embedded frame
  (an `<iframe>` player): that frame's URL **without query or fragment**
  (`origin + pathname`, e.g. `https://www.youtube-nocookie.com/embed/ID`). A receiver seeks
  only a frame whose URL matches it, so a video in another frame (an advert) is never touched.
  Absent: seek the top frame's first `<video>`, as before. Receivers that predate it ignore it
  (and so does Merged's extensionless receive path, which reads only `moveId`, `asWindow` and
  `tabs[].url`).

### `capture-window` — (Merged → its LOCAL extension only)

```json
{ "v": 1, "kind": "capture-window", "wl": 900, "wt": 100, "ww": 1050, "wh": 750 }
```

Not a peer message: Merged pushes this to the extension on the *same* computer when it
detects a browser window dragged across the screen seam. `wl`/`wt`/`ww`/`wh` are the dragged
window's on-screen rect in screen **pixels** (Win32 `GetWindowRect`) and are **required**.
The extension finds the window whose bounds match that rect (trying the standard display
scale factors, since its own bounds are in DIPs; with exactly one open window, that window)
and sends its tabs to the peer as an `open` with `asWindow: true`.

Optional (2.19+): `cid` — any JSON string or number Merged chooses to name this capture (Merged
sends the dragged window's handle as a decimal string); the extension echoes it unchanged in
`/source-kept`, so Merged knows which source window is meant.

Optional (2.19+): `lone` — boolean. The extension's **single-window fallback** captures the only
window it can see when no window's bounds match the rect; it exists for browsers whose skinned
frame reports bounds that differ from the Win32 rect (QQ Browser). `"lone": false` turns that
fallback off: no match means abort. Merged sends it for browsers whose frame bounds are recorded
to match Win32 (Chrome/Edge/Brave/Opera/Vivaldi — the stock Chromium frame — and 360 Safe), and
whenever more than one install of the dragged browser is connected, where a
miss means the dragged window is one the extension cannot see (an incognito/private window)
and the fallback would capture — and then close — the user's other window. Absent means the
fallback stays on (today's behaviour).

The extension never captures an incognito/private window. On Chrome and Firefox its manifest
sets `"incognito": "not_allowed"`, so it does not run in, or even see, private windows. Safari
has no `not_allowed` (MDN browser-compat-data: `safari: false`), so there the extension skips
windows whose `incognito` is true, and the single-window fallback applies only when the lone
window is the only one it can see.

After the peer's `ack` the extension closes **only the tabs it sent** (each still on the page it
was sent from) and blank new-tab pages of that window. Any other tab — a `chrome://` page, a
local file, a tab opened after the capture, a sent tab that navigated elsewhere — stays, and
keeps the window open.

If two or more windows match the rect equally well (identical bounds, or within one DIP per
edge), the extension takes the **focused** one, and aborts if none of them is focused.

If the rect is missing, zero-sized, or matches none of several windows, the extension
**aborts** and the window stays where it is. It never falls back to "the focused window":
by the time the extension runs, focus can belong to a different window, and capturing it
teleported and closed the wrong one.

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
