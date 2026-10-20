// 添付の文字の取り出し(src/textExtract.js)の確認。Node のみ。PDFは tests/fixtures/manual-ja.pdf(日本語。Edgeで作成)を使う
'use strict';
const fs = require('fs');
const path = require('path');
const { ROOT, makeChecker } = require('./lib/harness');
const { createZip, officeDummy } = require('./lib/zip');
const { extractAttachmentText, normalizeForSearch } = require(path.join(ROOT, 'src', 'textExtract.js'));
const { check, done } = makeChecker('extract');

(async () => {
  const origErr = console.error; console.error = () => {}; // 失敗のテスト中の想定ログを出さない
  try {
    // PDF(日本語)
    const pdf = fs.readFileSync(path.join(__dirname, 'fixtures', 'manual-ja.pdf'));
    const r = await extractAttachmentText('pdf', pdf);
    const n = normalizeForSearch(r.text);
    check('PDF: 日本語の文字を取り出せる', r.status === 'ok' && n.includes('vpn接続マニュアル') && n.includes('多要素認証'), r.text.slice(0, 60));
    check('PDF: 康熙部首(⼿⼊⼒など)が通常の漢字に正規化される(「手順」「入力」で検索できる)', n.includes('手順') && n.includes('入力'), r.text.slice(0, 80));
    check('PDF: 英数字も取り出せる(Wi-Fi)', n.includes('wi-fi'));
    const bad = await extractAttachmentText('pdf', Buffer.from('%PDF-1.4 not really a pdf'));
    check('PDF: 壊れたファイルは例外を投げず failed を返す', bad.status === 'failed' && bad.text === '');

    // Office(本物のzip構造のダミー)
    const docx = await extractAttachmentText('docx', officeDummy('docx', '<w:document><w:body><w:p><w:r><w:t>パスワードの変更手順</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">A &amp; B ＭＦＡ</w:t></w:r></w:p></w:body></w:document>'));
    check('docx: 段落の文字を取り出す(&amp;・全角英数は正規化)', docx.status === 'ok' && docx.text.includes('パスワードの変更手順') && docx.text.includes('A & B MFA'), docx.text);
    const pptx = await extractAttachmentText('pptx', officeDummy('pptx', '<p:sld><a:p><a:r><a:t>Teamsの使い方</a:t></a:r></a:p></p:sld>'));
    check('pptx: スライドの文字を取り出す', pptx.status === 'ok' && pptx.text.includes('Teamsの使い方'), pptx.text);
    const xlsx = await extractAttachmentText('xlsx', officeDummy('xlsx', '<sst><si><t>機器の購入申請</t></si><si><t>返却期限</t></si></sst>'));
    check('xlsx: セルの文字とシート名を取り出す', xlsx.status === 'ok' && xlsx.text.includes('機器の購入申請') && xlsx.text.includes('申請一覧'), xlsx.text);
    const stored = await extractAttachmentText('docx', createZip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': '<w:p><w:t>無圧縮</w:t></w:p>' }, { stored: true }));
    check('docx: 無圧縮のzipも読める', stored.text.includes('無圧縮'));

    // 壊れた・悪意のあるファイル: 処理時間が爆発しない(閉じタグの無い大量のタグ=ReDoS、展開後が巨大なzip)
    const t0 = Date.now();
    const redos = await extractAttachmentText('docx', officeDummy('docx', '<w:t>'.repeat(200000)));
    check('閉じタグの無い大量のタグでも、短時間で終わる(以前は1.7KBで約1分止まった)', Date.now() - t0 < 5000 && redos.status !== undefined, `elapsed=${Date.now() - t0}ms`);
    const bomb = createZip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': '<w:p><w:t>' + 'あ'.repeat(10 * 1024 * 1024) + '</w:t></w:p>', 'word/header1.xml': '<w:p><w:t>' + 'い'.repeat(10 * 1024 * 1024) + '</w:t></w:p>', 'word/header2.xml': '<w:p><w:t>' + 'う'.repeat(10 * 1024 * 1024) + '</w:t></w:p>' });
    const tb = Date.now();
    const bombR = await extractAttachmentText('docx', bomb);
    check('展開後が合計の上限(50MB)を超えるzipは、failed(メモリを使い切らない)', bombR.status === 'failed' || bombR.text.length <= 300000, `status=${bombR.status} ${Date.now() - tb}ms`);
    const tt = Date.now();
    const timedOut = await extractAttachmentText('docx', officeDummy('docx', '<w:p><w:t>x</w:t></w:p>'), { timeoutMs: 1 });
    check('時間切れ(1ミリ秒)なら、スレッドごと中断して failed を返す', timedOut.status === 'failed' && Date.now() - tt < 3000, timedOut.status);

    // 取り出せないもの
    check('zipでないdocxは failed(例外を投げない)', (await extractAttachmentText('docx', Buffer.from('これはzipではない'))).status === 'failed');
    check('画像は unsupported(文字認識はしない)', (await extractAttachmentText('png', Buffer.alloc(10))).status === 'unsupported');
    check('文字のないdocxは empty', (await extractAttachmentText('docx', officeDummy('docx', '<w:document/>'))).status === 'empty');

    // 正規化
    check('normalizeForSearch: 全角英数・大文字小文字・康熙部首を揃える', normalizeForSearch('ＶＰＮ ⼿順') === 'vpn 手順');
  } finally {
    console.error = origErr;
  }
  process.exit(done() ? 1 : 0);
})().catch(e => { console.error('TEST ERROR', e); process.exit(2); });
