# Blocker: guide for testers

Blocks ads and trackers in Chrome using ML.

- Some sites may break (hopefully not).
- Ads may show once, then disappear on reload.

## Install

- Use Chrome 124 or newer (version from 2024).
- Download compressed extension TODO LINK
- Unzip `crx-blocker-extension-1.0.0.zip`
- Go to `chrome://extensions`.
- Turn on **Developer mode** (top right).
- Click **Load unpacked** and pick the unzipped folder (the one with `manifest.json` inside).
- Click the puzzle piece icon next to the address bar and pin "blocker-extension".

> [!CAUTION]
> Don't delete the unpacked zip

## Use it

- Just browse normally for several days.

## If a **site breaks**

- Open the popup on that site.
- Click **report breakage**.
- Click **turn off** to stop blocking on that site.
- Many sites broken? Click **reset rules**.

## Send logs

- Open the popup
- Click **export**
- Send the `.ndjson.gz` file from your downloads.

> [!WARNING]
> Closing the popup cancels the download

> [!WARNING]
> Never click **clear all** unless asked.

## Privacy

- Logged: timings, counts, memory use, how the model compares to filter lists.
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
