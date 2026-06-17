# Privacy Policy — Tab Teleporter

**Effective date:** 17 June 2026

This policy explains what the **Tab Teleporter** browser extension ("the extension")
accesses, why, and where it goes. The extension is a companion to the **Merged** desktop
application and is used to move ("teleport") a browser tab or window to another computer
that the user controls.

## Summary

The extension only acts when **you explicitly teleport a tab** (via its toolbar button,
keyboard shortcut, right-click menu, or by dragging a browser window between your computers).
When you do, it reads a small amount of information about that one tab and hands it to the
**Merged app running on your own computer** at `http://127.0.0.1` (loopback), which transfers
it to your other computer over your own network. **No data is ever sent to us or to any
remote/third-party server. We do not collect, store, sell, or share your data, and we do not
use analytics, tracking, or advertising.**

## What the extension accesses, and when

Only at the moment you teleport a tab, and only for the tab(s) being teleported, the
extension reads:

- the **tab's URL**;
- the **page scroll position**;
- the **current `<video>` playback time** (if the page has a video), so playback can resume
  at the same point;
- which tab in a window is **active** (so it is re-focused after the move).

It does **not** read, monitor, record, or transmit any other page content, your browsing
history, form inputs, passwords, cookies, or activity on pages you are not teleporting.

## How that information is used

The values above are sent **only** to the Merged application on the **same computer** over the
local loopback address (`127.0.0.1`). Merged then transfers them, over a connection between
**your own computers** that you have set up, to the Merged instance on your other computer,
which re-opens the tab there in the same state. The information is used solely to recreate the
tab on the destination machine and is not retained by the extension afterwards.

## What the extension does **not** do

- It does **not** contact any remote or third-party server. Its only network destination is
  `http://127.0.0.1` (your own machine).
- It does **not** sell or share your data with anyone.
- It does **not** use the data for advertising, profiling, or creditworthiness.
- It does **not** include analytics, tracking pixels, or remotely-hosted code. All code ships
  inside the extension package.

## Local storage

The extension stores a small amount of **configuration** on your device using the browser's
local extension storage: the loopback endpoint and an access token used to connect to your
local Merged app. This never leaves your device and contains no browsing data.

## Permissions

- **Tabs / scripting / host access (all sites):** to read the scroll position and video
  timestamp of the single tab you teleport, and to restore them on the destination tab. Used
  only on the tab being teleported, only at teleport time.
- **Host access to `127.0.0.1`:** to communicate with your local Merged app.
- **Storage:** to save the local connection settings described above.
- **Context menus / alarms:** to provide the right-click teleport action and to keep the
  extension responsive to teleport requests.

## Data retention

The extension does not maintain a server and keeps no logs. The tab information it reads is
transient — used to perform the teleport and then discarded. The only persistent data is the
local configuration described under "Local storage," which you can clear at any time by
removing the extension.

## Children

The extension is a general-purpose utility and is not directed at children, and it collects no
personal information.

## Open source

The extension is open source. You can review exactly what it does at
<https://github.com/bawat/MouseTransfer-Browser-Extensions>.

## Changes to this policy

If this policy changes, the updated version will be posted at this URL with a new effective
date.

## Contact

For questions about this policy or the extension, contact:

**[YOUR NAME OR BUSINESS NAME]**
**[YOUR CONTACT EMAIL]**
**[YOUR POSTAL/BUSINESS ADDRESS — required if you registered as a "trader"]**
