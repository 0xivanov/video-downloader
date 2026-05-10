const statusEl = document.querySelector("#status");
const summaryEl = document.querySelector("#summary");
const progressEl = document.querySelector("#progress");
const pageTitleEl = document.querySelector("#pageTitle");
const urlInput = document.querySelector("#urlInput");
const qualitySelect = document.querySelector("#qualitySelect");
const analyzeButton = document.querySelector("#analyzeButton");
const downloadButton = document.querySelector("#downloadButton");

const state = {
  sourceText: "",
  sourceUrl: "",
  title: "",
  variants: [],
  mediaPlaylist: null,
  keepAwake: false
};

analyzeButton.addEventListener("click", analyzeSource);
downloadButton.addEventListener("click", saveSelectedPlaylist);
qualitySelect.addEventListener("change", loadSelectedVariant);
document.addEventListener("DOMContentLoaded", initialize);
window.addEventListener("pagehide", releaseKeepAwake);
window.addEventListener("beforeunload", releaseKeepAwake);

function initialize() {
  const params = new URLSearchParams(location.search);
  const url = params.get("url") || "";
  const title = params.get("title") || makeTitle(url);

  state.title = title;
  pageTitleEl.textContent = title || "Stream download";
  urlInput.value = url;

  if (url) {
    analyzeSource();
  }
}

async function analyzeSource() {
  setBusy(true);
  setStatus("Reading HLS playlist...");
  setSummary("Analyzing playlist...");
  progressEl.value = 0;
  downloadButton.disabled = true;
  qualitySelect.disabled = true;
  qualitySelect.replaceChildren(new Option("Auto", ""));

  try {
    state.sourceUrl = normalizeUrl(urlInput.value);
    state.sourceText = await fetchText(state.sourceUrl);

    if (!isHlsPlaylist(state.sourceText)) {
      throw new Error("This URL did not return a valid HLS playlist.");
    }

    state.variants = parseHlsVariants(state.sourceText, state.sourceUrl).sort(
      (a, b) => b.bandwidth - a.bandwidth
    );

    renderQualityOptions();
    await loadSelectedVariant();
    setStatus("Ready to save.");
  } catch (error) {
    state.mediaPlaylist = null;
    setSummary("No downloadable HLS media playlist loaded.");
    setStatus(error.message || "Could not analyze this playlist.", true);
  } finally {
    setBusy(false);
  }
}

async function loadSelectedVariant() {
  setBusy(true, { keepDownloadDisabled: true });
  setStatus("Loading selected rendition...");
  downloadButton.disabled = true;

  try {
    const selectedVariant = state.variants[qualitySelect.selectedIndex];
    const playlistUrl = selectedVariant?.url || state.sourceUrl;
    const playlistText = selectedVariant ? await fetchText(playlistUrl) : state.sourceText;

    ensureSupportedHlsPlaylist(playlistText);
    state.mediaPlaylist = parseHlsMediaPlaylist(playlistText, playlistUrl, selectedVariant);

    if (!state.mediaPlaylist.segments.length) {
      throw new Error("This HLS playlist did not contain media segments.");
    }

    renderSummary();
    downloadButton.disabled = false;
  } catch (error) {
    state.mediaPlaylist = null;
    setSummary("No downloadable HLS media playlist loaded.");
    setStatus(error.message || "Could not load this rendition.", true);
  } finally {
    setBusy(false);
  }
}

async function saveSelectedPlaylist() {
  if (!state.mediaPlaylist) {
    setStatus("Analyze a playlist before saving.", true);
    return;
  }

  const filename = makeHlsFilename(state.sourceUrl, state.mediaPlaylist);
  setBusy(true, { keepDownloadDisabled: true });
  downloadButton.disabled = true;
  progressEl.value = 0;

  try {
    requestKeepAwake();
    if (window.showSaveFilePicker) {
      await saveWithFilePicker(filename);
    } else {
      await saveInMemory(filename);
    }

    progressEl.value = progressEl.max;
    setStatus(`Saved ${filename}.`);
  } catch (error) {
    if (error.name === "AbortError") {
      setStatus("Save canceled.");
    } else {
      setStatus(error.message || "Could not save this HLS stream.", true);
    }
  } finally {
    releaseKeepAwake();
    setBusy(false);
    downloadButton.disabled = !state.mediaPlaylist;
  }
}

async function saveWithFilePicker(filename) {
  const handle = await window.showSaveFilePicker({
    suggestedName: filename,
    types: [
      {
        description: "Video",
        accept: {
          [state.mediaPlaylist.mimeType]: [`.${state.mediaPlaylist.suggestedExtension}`]
        }
      }
    ]
  });
  const writable = await handle.createWritable();

  try {
    await writeHlsMedia((buffer) => writable.write(new Uint8Array(buffer)));
    await writable.close();
  } catch (error) {
    await writable.abort();
    throw error;
  }
}

