document.addEventListener("DOMContentLoaded", () => {
  const urlParams = new URLSearchParams(window.location.search);
  const downloadId = parseInt(urlParams.get("downloadId"), 10);
  const filename = urlParams.get("filename");

  if (filename) {
    document.getElementById("filename-display").textContent = `保存完了: ${filename}`;
  }

  const openBtn = document.getElementById("open-btn");

  if (downloadId && openBtn) {
    openBtn.addEventListener("click", async () => {
      try {
        await messenger.downloads.open(downloadId);
        const currentTab = await messenger.tabs.getCurrent();
        if (currentTab && currentTab.id) {
          await messenger.tabs.remove(currentTab.id);
        }
      } catch (error) {
        console.error("Failed to open downloaded file:", error);
        alert("ファイルを開けませんでした: " + error.message);
      }
    });
  }
});