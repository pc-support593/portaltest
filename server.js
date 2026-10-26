// 吉村一建設 社内ポータル サーバー
// - public/ の静的配信(3画面: index.html / rooms.html / admin.html)
// - 管理コンテンツ(お知らせ・全社スケジュール・クイックリンク)の CRUD API
// - 会議室予約 API(Entra ID + Graph API 移行までのローカル実装)
// 認証は既定でEntra ID(AUTH_MODE=entra)。ローカル確認用に AUTH_MODE=dev(モックユーザー・認証なし)を明示できる。
// 設定手順は docs/entra-setup.md を参照。
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { open } = require('./src/db');
const jinjerDayOffs = require('./src/jinjerDayOffs');
const jinjerAttendance = require('./src/jinjerAttendance');
const { isConfigured: jinjerConfigured, jstNow } = require('./src/jinjerClient');
const { extractAttachmentText, normalizeForSearch } = require('./src/textExtract');

// Portal/.env があれば読み込む(環境変数の設定漏れ対策。既に設定済みの環境変数が優先される)
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* .env なしでも可 */ }

// 'entra'(Entra IDのトークンを検証)| 'dev'(モックユーザーで認証なし=ローカル確認用)。
// 認証なしで公開される事故を防ぐため(2026-10-08・レビュー指摘1。再発防止=checklists/tech-auth-integration.md「認証モード」):
//   ① 既定は安全側の'entra'(未設定でも認証なしにならない)
//   ② 前後の空白・大文字小文字は吸収する(' Entra '→'entra')
//   ③ 'entra'と'dev'以外の値(綴り違いなど)は、起動時にエラー終了する(認証なしに倒さない)
//   ④ 認証を飛ばす判定は「AUTH_MODE === 'dev'」のときだけ(それ以外は必ずEntra IDの検証に進む)
//   ⑤ devモードは AUTH_MODE=dev を明示したときだけ有効
//   ⑥ この検証は、DBを開く(open())より**前**に行う。設定ミスで起動を繰り返しても、DBに触れない(2026-10-08・再レビュー指摘1)
const AUTH_MODE = String(process.env.AUTH_MODE ?? '').trim().toLowerCase() || 'entra';
if (AUTH_MODE !== 'entra' && AUTH_MODE !== 'dev') {
  console.error(`AUTH_MODE の値が不正です: "${process.env.AUTH_MODE}"(使える値: entra / dev)。起動を中止します`);
  process.exit(1);
}

const app = express();
const db = open();
const PORT = process.env.PORT || 3100;

app.use(express.json({ limit: '256kb' }));

// 「本日のお休み」(jinjer連携)は一時停止中(2026-10-07・ユーザー指示)。
// jinjerに所定休日・法定休日を取得できるAPIが無く、要件(定休日も休みとして表示)を満たせないため。
// ENABLE_DAYOFFS=true を設定したときだけ、ページ・API・自動取り込みが有効になる(コードは残してある)。
const DAYOFFS_ENABLED = process.env.ENABLE_DAYOFFS === 'true';
if (!DAYOFFS_ENABLED) {
  app.use((req, res, next) => {
    const p = req.path.toLowerCase();
    if (p === '/today-off.html' || p === '/js/todayoff.js' || p.startsWith('/api/day-offs')) {
      return res.status(404).send('Not Found');
    }
    next();
  });
}

// 「出勤状況」(jinjerの打刻データ)は、jinjerのAPIキー(JINJER_API_KEY / JINJER_SECRET_KEY)が設定されているサーバーでだけ有効にする
// (2026-10-19・整理案F。ユーザー指示)。設定のない環境(本番など)では、ページ・API・自動取り込み・画面のリンクがすべて無効になる。
// これにより、テストと本番で同じコードを使い、機能の有無は環境変数だけで切り替える(本番に載せるときの差分作業をなくす)
const ATTENDANCE_ENABLED = jinjerConfigured();
if (!ATTENDANCE_ENABLED) {
  app.use((req, res, next) => {
    const p = req.path.toLowerCase(); // Expressのルーティングは大文字小文字を区別しないため、ゲートも区別しない
    if (p === '/attendance.html' || p === '/js/attendance.js' || p.startsWith('/api/attendance')) {
      return res.status(404).send('Not Found');
    }
    next();
  });
}

app.use(express.static(path.join(__dirname, 'public')));

// devモードのモックユーザー
const MOCK_ME = {
  name: '佐藤 美咲',
  dept: '営業企画部',
  email: 'm-sato@yoshimuraichi.com',
  roles: ['Portal.Admin']
};

// ---- entraモード: アクセストークン検証(docs/entra-setup.md §4) ----
// SPA(MSAL.js)が取得した api://<CLIENT_ID>/access_as_user のアクセストークンを
// Entra ID の JWKS で署名検証する。手書き検証禁止(joseを使用)。
const TENANT_ID = process.env.TENANT_ID || '';
const CLIENT_ID = process.env.CLIENT_ID || '';
let jose = null;
let jwks = null;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  err.expose = true;
  return err;
}

async function verifyEntraToken(req) {
  if (!TENANT_ID || !CLIENT_ID) {
    throw httpError(500, 'サーバーに TENANT_ID / CLIENT_ID が設定されていません');
  }
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) throw httpError(401, 'サインインが必要です');
  jose ||= require('jose');
  jwks ||= jose.createRemoteJWKSet(
    new URL(`https://login.microsoftonline.com/${TENANT_ID}/discovery/v2.0/keys`)
  );
  let payload;
  try {
    ({ payload } = await jose.jwtVerify(auth.slice(7), jwks, {
      issuer: `https://login.microsoftonline.com/${TENANT_ID}/v2.0`, // v2トークン(requestedAccessTokenVersion: 2 が前提)
      audience: [CLIENT_ID, `api://${CLIENT_ID}`]
    }));
  } catch {
    throw httpError(401, 'トークンが無効です。再度サインインしてください');
  }
  const scopes = String(payload.scp || '').split(' ');
  if (!scopes.includes('access_as_user')) throw httpError(403, 'このAPIに必要なスコープがありません');
  return {
    name: payload.name || payload.preferred_username || '(名前不明)',
    // 部署はトークンに入らないため、テスト段階ではUPN(メール)を表示に使う。Graph連携時に /me から取得予定
    dept: payload.preferred_username || '',
    email: payload.preferred_username || '',
    roles: Array.isArray(payload.roles) ? payload.roles : []
  };
}

// 認証はルート個別ではなくミドルウェアで一括適用(掛け忘れ防止 → P002)。
// /api/config のみ除外(MSAL起動に必要な公開情報のため)。
app.use('/api', async (req, res, next) => {
  try {
    if (req.path === '/config') return next();
    // 認証を飛ばすのは AUTH_MODE === 'dev'(明示)のときだけ。それ以外は必ずトークンを検証する
    req.user = AUTH_MODE === 'dev' ? MOCK_ME : await verifyEntraToken(req);
    next();
  } catch (err) {
    res.status(err.status || 401).json({ error: err.expose ? err.message : '認証に失敗しました' });
  }
});

function me(req) {
  if (!req.user) throw httpError(401, 'サインインが必要です'); // ミドルウェア外からの呼び出し防止
  return req.user;
}

