# LFDownloader

A Chrome + Firefox extension that catches the videos, music, streams and gallery pictures on a page, and lets you download them in the quality you choose — in the spirit of IDM's "Download this video" panel.

## What it does

- **Automatic detection.** Watches the page's network traffic for MP4, WebM, MKV, MOV, MP3, M4A, WAV, FLAC, OGG, Opus… and HLS (`.m3u8`) streams. The toolbar badge shows how many were found. Stream segments, child playlists and tiny files (beeps, ads) are filtered out.
- **Quality picker.** HLS master playlists become quality chips (1080p, 720p, … audio only) with an estimated file size.
- **Right-click menu.** *Download this media* on a video/audio element, *Download link with LFDownloader* on media links, and *Scan page for media* anywhere. That last one opens a slide-in panel on the page.
- **Floating button.** A **Download** button appears when you hover over a video. The × hides it on that site.
- **Gallery image scan.** Click the images button in the popup, or right-click → *Find full-size images on this page*. For every thumbnail, LFDownloader follows the link to the full-size picture, whether the link points straight at the image file or opens a page that only shows the picture. It also handles viewer pages with extra clutter, lazy-loaded images, other-domain viewers, and big pictures shown on the page itself. Results appear as a selectable grid; download all of them or just the ones you pick.
- **Magic select.** Click the wand (or right-click → *Magic select*, or <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>M</kbd>) and drag a box on the page. Only the pictures and videos inside it are collected, highlighted live as you drag, with full-size pictures resolved the same way as the gallery scan. Click without dragging to pick a single item; scroll with the wheel to make a taller box.
- **No "Save as" for every picture.** Choose how a set of pictures is saved:
  - *Into a folder* (Chrome, Edge, Brave): pick a folder once and every picture is written straight into it.
  - *As one ZIP file*: a single file, so at most one save dialog. Works in every browser.
  - *As separate downloads*: the browser may ask where to save each one if "Ask where to save each file" is on.
