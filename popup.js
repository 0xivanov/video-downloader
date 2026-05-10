const MEDIA_EXTENSIONS = [
  "mp4",
  "webm",
  "mov",
  "m4v",
  "avi",
  "mkv",
  "ogv",
  "3gp",
  "m3u8",
  "mpd"
];

const STREAM_EXTENSIONS = new Set(["m3u8", "mpd"]);
const DIRECT_DOWNLOAD_PROTOCOLS = new Set(["http:", "https:"]);

const statusEl = document.querySelector("#status");
const listEl = document.querySelector("#videoList");
const pageLabelEl = document.querySelector("#pageLabel");
const refreshButton = document.querySelector("#refreshButton");
const template = document.querySelector("#videoTemplate");

refreshButton.addEventListener("click", scanCurrentTab);
document.addEventListener("DOMContentLoaded", scanCurrentTab);

async function scanCurrentTab() {
  setStatus("Scanning page...");
  listEl.replaceChildren();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    setStatus("No active tab found.", true);
    return;
  }

  pageLabelEl.textContent = tab.title || tab.url || "Current page";

  try {
    const injections = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: collectVideosFromPage,
      args: [MEDIA_EXTENSIONS]
    });

    const videos = uniqueVideos(injections.flatMap((result) => result.result || []));
    renderVideos(videos);
  } catch (error) {
    setStatus(
      `Could not scan this page. Chrome blocks extension scripts on some internal pages. ${error.message || ""}`,
      true
    );
  }
}

function renderVideos(videos) {
  listEl.replaceChildren();

  if (!videos.length) {
    setStatus("No direct video sources found. Try playing the video, then rescan.");
    return;
  }

  statusEl.hidden = true;

  for (const video of videos) {
    const item = template.content.firstElementChild.cloneNode(true);
    const extension = getExtension(video.url);
    const isStream = STREAM_EXTENSIONS.has(extension);
    const isDownloadable = canDownload(video.url) && !isStream;

    item.querySelector(".video-title").textContent = video.title || makeTitle(video.url);
    item.querySelector(".video-details").textContent = [
      video.source,
      extension ? extension.toUpperCase() : "media",
      video.type
    ]
      .filter(Boolean)
      .join(" • ");

    const link = item.querySelector(".video-url");
    link.href = video.url;
    link.textContent = video.url;

    const downloadButton = item.querySelector(".download-button");
    downloadButton.disabled = !isDownloadable;
    downloadButton.textContent = isStream ? "Stream URL" : "Download";
    downloadButton.title = isStream
      ? "HLS/DASH streams need a media tool such as ffmpeg; this extension copies the stream URL."
      : "Download this direct video URL";
    downloadButton.addEventListener("click", () => downloadVideo(video));

    const copyButton = item.querySelector(".copy-button");
    copyButton.addEventListener("click", async () => {
      await navigator.clipboard.writeText(video.url);
      flashButton(copyButton, "Copied");
    });

    listEl.appendChild(item);
  }
}

async function downloadVideo(video) {
  const response = await chrome.runtime.sendMessage({
    type: "download-video",
    url: video.url,
    filename: makeTitle(video.url)
  });

  if (response?.ok) {
    return;
  }

  setStatus(response?.error || "Download failed.", true);
}

function setStatus(message, warning = false) {
  statusEl.hidden = false;
  statusEl.textContent = message;
  statusEl.classList.toggle("warning", warning);
}

function flashButton(button, label) {
  const previous = button.textContent;
  button.textContent = label;
  window.setTimeout(() => {
    button.textContent = previous;
  }, 1200);
}

function uniqueVideos(videos) {
  const seen = new Set();
  return videos
    .filter((video) => video?.url)
    .map((video) => ({ ...video, url: normalizeUrl(video.url) }))
    .filter((video) => {
      if (!video.url || seen.has(video.url)) {
        return false;
      }

      seen.add(video.url);
      return true;
    })
    .sort((a, b) => scoreVideo(b) - scoreVideo(a));
}

function scoreVideo(video) {
  const extension = getExtension(video.url);
  const directScore = STREAM_EXTENSIONS.has(extension) ? 20 : 40;
  const sourceScore = video.source === "video element" ? 20 : 0;
  return directScore + sourceScore;
}

function canDownload(url) {
  try {
    return DIRECT_DOWNLOAD_PROTOCOLS.has(new URL(url).protocol) || /^data:video\//i.test(url);
  } catch {
    return false;
  }
}

function normalizeUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.href;
  } catch {
    return "";
  }
}

function makeTitle(url) {
  try {
    const parsed = new URL(url);
    const name = parsed.pathname.split("/").filter(Boolean).pop() || "video";
    return decodeURIComponent(name).replace(/[\\/:*?"<>|]+/g, "-");
  } catch {
    return "video";
  }
}

function getExtension(url) {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    const match = pathname.match(/\.([a-z0-9]+)$/);
    return match?.[1] || "";
  } catch {
    return "";
  }
}

function collectVideosFromPage(mediaExtensions) {
  const extensionPattern = new RegExp(`\\.(${mediaExtensions.join("|")})(?:$|[?#])`, "i");
  const videos = [];

  const addVideo = (url, source, type = "") => {
    if (!url) {
      return;
    }

    let absoluteUrl;
    try {
      absoluteUrl = new URL(url, location.href).href;
    } catch {
      return;
    }

    const isVideoLike =
      /^blob:/i.test(absoluteUrl) ||
      /^data:video\//i.test(absoluteUrl) ||
      extensionPattern.test(absoluteUrl) ||
      /^video\//i.test(type) ||
      /resource:video/i.test(type) ||
      /mpegurl|dash\+xml|mp4|webm|ogg/i.test(type);

    if (!isVideoLike) {
      return;
    }

    videos.push({
      url: absoluteUrl,
      source,
      title: document.title,
      type
    });
  };

  for (const video of document.querySelectorAll("video")) {
    addVideo(video.currentSrc || video.src, "video element", video.type);

    for (const source of video.querySelectorAll("source")) {
      addVideo(source.src, "source element", source.type);
    }
  }

  for (const source of document.querySelectorAll("source[src]")) {
    addVideo(source.src, "source element", source.type);
  }

  for (const link of document.querySelectorAll("a[href]")) {
    addVideo(link.href, "page link", link.type);
  }

  for (const entry of performance.getEntriesByType("resource")) {
    const type = entry.initiatorType ? `resource:${entry.initiatorType}` : "resource";
    addVideo(entry.name, "network resource", type);
  }

  return videos;
}
