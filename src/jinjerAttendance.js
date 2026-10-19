// jinjer(人事システム)の打刻データから「本日出勤している人」を取り込み、attendance_today テーブルに保存する(2026-10-17)。
// API仕様: https://doc.api.jinjer.biz/index.html
//   - GET /v2/employees/attendances?month=YYYY-MM&page=N(1ページ20人分。X-Item-Counts=総人数。各人に月内の打刻が入る)
//   - GET /v1/employees?employee-ids=...(社員番号→社用メールアドレス・氏名。MS365とメールアドレスで紐づける)
// 判定: 本日の打刻(出勤1/直行2/退勤3/直帰4)のうち最後のものが 退勤・直帰 なら「退勤済み」、それ以外で出勤の打刻があれば「出勤中」。
//       退勤の打刻をしていない人は出勤中のまま表示する(ユーザー指示)。外出・休憩の打刻は出勤状態を変えない。欠勤は対象外。
// 毎日リセット(ユーザー指示): 表示は「本日(日本時間)の分」だけ。前日以前の行は取り込み・定期確認のたびに削除する(履歴は持たない)。
'use strict';

const { jstNow, isConfigured, authedFetch } = require('./jinjerClient');

const MAX_PAGES = 100;               // 暴走防止(20人×100=2,000人)
const DEADLINE_MS = 2 * 60 * 1000;   // 1回の取り込み全体の上限時間(超えたら通信ごと中断して失敗扱い。手動更新がゲートウェイのタイムアウトで切れないよう短めにする)
const NAME_BATCH = 100;              // employee-ids の上限(仕様: 100件まで)
const AUTO_INTERVAL_MS = 5 * 60 * 1000; // 自動取り込みの間隔
const AUTO_START_HOUR_JST = 5;       // この時刻より前は自動取り込みしない(前日分の削除だけ行う)
const EMP_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const empCache = new Map(); // employee_id → { email, name, at }
let running = false;

function hhmm(datetime) {
  const m = /(\d{2}):(\d{2})/.exec(datetime || '');
  return m ? `${m[1]}:${m[2]}` : '';
}

/** 1人ぶんの、対象日の打刻から状態を決める。出勤していなければ null */
function judge(records, targetDate) {
  const events = [];
  for (const r of records) {
    if (!r || r.date !== targetDate || r.is_absent === true) continue;
    const stamps = r.stamps || [];
    for (const s of stamps) {
      const id = String(s && s.stamp_type && s.stamp_type.id);
      if (['1', '2', '3', '4'].includes(id) && s.stamped_at) events.push({ id, at: s.stamped_at });
    }
    // 打刻明細が無い場合の保険(出勤時刻・退勤時刻のみ)
    if (!stamps.length) {
      if (r.attended_at) events.push({ id: '1', at: r.attended_at });
      if (r.left_at) events.push({ id: '3', at: r.left_at });
    }
  }
  if (!events.length) return null;
  events.sort((a, b) => a.at.localeCompare(b.at));
  const first = events.find(e => e.id === '1' || e.id === '2');
  if (!first) return null; // 退勤だけの記録(前日からの跨ぎ等)は出勤として扱わない
  const last = events[events.length - 1];
  const out = last.id === '3' || last.id === '4';
  return { attended: hhmm(first.at), left: out ? hhmm(last.at) : '' };
}

/** 指定月の打刻データを全ページ取得し、対象日に出勤している人だけを返す */
async function fetchAttendingOfDate(targetDate, signal) {
  const month = targetDate.slice(0, 7);
  const found = []; // { employee_id, attended, left }
  let total = Infinity;
  let seen = 0;
  for (let page = 1; seen < total; page++) {
    if (page > MAX_PAGES) throw new Error('jinjerの取得ページ数が上限を超えました');
    const res = await authedFetch(`/v2/employees/attendances?month=${month}&page=${page}`, { signal });
    const header = res.headers.get('X-Item-Counts');
    const count = header == null || header === '' ? NaN : Number(header);
    // 総数ヘッダーが無いと、途中終了・空ページを「全員が未出勤」と誤認して当日分を全削除しかねないため、失敗扱いにする
    if (!Number.isFinite(count)) throw new Error('jinjerの応答に総数(X-Item-Counts)がありません');
    total = count;
    const body = await res.json();
    const list = Array.isArray(body.data) ? body.data : [];
    if (!list.length) break;
    seen += list.length;
    for (const emp of list) {
      const j = judge(emp.attendances || [], targetDate);
      if (j) found.push({ employee_id: String(emp.employee_id), ...j });
    }
  }
  // 取り切れていなければ、部分取得を成功扱いにしない(前回のデータを残して失敗にする)
  if (seen < total) throw new Error(`jinjerのデータを全件取得できませんでした(${seen}/${total}人)`);
  return found;
}

