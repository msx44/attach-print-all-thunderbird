# Attach_Print_All v1.1 変更点

## 修正した問題
- PayPay銀行の振込明細など、暗号化されたPDFを結合するとページ全体が真っ白になる問題を修正。
- 原因: 対象PDFは RC4 暗号化 (V=1/R=2、空パスワード) されているが、pdf-lib の
  `PDFDocument.load({ ignoreEncryption: true })` は復号しないため、暗号化されたままの
  ストリームが暗号化なしの出力PDFにコピーされ、ビューアが解読できず白紙化していた。
  しかも読み込み自体は成功するため警告も出なかった。

## 変更内容
- `decrypt-pdf.js` (新規、自作): 標準PDF暗号の復号。MD5 (RFC 1321)・RC4 とも純JS実装で、
  ブラウザAPIを使わない。対応範囲は `/Filter /Standard`、`/V 1`、`/R 2`、40bit鍵、
  空パスワードのみ。復号前に /U によるパスワード検証を行い、合わなければ復号しない。
- `background.js`: PDF結合の前に `DecryptPdf.decryptPdfIfEncrypted()` を呼ぶ。
  復号できたものは結合、復号できない暗号化PDF (AES / V=2以上 / R=3以上 /
  パスワード付き / 構造が読めないもの) は結合から外し、通知と完了画面に
  ファイル名と理由を表示する (無言で白紙にしない)。
  pdf-lib には常に `dec.bytes` (Uint8Array) を渡す。生の ArrayBuffer を渡すと
  実行環境によっては pdf-lib の型チェックで弾かれるため。
- `manifest.json`: バージョン 1.1.0。background scripts に `decrypt-pdf.js` を追加。
- `result.html` / `result.js`: 結合から外したファイルがある場合、完了画面に注意書きを表示。
- `VENDOR.md`: decrypt-pdf.js は自作コードである旨を追記。
- `background.js` (ボタン無効化、あずさ側で再実装): 添付のないメールを表示している時は
  ツールバーボタンを無効化 (グレーアウト) する。`messageDisplayAction` API には
  hide/show がなく enable/disable (TB 71〜) しかないため、非表示ではなく無効化で対応。
  `messageDisplay.onMessagesDisplayed` (TB 81〜) で表示中のメールが変わるたびに
  タブごとに切り替え、起動時は `tabs.query` + `getDisplayedMessages` で既に表示中の
  分も同期する。複数表示ではいずれかに添付があれば有効。添付の有無が取得できない
  場合は有効のままにする (fail-open)。新しい権限の追加はない。
  ※引き継ぎメモでは v1.1.0 同梱済みとされていたが、受領した zip には実装が
  含まれていなかったため、引き継ぎメモの仕様に基づき 2026-11-12 に再実装した。

## 検証 (2026-11-12、実PDFで確認)
- PayPay銀行 振込明細PDF (暗号化): v1.0 では結合後テキスト0件・描画は真っ白 →
  v1.1 では復号して結合し、368件のテキストが読めることを確認。
- 暗号化されていないPDF: そのまま結合され、内容は変わらないことを確認。
- ZIP内の暗号化PDF: ZIP展開後の再帰処理でも復号されることを確認。
- 非対応の暗号化PDF (V=2 に書き換えたもの、/U を壊したパスワード付き相当):
  結合から外れ、通知と完了画面に表示されることを確認。
- 詳細は `../verification-2026-11-12.md` を参照。
- ボタン有効/無効 (2026-11-12、あずさ側で再検証): messenger スタブで background.js を
  実実行し 14/14 通過。起動時同期 (添付あり=enable / 添付なし・表示なし=disable /
  取得失敗=enable の fail-open)、メール切り替えでの disable/enable、複数表示では
  いずれかに添付があれば enable、MessageList 形式の正規化を確認。
  テストは `../tests-azusa/test-button-azusa.js`。

## インストール
- このフォルダ一式を zip 化した `Attach_Print_All_v1.1.zip` を Thunderbird の
  「アドオンとテーマ」からインストールする (v1.0 と同じ手順)。
- 署名なしの .zip のため、恒久インストールには環境に応じた設定が必要な場合がある
  (v1.0 と同じ)。
