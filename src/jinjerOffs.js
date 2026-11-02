// jinjer(人事システム)の「休暇」と「勤務予定」から、今日の休みの人を求め、attendance_offs に保存する(2026-11-02・ユーザー依頼。出勤状況の画面に「休み」を出す)。
// API仕様: https://doc.api.jinjer.biz/index.html
//   - GET /v2/employees/requested-day-offs?month=YYYY-MM&page=N … 休暇(年次有休・振休など)。1ページ20人分。X-Item-Counts=総人数
//   - GET /v2/employees/work-schedules?month=YYYY-MM&page=N … 勤務予定。社員ごとに、勤務のある日の行だけが入る(休みの日の行は無い。休日の種類の項目も無い)
//   - GET /v1/employees?employee-ids=... … 社員番号→社用メールアドレス・氏名(jinjerAttendance の resolveEmployees を共用)
// 判定(今日・日本時間。休暇を優先する):
//   ① 今日の休暇がある(承認済み・申請中。否認は除く) → 全日=「休み」、午前半休=「午前休」、午後半休=「午後休」、時間休=そのまま
//   ② 休暇が無く、今月の勤務予定が1行以上あるのに、今日の行が無い → 「休み」(所定休日・法定休日・祝日)。月の勤務予定が1行も無い人は、未作成の可能性があるため出さない
// 画面側(attendance.js)が、出勤の打刻がある人の「休み」を外す・部門に入らない人の「休日」を外す(出勤状況のデータと合わせて判定するため)。
// 休暇の理由・休暇名(年次有休など)は保存も表示もしない(ユーザー指示。氏名のみ)。取り込みは jinjerAttendance と同様、失敗しても例外を投げない(→ E001)。
'use strict';

const { jstNow, isConfigured, authedFetch } = require('./jinjerClient');
const { spanLabel, statusOf } = require('./jinjerDayOffs');
const { resolveEmployees, MONTH_WAIT_CODE, MONTH_WAIT_MESSAGE } = require('./jinjerAttendance');

const MAX_PAGES = 100;               // 暴走防止(20人×100=2,000人)
const DEADLINE_MS = 3 * 60 * 1000;   // 1回の取り込み全体の上限時間
const AUTO_INTERVAL_MS = 30 * 60 * 1000; // 自動取り込みの間隔(1回で約12回のAPI呼び出し。毎時1,500回の上限に対して十分余裕がある)
const AUTO_START_HOUR_JST = 5;       // この時刻より前は自動取り込みしない(出勤状況と同じ)
let running = false;

/** 休暇の期間(spanLabel)を、画面に出す文字にする。全日=「休み」、半休は午前休・午後休 */
function offLabelOf(span) {
  if (span === '午前半休') return '午前休';
  if (span === '午後半休') return '午後休';
  if (span === '半休') return '半休';
  if (String(span || '').startsWith('時間休')) return span;
  return '休み'; // 全日・その他
}

/** 指定月を全ページ取得する(20人ずつ)。取り切れなければ例外(部分取得を成功扱いにしない) */
async function fetchAllPages(path, month, deadline, signal) {
  const all = [];
  let total = Infinity;
  for (let page = 1; all.length < total; page++) {
    if (page > MAX_PAGES) throw new Error('jinjerの取得ページ数が上限を超えました');
    if (Date.now() > deadline) throw new Error('jinjerの取り込みが制限時間を超えました');
    const res = await authedFetch(`${path}?month=${month}&page=${page}`, { signal });
    const header = res.headers.get('X-Item-Counts');
    const count = header == null || header === '' ? NaN : Number(header);
    if (!Number.isFinite(count)) throw new Error('jinjerの応答に総数(X-Item-Counts)がありません');
    total = count;
    const body = await res.json();
    const list = Array.isArray(body.data) ? body.data : [];
    if (!list.length) break;
    all.push(...list);
  }
  if (all.length < total) throw new Error(`jinjerのデータを全件取得できませんでした(${all.length}/${total}人)`);
  return all;
}

/** 今日の休みの一覧を求める(純粋な関数。テスト用に切り出し)。
    leaveData: requested-day-offs の data、scheduleData: work-schedules の data、targetDate: 'YYYY-MM-DD'。
    戻り値: [{ employee_id, kind: 'leave'|'holiday', label, status: 'approved'|'pending' }] */
function computeOffs(leaveData, scheduleData, targetDate) {
  const out = new Map(); // employee_id → row(休暇を優先)
  for (const emp of leaveData || []) {
    const id = String(emp.employee_id);
    const list = [];
    for (const off of emp.requested_day_offs || []) {
      if (!off || off.date !== targetDate) continue;
      const status = statusOf(off.status);
      if (!status) continue; // 否認は出さない
      list.push({ label: offLabelOf(spanLabel(off.duration_classification)), status });
    }
    if (!list.length) continue;
    // 同じ日に複数あるときの決め方: ①全日(「休み」)があれば「休み」(承認済みの全日があれば承認済み、なければ申請中)
    // ②午前休と午後休が両方あれば、実質1日休みなので「休み」(両方とも承認済みなら承認済み、どちらかが申請中なら申請中)
    // ③それ以外は、承認済みを優先して、先頭の1件
    const full = list.filter(r => r.label === '休み');
    const am = list.filter(r => r.label === '午前休'), pm = list.filter(r => r.label === '午後休');
    let pick;
    if (full.length) pick = { label: '休み', status: full.some(r => r.status === 'approved') ? 'approved' : 'pending' };
    else if (am.length && pm.length) pick = { label: '休み', status: am.some(r => r.status === 'approved') && pm.some(r => r.status === 'approved') ? 'approved' : 'pending' };
    else pick = list.find(r => r.status === 'approved') || list[0];
    out.set(id, { employee_id: id, kind: 'leave', label: pick.label, status: pick.status });
  }
  for (const emp of scheduleData || []) {
    const id = String(emp.employee_id);
    if (out.has(id)) continue;
    const list = Array.isArray(emp.work_schedules) ? emp.work_schedules : [];
    if (!list.length) continue; // 今月の勤務予定が1行も無い人は、未作成の可能性があるため出さない
    if (list.some(w => w && w.date === targetDate)) continue; // 今日の勤務予定がある=出勤予定
    out.set(id, { employee_id: id, kind: 'holiday', label: '休み', status: 'approved' });
  }
  return [...out.values()];
}

