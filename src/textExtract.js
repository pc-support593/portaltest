// 添付ファイル(PDF・Word・Excel・PowerPoint)から、検索用の文字を取り出す(2026-10-20・システム案内(案B)の添付検索)。
// - docx/xlsx/pptx は中身がXMLのzipなので、外部の部品なしで取り出す(zipの読み取りは下の readZip。マクロ入りは添付時に拒否済み)。
// - PDF は unpdf(pdf.js)を使う。文字が入っているPDFだけが対象で、スキャンした画像のPDF・画像ファイルは文字を取り出せない(status='empty'/'unsupported')。
// - どのファイルでも例外は投げず、{ status, text } を返す(取り出せなくても、添付そのものは成功させる。→ E001)。
// - 返す text は NFKC 正規化(全角英数→半角、PDFで混ざる康熙部首「⼿」→「手」など)。検索側も同じ正規化をかけて比べる。
'use strict';

const zlib = require('zlib');
const path = require('path');
const { Worker } = require('worker_threads');

const MAX_TEXT_CHARS = 300_000;       // 1ファイルから保存する文字数の上限
const MAX_ENTRY_BYTES = 20 * 1024 * 1024; // zip内の1ファイルを展開してよい大きさの上限(zip爆弾対策)
const MAX_TOTAL_BYTES = 50 * 1024 * 1024; // 展開してよい合計の大きさの上限
const MAX_ZIP_ENTRIES = 2000;               // zipの目次の件数の上限(これを超えるzipは読まない)
const MAX_PDF_PAGES = 300;
const PDF_TIMEOUT_MS = 30_000;
const WORKER_TIMEOUT_MS = 45_000; // 取り出し全体の時間(超えたらスレッドごと強制終了)
const WORKER_MAX_MB = 512;        // 取り出し用スレッドが使えるメモリの上限

/** 検索用の正規化(NFKC・小文字)。保存する文字と、検索語の両方にかける */
function normalizeForSearch(s) {
  return String(s || '').normalize('NFKC').toLowerCase();
}

/** zip(PKZIP。ZIP64は非対応=添付は10MBまでのため不要)から、必要なファイルの中身を取り出す。filter(name)が真のものだけ展開する */
function readZip(buf, filter) {
  const out = new Map();
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zipの終端が見つかりません');
  const count = buf.readUInt16LE(eocd + 10);
  if (count > MAX_ZIP_ENTRIES) throw new Error('zipの件数が多すぎます');
  let total = 0;
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zipの目次が不正です');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    if (!filter(name)) continue;
    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error('zipの本体が不正です');
    const dataStart = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
    const raw = buf.slice(dataStart, dataStart + compSize);
    let data = null;
    if (method === 0) data = raw;
    else if (method === 8) data = zlib.inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES });
    if (data) {
      total += data.length;
      if (total > MAX_TOTAL_BYTES) throw new Error('zipの展開後の大きさが大きすぎます');
      out.set(name, data);
    }
    // それ以外の圧縮方式は読み飛ばす
  }
  return out;
}

