// jinjer(人事システム)の休日休暇データを取り込み、day_offs テーブルに保存する(2026-10-07)。
// API仕様: https://doc.api.jinjer.biz/index.html
//   - GET /v2/token(ヘッダー X-API-KEY / X-SECRET-KEY)→ data.access_token(有効4時間)
//   - GET /v2/employees/requested-day-offs?month=YYYY-MM&page=N(1ページ20人分。X-Item-Counts=総人数)
//   - GET /v1/employees?employee-ids=...(氏名の解決。休日休暇データには社員番号しか含まれないため)
//   - 取得リクエスト上限: 1社につき毎分100回・毎時1,500回(200応答のみカウント)
// APIキー/シークレットはサーバーの環境変数 JINJER_API_KEY / JINJER_SECRET_KEY にだけ置く(コード・public/・GitHubに書かない)。
'use strict';

const BASE = process.env.JINJER_BASE_URL || 'https://api.jinjer.biz'; // JINJER_BASE_URL はテスト(模擬サーバー)用
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_PAGES = 100;          // 暴走防止(20人×100=2,000人。取得上限は毎分100回)
const DEADLINE_MS = 3 * 60 * 1000; // 1回の取り込み全体の上限時間
const NAME_BATCH = 100;         // employee-ids の上限(仕様: 100件まで)
const AUTO_RUN_HOUR_JST = 6;    // 朝6:00(日本時間)以降に1日1回
const RETRY_AFTER_FAIL_MS = 30 * 60 * 1000;
const MANUAL_MIN_INTERVAL_MS = 2 * 60 * 1000;
const MANUAL_MAX_PER_HOUR = 10;   // jinjerの取得上限(毎時1,500回)を他の連携のために残す
const manualRuns = [];

let running = false;
let lastStartMs = 0;

/** 日本時間の日付(YYYY-MM-DD)と時刻(時)。サーバー(Render=UTC)のタイムゾーンに依存しない */
function jstNow(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23'
  }).formatToParts(date).reduce((o, p) => { o[p.type] = p.value; return o; }, {});
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

function isConfigured() {
  return Boolean(process.env.JINJER_API_KEY && process.env.JINJER_SECRET_KEY);
}

