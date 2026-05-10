# video-downloader

A small Chrome/Edge Manifest V3 extension that scans the current page for direct video sources and lets you download media URLs that the browser can save directly.

This extension is for downloading videos you own or have permission to save. It does not bypass DRM, paywalls, login walls, encrypted streams, or site access controls.

## Install For Local Testing

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the `video-downloader` project folder.

## Use

1. Open a page with a video.
2. Play the video for a few seconds if nothing appears at first.
3. Click the extension icon.
4. Click **Download** for direct files such as `.mp4` or `.webm`.
5. Use **Copy URL** for stream manifests such as `.m3u8` or `.mpd`.

## Limitations

- Blob URLs are session-local and often cannot be downloaded from the extension popup.
- HLS/DASH manifests are stream playlists, not final video files.
- Some sites hide media behind DRM or short-lived signed URLs.
- Chrome blocks extension scripts on browser-internal pages such as `chrome://`.
