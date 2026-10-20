// 添付ファイル(PDF・Word・Excel・PowerPoint)から、検索用の文字を取り出す(2026-10-20・システム案内(案B)の添付検索)。
// - docx/xlsx/pptx は中身がXMLのzipなので、外部の部品なしで取り出す(zipの読み取りは下の readZip。マクロ入りは添付時に拒否済み)。
// - PDF は unpdf(pdf.js)を使う。文字が入っているPDFだけが対象で、スキャンした画像のPDF・画像ファイルは文字を取り出せない(status='empty'/'unsupported')。
// - どのファイルでも例外は投げず、{ status, text } を返す(取り出せなくても、添付そのものは成功させる。→ E001)。
// - 返す text は NFKC 正規化(全角英数→半角、PDFで混ざる康熙部首「⼿」→「手」など)。検索側も同じ正規化をかけて比べる。
'use strict';

const zlib = require('zlib');

const MAX_TEXT_CHARS = 300_000;       // 1ファイルから保存する文字数の上限
const MAX_ENTRY_BYTES = 20 * 1024 * 1024; // zip内の1ファイルを展開してよい大きさの上限(zip爆弾対策)
const MAX_PDF_PAGES = 300;
const PDF_TIMEOUT_MS = 30_000;

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
    if (method === 0) out.set(name, raw);
    else if (method === 8) out.set(name, zlib.inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES }));
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

/** XMLから、指定したタグ(例: 'w:t')の中の文字を順に集める。段落などの終わり(breakTag)で改行を入れる */
function collectText(xml, textTag, breakTag) {
  const re = new RegExp(`<${textTag}(?:\\s[^>]*)?>([\\s\\S]*?)</${textTag}>|</${breakTag}>`, 'g');
  let out = '';
  let m;
  while ((m = re.exec(xml))) out += m[1] !== undefined ? decodeXml(m[1]) : '\n';
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

/** 拡張子とファイルの中身から、検索用の文字を取り出す。戻り値 { status: 'ok'|'empty'|'failed'|'unsupported', text } */
async function extractAttachmentText(ext, buf) {
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

module.exports = { extractAttachmentText, normalizeForSearch, readZip };