- **YouTube (with the yt-dlp helper).** On a YouTube video page (also Shorts, `youtu.be` and players embedded in other sites) the popup shows a card with the real qualities, from 240p up to 4K/8K, plus *Audio (M4A)* and *MP3*, each with its file size. 1080p is preselected (H.264 MP4 plays everywhere); 1440p and above are saved as MKV because YouTube only offers them as VP9/AV1. The original-language audio is used, never a dubbed track. Downloads run in the download manager with live progress and land in `Downloads/LFDownloader`. See [YouTube setup](#youtube-setup).
- **Skins.** *Aurora* (violet → cyan), *Crimson* (black & red), *Ocean*, *Emerald*, *Sunset*, or *Custom* with any accent color you pick. The skin also re-colors the toolbar icon, the badge, and the Download button on web pages. Add *Pure black background* for OLED screens.
- **Download manager window.** Progress, speed, ETA, pause/resume, cancel, retry, search, history, "Add link" (paste any media or `.m3u8` URL), and *Stop & save* for live streams.
- **Stream engine.** Parallel segment downloads with retries, AES-128 decryption, fMP4 (`EXT-X-MAP`), byte ranges, separate audio tracks, and live recording. Data is written to disk-backed browser storage (OPFS), not RAM.
- **Referer handling.** Many hosts reject requests without the page's Referer/Origin (hotlink protection). Short-lived `declarativeNetRequest` rules add them to LFDownloader's own requests. If the browser's own download is refused (401/403), LFDownloader fetches the file itself with the page's Referer and saves that instead.
- **Settings.** Theme (system/dark/light), skin, folder, filename template (`{title} - {quality}`), save-as dialog, detection types, minimum size, parallel connections, notifications.
- Shortcuts: <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd> opens the popup; <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> scans the page; <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>M</kbd> starts magic select.

**Not supported:** DRM-protected streams (Netflix, Disney+, Spotify… Widevine/FairPlay/PlayReady, SAMPLE-AES). These are detected and labelled *Protected*. DASH (`.mpd`) streams are listed, with a *Copy link* / *Copy yt-dlp command* action. Live YouTube streams can be downloaded once they have ended.

## Install

```powershell
npm install
npm run build
```

**Chrome / Edge / Brave:** open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick `dist/chrome`.

**Firefox (permanent install):** regular Firefox only keeps add-ons signed by Mozilla. Signing is free and automatic for *unlisted* add-ons: they are private and nothing is published on the add-ons store.

1. Sign in at <https://addons.mozilla.org/developers/addon/api/key/> and click **Generate new credentials**.
2. Save them as environment variables, then open a new terminal:
   ```powershell
   [Environment]::SetEnvironmentVariable('WEB_EXT_API_KEY', '<JWT issuer>', 'User')
   ```
   ```powershell
   [Environment]::SetEnvironmentVariable('WEB_EXT_API_SECRET', '<JWT secret>', 'User')
   ```
3. Sign the add-on. This usually takes a few minutes:
   ```powershell
   npm run sign:firefox
   ```
4. Drag the `.xpi` from `dist/packages/` onto a Firefox window (or *about:addons* → ⚙ → *Install Add-on From File…*). It now survives restarts.
5. To update later: `npm version patch --no-git-tag-version`, run `npm run sign:firefox` again, and install the new `.xpi`. Each upload needs a new version number.

If the welcome page shows **Allow access**, click it: Firefox makes site access opt-in.

**Firefox (quick test, temporary):** `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → pick `dist/firefox/manifest.json`. It is removed when Firefox restarts.

After changing code, run `npm run build` again (or `npm run watch`) and press reload on the extension.

### YouTube setup

YouTube doesn't send its videos as normal files: video and audio arrive in small scrambled pieces that change format often. So LFDownloader hands YouTube pages to [yt-dlp](https://github.com/yt-dlp/yt-dlp) on your computer, through a small helper program (native messaging). One-time setup on Windows:

1. Install yt-dlp and ffmpeg (skip if you have them):
   ```powershell
   winget install yt-dlp.yt-dlp Gyan.FFmpeg
   ```
2. Load the extension (above), then register the helper. It finds the extension in Brave/Chrome/Edge by itself:
   ```powershell
   npm run helper:install
   ```
   If it can't, pass the ID shown in `brave://extensions`: `npm run helper:install -- --id <id>`. Settings → *YouTube & other sites* shows the exact command and whether the helper is connected.
3. Reload the extension.

The installer only writes `native/out/` and one registry key per browser under `HKCU\Software\…\NativeMessagingHosts\com.lfdownloader.helper` (Chrome, Brave, Edge, Chromium, Mozilla). `npm run helper:uninstall` removes them. The helper only runs yt-dlp with links passed from the extension, only accepts http(s) links, and only opens files inside your Downloads folder.

If YouTube downloads start failing, update yt-dlp first: `yt-dlp -U` (or `pip install -U yt-dlp` if you installed it with pip).

## Output formats

| Source | Saved as |
| --- | --- |
| Direct files | original format (`.mp4`, `.mp3`, `.wav`, …) |
| HLS with fMP4 segments | `.mp4` |
| HLS with MPEG-TS segments | `.ts`. Plays in VLC, mpv, MPC-HC and most TVs; convert losslessly with `ffmpeg -i in.ts -c copy out.mp4` |
| HLS with a separate audio track | two files: video + `(audio)` |
| YouTube up to 1080p | `.mp4` (H.264 + AAC) |
| YouTube 1440p and above | `.mkv` (VP9/AV1 + Opus/AAC) |
| YouTube audio | `.m4a`, or `.mp3` |

## Project layout

```
src/
  manifest.json        shared manifest (build script adds browser-specific bits)
  background/          network sniffer, per-tab store, stream inspection, download routing, menus
  content/content.js   DOM scan, gallery image scan, floating button, in-page panel host
  content/extract.js   finds the full-size picture on a viewer page (shared with background)
  popup/               toolbar popup (also used as the in-page panel)
  manager/             download manager window: HLS engine, Referer fallback, picture ZIP/folder jobs, yt-dlp jobs
  options/ welcome/    settings and onboarding pages
  shared/              theme, skins, icons, HLS parser, media helpers, settings
native/                yt-dlp helper (host.mjs) and its installer
scripts/               build, icon rendering, Firefox signing
test/                  fixture generator (ffmpeg), test server, Chrome e2e, Firefox smoke test
```

## Testing

```powershell
node test/make-fixtures.mjs   # needs ffmpeg — MP4/MP3/WAV, 4 kinds of HLS, a photo gallery
npm run build
npm run test:e2e              # real Chrome: detection, UI, downloads, ffprobe-verified output
npm run test:gallery          # real Chrome: thumbnails → full-size images, bulk download
npm run test:firefox          # real Firefox: detection, Referer rules, downloads, gallery, helper
npm run test:helper           # yt-dlp helper: real YouTube downloads (small), cancel, errors
npm run test:youtube          # real Chrome: YouTube page → qualities → 240p download
npm run lint:firefox
npm run screens -- out crimson dark   # screenshots of every page in a skin
```

`npm run test:server` serves the test page at http://localhost:8765 for manual testing.

---

For personal use. Only download content you have the right to save.