app.get('/api/config', (_req, res) => {
  res.json({
    authMode: AUTH_MODE,
    tenantId: process.env.TENANT_ID || '',
    clientId: process.env.CLIENT_ID || '',
    features: { attendance: ATTENDANCE_ENABLED, dayOffs: DAYOFFS_ENABLED } // 画面側で、無効な機能のリンク・検索候補を隠すために使う
  });
});

app.get('/api/me', (req, res) => {
  res.json(me(req));
});

// ---- 社内報(igrace.jp)への自動ログイン用(2026-10-06) ----
// 全社共通のID/パスワードを環境変数(IGRACE_USER / IGRACE_PASSWORD)で持ち、認証済みユーザーにだけ返す。
// 画面ファイル(public/)は未認証でも取得できるため、資格情報は絶対にそこへ書かない。
// 返した値で igrace-login.html がWordPressのログインフォームを自動送信する。
app.get('/api/external-login/igrace', (req, res) => {
  me(req);
  // 共通ID/パスワードを返すため、Entra IDで本人を確認できるモードに限る(devモードは認証なしのため返さない)
  if (AUTH_MODE !== 'entra') {
    return res.status(503).json({ error: '社内報の自動ログインは、Entra IDでサインインする環境でのみ使えます' });
  }
  const user = process.env.IGRACE_USER || '';
  const password = process.env.IGRACE_PASSWORD || '';
  if (!user || !password) {
    return res.status(503).json({ error: '社内報の自動ログインが未設定です(サーバーの IGRACE_USER / IGRACE_PASSWORD)' });
  }
  res.set('Cache-Control', 'no-store');
  res.json({
    action: 'https://igrace.jp/wp-login.php',
    fields: { log: user, pwd: password, redirect_to: 'https://igrace.jp/' }
  });
});

// ---- 管理コンテンツ(お知らせ / 全社スケジュール / クイックリンク) ----

const KINDS = {
  news: ['tag', 'title', 'date', 'expires', 'pinned', 'body'],
  schedule: ['date', 'title', 'sub', 'body', 'calendar_scope'],
  links: ['char', 'label', 'url'],
  policies: ['char', 'label', 'url'],
  guide: ['cat', 'kind', 'title', 'updated', 'popular', 'body'] // システム案内(案B。2026-10-20)
};
// システム案内の分野・種類(画面の定義もここから /api/guide で受け取る=定義はこの1か所)
const GUIDE_CATS = [
  { id: 'pc', icon: '💻', label: 'PC・周辺機器', desc: '貸与・故障・購入申請、プリンタ、ソフトの導入' },
  { id: 'network', icon: '🌐', label: 'ネットワーク', desc: 'Wi-Fi・VPN・社外から使う方法、ファイルサーバー' },
  { id: 'm365', icon: '🔑', label: 'MS365', desc: 'サインイン・パスワード、Teams・Outlook・OneDrive' },
  { id: 'jinjer', icon: '🕘', label: 'jinjer(人事)', desc: '打刻・修正、休暇申請、出勤状況の見かた' },
  { id: 'apply', icon: '📝', label: '申請・手続き', desc: '入社/退社時の準備、アカウント申請、機器の返却' }
];
const GUIDE_KINDS = ['手順', 'FAQ', '申請', 'お知らせ'];
const BODY_LIMITS = { guide: 20000 }; // 本文の上限(既定は2000字。システム案内の記事は長い手順を書くため20000字)
const SCHEDULE_SCOPES = ['both', 'sunday_off', 'wednesday_off'];

function kindOf(req, res) {
  const kind = req.params.kind;
  if (!KINDS[kind]) { res.status(404).json({ error: 'unknown kind' }); return null; }
  return kind;
}

function pickFields(kind, body) {
  const row = {};
  for (const f of KINDS[kind]) {
    let v = typeof body[f] === 'string' ? body[f].trim() : '';
    if (f === 'body') v = v.slice(0, BODY_LIMITS[kind] || 2000);
    if (f === 'cat' && !GUIDE_CATS.some(c => c.id === v)) v = ''; // 許可外の分野は空(=どの分野にも入らない)
    if (f === 'kind' && !GUIDE_KINDS.includes(v)) v = GUIDE_KINDS[0];
    if (f === 'updated' && kind === 'guide' && !CAL_DATE_RE.test(v)) v = jstNow().date; // 更新日が空・不正なら当日(日本時間)
    if (f === 'calendar_scope' && !SCHEDULE_SCOPES.includes(v)) v = 'both';
    if (f === 'pinned' || f === 'popular') v = (body[f] === '1' || body[f] === 1 || body[f] === true) ? '1' : ''; // 固定表示・よくある困りごとは'1'か空文字のみ
    row[f] = v;
  }
  return row;
}

/** 「何か1つでも入力されているか」の判定。calendar_scope(未指定でも'both'が入る)と pinned(固定表示のチェックだけでは入力と見なさない)は判定から除く */
function hasAnyInput(row) {
  return Object.entries(row).some(([k, v]) => k !== 'calendar_scope' && k !== 'pinned' && k !== 'popular' && k !== 'kind' && k !== 'updated' && v !== '');
}

/** リンクURLは http(s) と相対パスのみ許可(javascript: 等のスキームによる格納型XSS対策) */
function isSafeUrl(url) {
  if (url === '' || url === '#') return true;
  const scheme = /^[a-z][a-z0-9+.-]*:/i.exec(url);
  return scheme ? /^https?:$/i.test(scheme[0]) : true;
}

function requireAdmin(req, res) {
  if (!(me(req).roles || []).includes('Portal.Admin')) {
    res.status(403).json({ error: 'Portal.Admin ロールが必要です' });
    return false;
  }
  return true;
}

// ポータルトップ用: まとめて取得
app.get('/api/content', (_req, res) => {
  // お知らせ・全社スケジュールの添付ファイル(名前・大きさのみ。本体は /api/attachments/:id/download から取得)
  const files = {};
  db.prepare('SELECT id, kind, item_id, original_name, size FROM attachments ORDER BY created_at, rowid').all()
    .forEach(a => { (files[`${a.kind}:${a.item_id}`] ||= []).push({ id: a.id, name: a.original_name, size: a.size }); });
  const withFiles = (kind, rows) => rows.map(r => ({ ...r, attachments: files[`${kind}:${r.id}`] || [] }));
  res.json({
    news: withFiles('news', db.prepare('SELECT * FROM news ORDER BY id').all()),
    schedule: withFiles('schedule', db.prepare('SELECT * FROM schedule ORDER BY id').all()),
    links: db.prepare('SELECT * FROM links ORDER BY id').all(),
    policies: db.prepare('SELECT * FROM policies ORDER BY id').all(),
    guide: withFiles('guide', db.prepare('SELECT * FROM guide ORDER BY id').all()) // 管理画面の一覧用
  });
});

// ---- ポータルトップの配置(個人ごとのドラッグ&ドロップ並び順) ----

const LAYOUT_SECTIONS = ['news', 'links', 'policies', 'today', 'schedule', 'tasks'];
// 初期配置(個人の保存済み配置があればそちらが優先され、これには戻さない)。tasks(タスク・承認待ち)は画面で非表示だが、
// 既存の保存済み配置(6セクション)を無効にしないためLAYOUT_SECTIONSには残す(2026-10-08)
const DEFAULT_LAYOUT = { left: ['news', 'schedule', 'links'], right: ['today', 'policies', 'tasks'] };

