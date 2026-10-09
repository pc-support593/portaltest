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
    if (req.path === '/today-off.html' || req.path === '/js/todayOff.js' || req.path.startsWith('/api/day-offs')) {
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
    clientId: process.env.CLIENT_ID || ''
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
  news: ['tag', 'title', 'date', 'expires', 'body'],
  schedule: ['date', 'title', 'sub', 'body', 'calendar_scope'],
  links: ['char', 'label', 'url'],
  policies: ['char', 'label', 'url']
};
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
    if (f === 'body') v = v.slice(0, 2000);
    if (f === 'calendar_scope' && !SCHEDULE_SCOPES.includes(v)) v = 'both';
    row[f] = v;
  }
  return row;
}

/** 「何か1つでも入力されているか」の判定。calendar_scopeは未指定でも'both'が入るため判定から除く */
function hasAnyInput(row) {
  return Object.entries(row).some(([k, v]) => k !== 'calendar_scope' && v !== '');
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
    policies: db.prepare('SELECT * FROM policies ORDER BY id').all()
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
const ATTACH_KINDS = ['news', 'schedule'];

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
  rows.forEach(r => removeAttachmentFile(r.id));
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

app.post('/api/attachments', readRawBody, (req, res) => {
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
  res.json({ id, name, size: buf.length });
});

app.delete('/api/attachments/:id', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const id = String(req.params.id);
  const info = db.prepare('DELETE FROM attachments WHERE id = ?').run(id);
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
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
  if ('url' in row && !isSafeUrl(row.url)) {
    return res.status(400).json({ error: 'URLは http(s) または相対パスのみ使用できます' });
  }
  // calendar_scope が送られてこなかった更新(古い画面からの保存等)では、登録済みの値を維持する
  if (kind === 'schedule' && !(req.body && 'calendar_scope' in req.body)) {
    const cur = db.prepare('SELECT calendar_scope FROM schedule WHERE id = ?').get(id);
    if (cur) row.calendar_scope = cur.calendar_scope;
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
const WORK_CALENDAR_TYPES = ['holiday', 'holiday_1', 'event', 'shift_work', 'shift_off'];
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
  if (AUTH_MODE === 'dev') {
    console.warn('⚠ AUTH_MODE=dev(認証なし・管理者権限のモックユーザー)で起動しました。ローカル確認専用です。本番・公開環境では使わないでください');
  }
  if (AUTH_MODE === 'entra' && (!TENANT_ID || !CLIENT_ID)) {
    console.warn('⚠ AUTH_MODE=entra ですが TENANT_ID / CLIENT_ID が未設定です。Portal/.env に設定してください(docs/entra-setup.md §0)');
  }
});