function decodeXml(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/** XMLから、指定したタグ(例: 'w:t')の中の文字を順に集める。段落などの終わり(breakTag)で改行を入れる。
    正規表現を使わず、前から1回だけ走査する(閉じタグの無い壊れたXMLで、処理時間が二次的に増える(ReDoS)のを防ぐ) */
function collectText(xml, textTag, breakTag) {
  let out = '';
  let pos = 0;
  while (true) {
    const lt = xml.indexOf('<', pos);
    if (lt < 0) break;
    const gt = xml.indexOf('>', lt);
    if (gt < 0) break;
    const inner = xml.slice(lt + 1, gt);
    let k = 1; // タグ名の終わり(空白・改行・「/」の手前)。先頭の「/」は閉じタグの印なので飛ばす
    while (k < inner.length && inner.charCodeAt(k) > 32 && inner[k] !== '/') k++;
    const name = inner.slice(0, k);
    pos = gt + 1;
    if (name === '/' + breakTag) { out += '\n'; continue; }
    if (name === textTag && inner[inner.length - 1] !== '/') {
      const end = xml.indexOf('</' + textTag + '>', pos);
      if (end < 0) break; // 閉じていないタグ以降は読まない(以降を何度も探し直さない)
      out += decodeXml(xml.slice(pos, end));
      pos = end + textTag.length + 3;
    }
  }
  return out;
}

function fromDocx(buf) {
  const files = readZip(buf, n => n === 'word/document.xml' || /^word\/(header|footer)\d*\.xml$/.test(n));
  return [...files.entries()].map(([, b]) => collectText(b.toString('utf8'), 'w:t', 'w:p')).join('\n');
}

function fromPptx(buf) {
  const files = readZip(buf, n => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  const names = [...files.keys()].sort((a, b) => Number(a.match(/(\d+)\.xml$/)[1]) - Number(b.match(/(\d+)\.xml$/)[1]));
  return names.map(n => collectText(files.get(n).toString('utf8'), 'a:t', 'a:p')).join('\n');
}

function fromXlsx(buf) {
  const files = readZip(buf, n => n === 'xl/sharedStrings.xml' || n === 'xl/workbook.xml');
  const parts = [];
  const wb = files.get('xl/workbook.xml');
  if (wb) for (const m of wb.toString('utf8').matchAll(/<sheet\s[^>]*name="([^"]*)"/g)) parts.push(decodeXml(m[1])); // シート名
  const ss = files.get('xl/sharedStrings.xml');
  if (ss) parts.push(collectText(ss.toString('utf8'), 't', 'si')); // セルの文字(数値だけのセルは対象外)
  return parts.join('\n');
}

async function fromPdf(buf) {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const work = (async () => {
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    try {
      if (pdf.numPages > MAX_PDF_PAGES) throw new Error(`ページ数が多すぎます(${pdf.numPages})`);
      const { text } = await extractText(pdf, { mergePages: true });
      return text;
    } finally {
      try { await pdf.destroy(); } catch { /* 後始末の失敗は無視 */ }
    }
  })();
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('PDFの読み取りが時間内に終わりませんでした')), PDF_TIMEOUT_MS); });
  try { return await Promise.race([work, limit]); } finally { clearTimeout(timer); }
}

/** 拡張子とファイルの中身から、検索用の文字を取り出す(この関数は呼び出したスレッドで動く。サーバーからは下の extractAttachmentText=別スレッド版を使う)。
    戻り値 { status: 'ok'|'empty'|'failed'|'unsupported', text } */
async function extractInline(ext, buf) {
  try {
    let raw;
    if (ext === 'pdf') raw = await fromPdf(buf);
    else if (ext === 'docx') raw = fromDocx(buf);
    else if (ext === 'pptx') raw = fromPptx(buf);
    else if (ext === 'xlsx') raw = fromXlsx(buf);
    else return { status: 'unsupported', text: '' }; // 画像など(文字認識はしない)
    const text = String(raw || '').normalize('NFKC').replace(/[ \t　]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim().slice(0, MAX_TEXT_CHARS);
    return { status: text ? 'ok' : 'empty', text };
  } catch (e) {
    console.error(`添付の文字の取り出しに失敗しました(${ext}):`, e.message || e);
    return { status: 'failed', text: '' };
  }
}

/** 別スレッド(worker)で取り出す。時間(timeoutMs)を超えたらスレッドごと強制終了し、メモリの上限も付ける。
    どんなファイルでも例外は投げず { status, text } を返す(時間切れ・メモリ超過・異常終了は status='failed') */
function extractAttachmentText(ext, buf, { timeoutMs = WORKER_TIMEOUT_MS } = {}) {
  if (ext !== 'pdf' && ext !== 'docx' && ext !== 'pptx' && ext !== 'xlsx') return Promise.resolve({ status: 'unsupported', text: '' }); // 画像など
  return new Promise(resolve => {
    let done = false;
    let worker;
    const finish = r => { if (done) return; done = true; clearTimeout(timer); try { worker && worker.terminate(); } catch { /* 既に終了 */ } resolve(r); };
    const timer = setTimeout(() => { console.error(`添付の文字の取り出しが時間内に終わらなかったため中断しました(${ext})`); finish({ status: 'failed', text: '' }); }, timeoutMs);
    try {
      worker = new Worker(path.join(__dirname, 'textExtractWorker.js'), {
        workerData: { ext, buf },
        resourceLimits: { maxOldGenerationSizeMb: WORKER_MAX_MB, maxYoungGenerationSizeMb: 64 }
      });
      worker.once('message', r => finish({ status: r.status, text: r.text || '' }));
      worker.once('error', e => { console.error(`添付の文字の取り出し用スレッドが異常終了しました(${ext}):`, (e && e.message) || e); finish({ status: 'failed', text: '' }); });
      worker.once('exit', () => finish({ status: 'failed', text: '' })); // 結果を返さずに終了した場合(メモリ上限など)
    } catch (e) {
      console.error('添付の文字の取り出し用スレッドを起動できませんでした:', (e && e.message) || e);
      finish({ status: 'failed', text: '' });
    }
  });
}

module.exports = { extractAttachmentText, extractInline, normalizeForSearch, readZip };