async function saveInMemory(filename) {
  setStatus("This browser cannot stream directly to a file; saving from memory...");
  const parts = [];
  await writeHlsMedia((buffer) => {
    parts.push(buffer);
  });

  const blob = new Blob(parts, { type: state.mediaPlaylist.mimeType });
  const objectUrl = URL.createObjectURL(blob);
  const response = await chrome.runtime.sendMessage({
    type: "download-video",
    url: objectUrl,
    filename
  });

  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);

  if (!response?.ok) {
    throw new Error(response?.error || "Download failed.");
  }
}

async function writeHlsMedia(writeChunk) {
  const playlist = state.mediaPlaylist;
  let completed = 0;
  let downloadedBytes = 0;
  const totalParts = playlist.segments.length + (playlist.mapUrl ? 1 : 0);

  progressEl.max = totalParts;

  if (playlist.mapUrl) {
    setStatus("Downloading initialization segment...");
    const mapBuffer = await fetchArrayBuffer(playlist.mapUrl);
    downloadedBytes += mapBuffer.byteLength;
    await writeChunk(mapBuffer);
    completed += 1;
    progressEl.value = completed;
  }

  for (let index = 0; index < playlist.segments.length; index += 1) {
    const segment = playlist.segments[index];
    setStatus(
      `Downloading segment ${index + 1} of ${playlist.segments.length} (${formatBytes(
        downloadedBytes
      )})...`
    );

    const segmentBuffer = await fetchArrayBuffer(segment.url, segment.byteRange);
    downloadedBytes += segmentBuffer.byteLength;
    await writeChunk(segmentBuffer);
    completed += 1;
    progressEl.value = completed;
  }
}

async function fetchText(url) {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) {
    throw new Error(`Could not load playlist (${response.status}).`);
  }

  return response.text();
}

async function fetchArrayBuffer(url, byteRange) {
  const headers = {};
  if (byteRange) {
    headers.Range = `bytes=${byteRange.start}-${byteRange.end}`;
  }

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        credentials: "include",
        headers
      });

      if (!response.ok && response.status !== 206) {
        throw new Error(`Could not load media segment (${response.status}).`);
      }

      return response.arrayBuffer();
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await delay(500 * attempt);
      }
    }
  }

  throw lastError;
}

function renderQualityOptions() {
  qualitySelect.replaceChildren();

  if (!state.variants.length) {
    qualitySelect.append(new Option("Single rendition", ""));
    qualitySelect.disabled = true;
    return;
  }

  for (const variant of state.variants) {
    qualitySelect.append(new Option(formatVariant(variant), variant.url));
  }

  qualitySelect.selectedIndex = 0;
  qualitySelect.disabled = false;
}

function renderSummary() {
  const playlist = state.mediaPlaylist;
  const quality = playlist.variant ? `${formatVariant(playlist.variant)}; ` : "";
  const duration = playlist.durationSeconds ? `${formatDuration(playlist.durationSeconds)}; ` : "";

  setSummary(
    `${quality}${duration}${playlist.segments.length} media segments; saving as .${playlist.suggestedExtension}.`
  );
}

function setBusy(isBusy, options = {}) {
  analyzeButton.disabled = isBusy;
  urlInput.disabled = isBusy;
  qualitySelect.disabled = isBusy || !state.variants.length;

  if (!options.keepDownloadDisabled) {
    downloadButton.disabled = isBusy || !state.mediaPlaylist;
  }
}

function setSummary(message) {
  summaryEl.textContent = message;
}

function setStatus(message, warning = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("warning", warning);
}

function requestKeepAwake() {
  if (typeof chrome === "undefined" || !chrome.power?.requestKeepAwake) {
    return;
  }

  chrome.power.requestKeepAwake("system");
  state.keepAwake = true;
}

function releaseKeepAwake() {
  if (!state.keepAwake || typeof chrome === "undefined" || !chrome.power?.releaseKeepAwake) {
    return;
  }

  chrome.power.releaseKeepAwake();
  state.keepAwake = false;
}

function isHlsPlaylist(text) {
  return /^#EXTM3U/m.test(text);
}