/** left/rightの合計がLAYOUT_SECTIONSの過不足ない並べ替えであることを検証 */
function isValidLayout(body) {
  if (!body || !Array.isArray(body.left) || !Array.isArray(body.right)) return false;
  const combined = [...body.left, ...body.right];
  if (combined.length !== LAYOUT_SECTIONS.length) return false;
  const set = new Set(combined);
  return set.size === LAYOUT_SECTIONS.length && LAYOUT_SECTIONS.every(id => set.has(id));
}

app.get('/api/layout', (req, res) => {
  const row = db.prepare('SELECT layout FROM user_layouts WHERE email = ?').get(me(req).email);
  if (!row) return res.json(DEFAULT_LAYOUT);
  let layout;
  try { layout = JSON.parse(row.layout); } catch { layout = null; }
  res.json(isValidLayout(layout) ? layout : DEFAULT_LAYOUT);
});

app.put('/api/layout', (req, res) => {
  if (!isValidLayout(req.body)) return res.status(400).json({ error: '不正なレイアウトです' });
  const layout = JSON.stringify({ left: req.body.left, right: req.body.right });
  db.prepare(
    `INSERT INTO user_layouts (email, layout, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(email) DO UPDATE SET layout = excluded.layout, updated_at = excluded.updated_at`
  ).run(me(req).email, layout);
  res.json({ ok: true });
});

// ---- メンバー個人のリンク並び順(業務システムリンク・社内規程。2026-10-08・ユーザー指示) ----
// 管理者が並びを決めるのではなく、各メンバーがトップ画面のタイルをドラッグして並べ替え、その人だけに反映する。
// 保存するのはリンクIDの並びだけ(リンク本体は links / policies テーブル)。保存が無い人・保存後に追加された
// リンクは、登録順(IDの順)で末尾に出る。

const TILE_KINDS = ['links', 'policies'];

app.get('/api/tile-order', (req, res) => {
  const kind = String(req.query.kind || '');
  if (!TILE_KINDS.includes(kind)) return res.status(400).json({ error: 'kindが不正です' });
  const row = db.prepare('SELECT item_ids FROM user_tile_orders WHERE email = ? AND kind = ?').get(me(req).email, kind);
  let ids = [];
  try { ids = row ? JSON.parse(row.item_ids) : []; } catch { ids = []; }
  res.json({ ids: Array.isArray(ids) ? ids.filter(Number.isInteger) : [] });
});

app.put('/api/tile-order', (req, res) => {
  const { kind, ids } = req.body || {};
  if (!TILE_KINDS.includes(kind)) return res.status(400).json({ error: 'kindが不正です' });
  if (!Array.isArray(ids) || ids.length > 500 || !ids.every(Number.isInteger)) {
    return res.status(400).json({ error: 'idsが不正です' });
  }
  const unique = [...new Set(ids)];
  db.prepare(
    `INSERT INTO user_tile_orders (email, kind, item_ids, updated_at) VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(email, kind) DO UPDATE SET item_ids = excluded.item_ids, updated_at = excluded.updated_at`
  ).run(me(req).email, kind, JSON.stringify(unique));
  res.json({ ok: true });
});

// ---- お知らせ・全社スケジュールの添付ファイル(2026-10-08・ユーザー指示: 1件につき3つまで・1ファイル10MBまで) ----
// ファイル本体は data/uploads/<UUID> に保存(元のファイル名は使わない)。DBには名前・大きさ・添付先だけを持つ。
// アップロード・削除は管理者のみ、ダウンロードはサインイン済みなら誰でも(認証付きAPI経由。URL直打ちでは取得できない)。
// 保存層はこの節(saveAttachmentFile / readAttachmentStream / removeAttachmentFile)に閉じているので、
// 将来SharePoint・Box等へ差し替えるときはここだけ変える。

const ATTACH_DIR = path.join(__dirname, 'data', 'uploads');
const ATTACH_MAX_BYTES = 10 * 1024 * 1024;
const ATTACH_MAX_COUNT = 3;
const ATTACH_KINDS = ['news', 'schedule', 'guide'];
const TEXT_EXTRACT_KINDS = ['guide']; // 添付の中の文字を検索用に取り出す添付先(システム案内の記事。お知らせ・スケジュールの添付は対象外)

function isZip(b) { return b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04; }
/** Officeファイル(zip)の判定。ファイル名一覧は平文で入っているため、種類ごとの必須フォルダの有無と、
    マクロ(vbaProject.bin)の混入を文字列検索で確認する */
function isOoxml(b, folder) {
  if (!isZip(b)) return false;
  const text = b.toString('latin1');
  return text.includes('[Content_Types].xml') && text.includes(folder) && !text.includes('vbaProject.bin');
}
// 拡張子 → 許可するMIMEと、中身(先頭バイト等)の検査。HTML・SVG・実行形式・マクロ付きOfficeは許可しない
const ATTACH_TYPES = {
  pdf: { mime: 'application/pdf', ok: b => b.slice(0, 5).toString('latin1') === '%PDF-' },
  png: { mime: 'image/png', ok: b => b.length > 8 && b[0] === 0x89 && b.slice(1, 4).toString('latin1') === 'PNG' },
  jpg: { mime: 'image/jpeg', ok: b => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  jpeg: { mime: 'image/jpeg', ok: b => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  gif: { mime: 'image/gif', ok: b => ['GIF87a', 'GIF89a'].includes(b.slice(0, 6).toString('latin1')) },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ok: b => isOoxml(b, 'word/') },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ok: b => isOoxml(b, 'xl/') },
  pptx: { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ok: b => isOoxml(b, 'ppt/') }
};

function saveAttachmentFile(id, buf) {
  fs.mkdirSync(ATTACH_DIR, { recursive: true });
  fs.writeFileSync(path.join(ATTACH_DIR, id), buf);
}
function readAttachmentStream(id) { return fs.createReadStream(path.join(ATTACH_DIR, id)); }
function removeAttachmentFile(id) {
  try { fs.unlinkSync(path.join(ATTACH_DIR, id)); } catch { /* 既に無い場合は無視 */ }
}

/** 添付先の項目(お知らせ・全社スケジュール)を消すときに、添付のDB行とファイルも消す */
function deleteAttachmentsFor(kind, itemId) {
  const rows = db.prepare('SELECT id FROM attachments WHERE kind = ? AND item_id = ?').all(kind, itemId);
  rows.forEach(r => { removeAttachmentFile(r.id); db.prepare('DELETE FROM attachment_texts WHERE attachment_id = ?').run(r.id); });
  db.prepare('DELETE FROM attachments WHERE kind = ? AND item_id = ?').run(kind, itemId);
}

/** ファイル名を安全な表示名にする(パス区切り・制御文字を除去。長すぎる名前は切る) */
function safeFileName(raw) {
  const base = String(raw || '').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f"<>|?*:]/g, '').trim();
  return base.slice(-120) || 'file';
}

/** アップロード本体の読み取り。サイズ超過などの失敗は、画面に出せる日本語メッセージで返す */
function readRawBody(req, res, next) {
  express.raw({ type: '*/*', limit: ATTACH_MAX_BYTES })(req, res, err => {
    if (!err) return next();
    const tooLarge = err.type === 'entity.too.large';
    res.status(tooLarge ? 413 : 400).json({ error: tooLarge ? 'ファイルが大きすぎます(1ファイル10MBまで)' : 'ファイルを読み込めませんでした' });
  });
}

