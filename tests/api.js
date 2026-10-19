// APIの確認(隔離したdevモードのサーバーに対して実行。添付ファイルの検証・お知らせの固定・基本の入出力)
'use strict';
const fs = require('fs');
const path = require('path');
const { makeChecker, startSandbox } = require('./lib/harness');
const { check, done } = makeChecker('api');
let B, UPLOADS;
const json = async (method, url, body) => {
  const r = await fetch(B + url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  let d = null; try { d = await r.json(); } catch {}
  return { status: r.status, data: d };
};
const up = async (kind, id, name, buf) => {
  const r = await fetch(`${B}/api/attachments?kind=${kind}&itemId=${id}&name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: buf });
  let d = null; try { d = await r.json(); } catch {}
  return { status: r.status, data: d };
};
const zipish = (folder, extra = '') => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(`[Content_Types].xml ${folder}document.xml ${extra}`), Buffer.alloc(64)]);
const files = {
  pdf: Buffer.from('%PDF-1.4\n%test\n'),
  png: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]),
  jpg: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]),
  gif: Buffer.from('GIF89a' + 'x'.repeat(20)),
  docx: zipish('word/'), xlsx: zipish('xl/'), pptx: zipish('ppt/')
};

(async () => {
  const sb = await startSandbox();
  B = sb.base; UPLOADS = path.join(sb.dir, 'data', 'uploads');
  try {
  // 基本
  const cfg = (await json('GET', '/api/config')).data;
  check('/api/config: devモード', cfg.authMode === 'dev');
  check('/api/me: モックユーザー', (await json('GET', '/api/me')).status === 200);
  check('jinjerキー未設定: 出勤状況の機能は無効(features)', cfg.features && cfg.features.attendance === false && cfg.features.dayOffs === false, JSON.stringify(cfg.features));
  check('jinjerキー未設定: /api/attendance は404', (await json('GET', '/api/attendance')).status === 404 && (await json('GET', '/API/Attendance')).status === 404 && (await fetch(B + '/attendance.html')).status === 404 && (await fetch(B + '/js/attendance.js')).status === 404);
  check('本日のお休みは無効(404)', (await fetch(B + '/today-off.html')).status === 404 && (await json('GET', '/api/day-offs')).status === 404);
  const pin = (await json('POST', '/api/admin/news', { title: '固定テスト', pinned: '1' })).data.id;
  check('お知らせの固定(pinned)が保存される', ((await json('GET', '/api/content')).data.news.find(n => n.id === pin) || {}).pinned === '1');
  await json('PUT', `/api/admin/news/${pin}`, { title: '固定テスト2' });
  check('pinnedを送らない更新では固定が外れない', ((await json('GET', '/api/content')).data.news.find(n => n.id === pin) || {}).pinned === '1');
  check('存在しないAPIは404', (await json('GET', '/api/no-such')).status === 404);

  const news = (await json('POST', '/api/admin/news', { title: '添付テスト', date: '2026-10-09' })).data.id;
  const sched = (await json('POST', '/api/admin/schedule', { title: '行事テスト', date: '2026-10-20' })).data.id;

  // 許可する種類(1件につき3つまでなので、種類ごとに別のお知らせへ)
  for (const ext of Object.keys(files)) {
    const id = (await json('POST', '/api/admin/news', { title: 'type-' + ext })).data.id;
    const r = await up('news', id, `ファイル.${ext}`, files[ext]);
    check(`許可: .${ext}`, r.status === 200, r.data && (r.data.error || ''));
  }

  // 3つまで
  const r1 = await up('news', news, 'a.pdf', files.pdf), r2 = await up('news', news, 'b.png', files.png), r3 = await up('news', news, 'c.docx', files.docx);
  check('1〜3件目は添付できる', [r1, r2, r3].every(r => r.status === 200));
  const r4 = await up('news', news, 'd.pdf', files.pdf);
  check('4件目は断る', r4.status === 400 && /3つまで/.test(r4.data.error), r4.data.error);

  // 拒否するもの
  const bad = [
    ['実行ファイルをpdfに改名', 'evil.pdf', Buffer.from('MZ\x90\x00 this is an exe')],
    ['HTMLをpngに改名', 'x.png', Buffer.from('<html><script>alert(1)</script></html>')],
    ['マクロ入りdocx', 'macro.docx', zipish('word/', 'vbaProject.bin')],
    ['docxの中身がxlsx', 'wrong.docx', zipish('xl/')],
    ['拡張子 .html', 'a.html', Buffer.from('<html>')],
    ['拡張子 .svg', 'a.svg', Buffer.from('<svg>')],
    ['拡張子 .exe', 'a.exe', Buffer.from('MZ')],
    ['拡張子 .docm', 'a.docm', zipish('word/')],
    ['古い形式 .doc', 'a.doc', Buffer.from('xxxx')],
    ['拡張子なし', 'noext', Buffer.from('xxxx')]
  ];
  const sink = (await json('POST', '/api/admin/news', { title: 'bad' })).data.id;
  for (const [label, name, buf] of bad) {
    const r = await up('news', sink, name, buf);
    check(`拒否: ${label}`, r.status === 400, r.data && r.data.error);
  }
  const empty = await up('news', sink, 'e.pdf', Buffer.alloc(0));
  check('拒否: 空ファイル', empty.status === 400, empty.data && empty.data.error);
  check('存在しない添付先は404', (await up('news', 99999, 'a.pdf', files.pdf)).status === 404);
  check('kindが不正は400', (await up('links', 1, 'a.pdf', files.pdf)).status === 400);

  // 10MB超
  const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(10 * 1024 * 1024 + 10)]);
  const rb = await up('news', sink, 'big.pdf', big);
  check('10MB超は413(日本語メッセージ)', rb.status === 413 && /10MB/.test(rb.data.error), rb.data && rb.data.error);
  const ok10 = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(10 * 1024 * 1024 - 100)]);
  check('10MB以内は通る', (await up('news', sink, 'ok10.pdf', ok10)).status === 200);

  // パス・名前の安全性
  const trav = await up('schedule', sched, '../../etc/passwd.pdf', files.pdf);
  check('パス区切りは除去される', trav.status === 200 && trav.data.name === 'passwd.pdf', trav.data && trav.data.name);
  const files1 = fs.readdirSync(UPLOADS);
  check('保存ファイル名はUUID(元の名前を使わない)', files1.every(n => /^[0-9a-f-]{36}$/.test(n)), String(files1.length) + '件');

  // 一覧とダウンロード
  const content = (await json('GET', '/api/content')).data;
  const item = content.news.find(n => n.id === news);
  check('/api/content に添付が付く', item.attachments.length === 3 && item.attachments[0].name === 'a.pdf', JSON.stringify(item.attachments.map(a => a.name)));
  const dl = await fetch(`${B}/api/attachments/${item.attachments[0].id}/download`);
  const got = Buffer.from(await dl.arrayBuffer());
  check('ダウンロード: 内容が一致', got.equals(files.pdf));
  check('ダウンロード: Content-Type', dl.headers.get('content-type') === 'application/pdf', dl.headers.get('content-type'));
  check('ダウンロード: 保存扱い・nosniff・no-store', /attachment/.test(dl.headers.get('content-disposition')) && dl.headers.get('x-content-type-options') === 'nosniff' && /no-store/.test(dl.headers.get('cache-control')), dl.headers.get('content-disposition'));
  const dlJa = await fetch(`${B}/api/attachments/${content.news.find(n => n.title === 'type-pdf').attachments[0].id}/download`);
  check('日本語ファイル名が保持される', decodeURIComponent((dlJa.headers.get('content-disposition').match(/filename\*=UTF-8''(.+)$/) || [])[1] || '') === 'ファイル.pdf', dlJa.headers.get('content-disposition'));
  check('存在しないIDは404', (await fetch(`${B}/api/attachments/not-exist/download`)).status === 404);

  // CSV由来の行事に添付すると手入力扱いになる
  const imp = await json('POST', '/api/admin/work-calendar/import', { csv: 'date,calendar_group,team,type,label\n2027-04-01,sunday_off,,event,入社式' });
  const csvItem = (await json('GET', '/api/content')).data.schedule.find(s => s.source === 'csv');
  await up('schedule', csvItem.id, 'k.pdf', files.pdf);
  const after = (await json('GET', '/api/content')).data.schedule.find(s => s.id === csvItem.id);
  check('CSV由来の行事に添付→手入力扱い(source="")', after.source === '' && after.attachments.length === 1, 'source=' + JSON.stringify(after.source));
  await json('POST', '/api/admin/work-calendar/import', { csv: 'date,calendar_group,team,type,label\n2027-04-01,sunday_off,,holiday,x' });
  const survive = (await json('GET', '/api/content')).data.schedule.find(s => s.id === csvItem.id);
  check('再取込でも添付つきの行事は消えない', !!survive && survive.attachments.length === 1);

  // 削除
  const before = fs.readdirSync(UPLOADS).length;
  const one = item.attachments[1];
  const del = await json('DELETE', `/api/attachments/${one.id}`);
  check('添付の削除: 200・ファイルも消える', del.status === 200 && fs.readdirSync(UPLOADS).length === before - 1 && !fs.existsSync(path.join(UPLOADS, one.id)));
  check('削除済みは404', (await json('DELETE', `/api/attachments/${one.id}`)).status === 404);
  const del2 = await json('DELETE', `/api/admin/news/${news}`);
  const left = (await json('GET', '/api/content')).data.news.find(n => n.id === news);
  check('お知らせ削除で添付ファイルも消える', del2.status === 200 && !left && fs.readdirSync(UPLOADS).length === before - 1 - 2, `uploads=${fs.readdirSync(UPLOADS).length}`);

  } finally { await sb.stop(); }

  // jinjerキーがある環境(ダミー。宛先は到達しない)では出勤状況が有効になる
  const sb2 = await startSandbox({ JINJER_API_KEY: 'dummy', JINJER_SECRET_KEY: 'dummy' });
  try {
    B = sb2.base;
    const cfg2 = (await json('GET', '/api/config')).data;
    check('jinjerキーあり: 出勤状況が有効(features)', cfg2.features.attendance === true && cfg2.features.dayOffs === false, JSON.stringify(cfg2.features));
    const att = await json('GET', '/api/attendance');
    check('jinjerキーあり: /api/attendance が使える', att.status === 200 && att.data.configured === true && Array.isArray(att.data.items), JSON.stringify(att.data).slice(0, 120));
    check('jinjerキーあり: 手動取り込みAPI(POST /api/attendance/sync)は無い(jinjerを呼ぶのはサーバーの自動取り込みだけ)', (await json('POST', '/api/attendance/sync')).status === 404);
    check('jinjerキーあり: attendance.html が配信される', (await fetch(B + '/attendance.html')).status === 200);
  } finally { await sb2.stop(); }
  process.exit(done() ? 1 : 0);
})().catch(e => { console.error("TEST ERROR", e); process.exit(2); });