/** 社員番号→社用メールアドレス・氏名。キャッシュにない人だけを引く(5分おきの取り込みでAPI呼び出しを増やさないため) */
async function resolveEmployees(ids, signal) {
  const now = Date.now();
  const need = [...new Set(ids)].filter(id => {
    const c = empCache.get(id);
    return !c || now - c.at > EMP_CACHE_TTL_MS;
  });
  for (let i = 0; i < need.length; i += NAME_BATCH) {
    const batch = need.slice(i, i + NAME_BATCH);
    const res = await authedFetch(`/v1/employees?employee-ids=${encodeURIComponent(batch.join(','))}`, { signal });
    const body = await res.json();
    const returned = new Set();
    for (const e of Array.isArray(body.data) ? body.data : []) {
      returned.add(String(e.id));
      const c = e.company || {};
      empCache.set(String(e.id), {
        email: String(c.email || '').trim().toLowerCase(),
        name: [c.last_name, c.first_name].filter(Boolean).join(' '),
        at: now
      });
    }
    // jinjerに見つからなかった社員番号は、空の結果を6時間キャッシュする(5分ごとに同じ問い合わせを繰り返さない)
    for (const id of batch) if (!returned.has(id)) empCache.set(id, { email: '', name: '', at: now });
  }
  return empCache;
}

/** 前日以前の行を削除する(毎日リセット)。日付が今日と異なる行だけを対象にする */
function purgeOld(db, today) {
  db.prepare('DELETE FROM attendance_today WHERE date <> ?').run(today);
}

/** 取り込み1回分。成功/失敗は attendance_sync に記録する。失敗しても例外は投げず結果を返す(→ E001) */
async function sync(db) {
  if (!isConfigured()) return { ok: false, message: 'jinjerのAPIキーが未設定です(サーバーの JINJER_API_KEY / JINJER_SECRET_KEY)' };
  if (running) return { ok: false, message: '取り込み中です。しばらくしてからもう一度お試しください' };
  running = true;
  const targetDate = jstNow().date;
  let result;
  try {
    const signal = AbortSignal.timeout(DEADLINE_MS);
    const found = await fetchAttendingOfDate(targetDate, signal);
    // 氏名・メールの解決に失敗しても、取得済みの出勤状況は保存する(氏名不明で表示。次回の取り込みで再解決される)
    let emps = empCache;
    if (found.length) {
      try { emps = await resolveEmployees(found.map(f => f.employee_id), signal); }
      catch (e) { console.error('jinjer社員情報(氏名・メール)の取得に失敗しました:', e.message || e); }
    }
    const syncedAt = new Date().toISOString();
    const ins = db.prepare(
      'INSERT INTO attendance_today (date, employee_id, email, name, attended, left_at, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM attendance_today WHERE date = ?').run(targetDate);
      purgeOld(db, targetDate);
      for (const f of found) {
        const e = emps.get(f.employee_id) || {};
        ins.run(targetDate, f.employee_id, e.email || '', e.name || '', f.attended, f.left, syncedAt);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    result = { ok: true, message: '', count: found.length };
  } catch (e) {
    console.error('jinjer出勤状況の取り込みに失敗しました:', e.message || e);
    result = { ok: false, message: e.name === 'TimeoutError' ? 'jinjerへの接続がタイムアウトしました' : (e.message || '取り込みに失敗しました') };
  } finally {
    running = false;
  }
  try {
    db.prepare(`
      INSERT INTO attendance_sync (id, target_date, ok, message, run_at, ok_date) VALUES (1, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET target_date = excluded.target_date, ok = excluded.ok, message = excluded.message,
        run_at = excluded.run_at, ok_date = CASE WHEN excluded.ok = 1 THEN excluded.target_date ELSE attendance_sync.ok_date END
    `).run(targetDate, result.ok ? 1 : 0, result.message, new Date().toISOString(), result.ok ? targetDate : '');
  } catch (e) {
    console.error('jinjer出勤状況の取り込み結果の記録に失敗しました:', e.message || e);
  }
  return result;
}

/** 5分ごとに確認し、5:00(日本時間)以降なら取り込む。日付が変わった直後(0:00〜)は取り込みはせず前日分だけ削除する。
    再起動(Renderの無料プランのスリープ復帰など)後も、起動直後に取り込まれる。失敗しても次の確認で再試行する */
function startScheduler(db) {
  if (!isConfigured()) {
    console.warn('⚠ JINJER_API_KEY / JINJER_SECRET_KEY が未設定のため、出勤状況の自動取り込みは行いません');
    return;
  }
  const tick = async () => {
    try {
      const { date, hour } = jstNow();
      purgeOld(db, date); // 毎日リセット
      if (hour < AUTO_START_HOUR_JST) return;
      await sync(db);
    } catch (e) {
      console.error('jinjer出勤状況の自動取り込みの確認で例外:', e.message || e);
    }
  };
  setTimeout(tick, 5000);
  setInterval(tick, AUTO_INTERVAL_MS).unref();
}

/** 画面用: 本日(日本時間)の出勤者一覧+取り込み状況。メールアドレスはMS365との紐づけ用(全社員向け画面。社用アドレスのみ) */
function getToday(db) {
  const { date } = jstNow();
  const items = db.prepare(
    'SELECT email, name, attended, left_at FROM attendance_today WHERE date = ? ORDER BY name' // 社員番号は画面で使わないため返さない
  ).all(date);
  const st = db.prepare('SELECT target_date, ok, message, run_at, ok_date FROM attendance_sync WHERE id = 1').get() || null;
  return {
    date,
    items,
    configured: isConfigured(),
    sync: st ? { ok: !!st.ok, message: st.message, runAt: st.run_at, lastSuccessDate: st.ok_date } : null
  };
}

module.exports = { sync, startScheduler, getToday, judge };