app.post('/api/attachments', readRawBody, async (req, res, next) => {
  try {
  if (!requireAdmin(req, res)) return;
  const kind = String(req.query.kind || '');
  const itemId = Number(req.query.itemId);
  if (!ATTACH_KINDS.includes(kind) || !Number.isInteger(itemId)) return res.status(400).json({ error: '添付先が不正です' });
  if (!db.prepare(`SELECT 1 FROM ${kind} WHERE id = ?`).get(itemId)) return res.status(404).json({ error: '添付先が見つかりません' });

  const buf = req.body;
  if (!Buffer.isBuffer(buf) || buf.length === 0) return res.status(400).json({ error: 'ファイルが空です' });
  const name = safeFileName(req.query.name);
  const ext = (name.split('.').pop() || '').toLowerCase();
  const type = ATTACH_TYPES[ext];
  if (!type) return res.status(400).json({ error: `この種類のファイルは添付できません(使えるもの: ${Object.keys(ATTACH_TYPES).join('・')})` });
  if (!type.ok(buf)) return res.status(400).json({ error: 'ファイルの中身が拡張子と一致しないか、マクロを含んでいるため添付できません' });

  const count = db.prepare('SELECT COUNT(*) AS c FROM attachments WHERE kind = ? AND item_id = ?').get(kind, itemId).c;
  if (count >= ATTACH_MAX_COUNT) return res.status(400).json({ error: `添付できるのは1件につき${ATTACH_MAX_COUNT}つまでです` });

  const id = crypto.randomUUID();
  saveAttachmentFile(id, buf);
  db.prepare('INSERT INTO attachments (id, kind, item_id, original_name, size, mime) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, kind, itemId, name, buf.length, type.mime);
  // CSV由来の行事に添付した場合は手入力扱いに切り替える(次回のCSV取込で、添付ごと消されないようにする)
  if (kind === 'schedule') db.prepare("UPDATE schedule SET source = '' WHERE id = ?").run(itemId);
  // システム案内の添付は、中の文字を検索用に取り出して保存する(失敗しても添付そのものは成功させる)
  if (TEXT_EXTRACT_KINDS.includes(kind)) await indexAttachmentText(id, ext, buf);
  res.json({ id, name, size: buf.length });
  } catch (e) {
    next(e); // Express 4 は async の例外を拾わないため明示的にエラーハンドラへ渡す(→ E001)
  }
});

app.delete('/api/attachments/:id', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const id = String(req.params.id);
  const info = db.prepare('DELETE FROM attachments WHERE id = ?').run(id);
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  db.prepare('DELETE FROM attachment_texts WHERE attachment_id = ?').run(id); // 検索用の文字も一緒に消す
  removeAttachmentFile(id);
  res.json({ ok: true });
});

app.get('/api/attachments/:id/download', (req, res, next) => {
  me(req);
  const row = db.prepare('SELECT original_name, mime FROM attachments WHERE id = ?').get(String(req.params.id));
  if (!row) return res.status(404).json({ error: 'not found' });
  const stream = readAttachmentStream(String(req.params.id));
  stream.on('error', () => { if (!res.headersSent) res.status(404).json({ error: 'ファイルが見つかりません' }); else res.destroy(); });
  res.set({
    'Content-Type': row.mime,
    'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(row.original_name)}`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store'
  });
  stream.pipe(res);
});

// ---- システム案内(案B)の記事と、添付の中の文字の検索(2026-10-20・ユーザー依頼) ----
// 記事は guide テーブル(管理画面で登録)。添付(PDF・Word・Excel・PowerPoint)は、アップロード時に中の文字を取り出して
// attachment_texts に保存し(src/textExtract.js)、検索ではタイトル・本文・添付の文字をまとめてAND検索する(NFKC正規化・小文字・部分一致)。
// 文字が取り出せない添付(スキャン画像のPDF・画像)は検索の対象外(記事のタイトル・本文では探せる)。閲覧はサインイン済みなら誰でも。

const TEXT_VERSION = 1; // 抽出・正規化のルールの版(attachment_texts.version)。変えたら、古い版の行を再抽出する

/** 添付の文字を取り出して保存する。例外は投げない(取り出せなくても添付は成功させる。→ E001) */
async function indexAttachmentText(id, ext, buf) {
  try {
    const r = await extractAttachmentText(ext, buf); // 別スレッドで実行(時間切れ・メモリ超過は failed)
    // 取り出している間に、添付や記事が削除されていたら保存しない(孤児を作らない)
    if (!db.prepare('SELECT 1 FROM attachments WHERE id = ?').get(id)) return;
    db.prepare('INSERT OR REPLACE INTO attachment_texts (attachment_id, text, status, version) VALUES (?, ?, ?, ?)')
      .run(id, r.text, r.status, TEXT_VERSION);
  } catch (e) {
    console.error('添付の文字の保存に失敗しました:', e.message || e);
  }
}

/** 起動時: ①添付が無くなった検索用の文字(孤児)を掃除 ②システム案内の添付で、文字を取り出していないもの・古い版のものを順に取り出す(1件ずつ・失敗しても続ける) */
async function reindexGuideAttachments() {
  try {
    db.prepare('DELETE FROM attachment_texts WHERE attachment_id NOT IN (SELECT id FROM attachments)').run();
    const todo = db.prepare(
      `SELECT a.id, a.original_name FROM attachments a
       LEFT JOIN attachment_texts t ON t.attachment_id = a.id
       WHERE a.kind IN (${TEXT_EXTRACT_KINDS.map(() => '?').join(',')}) AND (t.attachment_id IS NULL OR t.version < ?)`
    ).all(...TEXT_EXTRACT_KINDS, TEXT_VERSION);
    for (const row of todo) {
      try {
        const buf = fs.readFileSync(path.join(ATTACH_DIR, row.id));
        await indexAttachmentText(row.id, (row.original_name.split('.').pop() || '').toLowerCase(), buf);
      } catch (e) {
        console.error('添付の文字の再取り出しに失敗しました:', e.message || e);
      }
    }
  } catch (e) {
    console.error('添付の文字の再取り出しの確認に失敗しました:', e.message || e);
  }
}

/** text の中で、最初に見つかった語の前後を切り出した抜粋(1行・最大80字) */
function makeSnippet(text, lowText, terms) {
  let at = -1, len = 0;
  for (const t of terms) {
    const i = lowText.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) { at = i; len = t.length; }
  }
  if (at < 0) return '';
  const start = Math.max(0, at - 25);
  const end = Math.min(text.length, at + len + 45);
  return (start > 0 ? '…' : '') + text.slice(start, end).split('\n').join(' ') + (end < text.length ? '…' : '');
}

