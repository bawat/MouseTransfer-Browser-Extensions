# Safari (WebKit) build

This folder holds the standard Web Extension source for Safari. Unlike Chromium and Firefox,
Safari can't load this folder directly — a Safari Web Extension must be wrapped in a native
macOS/iOS app and built with **Xcode on macOS**, then distributed through the **Mac App Store**
(or run locally in Safari's developer mode).

## Build (requires macOS + Xcode)

1. Convert this folder into an Xcode project:
   ```sh
   xcrun safari-web-extension-converter ./safari --app-name "Tab Teleporter" --bundle-identifier app.mousetransfer.tabteleporter
   ```
2. Open the generated `.xcodeproj` in Xcode, select the extension target, and **Run** to load
   it into Safari (enable **Develop → Allow Unsigned Extensions** and tick the extension in
   Safari → Settings → Extensions).
3. For distribution, set your Apple Developer signing team, archive, and submit the containing
   app to the Mac App Store (and/or App Store for the iOS/iPadOS variant).

## Notes / caveats

- **Requires an Apple Developer account ($99/yr)** to sign and distribute. Local testing only
  needs Xcode.
- Safari grants host permissions per-site via its own UI; the user may need to allow access on
  the sites they teleport, and to allow access to `127.0.0.1` for the local Merged bridge.
- The JS is identical to the other builds; the cross-engine shim at the top of `background.js`
  points `chrome.*` at Safari's promise-based `browser.*`.
- `background.service_worker` requires Safari 16.4+. For older Safari, change it to
  `"background": { "scripts": ["background.js"] }`.
- This build has **not** been verified on a real Safari/macOS yet — see the repo's follow-ups.
