console.log("[DEBUG] background.js loaded successfully.");

// ポップアップ通知を表示する関数
function notify(message) {
  try {
    messenger.notifications.create({
      type: "basic",
      iconUrl: "icon.png",
      title: "Attach Print All",
      message: message
    });
  } catch (e) {
    console.log("[DEBUG] Notification error:", e);
  }
}

// 右クリックメニューの作成
try {
  messenger.menus.create({
    id: "print-all-attachments-menu",
    title: messenger.i18n.getMessage("contextMenuTitle"),
    contexts: ["message_attachments"]
  });
} catch (e) {}

// クリックイベントの登録
messenger.messageDisplayAction.onClicked.addListener(async (tab) => {
  notify("処理を開始します...");
  await processAndDownloadPdf(tab, null);
});

messenger.menus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "print-all-attachments-menu") {
    notify("処理を開始します...");
    await processAndDownloadPdf(tab, info);
  }
});

// 対象メッセージの取得
async function getTargetMessage(tab, info) {
  if (info && info.selectedMessages && info.selectedMessages.messages && info.selectedMessages.messages.length > 0) {
    return info.selectedMessages.messages[0];
  }
  if (tab && tab.id !== undefined) {
    try {
      const messages = await messenger.messageDisplay.getDisplayedMessages(tab.id);
      if (messages && messages.length > 0) return messages[0];
    } catch (e) {}
  }
  try {
    const selectedMessages = await messenger.mailTabs.getSelectedMessages();
    if (selectedMessages && selectedMessages.messages && selectedMessages.messages.length > 0) {
      return selectedMessages.messages[0];
    }
  } catch (e) {}
  return null;
}

// ファイル名の生成（MA_YYYYMMDD_HHMMSS_送信者名.pdf）
function generateFilename(message) {
  const d = new Date(message.date);
  const pad = (n) => String(n).padStart(2, "0");
  const dateStr = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

  let sender = message.author || "Unknown";
  const match = sender.match(/^"?([^"<]+)"?\s*<([^>]+)>/) || sender.match(/<([^>]+)>/);
  if (match) {
    sender = match[1] ? match[1].trim() : match[2].trim();
  }

  sender = sender.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, "_");
  return `MA_${dateStr}_${sender}.pdf`;
}

// 画像・PDF・ZIPの抽出と結合処理
async function appendBufferToPdf(arrayBuffer, fileName, mergedPdf) {
  const lowerName = fileName.toLowerCase();

  if (lowerName.endsWith(".pdf")) {
    try {
      const srcPdf = await PDFLib.PDFDocument.load(arrayBuffer, { ignoreEncryption: true });
      const copiedPages = await mergedPdf.copyPages(srcPdf, srcPdf.getPageIndices());
      copiedPages.forEach((page) => mergedPdf.addPage(page));
    } catch (pdfError) {
      console.warn("[DEBUG] PDFの読み込みに失敗したためスキップ:", fileName);
    }
  } else if (lowerName.endsWith(".png")) {
    try {
      const image = await mergedPdf.embedPng(arrayBuffer);
      const page = mergedPdf.addPage([image.width, image.height]);
      page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
    } catch (imgError) {}
  } else if (lowerName.endsWith(".jpg") || lowerName.endsWith(".jpeg")) {
    try {
      const image = await mergedPdf.embedJpg(arrayBuffer);
      const page = mergedPdf.addPage([image.width, image.height]);
      page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
    } catch (imgError) {}
  } else if (lowerName.endsWith(".zip")) {
    try {
      if (typeof JSZip !== "undefined") {
        const zip = await JSZip.loadAsync(arrayBuffer);
        for (const relativePath of Object.keys(zip.files)) {
          const zipEntry = zip.files[relativePath];
          if (!zipEntry.dir) {
            const entryBuffer = await zipEntry.async("arraybuffer");
            await appendBufferToPdf(entryBuffer, zipEntry.name, mergedPdf);
          }
        }
      }
    } catch (zipError) {}
  }
}

// メイン処理
async function processAndDownloadPdf(tab, info) {
  try {
    if (typeof PDFLib === "undefined") {
      notify("エラー: pdf-lib.min.js が読み込まれていません。");
      return;
    }

    const message = await getTargetMessage(tab, info);
    if (!message || !message.id) {
      notify("対象のメールが見つかりませんでした。");
      return;
    }

    const attachments = await messenger.messages.listAttachments(message.id);
    if (!attachments || attachments.length === 0) {
      notify("添付ファイルが見つかりませんでした。");
      return;
    }

    notify(`${attachments.length}件の添付ファイルを解析中...`);
    const mergedPdf = await PDFLib.PDFDocument.create();

    for (const att of attachments) {
      const partName = att.partName || att.id;
      const file = await messenger.messages.getAttachmentFile(message.id, partName);
      const arrayBuffer = await file.arrayBuffer();
      await appendBufferToPdf(arrayBuffer, att.name, mergedPdf);
    }

    if (mergedPdf.getPageCount() === 0) {
      notify("対象となるPDF・画像・ZIPファイルがありませんでした。");
      return;
    }

    const outputFilename = generateFilename(message);
    const pdfBytes = await mergedPdf.save();
    const blob = new Blob([pdfBytes], { type: "application/pdf" });
    const blobUrl = URL.createObjectURL(blob);

    const downloadId = await messenger.downloads.download({
      url: blobUrl,
      filename: outputFilename,
      saveAs: false
    });

    await messenger.tabs.create({
      url: `result.html?downloadId=${downloadId}&filename=${encodeURIComponent(outputFilename)}`,
      active: true
    });

    setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);

  } catch (error) {
    console.error("[DEBUG] Error:", error);
    notify("エラーが発生しました: " + error.message);
  }
}