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
const HLS_EXTENSION = "m3u8";
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

    const videos = uniqueVideos([
      currentTabMedia(tab),
      ...injections.flatMap((result) => result.result || [])
    ]);
    await renderVideos(videos);
  } catch (error) {
    setStatus(
      `Could not scan this page. Chrome blocks extension scripts on some internal pages. ${error.message || ""}`,
      true
    );
  }
}

async function renderVideos(videos) {
  listEl.replaceChildren();

  if (!videos.length) {
    setStatus("No direct video sources found. Try playing the video, then rescan.");
    return;
  }

  setStatus("Resolving HLS variants...");

  const displayVideos = await collapseHlsVariants(videos);

  statusEl.hidden = true;

  for (const video of displayVideos) {
    const item = template.content.firstElementChild.cloneNode(true);
    const extension = getExtension(video.url);
    const isStream = STREAM_EXTENSIONS.has(extension);
    const isHlsStream = extension === HLS_EXTENSION;
    const isDownloadable = canDownload(video.url) && (!isStream || isHlsStream);

    item.querySelector(".video-title").textContent = video.title || makeTitle(video.url);
    item.querySelector(".video-details").textContent = [
      video.source,
      extension ? extension.toUpperCase() : "media",
      video.hlsVariants?.length ? `${video.hlsVariants.length} variants` : video.type
    ]
      .filter(Boolean)
      .join(" • ");

    const facts = getVideoFacts(video);
    const factsEl = item.querySelector(".video-facts");
    if (facts.length) {
      factsEl.hidden = false;
      factsEl.replaceChildren(
        ...facts.map((fact) => {
          const element = document.createElement("span");
          element.className = "video-fact";
          element.textContent = fact;
          return element;
        })
      );
    }

    const qualityField = item.querySelector(".quality-field");
    const qualitySelect = item.querySelector(".quality-select");
    const link = item.querySelector(".video-url");
    const getSelectedUrl = () => qualitySelect.value || video.url;

    if (video.hlsVariants?.length) {
      qualityField.hidden = false;
      qualitySelect.replaceChildren(
        ...video.hlsVariants.map((variant) => new Option(formatHlsVariant(variant), variant.url))
      );
      qualitySelect.addEventListener("change", () => {
        link.href = getSelectedUrl();
        link.textContent = getSelectedUrl();
      });
    }

    link.href = getSelectedUrl();
    link.textContent = getSelectedUrl();

    const downloadButton = item.querySelector(".download-button");
    downloadButton.disabled = !isDownloadable;
    downloadButton.textContent = isHlsStream ? "Download HLS" : isStream ? "Stream URL" : "Download";
    downloadButton.title = isHlsStream
      ? "Download an unencrypted HLS stream by combining its media segments."
      : isStream
      ? "DASH streams need a media tool such as ffmpeg; this extension copies the stream URL."
      : "Download this direct video URL";
    downloadButton.addEventListener("click", () => {
      if (isHlsStream) {
        openHlsDownloader({ ...video, url: getSelectedUrl() });
        return;
      }

      downloadVideo(video);
    });

    const copyButton = item.querySelector(".copy-button");
    copyButton.addEventListener("click", async () => {
      await navigator.clipboard.writeText(getSelectedUrl());
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

function openHlsDownloader(video) {
  const params = new URLSearchParams({
    url: video.url,
    title: video.title || makeTitle(video.url)
  });

  chrome.tabs.create({
    url: chrome.runtime.getURL(`downloader.html?${params.toString()}`)
  });
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

function currentTabMedia(tab) {
  const extension = getExtension(tab.url || "");
  if (!MEDIA_EXTENSIONS.includes(extension)) {
    return null;
  }

  return {
    url: tab.url,
    source: "current tab",
    title: tab.title,
    type: ""
  };
}

function getVideoFacts(video) {
  return [
    Number.isFinite(video.duration) && video.duration > 0 ? formatDuration(video.duration) : "",
    video.width && video.height ? `${video.width}x${video.height}` : "",
    video.hlsVariants?.length ? "HLS" : "",
    video.fromCurrentSource ? "playing source" : ""
  ].filter(Boolean);
}

async function collapseHlsVariants(videos) {
  const hlsByUrl = new Map();
  const directVideos = [];

  for (const video of videos) {
    if (getExtension(video.url) === HLS_EXTENSION) {
      hlsByUrl.set(video.url, video);
    } else {
      directVideos.push(video);
    }
  }

  if (!hlsByUrl.size) {
    return directVideos;
  }

  const parsedHlsItems = await Promise.all(
    Array.from(hlsByUrl.values()).map(async (video) => {
      const details = await fetchHlsDetails(video.url);
      return { video, details };
    })
  );
  const variantUrls = new Set(
    parsedHlsItems.flatMap(({ details }) => details.variants.map((variant) => normalizeUrl(variant.url)))
  );
  const hlsItems = [];

  for (const { video, details } of parsedHlsItems) {
    if (variantUrls.has(video.url) && details.variants.length === 0) {
      continue;
    }

    hlsItems.push({
      ...video,
      duration: video.duration || details.duration || 0,
      hlsVariants: details.variants.length ? details.variants : undefined
    });
  }

  return [...directVideos, ...groupLooseHlsVariants(hlsItems)].sort((a, b) => scoreVideo(b) - scoreVideo(a));
}

async function fetchHlsDetails(url) {
  try {
    const response = await fetch(url, { credentials: "include" });
    if (!response.ok) {
      return emptyHlsDetails();
    }

    const text = await response.text();
    if (!/^#EXTM3U/m.test(text)) {
      return emptyHlsDetails();
    }

    return {
      duration: parseHlsDuration(text),
      variants: parseHlsVariants(text, url).sort((a, b) => b.bandwidth - a.bandwidth)
    };
  } catch {
    return emptyHlsDetails();
  }
}

function emptyHlsDetails() {
  return {
    duration: 0,
    variants: []
  };
}

function parseHlsDuration(text) {
  return text
    .split(/\r?\n/)
    .reduce((total, line) => {
      if (!line.startsWith("#EXTINF")) {
        return total;
      }

      return total + (Number(line.replace(/^#EXTINF:/i, "").split(",")[0]) || 0);
    }, 0);
}

function parseHlsVariants(text, playlistUrl) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const variants = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.startsWith("#EXT-X-STREAM-INF")) {
      continue;
    }

    const nextUri = findNextPlaylistUri(lines, index + 1);
    if (!nextUri) {
      continue;
    }

    variants.push({
      url: normalizeUrl(new URL(nextUri, playlistUrl).href),
      bandwidth: Number(getHlsAttribute(line, "BANDWIDTH")) || 0,
      resolution: getHlsAttribute(line, "RESOLUTION")
    });
  }

  return variants;
}

function findNextPlaylistUri(lines, startIndex) {
  for (let index = startIndex; index < lines.length; index += 1) {
    if (!lines[index].startsWith("#")) {
      return lines[index];
    }
  }

  return "";
}

function getHlsAttribute(line, attributeName) {
  const match = line.match(new RegExp(`${attributeName}=("[^"]+"|[^,]+)`, "i"));
  if (!match) {
    return "";
  }

  return match[1].replace(/^"|"$/g, "");
}

function groupLooseHlsVariants(hlsItems) {
  const groupedItems = [];
  const groups = new Map();

  for (const item of hlsItems) {
    if (item.hlsVariants?.length) {
      groupedItems.push(item);
      continue;
    }

    const key = looseHlsGroupKey(item.url);
    const group = groups.get(key) || [];
    group.push(item);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    if (group.length === 1) {
      groupedItems.push(group[0]);
      continue;
    }

    const base = group[0];
    groupedItems.push({
      ...base,
      source: "HLS playlist",
      type: "media variants",
      hlsVariants: group.map((item, index) => ({
        url: item.url,
        label: makeLooseVariantLabel(item.url, index)
      }))
    });
  }

  return groupedItems;
}

function looseHlsGroupKey(url) {
  try {
    const parsed = new URL(url);
    const name = parsed.pathname.split("/").filter(Boolean).pop() || "stream.m3u8";
    return `${parsed.hostname}/${name}`;
  } catch {
    return url;
  }
}

function makeLooseVariantLabel(url, index) {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.split("/").filter(Boolean).slice(-2).join("/");
    return pathname || `Variant ${index + 1}`;
  } catch {
    return `Variant ${index + 1}`;
  }
}

function formatHlsVariant(variant) {
  if (variant.label) {
    return variant.label;
  }

  const bandwidth = variant.bandwidth ? `${(variant.bandwidth / 1000000).toFixed(1)} Mbps` : "";
  return [variant.resolution, bandwidth].filter(Boolean).join(" - ") || "Auto";
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

  const addVideo = (url, source, type = "", metadata = {}) => {
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
      type,
      ...metadata
    });
  };

  for (const video of document.querySelectorAll("video")) {
    const metadata = getVideoElementMetadata(video);
    addVideo(video.currentSrc || video.src, "video element", video.type, {
      ...metadata,
      fromCurrentSource: true
    });

    for (const source of video.querySelectorAll("source")) {
      addVideo(source.src, "source element", source.type, metadata);
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

function getVideoElementMetadata(video) {
  return {
    duration: Number.isFinite(video.duration) ? video.duration : 0,
    width: video.videoWidth || video.clientWidth || 0,
    height: video.videoHeight || video.clientHeight || 0
  };
}

function formatDuration(seconds) {
  const rounded = Math.round(seconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remainingSeconds = rounded % 60;

  if (hours) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
  }

  return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}