app.get('/api/guide', (req, res) => {
  me(req);
  const q = normalizeForSearch(String(req.query.q || '').slice(0, 200)); // 検索語は200字まで
  const terms = q.split(/[ 　]+/).filter(Boolean).slice(0, 8);

  const files = {};
  db.prepare("SELECT id, item_id, original_name, size FROM attachments WHERE kind = 'guide' ORDER BY created_at, rowid").all()
    .forEach(a => { (files[a.item_id] ||= []).push({ id: a.id, name: a.original_name, size: a.size }); });
  // 添付の文字は、検索語があるときだけ読む(一覧の取得では text 列を読まない)。attachments に無い行(孤児)は JOIN で除外
  const texts = {};
  if (terms.length) {
    db.prepare("SELECT a.id, a.item_id, t.text FROM attachments a JOIN attachment_texts t ON t.attachment_id = a.id WHERE a.kind = 'guide' AND t.status = 'ok'").all()
      .forEach(r => { (texts[r.item_id] ||= {})[r.id] = { raw: r.text, low: r.text.toLowerCase() }; }); // 保存した文字はNFKC済み。検索は小文字で比べ、抜粋は元の大文字小文字のまま出す
  }

  const out = [];
  for (const a of db.prepare('SELECT * FROM guide ORDER BY id').all()) {
    const attachments = files[a.id] || [];
    const item = { ...a, attachments, hits: [] };
    if (terms.length) {
      const own = normalizeForSearch(`${a.title}\n${a.body}`);
      const atts = texts[a.id] || {};
      const all = own + '\n' + Object.values(atts).map(t => t.low).join('\n');
      if (!terms.every(t => all.includes(t))) continue; // すべての語が、タイトル・本文・添付のどこかにあること(AND)
      for (const att of attachments) {
        const tx = atts[att.id];
        if (tx && terms.some(t => tx.low.includes(t))) item.hits.push({ attachmentId: att.id, name: att.name, snippet: makeSnippet(tx.raw, tx.low, terms) });
      }
      item.inBody = terms.some(t => own.includes(t));
    }
    out.push(item);
  }
  res.set('Cache-Control', 'no-store');
  res.json({ categories: GUIDE_CATS, kinds: GUIDE_KINDS, articles: out });
});

// ---- 組織図の役職(2026-10-20・ユーザー依頼): MS365に無い課長以下の役職と兼任の手入力 ----
// 表示(組織図ページ)はサインイン済みなら誰でも。書き込みは管理者のみ。title が空なら行を削除する。
/** 組織図の行のキー: メールは小文字・前後空白除去。メールを持たない人は 'name:'+氏名(NFKC・空白をすべて除去)(画面の orgKeyOf と同じ規則) */
function normalizeOrgKey(raw) {
  const s = String(raw || '').normalize('NFKC').trim();
  if (s.toLowerCase().startsWith('name:')) return 'name:' + s.slice(5).replace(/\s+/g, '');
  return s.toLowerCase();
}
function hasControlChar(s) { return [...s].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127); }

app.get('/api/orgchart-titles', (req, res) => {
  me(req);
  res.set('Cache-Control', 'no-store');
  res.json(db.prepare('SELECT email, dept, title, sort FROM orgchart_titles ORDER BY dept, sort, email').all());
});

app.put('/api/admin/orgchart-titles', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const b = req.body || {};
  const email = normalizeOrgKey(b.email);
  const dept = String(b.dept || '').trim(); // 部門名は正規化しない(㈱ は NFKC で「(株)」になり、画面の枠組み ORG_CHART_FRAME の名前と一致しなくなる)
  const title = String(b.title || '').normalize('NFKC').trim();
  let sort = Math.round(Number(b.sort) || 0);
  if (!email || email === 'name:' || email.length > 200 || hasControlChar(email)) return res.status(400).json({ error: 'メールアドレス(または氏名)が不正です' });
  if (dept.length > 60 || hasControlChar(dept)) return res.status(400).json({ error: '部門名が不正です' });
  if (title.length > 30 || hasControlChar(title)) return res.status(400).json({ error: '役職は30文字までです' });
  sort = Math.max(0, Math.min(9999, sort));
  // 役職が空でも、表示順(1以上)があれば行を残す(役職を付けない人の並び順だけを指定できる)。両方が空(表示順0)のときだけ、行を削除する
  if (!title && sort === 0) {
    db.prepare('DELETE FROM orgchart_titles WHERE email = ? AND dept = ?').run(email, dept);
    return res.json({ ok: true, deleted: true });
  }
  db.prepare(
    `INSERT INTO orgchart_titles (email, dept, title, sort, updated_at) VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(email, dept) DO UPDATE SET title = excluded.title, sort = excluded.sort, updated_at = excluded.updated_at`
  ).run(email, dept, title, sort);
  res.json({ ok: true });
});

// ---- 組織図の補足(2026-10-27・ユーザー依頼): 部門の枠の一番下に出す「手動の人」「人数だけの行」。組織図ページだけが使う ----
// 保存は一覧ごと置き換える(管理画面で並びごと編集するため)。入力は型・長さ・範囲をここで検証する
app.get('/api/orgchart-extras', (req, res) => {
  me(req);
  res.set('Cache-Control', 'no-store');
  res.json(db.prepare('SELECT id, dept, kind, title, name, count, sort FROM orgchart_extras ORDER BY dept, sort, id').all());
});
app.put('/api/admin/orgchart-extras', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const items = req.body && req.body.items;
  if (!Array.isArray(items) || items.length > 200) return res.status(400).json({ error: '入力が不正です(200行まで)' });
  const rows = [];
  for (const it of items) {
    const o = it || {};
    const dept = String(o.dept || '').trim(); // 部門名は正規化しない(㈱ を壊さない)
    const kind = String(o.kind || '');
    const title = String(o.title || '').normalize('NFKC').trim();
    const name = String(o.name || '').normalize('NFKC').trim();
    const sort = Math.max(0, Math.min(9999, Math.round(Number(o.sort) || 0)));
    const countRaw = Math.round(Number(o.count) || 0);
    if (!dept || dept.length > 60 || hasControlChar(dept)) return res.status(400).json({ error: '部門名が不正です' });
    if (kind !== 'person' && kind !== 'count') return res.status(400).json({ error: '種類が不正です' });
    if (title.length > 30 || hasControlChar(title) || name.length > 30 || hasControlChar(name)) return res.status(400).json({ error: '役職・氏名・行の名前は30文字までです' });
    if (kind === 'person' && !name) return res.status(400).json({ error: '氏名を入力してください' });
    if (kind === 'count' && (!title || countRaw < 0 || countRaw > 9999)) return res.status(400).json({ error: '行の名前と人数(0〜9999)を入力してください' });
    rows.push({ dept, kind, title, name: kind === 'person' ? name : '', count: kind === 'count' ? countRaw : 0, sort });
  }
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM orgchart_extras').run();
    const ins = db.prepare("INSERT INTO orgchart_extras (dept, kind, title, name, count, sort, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))");
    rows.forEach(r => ins.run(r.dept, r.kind, r.title, r.name, r.count, r.sort));
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ROLLBACK の失敗で、元の例外を隠さない */ }
    throw e;
  }
  res.json({ ok: true, count: rows.length });
});

// 班の臨時交代の管理API。/api/admin/:kind という1セグメントの汎用CRUDルートと
// パスの形が重なってしまうため(例: GET/POST /api/admin/shift-swaps, DELETE /api/admin/shift-swaps/:id)、
// 汎用ルートより前に登録して先にマッチさせる(でなければ kind='shift-swaps' が KINDS になく 404 になる)
app.get('/api/admin/shift-swaps', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { from } = req.query;
  const rows = CAL_DATE_RE.test(from || '')
    ? db.prepare('SELECT * FROM shift_swaps WHERE date >= ? ORDER BY date').all(from)
    : db.prepare('SELECT * FROM shift_swaps ORDER BY date').all();
  res.json(rows);
});