async function jinjerFetch(path, { headers = {} } = {}) {
  const res = await fetch(BASE + path, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!res.ok) {
    // 応答本文にはキー等を含めない(ステータスのみ記録)
    const err = new Error(`jinjer APIエラー (HTTP ${res.status}) ${path.split('?')[0]}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

async function getToken() {
  const res = await jinjerFetch('/v2/token', {
    headers: { 'X-API-KEY': process.env.JINJER_API_KEY, 'X-SECRET-KEY': process.env.JINJER_SECRET_KEY }
  });
  const body = await res.json();
  const token = body && body.data && body.data.access_token;
  if (!token) throw new Error('jinjerのアクセストークンを取得できませんでした');
  return token;
}

/** 指定月の休日休暇データを全ページ取得し、対象日のものだけを返す */
async function fetchDayOffsOfDate(token, targetDate, deadline) {
  const month = targetDate.slice(0, 7);
  const headers = { Authorization: `Bearer ${token}` };
  const found = []; // {employee_id, off}
  let total = Infinity; // X-Item-Counts が取れない場合は空ページまで進む
  let seen = 0;
  for (let page = 1; seen < total; page++) {
    if (page > MAX_PAGES) throw new Error('jinjerの取得ページ数が上限を超えました');
    if (Date.now() > deadline) throw new Error('jinjerの取り込みが制限時間を超えました');
    const res = await jinjerFetch(`/v2/employees/requested-day-offs?month=${month}&page=${page}`, { headers });
    const header = res.headers.get('X-Item-Counts');
    const count = header == null || header === '' ? NaN : Number(header);
    if (Number.isFinite(count)) total = count;
    const body = await res.json();
    const list = Array.isArray(body.data) ? body.data : [];
    if (!list.length) break;
    seen += list.length;
    for (const emp of list) {
      for (const off of emp.requested_day_offs || []) {
        if (off && off.date === targetDate) found.push({ employee_id: String(emp.employee_id), off });
      }
    }
  }
  // 総数が分かっているのに取り切れていなければ、部分取得を成功扱いにしない(前回のデータを残して失敗にする)
  if (Number.isFinite(total) && seen < total) throw new Error(`jinjerのデータを全件取得できませんでした(${seen}/${total}人)`);
  return found;
}

/** 社員番号→氏名。休暇のある人だけを引く(API呼び出しを最小限にする) */
async function fetchNames(token, ids) {
  const names = new Map();
  const headers = { Authorization: `Bearer ${token}` };
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += NAME_BATCH) {
    const batch = unique.slice(i, i + NAME_BATCH);
    const res = await jinjerFetch(`/v1/employees?employee-ids=${encodeURIComponent(batch.join(','))}`, { headers });
    const body = await res.json();
    for (const e of Array.isArray(body.data) ? body.data : []) {
      const c = e.company || {};
      const name = [c.last_name, c.first_name].filter(Boolean).join(' ');
      if (e.id && name) names.set(String(e.id), name);
    }
  }
  return names;
}

function hhmm(datetime) {
  const m = /(\d{2}):(\d{2})/.exec(datetime || '');
  return m ? `${m[1]}:${m[2]}` : '';
}

/** 休日休暇種別(全日/半休/時間休)を表示用の文字列にする */
function spanLabel(dc) {
  const id = String((dc && dc.id) ?? '');
  const start = hhmm(dc && dc.start_time);
  const end = hhmm(dc && dc.end_time);
  if (id === '0') return '全日';
  if (id === '1') {
    if (start) return Number(start.slice(0, 2)) < 12 ? '午前半休' : '午後半休';
    return '半休';
  }
  if (id === '2') return start && end ? `時間休 ${start}-${end}` : '時間休';
  return (dc && dc.name) || '';
}

/** 申請ステータス 0:未対応(申請中) 1:承認 2:否認 → pending/approved。否認は null(表示しない) */
function statusOf(s) {
  const v = String(s ?? '');
  if (v === '1') return 'approved';
  if (v === '0') return 'pending';
  return null;
}

/** 取り込み1回分。成功/失敗は day_offs_sync に記録する。失敗しても例外は投げず結果を返す(→ E001) */
async function sync(db, { force = false } = {}) {
  const now = Date.now();
  if (!isConfigured()) return { ok: false, message: 'jinjerのAPIキーが未設定です(サーバーの JINJER_API_KEY / JINJER_SECRET_KEY)' };
  if (running) return { ok: false, message: '取り込み中です。しばらくしてからもう一度お試しください' };
  if (force) {
    if (now - lastStartMs < MANUAL_MIN_INTERVAL_MS) {
      return { ok: false, message: '直前に取り込んだばかりです。2分ほど待ってからお試しください' };
    }
    while (manualRuns.length && now - manualRuns[0] > 60 * 60 * 1000) manualRuns.shift();
    if (manualRuns.length >= MANUAL_MAX_PER_HOUR) {
      return { ok: false, message: '手動更新の回数が1時間の上限に達しました。しばらくしてからお試しください' };
    }
    manualRuns.push(now);
  }
  running = true;
  lastStartMs = now;
  const targetDate = jstNow().date;
  let result;
  try {
    const token = await getToken();
    const found = await fetchDayOffsOfDate(token, targetDate, now + DEADLINE_MS);
    const rows = found
      .map(f => ({ ...f, status: statusOf(f.off.status) }))
      .filter(f => f.status);
    const names = rows.length ? await fetchNames(token, rows.map(r => r.employee_id)) : new Map();

    const syncedAt = new Date().toISOString();
    const ins = db.prepare(
      'INSERT INTO day_offs (date, employee_id, name, kind, span, status, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM day_offs WHERE date = ?').run(targetDate);
      // 古い日付は残さない(キャッシュのため。履歴は持たない)
      db.prepare('DELETE FROM day_offs WHERE date < ?').run(targetDate);
      for (const r of rows) {
        const dc = r.off.day_off_classification || {};
        ins.run(
          targetDate, r.employee_id, names.get(r.employee_id) || r.employee_id,
          dc.name || '休暇', spanLabel(r.off.duration_classification), r.status, syncedAt
        );
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    result = { ok: true, message: '', count: rows.length };
  } catch (e) {
    console.error('jinjer取り込みに失敗しました:', e.message || e);
    result = { ok: false, message: e.name === 'TimeoutError' ? 'jinjerへの接続がタイムアウトしました' : (e.message || '取り込みに失敗しました') };
  } finally {
    running = false;
  }
  try {
    db.prepare(`
    INSERT INTO day_offs_sync (id, target_date, ok, message, run_at, ok_date) VALUES (1, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET target_date = excluded.target_date, ok = excluded.ok, message = excluded.message,
      run_at = excluded.run_at, ok_date = CASE WHEN excluded.ok = 1 THEN excluded.target_date ELSE day_offs_sync.ok_date END
  `).run(targetDate, result.ok ? 1 : 0, result.message, new Date().toISOString(), result.ok ? targetDate : '');
  } catch (e) {
    console.error('jinjer取り込み結果の記録に失敗しました:', e.message || e);
  }
  return result;
}

/** 朝6:00(日本時間)以降、その日まだ成功していなければ取り込む。1分ごとに確認するので、
    再起動(Renderの無料プランのスリープ復帰など)で朝を逃しても、起動後に取り込まれる。失敗時は30分後に再試行 */
function startScheduler(db) {
  if (!isConfigured()) {
    console.warn('⚠ JINJER_API_KEY / JINJER_SECRET_KEY が未設定のため、休日休暇の自動取り込みは行いません');
    return;
  }
  const tick = async () => {
    try {
      const { date, hour } = jstNow();
      if (hour < AUTO_RUN_HOUR_JST) return;
      const st = db.prepare('SELECT ok_date, run_at FROM day_offs_sync WHERE id = 1').get();
      if (st && st.ok_date === date) return;
      if (st && st.run_at && Date.now() - Date.parse(st.run_at) < RETRY_AFTER_FAIL_MS) return;
      await sync(db);
    } catch (e) {
      console.error('jinjer自動取り込みの確認で例外:', e.message || e);
    }
  };
  setTimeout(tick, 5000);
  setInterval(tick, 60 * 1000).unref();
}

/** 画面用: 本日(日本時間)の休暇一覧+取り込み状況。
    表示は氏名と申請中/承認のみ(ユーザー指示 2026-10-07)。休暇名・全日/半休は保存しているがAPIでは返さない(再表示したくなったら、ここのSELECTと画面側を戻す) */
function getToday(db) {
  const { date } = jstNow();
  const items = db.prepare(
    `SELECT name, status FROM day_offs WHERE date = ?
     ORDER BY CASE status WHEN 'approved' THEN 0 ELSE 1 END, name`
  ).all(date);
  const st = db.prepare('SELECT target_date, ok, message, run_at, ok_date FROM day_offs_sync WHERE id = 1').get() || null;
  return {
    date,
    items,
    configured: isConfigured(),
    sync: st ? { ok: !!st.ok, message: st.message, runAt: st.run_at, lastSuccessDate: st.ok_date } : null
  };
}

module.exports = { sync, startScheduler, getToday, isConfigured, jstNow, spanLabel, statusOf };
