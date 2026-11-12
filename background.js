console.log("[DEBUG] background.js loaded successfully.");

// 【v1.1】暗号化PDFの復号に対応 (decrypt-pdf.js)。
// 銀行の明細PDFなどは RC4 で暗号化されていることがあり、pdf-lib の
// ignoreEncryption は復号しないため、結合するとページ全体が真っ白になる。
// 結合前に DecryptPdf.decryptPdfIfEncrypted() で復号し、復号できない
// 暗号化PDFは結合から外してユーザーへ通知する (無言で白紙にしない)。
// あわせて、添付がないメールではツールバーボタンを無効化する
// (updateButtonState、詳細は下記)。

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

// 【v1.1・あずさ側で再実装】添付がないメールではボタンを無効化する。
// messageDisplayAction API には hide/show がなく、enable([tabId]) /
// disable([tabId]) (TB 71〜) しかないため、非表示ではなくグレーアウトで対応する。
// 注意: タブの enable 状態を個別に更新すると、それ以降の変更も個別に行う
// 必要があるため、本実装では常に tabId を渡して切り替える。
// 右クリックメニューは contexts: ["message_attachments"] のため添付ファイル上
// でしか表示されず、添付のないメールでは元々出ないので変更なし。
// 新しい権限の追加はない。

// getDisplayedMessages / onMessagesDisplayed の戻り値を配列にそろえる。
// MV3 の公式ドキュメントでは配列だが、MessageList ({ messages: [...] }) 形式で
// 返る環境でも壊れないよう両形式に対応する。
function normalizeDisplayedMessages(displayed) {
  if (!displayed) return [];
  if (Array.isArray(displayed)) return displayed;
  if (Array.isArray(displayed.messages)) return displayed.messages;
  return [];
}

// 指定タブで表示中のメールに添付があるかを調べ、ボタンの有効/無効を切り替える。
// displayedMessages を渡された場合はそれを使い、なければ自分で取得する。
// 添付の有無が取得できなかった場合は有効のままにする (fail-open、従来動作を壊さない)。
async function updateButtonState(tab, displayedMessages) {
  const tabId = tab && typeof tab === "object" ? tab.id : tab;
  if (tabId === undefined || tabId === null) return;
  try {
    let messages = displayedMessages;
    if (messages === undefined || messages === null) {
      messages = await messenger.messageDisplay.getDisplayedMessages(tabId);
    }
    const list = normalizeDisplayedMessages(messages);
    if (list.length === 0) {
      await messenger.messageDisplayAction.disable(tabId);
      return;
    }
    let hasAttachments = false;
    for (const message of list) {
      if (!message || message.id === undefined) continue;
      const attachments = await messenger.messages.listAttachments(message.id);
      if (attachments && attachments.length > 0) {
        hasAttachments = true;
        break;
      }
    }
    if (hasAttachments) {
      await messenger.messageDisplayAction.enable(tabId);
    } else {
      await messenger.messageDisplayAction.disable(tabId);
    }
  } catch (e) {
    // fail-open: 取得に失敗したら有効のままにする
    try {
      await messenger.messageDisplayAction.enable(tabId);
    } catch (e2) {}
  }
}

// 表示中のメールが変わるたびにボタンの状態を切り替える
// (TB 81〜、単数・複数表示の両方で発火する)
try {
  messenger.messageDisplay.onMessagesDisplayed.addListener(
    async (tab, displayedMessages) => {
      await updateButtonState(tab, displayedMessages);
    }
  );
} catch (e) {}