app.post('/api/admin/shift-swaps', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const date = String((req.body && req.body.date) || '').trim();
  const calendar_group = String((req.body && req.body.calendar_group) || '').trim();
  const email_out = String((req.body && req.body.email_out) || '').trim().toLowerCase();
  const email_in = String((req.body && req.body.email_in) || '').trim().toLowerCase();
  if (!CAL_DATE_RE.test(date)) return res.status(400).json({ error: '日付の形式が不正です' });
  if (!CALENDAR_GROUPS.includes(calendar_group)) return res.status(400).json({ error: 'calendar_groupが不正です' });
  if (!email_out || !email_in) return res.status(400).json({ error: '交代する2人を指定してください' });
  if (email_out === email_in) return res.status(400).json({ error: '同じ人が指定されています' });
  const info = db.prepare(
    'INSERT INTO shift_swaps (date, calendar_group, email_out, email_in) VALUES (?, ?, ?, ?)'
  ).run(date, calendar_group, email_out, email_in);
  res.json({ id: Number(info.lastInsertRowid) });
});

app.delete('/api/admin/shift-swaps/:id', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const info = db.prepare('DELETE FROM shift_swaps WHERE id = ?').run(Number(req.params.id));
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

app.get('/api/admin/:kind', (req, res) => {
  const kind = kindOf(req, res); if (!kind) return;
  res.json(db.prepare(`SELECT * FROM ${kind} ORDER BY id`).all());
});

app.post('/api/admin/:kind', (req, res) => {
  const kind = kindOf(req, res); if (!kind) return;
  if (!requireAdmin(req, res)) return;
  const row = pickFields(kind, req.body || {});
  if (!hasAnyInput(row)) {
    return res.status(400).json({ error: 'いずれかの項目を入力してください' });
  }
  if (kind === 'guide' && !row.title) return res.status(400).json({ error: 'タイトルを入力してください' });
  if ('url' in row && !isSafeUrl(row.url)) {
    return res.status(400).json({ error: 'URLは http(s) または相対パスのみ使用できます' });
  }
  const fields = KINDS[kind];
  const info = db.prepare(
    `INSERT INTO ${kind} (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`
  ).run(...fields.map(f => row[f]));
  res.json({ id: Number(info.lastInsertRowid) });
});

app.put('/api/admin/:kind/:id', (req, res) => {
  const kind = kindOf(req, res); if (!kind) return;
  if (!requireAdmin(req, res)) return;
  const id = Number(req.params.id);
  const row = pickFields(kind, req.body || {});
  if (!hasAnyInput(row)) {
    return res.status(400).json({ error: 'いずれかの項目を入力してください' });
  }
  if (kind === 'guide' && !row.title) return res.status(400).json({ error: 'タイトルを入力してください' });
  if ('url' in row && !isSafeUrl(row.url)) {
    return res.status(400).json({ error: 'URLは http(s) または相対パスのみ使用できます' });
  }
  // calendar_scope が送られてこなかった更新(古い画面からの保存等)では、登録済みの値を維持する
  if (kind === 'schedule' && !(req.body && 'calendar_scope' in req.body)) {
    const cur = db.prepare('SELECT calendar_scope FROM schedule WHERE id = ?').get(id);
    if (cur) row.calendar_scope = cur.calendar_scope;
  }
  // pinned が送られてこなかった更新(古い画面からの保存等)では、登録済みの値を維持する(固定表示が勝手に外れないように)。
  // UPDATEで上書きされる前に読む
  if (kind === 'news' && !(req.body && 'pinned' in req.body)) {
    const cur = db.prepare('SELECT pinned FROM news WHERE id = ?').get(id);
    if (cur) row.pinned = cur.pinned;
  }
  // popular が送られてこなかった更新では、登録済みの値を維持する(「よくある困りごと」の表示が勝手に外れないように)
  if (kind === 'guide' && !(req.body && 'popular' in req.body)) {
    const cur = db.prepare('SELECT popular FROM guide WHERE id = ?').get(id);
    if (cur) row.popular = cur.popular;
  }
  const fields = KINDS[kind];
  const info = db.prepare(
    `UPDATE ${kind} SET ${fields.map(f => `${f} = ?`).join(', ')} WHERE id = ?`
  ).run(...fields.map(f => row[f]), id);
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  // CSV由来の項目を管理画面で編集したら手入力扱いに切り替える(次回のCSV取込で上書き・削除されないようにする)
  if (kind === 'schedule') db.prepare("UPDATE schedule SET source = '' WHERE id = ?").run(id);
  res.json({ ok: true });
});

app.delete('/api/admin/:kind/:id', (req, res) => {
  const kind = kindOf(req, res); if (!kind) return;
  if (!requireAdmin(req, res)) return;
  const info = db.prepare(`DELETE FROM ${kind} WHERE id = ?`).run(Number(req.params.id));
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  if (ATTACH_KINDS.includes(kind)) deleteAttachmentsFor(kind, Number(req.params.id)); // 添付ファイルも一緒に消す
  res.json({ ok: true });
});

// ---- 出社日(A/B/C班ローテーション)年間カレンダー(2026-10-02追加) ----

const CAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CALENDAR_GROUPS = ['sunday_off', 'wednesday_off'];
const SHIFT_TEAMS = ['A', 'B', 'C'];
const WORK_CALENDAR_TYPES = ['holiday', 'holiday_1', 'event', 'shift_work', 'shift_off', 'shift_holiday']; // shift_holiday(2026-10-19追加): 文字枠(ラベル)を赤で表示。日付枠は色を付けない。teamは空(共通)でもA/B/Cでもよい
const WORK_CALENDAR_HEADER = 'date,calendar_group,team,type,label';

/** CSV 1行(5列の配列)を検証する。問題なければ null、問題があればエラー文言を返す */
function validateWorkCalendarRow(cols) {
  const [date, calendar_group, team, type, label] = cols;
  if (!CAL_DATE_RE.test(date)) return `日付の形式が不正です: "${date}"`;
  if (!CALENDAR_GROUPS.includes(calendar_group)) return `calendar_groupが不正です: "${calendar_group}"`;
  if (team !== '' && !SHIFT_TEAMS.includes(team)) return `teamが不正です: "${team}"`;
  if (type !== '' && !WORK_CALENDAR_TYPES.includes(type)) return `typeが不正です: "${type}"`;
  return null;
}

/** 社内で作成するシンプルなCSV専用パーサー(クォート処理なし。ラベルにASCIIカンマを含めない運用とし、
    複数項目は全角読点「、」で区切る)。1件でもエラーがあれば全体を取り込ませたくないため、
    エラー一覧をまとめて返す(呼び出し元は errors.length があれば一切INSERTしない) */
function parseWorkCalendarCsv(text) {
  const lines = String(text || '').replace(/^﻿/, '').split(/\r\n|\n|\r/).filter(l => l.trim() !== '');
  if (!lines.length) return { rows: [], errors: ['CSVが空です'] };
  const header = lines[0].trim();
  if (header !== WORK_CALENDAR_HEADER) {
    return { rows: [], errors: [`ヘッダー行が不正です。"${WORK_CALENDAR_HEADER}" である必要があります(実際: "${header}")`] };
  }
  const rows = [];
  const errors = [];
  const seenKey = new Set();     // (date,calendar_group,team,type) の重複チェック
  const seenWorkOff = new Set(); // 同じ(date,calendar_group,team)にshift_work/shift_offが両方無いかのチェック
  for (let i = 1; i < lines.length; i++) {
    const lineNo = i + 1;
    const cols = lines[i].split(',').map(c => c.trim());
    if (cols.length !== 5) {
      errors.push(`${lineNo}行目: 列数が5ではありません(${cols.length}列)`);
      continue;
    }
    const err = validateWorkCalendarRow(cols);
    if (err) { errors.push(`${lineNo}行目: ${err}`); continue; }
    const [date, calendar_group, team, type, label] = cols;
    const key = `${date}|${calendar_group}|${team}|${type}`;
    if (seenKey.has(key)) { errors.push(`${lineNo}行目: 重複した行です(${date} ${calendar_group} ${team || '(共通)'} ${type})`); continue; }
    seenKey.add(key);
    if (type === 'shift_work' || type === 'shift_off') {
      const woKey = `${date}|${calendar_group}|${team}`;
      const other = type === 'shift_work' ? 'shift_off' : 'shift_work';
      if (seenWorkOff.has(`${woKey}|${other}`)) {
        errors.push(`${lineNo}行目: 同じ日・班に出勤番と振替休日が両方登録されています(${date} ${calendar_group} ${team}班)`);
        continue;
      }
      seenWorkOff.add(`${woKey}|${type}`);
    }
    rows.push({ date, calendar_group, team, type, label });
  }
  return { rows, errors };
}

app.get('/api/work-calendar', (req, res) => {
  const { group, from, to } = req.query;
  if (!CALENDAR_GROUPS.includes(group)) return res.status(400).json({ error: 'groupが不正です' });
  if (!CAL_DATE_RE.test(from || '') || !CAL_DATE_RE.test(to || '')) return res.status(400).json({ error: 'from/toの形式が不正です' });
  const rows = db.prepare(
    'SELECT date, team, type, label FROM work_calendar WHERE calendar_group = ? AND date >= ? AND date <= ? ORDER BY date'
  ).all(group, from, to);
  // 管理画面で手入力した全社スケジュール(source='')を event として合流させる。CSV由来(source='csv')は
  // すでに work_calendar 側に行があるため二重表示を避けて除外する。同日・同名の行も重複させない
  const manual = db.prepare(
    `SELECT date, title AS label FROM schedule
     WHERE source != 'csv' AND title != '' AND (calendar_scope = 'both' OR calendar_scope = ?)
       AND date >= ? AND date <= ? AND date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`
  ).all(group, from, to);
  const seen = new Set(rows.map(r => `${r.date}|${r.label}`));
  manual.forEach(m => {
    if (seen.has(`${m.date}|${m.label}`)) return;
    rows.push({ date: m.date, team: '', type: 'event', label: m.label });
  });
  rows.sort((a, b) => a.date.localeCompare(b.date));
  res.json(rows);
});

app.get('/api/shift-teams', (req, res) => {
  const { group, team, date } = req.query;
  let rows = (group && team)
    ? db.prepare('SELECT email, calendar_group, team FROM shift_teams WHERE calendar_group = ? AND team = ?').all(group, team)
    : db.prepare('SELECT email, calendar_group, team FROM shift_teams ORDER BY email').all();
  // 班の臨時交代(その1回だけ。ベースの班割当ては変えない)の反映。date指定時のみ適用
  if (group && team && date && CAL_DATE_RE.test(date)) {
    const swaps = db.prepare('SELECT email_out, email_in FROM shift_swaps WHERE calendar_group = ? AND date = ?').all(group, date);
    if (swaps.length) {
      const outSet = new Set(swaps.map(s => s.email_out.toLowerCase()));
      rows = rows.filter(r => !outSet.has(r.email.toLowerCase()));
      swaps.forEach(s => {
        if (!rows.some(r => r.email.toLowerCase() === s.email_in.toLowerCase())) {
          rows.push({ email: s.email_in, calendar_group: group, team });
        }
      });
    }
  }
  res.json(rows);
});

app.put('/api/admin/shift-teams', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'メールアドレスを指定してください' });
  if (req.body && req.body.unassign) {
    db.prepare('DELETE FROM shift_teams WHERE email = ?').run(email);
    return res.json({ ok: true });
  }
  const calendar_group = String((req.body && req.body.calendar_group) || '');
  const team = String((req.body && req.body.team) || '');
  if (!CALENDAR_GROUPS.includes(calendar_group)) return res.status(400).json({ error: 'calendar_groupが不正です' });
  if (!SHIFT_TEAMS.includes(team)) return res.status(400).json({ error: 'teamが不正です' });
  db.prepare(
    `INSERT INTO shift_teams (email, calendar_group, team) VALUES (?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET calendar_group = excluded.calendar_group, team = excluded.team`
  ).run(email, calendar_group, team);
  res.json({ ok: true });
});

