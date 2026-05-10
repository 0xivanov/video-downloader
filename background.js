chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "download-video") {
    return false;
  }

  const url = String(message.url || "");
  if (!isDownloadableUrl(url)) {
    sendResponse({
      ok: false,
      error: "This item is not a direct downloadable media URL."
    });
    return false;
  }

  chrome.downloads.download(
    {
      url,
      filename: sanitizeFilename(message.filename || guessFilename(url)),
      saveAs: true,
      conflictAction: "uniquify"
    },
    (downloadId) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        sendResponse({ ok: false, error: lastError.message });
        return;
      }

      sendResponse({ ok: true, downloadId });
    }
  );

  return true;
});

function isDownloadableUrl(url) {
  return /^https?:\/\//i.test(url) || /^data:video\//i.test(url) || /^blob:/i.test(url);
}

function guessFilename(url) {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.split("/").filter(Boolean).pop();
    return pathname || "video";
  } catch {
    return "video";
  }
}

function sanitizeFilename(filename) {
  const clean = String(filename)
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim();

  return clean || "video";
}
