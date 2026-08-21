// 吉村一建設 社内ポータル サーバー
// - public/ の静的配信(3画面: index.html / rooms.html / admin.html)
// - 管理コンテンツ(お知らせ・全社スケジュール・クイックリンク)の CRUD API
// - 会議室予約 API(Entra ID + Graph API 移行までのローカル実装)
// 認証は現在 devモード(モックユーザー)。Entra ID 移行手順は docs/entra-setup.md を参照。
const express = require('express');
const path = require('path');
const { open } = require('./src/db');

// Portal/.env があれば読み込む(環境変数の設定漏れ対策。既に設定済みの環境変数が優先される)
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* .env なしでも可 */ }

const app = express();
const db = open();
const PORT = process.env.PORT || 3100;
const AUTH_MODE = process.env.AUTH_MODE || 'dev'; // 'dev' | 'entra'

app.use(express.json({ limit: '256kb' }));
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
    req.user = AUTH_MODE === 'entra' ? await verifyEntraToken(req) : MOCK_ME;
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

// ---- 管理コンテンツ(お知らせ / 全社スケジュール / クイックリンク) ----

const KINDS = {
  news: ['tag', 'title', 'date', 'expires', 'body'],
  schedule: ['date', 'title', 'sub', 'body'],
  links: ['char', 'label', 'url']
};

function kindOf(req, res) {
  const kind = req.params.kind;
  if (!KINDS[kind]) { res.status(404).json({ error: 'unknown kind' }); return null; }
  return kind;
}

function pickFields(kind, body) {
  const row = {};
  for (const f of KINDS[kind]) {
    let v = typeof body[f] === 'string' ? body[f].trim() : '';
    if (f === 'body') v = v.slice(0, 500);
    row[f] = v;
  }
  return row;
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

// ポータルトップ用: 3種まとめて取得
app.get('/api/content', (_req, res) => {
  res.json({
    news: db.prepare('SELECT * FROM news ORDER BY id').all(),
    schedule: db.prepare('SELECT * FROM schedule ORDER BY id').all(),
    links: db.prepare('SELECT * FROM links ORDER BY id').all()
  });
});

// ---- ポータルトップの配置(個人ごとのドラッグ&ドロップ並び順) ----

const LAYOUT_SECTIONS = ['news', 'links', 'today', 'schedule', 'tasks'];
const DEFAULT_LAYOUT = { left: ['news', 'links'], right: ['today', 'schedule', 'tasks'] };

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

app.get('/api/admin/:kind', (req, res) => {
  const kind = kindOf(req, res); if (!kind) return;
  res.json(db.prepare(`SELECT * FROM ${kind} ORDER BY id`).all());
});

app.post('/api/admin/:kind', (req, res) => {
  const kind = kindOf(req, res); if (!kind) return;
  if (!requireAdmin(req, res)) return;
  const row = pickFields(kind, req.body || {});
  if (!Object.values(row).some(v => v !== '')) {
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
  if (!Object.values(row).some(v => v !== '')) {
    return res.status(400).json({ error: 'いずれかの項目を入力してください' });
  }
  if ('url' in row && !isSafeUrl(row.url)) {
    return res.status(400).json({ error: 'URLは http(s) または相対パスのみ使用できます' });
  }
  const fields = KINDS[kind];
  const info = db.prepare(
    `UPDATE ${kind} SET ${fields.map(f => `${f} = ?`).join(', ')} WHERE id = ?`
  ).run(...fields.map(f => row[f]), id);
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

app.delete('/api/admin/:kind/:id', (req, res) => {
  const kind = kindOf(req, res); if (!kind) return;
  if (!requireAdmin(req, res)) return;
  const info = db.prepare(`DELETE FROM ${kind} WHERE id = ?`).run(Number(req.params.id));
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
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
    'INSERT INTO bookings (room, date, start, end, title, owner, owner_email, members, guests) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(f.room, f.date, f.start, f.end, f.title, f.owner, f.owner_email, f.members, f.guests);
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
    'UPDATE bookings SET room = ?, date = ?, start = ?, end = ?, title = ?, members = ?, guests = ? WHERE id = ?'
  ).run(f.room, f.date, f.start, f.end, f.title, f.members, f.guests, id);
  res.json({ ok: true });
});

app.delete('/api/bookings/:id', (req, res) => {
  if (!ownBooking(req, res)) return;
  db.prepare('DELETE FROM bookings WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
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
  if (AUTH_MODE === 'entra' && (!TENANT_ID || !CLIENT_ID)) {
    console.warn('⚠ AUTH_MODE=entra ですが TENANT_ID / CLIENT_ID が未設定です。Portal/.env に設定してください(docs/entra-setup.md §0)');
  }
});