/** 年間カレンダーCSVの event 行を全社スケジュール(source='csv')へ反映する(2026-10-06)。
    取込範囲(group, from〜to)の既存CSV由来項目からこのグループを外し(他グループ分は残す)、
    CSVの event 行を日付+行事名で突き合わせて追加・統合する。手入力の項目(source='')には触れない。
    呼び出し元のトランザクション内で実行する */
function syncScheduleFromCalendar(group, from, to, groupRows) {
  const other = group === 'sunday_off' ? 'wednesday_off' : 'sunday_off';
  const old = db.prepare("SELECT id, calendar_scope FROM schedule WHERE source = 'csv' AND date >= ? AND date <= ?").all(from, to);
  for (const o of old) {
    if (o.calendar_scope === group) db.prepare('DELETE FROM schedule WHERE id = ?').run(o.id);
    else if (o.calendar_scope === 'both') db.prepare('UPDATE schedule SET calendar_scope = ? WHERE id = ?').run(other, o.id);
  }
  const find = db.prepare("SELECT id, calendar_scope FROM schedule WHERE source = 'csv' AND date = ? AND title = ?");
  const insert = db.prepare("INSERT INTO schedule (date, title, sub, body, calendar_scope, source) VALUES (?, ?, '', '', ?, 'csv')");
  for (const r of groupRows) {
    if (r.type !== 'event' || !r.label) continue;
    const ex = find.get(r.date, r.label);
    if (!ex) insert.run(r.date, r.label, group);
    else if (ex.calendar_scope !== group && ex.calendar_scope !== 'both') {
      db.prepare("UPDATE schedule SET calendar_scope = 'both' WHERE id = ?").run(ex.id);
    }
  }
}

app.post('/api/admin/work-calendar/import', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { rows, errors } = parseWorkCalendarCsv(req.body && req.body.csv);
  if (errors.length) return res.status(400).json({ error: 'CSVにエラーがあります', errors });
  if (!rows.length) return res.status(400).json({ error: '取り込み対象の行がありません' });

  const byGroup = {};
  rows.forEach(r => { (byGroup[r.calendar_group] ||= []).push(r); });

  const del = db.prepare('DELETE FROM work_calendar WHERE calendar_group = ? AND date >= ? AND date <= ?');
  const ins = db.prepare('INSERT INTO work_calendar (date, calendar_group, team, type, label) VALUES (?, ?, ?, ?, ?)');
  const summary = [];
  db.exec('BEGIN');
  try {
    for (const [group, groupRows] of Object.entries(byGroup)) {
      const dates = groupRows.map(r => r.date).sort();
      const from = dates[0], to = dates[dates.length - 1];
      del.run(group, from, to);
      groupRows.forEach(r => ins.run(r.date, r.calendar_group, r.team, r.type, r.label));
      syncScheduleFromCalendar(group, from, to, groupRows);
      summary.push({ calendar_group: group, from, to, count: groupRows.length });
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  res.json({ imported: rows.length, groups: summary });
});

// ---- 社内メンバー検索(Entra移行後は Graph /users $search に置換) ----

app.get('/api/users', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json([]);
  const like = `%${q}%`;
  res.json(db.prepare(
    'SELECT name, dept, email FROM users WHERE name LIKE ? OR dept LIKE ? OR email LIKE ? LIMIT 5'
  ).all(like, like, like));
});

