# Browser coverage

Most major browsers share an engine, so they share an extension build. There are only **three
engine families** to target, which between them cover the top desktop browsers:

| Build | Engine | Browsers it covers |
|---|---|---|
| [`chrome/`](chrome/) | Chromium (MV3) | Chrome, Edge, Brave, Opera, Vivaldi, Yandex, Arc, Samsung Internet, and other Chromium browsers |
| [`firefox/`](firefox/) | Gecko (MV3) | Firefox (desktop + Android), and Gecko forks (LibreWolf, Waterfox, Tor Browser) |
| [`safari/`](safari/) | WebKit | Safari (macOS + iOS) — built via Xcode, see [safari/README.md](safari/README.md) |

The runtime protocol ([PROTOCOL.md](PROTOCOL.md)) is identical across all of them; only the
manifest and packaging differ per engine.

## Top browsers → which build + store

| # | Browser | Engine | Build | Store / install | Status |
|---|---|---|---|---|---|
| 1 | Google Chrome | Chromium | `chrome/` | Chrome Web Store | **Submitted (unlisted), in review** |
| 2 | Microsoft Edge | Chromium | `chrome/` | Microsoft Edge Add-ons (Partner Center) — or installs Chrome Web Store items directly | Needs Edge dev account |
| 3 | Safari | WebKit | `safari/` | Mac App Store, or a notarized Developer ID app outside it (via Xcode) | Source prepped + gap-audited; needs macOS + Xcode + Apple Developer acct — see `safari/README.md` |
| 4 | Firefox | Gecko | `firefox/` | addons.mozilla.org (AMO) | Ready to submit; needs AMO account |
| 5 | Opera | Chromium | `chrome/` | Opera Addons | Needs Opera dev account |
| 6 | Brave | Chromium | `chrome/` | Installs directly from the Chrome Web Store | Covered once #1 publishes |
| 7 | Samsung Internet | Chromium | `chrome/` | Galaxy Store (Android; limited extension support) | Needs Samsung/Galaxy acct |
| 8 | Vivaldi | Chromium | `chrome/` | Installs directly from the Chrome Web Store | Covered once #1 publishes |
| 9 | Yandex Browser | Chromium | `chrome/` | Yandex add-ons / Chrome Web Store | Needs Yandex acct |
| 10 | UC Browser | Chromium-ish | `chrome/` | No meaningful desktop extension support on current builds | Not viable / out of scope |

**Takeaway:** Chrome (#1) publishing covers Chrome, Brave, and Vivaldi immediately (they all
install from the Chrome Web Store). Edge, Opera, Samsung, and Yandex are the *same `chrome/`
package* re-submitted to their own stores (account + manual upload each). Firefox and Safari
are the two genuinely separate builds, both prepared here.

## Packaging

Build an upload zip for any folder with the Merged repo's tool:

```sh
go run ./tools/packzip -src <this-repo>/firefox -out tab-teleporter-firefox.zip
go run ./tools/packzip -src <this-repo>/chrome  -out tab-teleporter-chrome.zip
```

(Firefox/AMO also accepts the same zip; Safari is built from source via Xcode — see
[safari/README.md](safari/README.md).)