function parseHlsVariants(text, playlistUrl) {
  const lines = getPlaylistLines(text);
  const variants = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.startsWith("#EXT-X-STREAM-INF")) {
      continue;
    }

    const nextUri = findNextUri(lines, index + 1);
    if (!nextUri) {
      continue;
    }

    variants.push({
      url: resolvePlaylistUrl(nextUri, playlistUrl),
      bandwidth: Number(getHlsAttribute(line, "BANDWIDTH")) || 0,
      resolution: getHlsAttribute(line, "RESOLUTION")
    });
  }

  return variants;
}

function parseHlsMediaPlaylist(text, playlistUrl, variant = null) {
  const lines = getPlaylistLines(text);
  const segments = [];
  let durationSeconds = 0;
  let mapUrl = "";
  let nextByteRange = null;
  let nextDuration = 0;
  let byteRangeOffset = 0;

  for (const line of lines) {
    if (line.startsWith("#EXT-X-MAP")) {
      const uri = getHlsAttribute(line, "URI");
      if (uri) {
        mapUrl = resolvePlaylistUrl(uri, playlistUrl);
      }
      continue;
    }

    if (line.startsWith("#EXT-X-BYTERANGE")) {
      nextByteRange = parseByteRange(line, byteRangeOffset);
      if (nextByteRange) {
        byteRangeOffset = nextByteRange.end + 1;
      }
      continue;
    }

    if (line.startsWith("#EXTINF")) {
      nextDuration = Number(line.replace(/^#EXTINF:/i, "").split(",")[0]) || 0;
      continue;
    }

    if (line.startsWith("#")) {
      continue;
    }

    segments.push({
      url: resolvePlaylistUrl(line, playlistUrl),
      byteRange: nextByteRange
    });
    durationSeconds += nextDuration;
    nextByteRange = null;
    nextDuration = 0;
  }

  const firstSegmentUrl = segments[0]?.url || mapUrl || playlistUrl;
  const extension = getExtension(firstSegmentUrl);
  const isFragmentedMp4 = Boolean(mapUrl) || extension === "m4s" || extension === "mp4";

  return {
    durationSeconds,
    mapUrl,
    mimeType: isFragmentedMp4 ? "video/mp4" : "video/mp2t",
    suggestedExtension: isFragmentedMp4 ? "mp4" : "ts",
    segments,
    variant
  };
}

function ensureSupportedHlsPlaylist(text) {
  if (/#EXT-X-KEY:(?!.*METHOD=NONE)/i.test(text)) {
    throw new Error("Encrypted HLS streams are not supported by this extension.");
  }
}

function getPlaylistLines(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function findNextUri(lines, startIndex) {
  for (let index = startIndex; index < lines.length; index += 1) {
    if (!lines[index].startsWith("#")) {
      return lines[index];
    }
  }

  return "";
}

function resolvePlaylistUrl(url, playlistUrl) {
  return new URL(url, playlistUrl).href;
}

function normalizeUrl(url) {
  return new URL(url).href;
}

function getHlsAttribute(line, attributeName) {
  const match = line.match(new RegExp(`${attributeName}=("[^"]+"|[^,]+)`, "i"));
  if (!match) {
    return "";
  }

  return match[1].replace(/^"|"$/g, "");
}

function parseByteRange(line, fallbackOffset) {
  const value = line.replace(/^#EXT-X-BYTERANGE:/i, "").trim();
  const match = value.match(/^(\d+)(?:@(\d+))?$/);
  if (!match) {
    return null;
  }

  const length = Number(match[1]);
  const start = match[2] ? Number(match[2]) : fallbackOffset;
  return {
    start,
    end: start + length - 1
  };
}

function makeHlsFilename(url, playlist) {
  const title = (state.title || makeTitle(url)).replace(/\.[a-z0-9]+$/i, "") || "video";
  return `${sanitizeFilename(title)}.${playlist.suggestedExtension}`;
}

function makeTitle(url) {
  try {
    const parsed = new URL(url);
    const name = parsed.pathname.split("/").filter(Boolean).pop() || "video";
    return decodeURIComponent(name);
  } catch {
    return "video";
  }
}

function sanitizeFilename(filename) {
  return (
    String(filename)
      .replace(/[\\/:*?"<>|]+/g, "-")
      .replace(/\s+/g, " ")
      .trim() || "video"
  );
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

function formatVariant(variant) {
  const bandwidth = variant.bandwidth ? `${(variant.bandwidth / 1000000).toFixed(1)} Mbps` : "";
  return [variant.resolution, bandwidth].filter(Boolean).join(" - ") || "Rendition";
}

function formatDuration(seconds) {
  const rounded = Math.round(seconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remainingSeconds = rounded % 60;

  if (hours) {
    return `${hours}h ${minutes}m ${remainingSeconds}s`;
  }

  return `${minutes}m ${remainingSeconds}s`;
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
