// 会議室予約の「Excel出力」(2026-10-30・ユーザー依頼)。1日分の予定を、時間順に、縦に並べたExcelファイル(.xlsx)で出す。
// ライブラリは使わず、.xlsx(ZIPの中のXML)をここで組み立てる(サーバーに何も足さない)。
// 体裁は manual/template/フォーマット.xlsx を元にしている: 列幅・30pt の文字・見出し行の高さ・A3縦。
// 見出しは 会議室名・件名・時間・区分。右上(D1・E1)に日付。各行に、ポータルの予定の色(主催=黄・参加=青緑・それ以外=会議室の色)を塗る。
'use strict';

const XLSX_COL_WIDTHS = [38.5, 39.5, 44.75, 17.125, 23.125]; // テンプレートの列幅(A〜E)
const XLSX_HEADERS = ['会議室名', '件名', '時間', '区分'];
const XLSX_HEADER_HEIGHT = 48.75; // テンプレートの見出し行の高さ
const XLSX_LINE_HEIGHT = 40; // 30pt の文字の1行の高さ(行の高さの見積もり用)

let xlsxCrcTable = null;
function xlsxCrc32(bytes) {
  if (!xlsxCrcTable) {
    xlsxCrcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      xlsxCrcTable[n] = c >>> 0;
    }
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) crc = xlsxCrcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/** ファイルの一覧([{ name, data: Uint8Array }])を、圧縮なしのZIPにまとめる(.xlsx は ZIP。ファイル名はUTF-8) */
function xlsxZip(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  const u16 = v => [v & 0xFF, (v >>> 8) & 0xFF];
  const u32 = v => [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF];
  files.forEach(f => {
    const name = enc.encode(f.name);
    const crc = xlsxCrc32(f.data);
    const common = [...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(f.data.length), ...u32(f.data.length), ...u16(name.length), ...u16(0)];
    parts.push(new Uint8Array([0x50, 0x4B, 0x03, 0x04, ...common]), name, f.data);
    central.push(new Uint8Array([0x50, 0x4B, 0x01, 0x02, ...u16(20), ...common, ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset)]), name);
    offset += 30 + name.length + f.data.length;
  });
  const cdSize = central.reduce((s, p) => s + p.length, 0);
  parts.push(...central, new Uint8Array([0x50, 0x4B, 0x05, 0x06, ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length), ...u32(cdSize), ...u32(offset), ...u16(0)]));
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let pos = 0;
  parts.forEach(p => { out.set(p, pos); pos += p.length; });
  return out;
}

/** XMLに入れる文字にする(&<>" のエスケープ。XMLで使えない制御文字は除く) */
function xlsxEsc(v) {
  return String(v ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** 背景色(#rrggbb)に対して読みやすい文字色(明るい背景=黒・暗い背景=白) */
function xlsxTextColor(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || ''));
  if (!m) return 'black';
  const lum = 0.299 * parseInt(m[1], 16) + 0.587 * parseInt(m[2], 16) + 0.114 * parseInt(m[3], 16);
  return lum > 128 ? 'black' : 'white';
}

/** 30ptで折り返したときの行数の見積もり(全角=2・半角=1として、列の幅から1行の文字数を出す) */
function xlsxLineCount(text, colWidth) {
  // 列の幅 w は約 7w+5 px。30pt の文字は、半角が約20px・全角が約40px。1行に入る半角の数(capacity)にして数える
  const capacity = Math.max(2, Math.floor((colWidth * 7 + 5) / 20));
  let lines = 1, used = 0;
  for (const ch of String(text || '')) {
    const w = ch.charCodeAt(0) > 0xFF ? 2 : 1;
    if (used + w > capacity && used > 0) { lines++; used = 0; }
    used += w;
  }
  return lines;
}

/** 1日分の予定のExcel(.xlsx)を作る。dateLabel=右上に出す日付の文字。rows=[{ room, title, time, kind, color }](並べる順にして渡す)。戻り値は Uint8Array */
function buildDayXlsx(dateLabel, rows) {
  const enc = new TextEncoder();
  const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const hexOf = c => String(c || '').replace('#', '').toUpperCase();
  // 色ごとの塗りつぶしと書式(cellXfs の 0=標準・1=見出し/日付、2以降=色ごとのデータ行)
  const colors = [...new Set(rows.map(r => hexOf(r.color)))];
  const fonts = [
    '<font><sz val="11"/><color rgb="FF000000"/><name val="游ゴシック"/><family val="2"/><charset val="128"/></font>',
    '<font><sz val="30"/><color rgb="FF000000"/><name val="游ゴシック"/><family val="3"/><charset val="128"/></font>',
    '<font><sz val="30"/><color rgb="FFFFFFFF"/><name val="游ゴシック"/><family val="3"/><charset val="128"/></font>'
  ];
  const fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>']
    .concat(colors.map(h => `<fill><patternFill patternType="solid"><fgColor rgb="FF${/^[0-9A-F]{6}$/.test(h) ? h : 'FFFFFF'}"/><bgColor indexed="64"/></patternFill></fill>`));
  const side = '<left style="thin"><color auto="1"/></left><right style="thin"><color auto="1"/></right><top style="thin"><color auto="1"/></top><bottom style="thin"><color auto="1"/></bottom><diagonal/>';
  const xfs = [
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"><alignment vertical="center"/></xf>',
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"><alignment vertical="center"/></xf>'
  ].concat(colors.map((h, i) => {
    const white = xlsxTextColor('#' + h) === 'white';
    return `<xf numFmtId="0" fontId="${white ? 2 : 1}" fillId="${i + 2}" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>`;
  }));
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="${NS}"><fonts count="${fonts.length}">${fonts.join('')}</fonts><fills count="${fills.length}">${fills.join('')}</fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border>${side}</border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"><alignment vertical="center"/></xf></cellStyleXfs><cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs><cellStyles count="1"><cellStyle name="標準" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

  const cell = (ref, text, style) => `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xlsxEsc(text)}</t></is></c>`;
  const sheetRows = [
    `<row r="1">${cell('D1', '日付', 1)}${cell('E1', dateLabel, 1)}</row>`,
    `<row r="2" ht="${XLSX_HEADER_HEIGHT}" customHeight="1">${XLSX_HEADERS.map((h, i) => cell('ABCD'[i] + '2', h, 1)).join('')}</row>`
  ];
  rows.forEach((r, i) => {
    const n = i + 3;
    const style = 2 + colors.indexOf(hexOf(r.color));
    const vals = [r.room, r.title, r.time, r.kind];
    const lines = Math.max(...vals.map((v, k) => xlsxLineCount(v, XLSX_COL_WIDTHS[k])));
    const ht = Math.max(XLSX_HEADER_HEIGHT, lines * XLSX_LINE_HEIGHT + 8.75);
    sheetRows.push(`<row r="${n}" ht="${ht}" customHeight="1">${vals.map((v, k) => cell('ABCD'[k] + n, v, style)).join('')}</row>`);
  });
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="${NS}"><dimension ref="A1:E${rows.length + 2}"/><sheetViews><sheetView tabSelected="1" workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="18.75"/><cols>${XLSX_COL_WIDTHS.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols><sheetData>${sheetRows.join('')}</sheetData><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/><pageSetup paperSize="8" orientation="portrait"/></worksheet>`;

  const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const files = [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="${NS}" xmlns:r="${R}"><sheets><sheet name="予定" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${R}/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', styles],
    ['xl/worksheets/sheet1.xml', sheet]
  ];
  return xlsxZip(files.map(([name, text]) => ({ name, data: enc.encode(text) })));
}