/** 取り込み1回分。成功/失敗は attendance_offs_sync に記録する。失敗しても例外は投げず結果を返す(→ E001) */
async function sync(db) {
  if (!isConfigured()) return { ok: false, message: 'jinjerのAPIキーが未設定です(サーバーの JINJER_API_KEY / JINJER_SECRET_KEY)' };
  if (running) return { ok: false, message: '取り込み中です。しばらくしてからもう一度お試しください' };
  running = true;
  const targetDate = jstNow().date;
  const month = targetDate.slice(0, 7);
  let result;
  try {
    const signal = AbortSignal.timeout(DEADLINE_MS);
    const deadline = Date.now() + DEADLINE_MS;
    const leaveData = await fetchAllPages('/v2/employees/requested-day-offs', month, deadline, signal);
    const scheduleData = await fetchAllPages('/v2/employees/work-schedules', month, deadline, signal);
    const rows = computeOffs(leaveData, scheduleData, targetDate);
    // 氏名・メールが解決できないと、メールなしの行(休日は画面で出なくなる・休暇は氏名不明になる)で前回の良いデータを置き換えてしまうため、失敗として扱う(前回の休みを残す)
    let emps = new Map();
    if (rows.length) {
      try { emps = await resolveEmployees(rows.map(r => r.employee_id), signal); }
      catch (e) { console.error('jinjer社員情報(氏名・メール)の取得に失敗しました:', e.message || e); throw new Error('jinjerの社員情報(氏名・メール)を取得できませんでした'); }
    }
    const syncedAt = new Date().toISOString();
    const ins = db.prepare(
      'INSERT INTO attendance_offs (date, employee_id, email, name, kind, label, status, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM attendance_offs').run(); // 履歴は持たない(今日の分だけに入れ替える)
      for (const r of rows) {
        const e = emps.get(r.employee_id) || {};
        ins.run(targetDate, r.employee_id, e.email || '', e.name || '', r.kind, r.label, r.status, syncedAt);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    result = { ok: true, message: '', count: rows.length };
  } catch (e) {
    if (e && e.status === 400 && e.code === MONTH_WAIT_CODE) {
      console.warn('jinjer: 月の切り替え待ちのため、休みの取り込みを見送りました(日本時間の9時以降に取得できます)');
      result = { ok: false, message: MONTH_WAIT_MESSAGE };
    } else {
      console.error('jinjer休みの取り込みに失敗しました:', e.message || e);
      result = { ok: false, message: e.name === 'TimeoutError' ? 'jinjerへの接続がタイムアウトしました' : (e.message || '取り込みに失敗しました') };
    }
  } finally {
    running = false;
  }
  try {
    db.prepare(`
      INSERT INTO attendance_offs_sync (id, target_date, ok, message, run_at, ok_date) VALUES (1, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET target_date = excluded.target_date, ok = excluded.ok, message = excluded.message,
        run_at = excluded.run_at, ok_date = CASE WHEN excluded.ok = 1 THEN excluded.target_date ELSE attendance_offs_sync.ok_date END
    `).run(targetDate, result.ok ? 1 : 0, result.message, new Date().toISOString(), result.ok ? targetDate : '');
  } catch (e) {
    console.error('jinjer休みの取り込み結果の記録に失敗しました:', e.message || e);
  }
  return result;
}

/** 30分ごとに確認し、5:00(日本時間)以降に取り込む。起動直後にも1回行う(再起動後も反映される)。失敗しても次の確認で再試行する */
function startScheduler(db) {
  if (!isConfigured()) return;
  const tick = async () => {
    try {
      const { hour } = jstNow();
      if (hour < AUTO_START_HOUR_JST) return;
      await sync(db);
    } catch (e) {
      console.error('jinjer休みの自動取り込みの確認で例外:', e.message || e);
    }
  };
  setTimeout(tick, 12000); // 出勤状況の最初の取り込み(5秒後)と重ならないよう、少しずらす
  setInterval(tick, AUTO_INTERVAL_MS).unref();
}

/** 画面用: 今日(日本時間)の休みの一覧+取り込み状況。メールアドレスはMS365との紐づけ用(出勤状況と同じ。全社員向け画面) */
function getToday(db) {
  const { date } = jstNow();
  const offs = db.prepare(
    'SELECT email, name, kind, label, status FROM attendance_offs WHERE date = ? ORDER BY name' // 社員番号は画面で使わないため返さない
  ).all(date);
  const st = db.prepare('SELECT target_date, ok, message, run_at, ok_date FROM attendance_offs_sync WHERE id = 1').get() || null;
  return {
    offs,
    offsSync: st ? { ok: !!st.ok, waiting: !st.ok && st.message === MONTH_WAIT_MESSAGE, message: st.message, runAt: st.run_at, lastSuccessDate: st.ok_date } : null
  };
}

module.exports = { sync, startScheduler, getToday, computeOffs, offLabelOf };
