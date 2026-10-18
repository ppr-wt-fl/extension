# Blocker: guide for testers

Blocks ads and trackers in Chrome using ML.

- Some sites may break (hopefully not).
- Ads may show once, then disappear on reload.

## Install

- Use Chrome 141 or newer (version from autumn 2025).
- Download `blocker-extension-*.zip` from the [latest release](https://github.com/ppr-wt-fl/extension/releases/latest).
- Unzip it.
- Go to `chrome://extensions`.
- Turn on **Developer mode** (top right).
- Click **Load unpacked** and pick the unzipped folder (the one with `manifest.json` inside).
- Click the puzzle piece icon next to the address bar and pin "blocker-extension".
- Disable other ad blockers (please 🙏).

> [!CAUTION]
> Don't delete the unpacked zip

> [!CAUTION]
> I would really appreciate it if you disable other ad blockers

## Use it

- Just browse normally for several days.

## If a **site breaks**

- Open the popup on that site.
- Click **Report broken site**, then click again to confirm.
- Flip the switch next to the site name to pause blocking there, then click **Reload page to apply**.
- Many sites broken? Click **Reset rules**, then click again to confirm.

## If you **see an ad or tracker**

- Open the popup on that site.
- Click **Report seeing an ad/tracker**, then click again to confirm.

## Send logs

- Open the popup
- Click **Export**
- Send the `perf-*.ndjson.gz` files from your downloads (a big export is split into several).
- Once the download is done, you can click **Clear exported** (before closing the popup) to free space.

> [!WARNING]
> Closing the popup cancels the download

> [!WARNING]
> Never click **Clear all** unless asked.

## Privacy

- Logged: timings, counts, memory use, how the model compares to filter lists, how often you pause or resume a site and click **Report broken site** or **Report seeing an ad/tracker**.
- Also logged: your browser and its version, operating system and its version, CPU type and core count, roughly how much RAM, the device model if the browser reports it, and the extension and model version.
- Every entry has a timestamp and a random ID made on install (also in the file name), so your files can be grouped. It isn't linked to your name or account.
- Not logged: URLs, site names, page content, cookies, anything you type.
- Nothing is sent automatically. You send the file yourself.
- The extension re-downloads scripts and pages you visit (with your cookies) to analyze them locally. Nothing from them is stored.

## Uninstall

- Send logs one last time plss.
- In `chrome://extensions`, click **Remove** on "blocker-extension".
- Delete the unzipped folder.

## Problems

- Export fails or hangs: tell us before clicking anything else.
- Extension gone or "folder missing" error: unzip again and reinstall.
