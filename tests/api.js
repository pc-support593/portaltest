// APIの確認(隔離したdevモードのサーバーに対して実行。添付ファイルの検証・お知らせの固定・基本の入出力)
'use strict';
const fs = require('fs');
const path = require('path');
const { makeChecker, startSandbox } = require('./lib/harness');
const { officeDummy } = require('./lib/zip');
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

  // システム案内(案B): 記事のCRUD・添付の中の文字の検索(PDF・Office)・削除の連動
  const gpdf = fs.readFileSync(path.join(__dirname, 'fixtures', 'manual-ja.pdf'));
  const mkGuide = async o => (await json('POST', '/api/admin/guide', o)).data.id;
  const g1 = await mkGuide({ cat: 'network', kind: '手順', title: '社外から社内システムを使うには', body: '手順の概要です', popular: '1' });
  const g2 = await mkGuide({ cat: 'm365', kind: 'FAQ', title: 'パスワードを変更する', body: '変更の手順は添付を見てください' });
  const g3 = await mkGuide({ cat: 'bogus', kind: 'bogus', title: '分野と種類が不正' });
  const gl = (await json('GET', '/api/guide')).data;
  check('システム案内: 記事を登録でき、分野・種類の定義(categories/kinds)が返る', gl.articles.length === 3 && gl.categories.length === 5 && gl.kinds.includes('FAQ'));
  const a3 = gl.articles.find(a => a.id === g3);
  check('システム案内: 許可外の分野は空・種類は「手順」に正規化', a3.cat === '' && a3.kind === '手順', JSON.stringify([a3.cat, a3.kind]));
  check('システム案内: 更新日が空なら当日(YYYY-MM-DD)', /^\d{4}-\d{2}-\d{2}$/.test(a3.updated));
  check('システム案内: タイトルが無いと登録できない', (await json('POST', '/api/admin/guide', { cat: 'pc', body: 'x' })).status === 400);
  const longBody = 'あ'.repeat(15000);
  const g4 = await mkGuide({ cat: 'pc', title: '長い本文', body: longBody });
  check('システム案内: 本文は20000字まで(お知らせの2000字制限は受けない)', (await json('GET', '/api/guide')).data.articles.find(a => a.id === g4).body.length === 15000);
  await json('PUT', '/api/admin/guide/' + g1, { cat: 'network', kind: '手順', title: '社外から社内システムを使うには(更新)', body: '本文' });
  check('システム案内: popularを送らない更新では「よくある」表示が外れない', (await json('GET', '/api/guide')).data.articles.find(a => a.id === g1).popular === '1');

  const upG = (id, name, buf) => up('guide', id, name, buf);
  const rp = await upG(g1, 'VPN接続マニュアル.pdf', gpdf);
  check('システム案内: PDFを添付できる', rp.status === 200, JSON.stringify(rp.data));
  const rd = await upG(g2, 'password.docx', officeDummy('docx', '<w:document><w:p><w:r><w:t>パスワード変更の画面手順 ＭＦＡ</w:t></w:r></w:p></w:document>'));
  const rx = await upG(g2, 'list.xlsx', officeDummy('xlsx', '<sst><si><t>機器購入の申請番号</t></si></sst>'));
  check('システム案内: Word・Excelも添付できる', rd.status === 200 && rx.status === 200);
  const searchG = async q => (await json('GET', '/api/guide?q=' + encodeURIComponent(q))).data.articles;
  const rs1 = await searchG('多要素認証');
  check('添付PDFの中の文字で検索できる(記事の本文・タイトルに無い語)', rs1.length === 1 && rs1[0].id === g1 && rs1[0].hits.length === 1 && rs1[0].hits[0].name === 'VPN接続マニュアル.pdf' && rs1[0].hits[0].snippet.includes('多要素認証'), JSON.stringify(rs1.map(a => [a.id, a.hits])));
  check('PDFの康熙部首(⼿順)が正規化され、「手順」で添付からも見つかる', (await searchG('手順1')).some(a => a.id === g1 && a.hits.length === 1));
  check('Word添付の中の文字で検索できる(全角ＭＦＡ→半角・大文字小文字を区別しない)', (await searchG('mfa')).some(a => a.id === g2 && a.hits.some(h => h.name === 'password.docx')));
  check('Excel添付の中の文字で検索できる', (await searchG('申請番号')).some(a => a.id === g2 && a.hits.some(h => h.name === 'list.xlsx')));
  check('複数の語はすべて含むものだけ(AND。タイトル+添付をまたいでもよい)', (await searchG('社外 多要素認証')).some(a => a.id === g1) && (await searchG('社外 申請番号')).length === 0);
  check('記事のタイトル・本文でも検索できる(添付ヒットなし)', (await searchG('概要')).length === 0 && (await searchG('更新')).some(a => a.id === g1) && (await searchG('更新')).find(a => a.id === g1).inBody === true);
  check('該当なしは空', (await searchG('存在しない言葉xyz')).length === 0);
  check('検索語なしの一覧では、添付の本文(text)を返さない', !JSON.stringify((await json('GET', '/api/guide')).data).includes('多要素認証'));
  const brokenPdf = await upG(g1, 'broken.pdf', Buffer.from('%PDF-1.4 壊れたPDF'));
  check('壊れたPDFでも、添付そのものは成功する(文字は取り出せない)', brokenPdf.status === 200);
  const third = await upG(g1, 'third.pdf', gpdf);
  const ng = await upG(g1, 'x.pdf', gpdf);
  check('システム案内の添付も、1件3つまで(4つ目は断る)', third.status === 200 && ng.status === 400);
  // 添付の削除で、検索用の文字も消える
  const delId = (await json('GET', '/api/guide')).data.articles.find(a => a.id === g1).attachments.find(a => a.name === 'VPN接続マニュアル.pdf').id;
  await json('DELETE', '/api/attachments/' + delId);
  check('添付を削除すると、その添付の文字は検索されなくなる(残りの添付は検索される)', (await searchG('多要素認証')).every(a => a.hits.every(h => h.name !== 'VPN接続マニュアル.pdf')) && (await searchG('多要素認証')).some(a => a.hits.some(h => h.name === 'third.pdf')));
  // 記事の削除で、添付とその文字も消える
  const before2 = fs.readdirSync(UPLOADS).length;
  const delG2 = await json('DELETE', '/api/admin/guide/' + g2);
  check('記事を削除すると、添付ファイルも消える(検索にも出ない)', delG2.status === 200 && fs.readdirSync(UPLOADS).length === before2 - 2 && (await searchG('申請番号')).length === 0);

  // 組織図の役職(orgchart_titles)
  const putT = o => json('PUT', '/api/admin/orgchart-titles', o);
  const getT = async () => (await json('GET', '/api/orgchart-titles')).data;
  check('組織図の役職: 登録でき、メールは小文字・前後空白除去で保存される', (await putT({ email: '  K-Test@Yoshimuraichi.com ', dept: '', title: '課長', sort: 2 })).status === 200 && (await getT()).some(r => r.email === 'k-test@yoshimuraichi.com' && r.title === '課長' && r.sort === 2));
  await putT({ email: 'K-TEST@yoshimuraichi.com', dept: '', title: '係長' });
  check('組織図の役職: 大文字小文字違いのメールでも行が増えない(上書き)', (await getT()).filter(r => r.email === 'k-test@yoshimuraichi.com' && r.dept === '').length === 1 && (await getT()).find(r => r.email === 'k-test@yoshimuraichi.com').title === '係長');
  await putT({ email: 'k-test@yoshimuraichi.com', dept: '不動産部', title: '次長(兼任)' });
  check('組織図の役職: 部門を指定した行(兼任)は、既定の行とは別に持てる', (await getT()).filter(r => r.email === 'k-test@yoshimuraichi.com').length === 2);
  await putT({ email: 'name:荒井　正義', dept: '', title: '主任' });
  check('組織図の役職: メールの無い人は「name:氏名」のキー(空白は全角・半角とも除去)', (await getT()).some(r => r.email === 'name:荒井正義' && r.title === '主任'));
  await putT({ email: 'm@y.com', dept: '㈱ゆめすみか', title: '次長(兼任)' });
  check('組織図の役職: 部門名「㈱ゆめすみか」が正規化で変わらず、そのまま保存・取得できる(NFKCで「(株)」にしない)', (await getT()).some(r => r.email === 'm@y.com' && r.dept === '㈱ゆめすみか'));
  check('組織図の役職: 役職が31字以上・制御文字・メールなしは拒否', (await putT({ email: 'a@x.com', dept: '', title: 'あ'.repeat(31) })).status === 400 && (await putT({ email: 'a@x.com', dept: '', title: 'a' + String.fromCharCode(10) + 'b' })).status === 400 && (await putT({ email: '', dept: '', title: '課長' })).status === 400);
  await putT({ email: 'k-test@yoshimuraichi.com', dept: '', title: '' });
  await putT({ email: 's-sort@yoshimuraichi.com', dept: '', title: '', sort: 5 });
  check('組織図の役職: 役職が空でも、表示順(1以上)があれば行が残る(役職なしの人の並び順だけを指定できる)', (await getT()).some(r => r.email === 's-sort@yoshimuraichi.com' && r.title === '' && r.sort === 5));
  await putT({ email: 's-sort@yoshimuraichi.com', dept: '', title: '', sort: 0 });
  check('組織図の役職: 役職も表示順(0)も空にすると、行が削除される', !(await getT()).some(r => r.email === 's-sort@yoshimuraichi.com'));
  check('組織図の役職: 役職を空にすると行が削除される', !(await getT()).some(r => r.email === 'k-test@yoshimuraichi.com' && r.dept === '') && (await getT()).some(r => r.email === 'k-test@yoshimuraichi.com' && r.dept === '不動産部'));
  check('組織図の役職: 返す項目は email・dept・title・sort だけ', Object.keys((await getT())[0]).sort().join() === 'dept,email,sort,title');

  // 組織図の補足(orgchart_extras。2026-10-26): 人数だけの行・手動の人。一覧ごと置き換える
  const putX = items => json('PUT', '/api/admin/orgchart-extras', { items });
  const getX = async () => (await json('GET', '/api/orgchart-extras')).data;
  const okX = await putX([{ dept: 'フレミング大工', kind: 'person', title: 'リーダー', name: '岸上　大介', sort: 1 }, { dept: 'フレミング大工', kind: 'count', title: 'フィリピン', count: 3, sort: 3 }, { dept: '外壁・2×4事業課(㈱来夢エンジニア)', kind: 'count', title: 'フィリピン', count: 5 }]);
  const gx = await getX();
  check('組織図の補足: 登録でき、取得できる(人数だけの行・手動の人。部門名の㈱はそのまま)', okX.status === 200 && gx.length === 3 && gx.some(r => r.dept === '外壁・2×4事業課(㈱来夢エンジニア)' && r.kind === 'count' && r.count === 5) && gx.some(r => r.kind === 'person' && r.name === '岸上 大介' && r.count === 0), JSON.stringify(gx));
  check('組織図の補足: 返す項目は id・dept・kind・title・name・count・sort だけ', Object.keys(gx[0]).sort().join() === 'count,dept,id,kind,name,sort,title');
  await putX([{ dept: '設計企画部', kind: 'count', title: 'フィリピンCADセンター', count: 3 }]);
  check('組織図の補足: 保存は一覧ごとの置き換え(前の行は残らない)', (await getX()).length === 1 && (await getX())[0].dept === '設計企画部');
  check('組織図の補足: 不正な入力は拒否(人数の範囲・氏名なし・行の名前なし・種類・長さ・制御文字・201行)', (await putX([{ dept: '設計企画部', kind: 'count', title: 'x', count: 10000 }])).status === 400 && (await putX([{ dept: '設計企画部', kind: 'count', title: 'x', count: -1 }])).status === 400 && (await putX([{ dept: '設計企画部', kind: 'person', title: 'リーダー', name: '' }])).status === 400 && (await putX([{ dept: '設計企画部', kind: 'count', title: '', count: 1 }])).status === 400 && (await putX([{ dept: '設計企画部', kind: 'other', title: 'x' }])).status === 400 && (await putX([{ dept: '設計企画部', kind: 'count', title: 'あ'.repeat(31), count: 1 }])).status === 400 && (await putX([{ dept: '', kind: 'count', title: 'x', count: 1 }])).status === 400 && (await putX([{ dept: '設計企画部', kind: 'count', title: 'x\u0001', count: 1 }])).status === 400 && (await putX(Array.from({ length: 201 }, () => ({ dept: '設計企画部', kind: 'count', title: 'x', count: 1 })))).status === 400);
  check('組織図の補足: 不正な入力で拒否されたとき、前の内容は残る(途中までの置き換えをしない)', (await getX()).length === 1 && (await getX())[0].title === 'フィリピンCADセンター');
  await putX([]);
  check('組織図の補足: 空の一覧で全て削除できる', (await getX()).length === 0);

  // 打ち合わせの区分(meeting_kinds。2026-10-30): 予定の画面のプルダウンの選択肢。一覧ごと置き換える。初めて作るときだけ「初回」が入る
  const putK = items => json('PUT', '/api/admin/meeting-kinds', { items });
  const getK = async () => (await json('GET', '/api/meeting-kinds')).data;
  const k0 = await getK();
  check('打ち合わせの区分: 初めて作ったときは「初回」だけが入っている。返す項目は id・label・sort だけ', k0.length === 1 && k0[0].label === '初回' && Object.keys(k0[0]).sort().join() === 'id,label,sort', JSON.stringify(k0));
  const okK = await putK([{ label: '再提案', sort: 2 }, { label: '初回', sort: 1 }, { label: '　契約　', sort: 3 }]);
  const k1 = await getK();
  check('打ち合わせの区分: 登録でき、表示順(小さい順)で返る。前後の空白は除く', okK.status === 200 && k1.map(r => r.label).join() === '初回,再提案,契約', JSON.stringify(k1));
  check('打ち合わせの区分: 不正な入力は拒否(空・31字・重複・セミコロン・制御文字・31件)', (await putK([{ label: '' }])).status === 400 && (await putK([{ label: 'あ'.repeat(31) }])).status === 400 && (await putK([{ label: '初回' }, { label: '初回' }])).status === 400 && (await putK([{ label: 'a;b' }])).status === 400 && (await putK([{ label: 'a' + String.fromCharCode(1) }])).status === 400 && (await putK(Array.from({ length: 31 }, (_, i) => ({ label: 'k' + i })))).status === 400);
  check('打ち合わせの区分: 不正な入力で拒否されたとき、前の内容は残る', (await getK()).map(r => r.label).join() === '初回,再提案,契約');
  await putK([]);
  check('打ち合わせの区分: 空の一覧で全て削除できる(再起動しても「初回」は復活しない設計)', (await getK()).length === 0);
  await putK([{ label: '初回', sort: 1 }]);

  // 年間カレンダー: typeに shift_holiday を指定できる(team空・A、他の種類との重複チェックの対象外)
  const csvOk = ['date,calendar_group,team,type,label', '2027-05-01,sunday_off,,shift_holiday,創立記念日', '2027-05-02,sunday_off,A,shift_holiday,特別休', '2027-05-02,sunday_off,A,shift_work,x'].join('\n');
  const impOk = await json('POST', '/api/admin/work-calendar/import', { csv: csvOk });
  check('年間カレンダー取込: shift_holiday を受け付ける(shift_workと同じ日・班でも可)', impOk.status === 200, JSON.stringify(impOk.data));
  const wc = (await json('GET', '/api/work-calendar?group=sunday_off&from=2027-05-01&to=2027-05-31')).data;
  check('年間カレンダー取得: shift_holiday が返る', Array.isArray(wc) ? wc.some(r => r.type === 'shift_holiday' && r.label === '創立記念日') : JSON.stringify(wc).includes('shift_holiday'), JSON.stringify(wc).slice(0, 160));
  const impBad = await json('POST', '/api/admin/work-calendar/import', { csv: ['date,calendar_group,team,type,label', '2027-05-03,sunday_off,,shift_holidayX,x'].join('\n') });
  check('年間カレンダー取込: 不正なtypeは断る', impBad.status === 400);

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