// ---- 会議室予約(Entra移行後は Graph /me/events に置換) ----

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validateBooking(b) {
  if (!b || typeof b !== 'object') return '不正なリクエストです';
  if (!b.room || typeof b.room !== 'string') return '会議室を選択してください';
  if (!DATE_RE.test(b.date || '')) return '日付が不正です';
  if (!TIME_RE.test(b.start || '') || !TIME_RE.test(b.end || '')) return '時刻が不正です';
  if (b.start >= b.end) return '終了時刻は開始時刻より後にしてください';
  if (!String(b.title || '').trim()) return '件名を入力してください';
  return null;
}

app.get('/api/bookings', (req, res) => {
  const { from, to } = req.query;
  let rows;
  if (DATE_RE.test(from || '') && DATE_RE.test(to || '')) {
    rows = db.prepare('SELECT * FROM bookings WHERE date >= ? AND date <= ? ORDER BY date, start').all(from, to);
  } else {
    rows = db.prepare('SELECT * FROM bookings ORDER BY date, start').all();
  }
  res.json(rows.map(r => ({ ...r, members: safeParse(r.members) })));
});

function safeParse(json) {
  try { return JSON.parse(json) || []; } catch { return []; }
}

function bookingFields(b, req) {
  return {
    room: String(b.room),
    date: b.date,
    start: b.start,
    end: b.end,
    title: String(b.title).trim(),
    content: String(b.content || '').trim().slice(0, 2000),
    owner: me(req).name,
    owner_email: me(req).email,
    members: JSON.stringify(Array.isArray(b.members) ? b.members.slice(0, 20).map(m => ({
      name: String(m.name || ''), dept: String(m.dept || ''), email: String(m.email || '')
    })) : []),
    guests: String(b.guests || '').trim().slice(0, 200)
  };
}

/** 同一会議室・同一日の時間帯重複(ダブルブッキング)を検査 */
function hasConflict(f, excludeId) {
  const sql = 'SELECT COUNT(*) AS c FROM bookings WHERE room = ? AND date = ? AND start < ? AND end > ?' +
    (excludeId != null ? ' AND id != ?' : '');
  const args = [f.room, f.date, f.end, f.start];
  if (excludeId != null) args.push(excludeId);
  return db.prepare(sql).get(...args).c > 0;
}

app.post('/api/bookings', (req, res) => {
  const err = validateBooking(req.body);
  if (err) return res.status(400).json({ error: err });
  const f = bookingFields(req.body, req);
  if (hasConflict(f)) return res.status(409).json({ error: 'この時間帯は既に予約があります' });
  const info = db.prepare(
    'INSERT INTO bookings (room, date, start, end, title, content, owner, owner_email, members, guests) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(f.room, f.date, f.start, f.end, f.title, f.content, f.owner, f.owner_email, f.members, f.guests);
  res.json({ id: Number(info.lastInsertRowid) });
});

function ownBooking(req, res) {
  const row = db.prepare('SELECT * FROM bookings WHERE id = ?').get(Number(req.params.id));
  if (!row) { res.status(404).json({ error: 'not found' }); return null; }
  // この予約データはデザインサンプル(rooms.html)専用のため、一旦サインイン済みユーザーなら
  // 誰でも変更・取消できるようにしている(ユーザー指示 2026-08-20。シードされたサンプル予約も編集可能にするため)。
  // 実データ化する際は主催者のみに戻すこと: if (row.owner_email !== me(req).email) → 403
  return row;
}

app.put('/api/bookings/:id', (req, res) => {
  if (!ownBooking(req, res)) return;
  const err = validateBooking(req.body);
  if (err) return res.status(400).json({ error: err });
  const f = bookingFields(req.body, req);
  const id = Number(req.params.id);
  if (hasConflict(f, id)) return res.status(409).json({ error: 'この時間帯は既に予約があります' });
  db.prepare(
    'UPDATE bookings SET room = ?, date = ?, start = ?, end = ?, title = ?, content = ?, members = ?, guests = ? WHERE id = ?'
  ).run(f.room, f.date, f.start, f.end, f.title, f.content, f.members, f.guests, id);
  res.json({ ok: true });
});

app.delete('/api/bookings/:id', (req, res) => {
  if (!ownBooking(req, res)) return;
  db.prepare('DELETE FROM bookings WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// ---- 本日のお休み(jinjer連携。2026-10-07) ----
// 取り込みはサーバーが朝6:00(日本時間)に自動実行する(src/jinjerDayOffs.js)。画面はDBのキャッシュだけを読む。
// 電話連絡などで当日にjinjerへ入力された休暇を反映するため、サインイン済みなら誰でも手動で再取り込みできる(1分に1回まで)。
app.get('/api/day-offs', (req, res) => {
  me(req);
  res.set('Cache-Control', 'no-store');
  res.json(jinjerDayOffs.getToday(db));
});

app.post('/api/day-offs/sync', async (req, res, next) => {
  try {
    me(req);
    const result = await jinjerDayOffs.sync(db, { force: true });
    res.set('Cache-Control', 'no-store');
    res.status(result.ok ? 200 : 503).json({ ...result, ...jinjerDayOffs.getToday(db), error: result.ok ? undefined : result.message });
  } catch (e) {
    next(e); // Express 4 は async の例外を拾わないため明示的にエラーハンドラへ渡す(→ E001)
  }
});

// ---- 出勤状況(jinjerの打刻データ。2026-10-17) ----
// 取り込みはサーバーが10分おきに自動実行する(src/jinjerAttendance.js)。画面はDBのキャッシュだけを読む。全社員が閲覧できる(ユーザー指示)。
app.get('/api/attendance', (req, res) => {
  me(req);
  res.set('Cache-Control', 'no-store');
  res.json(jinjerAttendance.getToday(db));
});

// 1件の失敗でプロセスを落とさない(→ E001)
app.use((err, _req, res, _next) => {
  console.error(err.message || err);
  const status = err.status || 500;
  res.status(status).json({
    error: status === 400 ? 'リクエストの形式が不正です'
      : err.expose ? err.message
      : 'サーバーエラーが発生しました'
  });
});

app.listen(PORT, () => {
  console.log(`社内ポータルが起動しました: http://localhost:${PORT} (認証: ${AUTH_MODE})`);
  if (DAYOFFS_ENABLED) jinjerDayOffs.startScheduler(db);
  if (ATTENDANCE_ENABLED) jinjerAttendance.startScheduler(db);
  reindexGuideAttachments(); // システム案内の添付で、検索用の文字が未取得のものを順に取り出す(待たずに起動する)
  if (AUTH_MODE === 'dev') {
    console.warn('⚠ AUTH_MODE=dev(認証なし・管理者権限のモックユーザー)で起動しました。ローカル確認専用です。本番・公開環境では使わないでください');
  }
  if (AUTH_MODE === 'entra' && (!TENANT_ID || !CLIENT_ID)) {
    console.warn('⚠ AUTH_MODE=entra ですが TENANT_ID / CLIENT_ID が未設定です。Portal/.env に設定してください(docs/entra-setup.md §0)');
  }
});
