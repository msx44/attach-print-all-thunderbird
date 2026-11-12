/* decrypt-pdf.js — 標準PDF暗号の復号 (Attach_Print_All v1.1)
 *
 * 背景: 銀行の明細PDFなどは RC4 で暗号化されていることがある。
 * pdf-lib の PDFDocument.load({ ignoreEncryption: true }) は復号せず、
 * copyPages が暗号化されたままのストリームを暗号化なしの出力PDFへ
 * コピーするため、開いた側が Flate 解凍に失敗してページ全体が真っ白になる。
 * このモジュールは結合の前段で、標準アルゴリズム (PDF仕様 §3.5) により
 * 空パスワードの RC4-40bit (V=1 / R=2) のPDFを復号する。
 *
 * 対応範囲: /Filter /Standard, /V 1 (または省略), /R 2, /Length 40 (または省略)。
 * 非対応 (AES / V=2 以上 / R=3 以上 / パスワード付き) は復号せず
 * status: 'unsupported' を返す。呼び出し側はそのファイルを結合から外し、
 * ユーザーへ通知すること。無言で白紙を印刷しないための安全装置である。
 * ブラウザAPIは使わない (MD5・RC4とも純JS実装) ので、background page
 * でも Node でもそのまま動く。
 */
(function (global) {
  'use strict';

  // PDF仕様の固定パディング文字列 (32バイト)
  var PADDING = new Uint8Array([
    0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41,
    0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
    0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80,
    0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a
  ]);

  // ===== MD5 (RFC 1321) =====
  function md5(input) {
    var s = [
      7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
      5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
      4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
      6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
    ];
    var K = [];
    for (var i = 0; i < 64; i++) {
      K.push(Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0);
    }
    var a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    var msgLen = input.length;
    var bitLenLow = (msgLen * 8) >>> 0;
    var bitLenHigh = Math.floor((msgLen * 8) / 4294967296) >>> 0;
    var paddedLen = (((msgLen + 8) >> 6) + 1) << 6;
    var msg = new Uint8Array(paddedLen);
    msg.set(input);
    msg[msgLen] = 0x80;
    var dv = new DataView(msg.buffer);
    dv.setUint32(paddedLen - 8, bitLenLow, true);
    dv.setUint32(paddedLen - 4, bitLenHigh, true);
    function rol(x, c) { return (x << c) | (x >>> (32 - c)); }
    for (var off = 0; off < paddedLen; off += 64) {
      var M = [];
      for (var j = 0; j < 16; j++) M.push(dv.getUint32(off + j * 4, true));
      var A = a0, B = b0, C = c0, D = d0;
      for (var k = 0; k < 64; k++) {
        var F, g;
        if (k < 16) { F = (B & C) | (~B & D); g = k; }
        else if (k < 32) { F = (D & B) | (~D & C); g = (5 * k + 1) % 16; }
        else if (k < 48) { F = B ^ C ^ D; g = (3 * k + 5) % 16; }
        else { F = C ^ (B | ~D); g = (7 * k) % 16; }
        F = (F + A + K[k] + M[g]) >>> 0;
        A = D; D = C; C = B;
        B = (B + rol(F, s[k])) >>> 0;
      }
      a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0;
      c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
    }
    var out = new Uint8Array(16);
    var od = new DataView(out.buffer);
    od.setUint32(0, a0, true); od.setUint32(4, b0, true);
    od.setUint32(8, c0, true); od.setUint32(12, d0, true);
    return out;
  }

  // ===== RC4 =====
  function rc4(key, data) {
    var S = new Uint8Array(256);
    for (var i = 0; i < 256; i++) S[i] = i;
    var j = 0, tmp;
    for (var a = 0; a < 256; a++) {
      j = (j + S[a] + key[a % key.length]) & 0xff;
      tmp = S[a]; S[a] = S[j]; S[j] = tmp;
    }
    var out = new Uint8Array(data.length);
    var ii = 0; j = 0;
    for (var n = 0; n < data.length; n++) {
      ii = (ii + 1) & 0xff; j = (j + S[ii]) & 0xff;
      tmp = S[ii]; S[ii] = S[j]; S[j] = tmp;
      out[n] = data[n] ^ S[(S[ii] + S[j]) & 0xff];
    }
    return out;
  }

  // ===== バイト列 <-> Latin-1文字列 (1バイト=1文字で可逆) =====
  function bytesToBinStr(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return s;
  }
  function binStrToBytes(str) {
    var b = new Uint8Array(str.length);
    for (var i = 0; i < str.length; i++) b[i] = str.charCodeAt(i) & 0xff;
    return b;
  }

  // ===== PDF文字列のパース・生成 =====
  function parseLiteralString(raw) {
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var c = raw.charCodeAt(i);
      if (c === 0x5c) { // backslash
        var n = i + 1 < raw.length ? raw.charCodeAt(i + 1) : 0;
        if (n === 0x6e) { out.push(0x0a); i++; }
        else if (n === 0x72) { out.push(0x0d); i++; }
        else if (n === 0x74) { out.push(0x09); i++; }
        else if (n === 0x62) { out.push(0x08); i++; }
        else if (n === 0x66) { out.push(0x0c); i++; }
        else if (n === 0x28 || n === 0x29 || n === 0x5c) { out.push(n); i++; }
        else if (n === 0x0d || n === 0x0a) {
          i++;
          if (n === 0x0d && i + 1 < raw.length && raw.charCodeAt(i + 1) === 0x0a) i++;
        }
        else if (n >= 0x30 && n <= 0x37) {
          var oct = '', j = i + 1;
          while (j < raw.length && oct.length < 3) {
            var d = raw.charCodeAt(j);
            if (d < 0x30 || d > 0x37) break;
            oct += raw.charAt(j); j++;
          }
          out.push(parseInt(oct, 8) & 0xff); i = j - 1;
        }
        else { out.push(n); i++; }
      } else {
        out.push(c);
      }
    }
    return new Uint8Array(out);
  }

  function escapeLiteral(data) {
    var s = '';
    for (var i = 0; i < data.length; i++) {
      var b = data[i];
      if (b === 0x28) s += '\\(';
      else if (b === 0x29) s += '\\)';
      else if (b === 0x5c) s += '\\\\';
      else if (b === 0x0a) s += '\\n';
      else if (b === 0x0d) s += '\\r';
      else if (b === 0x09) s += '\\t';
      else if (b < 0x20 || b >= 0x7f) s += '\\' + ('00' + b.toString(8)).slice(-3);
      else s += String.fromCharCode(b);
    }
    return s;
  }

  function bytesToHex(data) {
    var h = '';
    for (var i = 0; i < data.length; i++) {
      h += ('0' + data[i].toString(16)).slice(-2);
    }
    return h;
  }

  function hexToBytes(hex) {
    var h = hex.replace(/\s+/g, '');
    if (h.length % 2 === 1) h += '0';
    var out = new Uint8Array(h.length / 2);
    for (var i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
    return out;
  }

  function bytesEqual(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  // オブジェクト本体中の文字列リテラル / 16進文字列を復号する (ストリーム部は除く)
  function decryptStringsInRegion(body, objKey) {
    var out = '', i = 0, n = body.length;
    while (i < n) {
      var c = body.charAt(i);
      if (c === '(') {
        var depth = 1, j = i + 1;
        while (j < n && depth > 0) {
          if (body.charAt(j) === '\\') { j += 2; continue; }
          if (body.charAt(j) === '(') depth++;
          else if (body.charAt(j) === ')') depth--;
          j++;
        }
        var dec = rc4(objKey, parseLiteralString(body.slice(i + 1, j - 1)));
        out += '(' + escapeLiteral(dec) + ')';
        i = j;
      } else if (c === '<' && body.charAt(i + 1) !== '<') {
        var k = body.indexOf('>', i + 1);
        if (k === -1) { out += c; i++; continue; }
        var inner = body.slice(i + 1, k);
        if (/^[0-9A-Fa-f\s]*$/.test(inner)) {
          var decHex = rc4(objKey, hexToBytes(inner));
          out += '<' + bytesToHex(decHex) + '>';
          i = k + 1;
        } else { out += c; i++; }
      } else {
        out += c; i++;
      }
    }
    return out;
  }

  function objectKeyFor(fileKey, num, gen) {
    var buf = new Uint8Array(fileKey.length + 5);
    buf.set(fileKey, 0);
    buf[fileKey.length] = num & 0xff;
    buf[fileKey.length + 1] = (num >> 8) & 0xff;
    buf[fileKey.length + 2] = (num >> 16) & 0xff;
    buf[fileKey.length + 3] = gen & 0xff;
    buf[fileKey.length + 4] = (gen >> 8) & 0xff;
    var digest = md5(buf);
    var len = Math.min(fileKey.length + 5, 16);
    return digest.slice(0, len);
  }

  // /Name <hex> または /Name (literal) のどちらかで値を読む
  function readPdfStringValue(dictText, key) {
    var re = new RegExp('/' + key + '\\s*<([0-9A-Fa-f\\s]+)>');
    var m = dictText.match(re);
    if (m) return hexToBytes(m[1]);
    var re2 = new RegExp('/' + key + '\\s*\\(');
    var m2 = dictText.match(re2);
    if (!m2) return null;
    var start = m2.index + m2[0].length;
    var depth = 1, j = start;
    while (j < dictText.length && depth > 0) {
      if (dictText.charAt(j) === '\\') { j += 2; continue; }
      if (dictText.charAt(j) === '(') depth++;
      else if (dictText.charAt(j) === ')') depth--;
      j++;
    }
    return parseLiteralString(dictText.slice(start, j - 1));
  }

  function decryptPdfIfEncrypted(arrayBuffer) {
    try {
      var input = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);
      var s = bytesToBinStr(input);

      // --- trailer から /Encrypt と /ID を読む ---
      var trailerIdx = s.lastIndexOf('trailer');
      if (trailerIdx === -1) return { status: 'not-encrypted', bytes: input };
      var trailerMatch = s.slice(trailerIdx).match(/trailer\s*<<([\s\S]*?)>>/);
      if (!trailerMatch) return { status: 'not-encrypted', bytes: input };
      var trailerInner = trailerMatch[1];
      var encRef = trailerInner.match(/\/Encrypt\s+(\d+)\s+(\d+)\s+R/);
      if (!encRef) return { status: 'not-encrypted', bytes: input };
      var encNum = parseInt(encRef[1], 10), encGen = parseInt(encRef[2], 10);
      var idMatch = trailerInner.match(/\/ID\s*\[\s*<([0-9A-Fa-f\s]+)>/);
      if (!idMatch) return { status: 'failed', reason: '暗号辞書の /ID が読めませんでした' };
      var fileId = hexToBytes(idMatch[1]);

      // --- /Encrypt 辞書を読む ---
      var encObjRe = new RegExp(encNum + '\\s+' + encGen + '\\s+obj([\\s\\S]*?)endobj');
      var encObj = s.match(encObjRe);
      if (!encObj) return { status: 'failed', reason: '暗号辞書のオブジェクトが見つかりませんでした' };
      var encBody = encObj[1];
      var filterMatch = encBody.match(/\/Filter\s*\/(\S+)/);
      var filter = filterMatch ? filterMatch[1] : '';
      if (filter !== 'Standard') return { status: 'unsupported', reason: '標準以外の暗号方式です (' + filter + ')' };
      var vMatch = encBody.match(/\/V\s+(\d+)/);
      var v = vMatch ? parseInt(vMatch[1], 10) : 0;
      if (v !== 0 && v !== 1) return { status: 'unsupported', reason: '未対応の暗号バージョンです (V=' + v + ')' };
      if (v === 0) return { status: 'not-encrypted', bytes: input };
      var rMatch = encBody.match(/\/R\s+(\d+)/);
      var r = rMatch ? parseInt(rMatch[1], 10) : 2;
      if (r !== 2) return { status: 'unsupported', reason: '未対応の暗号リビジョンです (R=' + r + ')' };
      var lenMatch = encBody.match(/\/Length\s+(\d+)/);
      var keyLenBits = lenMatch ? parseInt(lenMatch[1], 10) : 40;
      if (keyLenBits !== 40) return { status: 'unsupported', reason: '未対応の鍵長です (' + keyLenBits + 'bit)' };
      var oVal = readPdfStringValue(encBody, 'O');
      var uVal = readPdfStringValue(encBody, 'U');
      var pMatch = encBody.match(/\/P\s+(-?\d+)/);
      if (!oVal || !uVal || !pMatch) return { status: 'failed', reason: '暗号辞書の項目が不足しています' };
      var pVal = parseInt(pMatch[1], 10);

      // --- ファイル鍵 (空パスワード) と /U による検証 ---
      var keyMaterial = new Uint8Array(PADDING.length + oVal.length + 4 + fileId.length);
      keyMaterial.set(PADDING, 0);
      keyMaterial.set(oVal, PADDING.length);
      var pView = new DataView(keyMaterial.buffer, PADDING.length + oVal.length, 4);
      pView.setInt32(0, pVal, true);
      keyMaterial.set(fileId, PADDING.length + oVal.length + 4);
      var fileKey = md5(keyMaterial).slice(0, 5);
      var computedU = rc4(fileKey, PADDING);
      if (!bytesEqual(computedU, uVal)) {
        return { status: 'unsupported', reason: 'パスワード付きのPDFです' };
      }

      // --- 全オブジェクトを抽出 ---
      var objRe = /(\d+)\s+(\d+)\s+obj([\s\S]*?)endobj/g;
      var objects = [], m;
      while ((m = objRe.exec(s)) !== null) {
        objects.push({ num: parseInt(m[1], 10), gen: parseInt(m[2], 10), body: m[3] });
      }
      if (objects.length === 0) return { status: 'failed', reason: 'PDFオブジェクトが読めませんでした' };

      // /Length 間接参照の解決用 (整数だけのオブジェクト)
      var intObjs = {};
      objects.forEach(function (o) {
        var t = o.body.replace(/^\s+|\s+$/g, '');
        if (/^\d+$/.test(t)) intObjs[o.num + ' ' + o.gen] = parseInt(t, 10);
      });

      // --- 各オブジェクトを復号 ---
      var outObjs = [];
      for (var oi = 0; oi < objects.length; oi++) {
        var obj = objects[oi];
        if (obj.num === encNum && obj.gen === encGen) continue; // /Encrypt 自体は捨てる
        var objKey = objectKeyFor(fileKey, obj.num, obj.gen);
        var sm = obj.body.match(/stream(\r\n|\n|\r)/);
        if (sm && sm.index !== undefined) {
          var head = obj.body.slice(0, sm.index + sm[0].length);
          var rest = obj.body.slice(sm.index + sm[0].length);
          var length = null;
          var lmRef = head.match(/\/Length\s+(\d+)\s+(\d+)\s+R/);
          if (lmRef) length = intObjs[lmRef[1] + ' ' + lmRef[2]];
          if (length === null || length === undefined) {
            var lmDirect = head.match(/\/Length\s+(\d+)/);
            if (lmDirect) length = parseInt(lmDirect[1], 10);
          }
          if (length === null || length === undefined) {
            return { status: 'failed', reason: 'ストリーム長が読めませんでした (obj ' + obj.num + ')' };
          }
          var streamData = rest.slice(0, length);
          var tail = rest.slice(length);
          // 検証: ストリーム直後に endstream があること (復号前に長さが合っているか確認)
          if (tail.replace(/^\s+/, '').indexOf('endstream') !== 0) {
            return { status: 'failed', reason: 'ストリームの区切りが合いませんでした (obj ' + obj.num + ')' };
          }
          var decStream = rc4(objKey, binStrToBytes(streamData));
          var newHead = decryptStringsInRegion(head, objKey);
          outObjs.push({ num: obj.num, gen: obj.gen, body: newHead + bytesToBinStr(decStream) + tail });
        } else {
          outObjs.push({ num: obj.num, gen: obj.gen, body: decryptStringsInRegion(obj.body, objKey) });
        }
      }

      // --- 再構築 (xref を作り直し、trailer から /Encrypt を除去) ---
      var headerMatch = s.match(/^%PDF-[0-9.]+/);
      var header = headerMatch ? headerMatch[0] : '%PDF-1.4';
      var out = header + '\n';
      var offsets = {};
      outObjs.sort(function (a, b) { return a.num - b.num || a.gen - b.gen; });
      outObjs.forEach(function (o) {
        offsets[o.num + ' ' + o.gen] = out.length;
        out += o.num + ' ' + o.gen + ' obj' + o.body + 'endobj\n';
      });
      var xrefPos = out.length;
      var maxNum = 0;
      outObjs.forEach(function (o) { if (o.num > maxNum) maxNum = o.num; });
      out += 'xref\n0 ' + (maxNum + 1) + '\n';
      for (var n = 0; n <= maxNum; n++) {
        if (offsets[n + ' 0'] !== undefined) {
          out += ('0000000000' + offsets[n + ' 0']).slice(-10) + ' 00000 n \n';
        } else {
          out += '0000000000 65535 f \n';
        }
      }
      var newTrailer = trailerInner.replace(/\/Encrypt\s+\d+\s+\d+\s+R/, '');
      newTrailer = newTrailer.replace(/\/Size\s+\d+/, '/Size ' + (maxNum + 1));
      out += 'trailer\n<<' + newTrailer + '>>\nstartxref\n' + xrefPos + '\n%%EOF\n';
      return { status: 'decrypted', bytes: binStrToBytes(out) };
    } catch (e) {
      return { status: 'failed', reason: '復号中にエラーが発生しました: ' + (e && e.message ? e.message : e) };
    }
  }

  global.DecryptPdf = {
    decryptPdfIfEncrypted: decryptPdfIfEncrypted,
    // テスト用に内部関数も公開する
    _md5: md5,
    _rc4: rc4
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
