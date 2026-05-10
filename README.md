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
5. Click **Download HLS** for unencrypted `.m3u8` playlists, then choose a quality and save location in the downloader tab.
6. Use **Copy URL** for unsupported stream manifests such as `.mpd`.

## Limitations

- Blob URLs are session-local and often cannot be downloaded from the extension popup.
- HLS downloads stream segments into the save file when Chrome supports the File System Access API.
- HLS downloads ask Chrome to keep the system awake until the save finishes.
- If direct file streaming is unavailable, HLS downloads fall back to memory and very large videos may fail.
- Some HLS streams use fragmented MP4 segments; the saved file may still need a media tool such as `ffmpeg` for maximum compatibility.
- DASH manifests are stream playlists, not final video files.
- Some sites hide media behind DRM or short-lived signed URLs.
- Encrypted HLS and DRM-protected videos are not supported.
- Closing the laptop lid, losing network, or OS/battery policies can still interrupt long downloads.
- Chrome blocks extension scripts on browser-internal pages such as `chrome://`.