// 起動時に、既に表示中のメールの分もタブごとに同期する
(async () => {
  try {
    const tabs = await messenger.tabs.query({});
    for (const tab of tabs) {
      await updateButtonState(tab);
    }
  } catch (e) {}
})();

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
// 戻り値: { skipped: true, reason } = 結合から外した (暗号化PDFなど)
//         { skipped: false } = 結合した (または対象外で何もしなかった)
async function appendBufferToPdf(arrayBuffer, fileName, mergedPdf) {
  const lowerName = fileName.toLowerCase();

  if (lowerName.endsWith(".pdf")) {
    // 【v1.1】暗号化PDFは復号してから結合する
    // dec.bytes (Uint8Array) を常に使う: 生の ArrayBuffer をそのまま渡すと
    // 実行環境によっては pdf-lib の型チェックで弾かれるため。
    let pdfBytes = arrayBuffer;
    if (typeof DecryptPdf !== "undefined" && DecryptPdf.decryptPdfIfEncrypted) {
      const dec = DecryptPdf.decryptPdfIfEncrypted(arrayBuffer);
      if (dec.status === "decrypted" || dec.status === "not-encrypted") {
        pdfBytes = dec.bytes;
      } else if (dec.status === "unsupported" || dec.status === "failed") {
        console.warn("[DEBUG] 暗号化PDFのためスキップ:", fileName, dec.reason);
        return { skipped: true, reason: dec.reason || "暗号化されているため結合できません" };
      }
    }
    try {
      const srcPdf = await PDFLib.PDFDocument.load(pdfBytes, { ignoreEncryption: true });
      const copiedPages = await mergedPdf.copyPages(srcPdf, srcPdf.getPageIndices());
      copiedPages.forEach((page) => mergedPdf.addPage(page));
      return { skipped: false };
    } catch (pdfError) {
      console.warn("[DEBUG] PDFの読み込みに失敗したためスキップ:", fileName);
      return { skipped: true, reason: "PDFとして読み込めませんでした" };
    }
  } else if (lowerName.endsWith(".png")) {
    try {
      const image = await mergedPdf.embedPng(arrayBuffer);
      const page = mergedPdf.addPage([image.width, image.height]);
      page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
    } catch (imgError) {}
    return { skipped: false };
  } else if (lowerName.endsWith(".jpg") || lowerName.endsWith(".jpeg")) {
    try {
      const image = await mergedPdf.embedJpg(arrayBuffer);
      const page = mergedPdf.addPage([image.width, image.height]);
      page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
    } catch (imgError) {}
    return { skipped: false };
  } else if (lowerName.endsWith(".zip")) {
    try {
      if (typeof JSZip !== "undefined") {
        const zip = await JSZip.loadAsync(arrayBuffer);
        let zipSkipped = null;
        for (const relativePath of Object.keys(zip.files)) {
          const zipEntry = zip.files[relativePath];
          if (!zipEntry.dir) {
            const entryBuffer = await zipEntry.async("arraybuffer");
            const r = await appendBufferToPdf(entryBuffer, zipEntry.name, mergedPdf);
            if (r && r.skipped && !zipSkipped) {
              zipSkipped = { skipped: true, reason: r.reason };
            }
          }
        }
        if (zipSkipped) return zipSkipped;
      }
    } catch (zipError) {}
    return { skipped: false };
  }
  return { skipped: false };
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
    // 【v1.1】結合から外したファイル (暗号化PDFなど) を集める
    const skippedFiles = [];

    for (const att of attachments) {
      const partName = att.partName || att.id;
      const file = await messenger.messages.getAttachmentFile(message.id, partName);
      const arrayBuffer = await file.arrayBuffer();
      const r = await appendBufferToPdf(arrayBuffer, att.name, mergedPdf);
      if (r && r.skipped) {
        skippedFiles.push({ name: att.name, reason: r.reason });
      }
    }

    if (mergedPdf.getPageCount() === 0) {
      if (skippedFiles.length > 0) {
        const names = skippedFiles.map((f) => f.name).join("、");
        notify(`結合できませんでした (${skippedFiles.length}件): ${names} — ${skippedFiles[0].reason}。元のファイルを直接開いて印刷してください。`);
      } else {
        notify("対象となるPDF・画像・ZIPファイルがありませんでした。");
      }
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

    // 【v1.1】結合から外したファイルがあれば完了画面にも表示する
    const skippedParam = skippedFiles.length > 0
      ? `&skipped=${encodeURIComponent(skippedFiles.map((f) => `${f.name} (${f.reason})`).join(" / "))}`
      : "";

    await messenger.tabs.create({
      url: `result.html?downloadId=${downloadId}&filename=${encodeURIComponent(outputFilename)}${skippedParam}`,
      active: true
    });

    if (skippedFiles.length > 0) {
      const names = skippedFiles.map((f) => f.name).join("、");
      notify(`結合できないファイルが ${skippedFiles.length} 件ありました: ${names} — ${skippedFiles[0].reason}。元のファイルを直接開いて印刷してください。`);
    }

    setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);

  } catch (error) {
    console.error("[DEBUG] Error:", error);
    notify("エラーが発生しました: " + error.message);
  }
}