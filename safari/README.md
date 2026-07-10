# Safari (WebKit) build

This folder holds the standard Web Extension source for Safari. The JS is the same
`background.js` as the other builds (a shim at the top points `chrome.*` at the promise-based
`browser.*`; on Safari that's a harmless normalization — Apple: "Safari web extensions support
both the `chrome.*` and `browser.*` namespaces" and "both the callback and `Promise` approaches
for asynchronous APIs" —
<https://developer.apple.com/documentation/safariservices/assessing-your-safari-web-extension-s-browser-compatibility>).

**Minimum Safari: 16.4** (declared via `browser_specific_settings.safari.strict_min_version`).
The floor is set by `storage.session` — "Supported in Safari 16.4 or later" (Apple compatibility
page above; also the WebKit 16.4 release notes) — which the extension uses to survive
service-worker suspension. The MV3 `background.service_worker` itself needs Safari 15.4+
(MDN browser-compat-data).

## Test locally — NO Xcode needed (Safari 17+)

Safari 17 can load this folder directly as a **temporary extension**
(<https://developer.apple.com/documentation/safariservices/running-your-safari-web-extension>):

1. Safari > Settings > Advanced: check **"Show features for web developers"**
   (Safari 16 and earlier: "Show Develop menu in menu bar").
2. Safari > Settings > **Developer** tab: check **"Allow unsigned extensions"**
   (Safari 16 and earlier: Develop > Allow Unsigned Extensions). This setting **resets when you
   quit Safari** — re-set it each launch.
3. Same Developer tab: click **"Add Temporary Extension…"** and select this `safari/` folder
   (or a zip of it). Safari removes temporary extensions after 24 hours or when it quits.
4. Safari > Settings > Extensions: enable **Tab Teleporter** and grant it access when prompted
   (Safari grants host permissions per-site via its own UI — including `127.0.0.1` for the
   local bridge).

## Package as an app (requires macOS + Xcode)

For distribution, a Safari web extension must be wrapped in a native macOS/iOS app:

1. Generate the Xcode project
   (<https://developer.apple.com/documentation/safariservices/packaging-a-web-extension-for-safari>):
   ```sh
   xcrun safari-web-extension-packager ./safari \
     --app-name "Tab Teleporter" \
     --bundle-identifier app.mousetransfer.tabteleporter \
     --macos-only --copy-resources --project-location ./safari-xcode
   ```
   The tool "used to be named `safari-web-extension-converter`" (same doc) — older Xcodes ship
   it under that name with the same arguments. Notes: without `--copy-resources` the project
   *references* this folder (edits here flow into the packaged extension — handy for dev);
   `--rebuild-project` re-runs on an existing project (e.g. to add iOS later); `--swift`/`--objc`
   pick the app language; `--no-open`, `--no-prompt`, `--force` for scripting.
2. Open the generated `.xcodeproj`, select the macOS app scheme, and **Product > Run** — "as
   soon as your app runs, your extension is ready for use in Safari" (enable it per the
   local-testing steps above; unsigned dev builds still need "Allow unsigned extensions").

## Distribute

(<https://developer.apple.com/documentation/safariservices/distributing-your-safari-web-extension>)

- **macOS — two paths**: the Mac App Store, **or** outside it — "you can sign and notarize your
  extension's app with a Developer ID to distribute it outside the Mac App Store."
- **iOS/iPadOS/visionOS**: App Store only (plus signed ad-hoc builds for beta testers).
- Either path **requires an Apple Developer account ($99/yr)**. Local testing does not.
- `update_url` is not supported — "Handle Safari web extension updates with the App Store"
  (Apple compatibility page).

## Safari platform limits (verified, with sources)

The shared `background.js` feature-detects each of these and degrades as described:

| API | Safari status | Effect here |
|---|---|---|
| `bookmarks.*` | **Not supported** (MDN BCD `webextensions/api/bookmarks`: safari `false`; absent from Apple's compatibility page) | Carry-back skips the bookmark staging and opens queued windows directly on the next real startup; the one-shot `/carryback-drain` is never consumed without a place to put it. The `bookmarks` permission is dropped from this manifest. |
| `tabs.move` | **Not supported** — "tabs.move: Not supported." (Apple compatibility page) | A tear-off merge-drop leaves the teleported window standalone (the documented any-miss fallback). |
| `runtime.onSuspend` | "API exists, but has no effect" (MDN BCD) | Harmless — it's a belt on top of `storage.session` mirroring. |
| `navigator.sendBeacon` in a service worker | Beacon is specified on `Navigator` (window), not `WorkerNavigator` | Carry-back already falls back to `fetch(…, { keepalive: true })`. |
| `storage.sync` | "Storage mechanism implemented, but syncing not supported" (Apple) | Not used. |

Everything else the extension uses is supported: `tabs`/`windows`/`runtime`/`commands`/
`contextMenus`/`alarms` since Safari 14, `scripting`/`action` since 15.4, `storage.session`
since 16.4 (Apple compatibility page + MDN BCD).
