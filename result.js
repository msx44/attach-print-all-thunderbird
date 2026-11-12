document.addEventListener("DOMContentLoaded", () => {
  const urlParams = new URLSearchParams(window.location.search);
  const downloadId = parseInt(urlParams.get("downloadId"), 10);
  const filename = urlParams.get("filename");
  const skipped = urlParams.get("skipped");

  if (filename) {
    document.getElementById("filename-display").textContent = `保存完了: ${filename}`;
  }

  // 【v1.1】結合から外したファイル (暗号化PDFなど) があれば表示する
  if (skipped) {
    const skippedElem = document.getElementById("skipped-display");
    if (skippedElem) {
      skippedElem.textContent = `結合できなかったファイルがあります: ${skipped}。元のファイルを直接開いて印刷してください。`;
      skippedElem.style.display = "block";
    }
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