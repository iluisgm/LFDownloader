# LFDownloader

A Chrome + Firefox extension that catches the videos, music and streams a page loads, and lets you download them in the quality you choose — in the spirit of IDM's "Download this video" panel.

## What it does

- **Automatic detection.** Watches the page's network traffic for MP4, WebM, MKV, MOV, MP3, M4A, WAV, FLAC, OGG, Opus… and HLS (`.m3u8`) streams. The toolbar badge shows how many were found. Stream segments, child playlists and tiny files (beeps, ads) are filtered out.
- **Quality picker.** HLS master playlists become quality chips (1080p, 720p, … audio only) with an estimated file size.
- **Right-click menu.** *Download this media* on a video/audio element, *Download link with LFDownloader* on media links, and *Scan page for media* anywhere. That last one opens a slide-in panel on the page.
- **Floating button.** A **Download** button appears when you hover over a video. The × hides it on that site.
- **Download manager window.** Progress, speed, ETA, pause/resume, cancel, retry, search, history, "Add link" (paste any media or `.m3u8` URL), and *Stop & save* for live streams.
- **Stream engine.** Parallel segment downloads with retries, AES-128 decryption, fMP4 (`EXT-X-MAP`), byte ranges, separate audio tracks, and live recording. Data is written to disk-backed browser storage (OPFS), not RAM.
- **Referer handling.** Many video hosts reject requests without the page's Referer/Origin. Short-lived `declarativeNetRequest` rules add them only for LFDownloader's own requests.
- **Settings.** Theme (system/dark/light), folder, filename template (`{title} - {quality}`), save-as dialog, detection types, minimum size, parallel connections, notifications.
- Shortcuts: <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd> opens the popup; <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> scans the page.

**Not supported:** DRM-protected streams (Netflix, Disney+, Spotify… Widevine/FairPlay/PlayReady, SAMPLE-AES). These are detected and labelled *Protected*. DASH (`.mpd`) streams are listed, with a *Copy link* / *Copy yt-dlp command* action. YouTube uses its own protected streaming format, so use yt-dlp for it.

## Install

```powershell
npm install
npm run build
```

**Chrome / Edge / Brave:** open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick `dist/chrome`.

**Firefox:** open `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → pick `dist/firefox/manifest.json`. Temporary add-ons are removed when Firefox restarts. For permanent use, sign it for free as an *unlisted* add-on on [addons.mozilla.org](https://addons.mozilla.org/developers/) (`npm run package:firefox` makes the zip), then install the signed `.xpi`. If the welcome page shows **Allow access**, click it: Firefox makes site access opt-in.

After changing code, run `npm run build` again (or `npm run watch`) and press reload on the extension.

## Output formats

| Source | Saved as |
| --- | --- |
| Direct files | original format (`.mp4`, `.mp3`, `.wav`, …) |
| HLS with fMP4 segments | `.mp4` |
| HLS with MPEG-TS segments | `.ts`. Plays in VLC, mpv, MPC-HC and most TVs; convert losslessly with `ffmpeg -i in.ts -c copy out.mp4` |
| HLS with a separate audio track | two files: video + `(audio)` |

## Project layout

```
src/
  manifest.json        shared manifest (build script adds browser-specific bits)
  background/          network sniffer, per-tab store, stream inspection, download routing, menus
  content/content.js   DOM scan, floating button, in-page panel host
  popup/               toolbar popup (also used as the in-page panel)
  manager/             download manager window + HLS engine (hls-job.js)
  options/ welcome/    settings and onboarding pages
  shared/              theme, icons, HLS parser, media helpers, settings
scripts/               build + icon rendering
test/                  fixture generator (ffmpeg), test server, Chrome e2e, Firefox smoke test
```

## Testing

```powershell
node test/make-fixtures.mjs   # needs ffmpeg — generates MP4/MP3/WAV + 3 kinds of HLS
npm run build
npm run test:e2e              # real Chrome: detection, UI, downloads, ffprobe-verified output
node test/firefox-smoke.mjs   # real Firefox: detection, Referer rules, real downloads
npm run lint:firefox
```

`npm run test:server` serves the test page at http://localhost:8765 for manual testing.

---

For personal use. Only download content you have the right to save.
