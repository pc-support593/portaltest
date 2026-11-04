// 月間の休み表(2026-11-04・ユーザー依頼)。jinjerの「勤務予定」と「休暇」から、指定した月の、出勤以外(休日・休暇・半休・時間休)を、社員×日で返す。
// 判定の中身は jinjerOffs.computeOffs(今日の休みと同じ規則)を、月の各日に当てはめる。休暇を優先し、勤務予定の行が無い日は休日。
//   ・月の勤務予定が1行も無い人は、休日を出さない(未作成の可能性)。休暇だけは出す
//   ・振休は furi: true(画面で文字色を変える)。他の休暇名(年次有休など)は返さない
// API呼び出しは1回あたり約12回(勤務予定・休暇の全ページ+社員情報)。毎時1,500回の上限を守るため、月ごとにサーバーのメモリにキャッシュする
// (現在の月=30分、過去の月=6時間。同じ月の取得が重なったときは1回にまとめる。失敗後は1分間、同じ月を再取得しない)。保存はしない(履歴を持たない)。
// jinjerは「今月」をUTCで判定するため、毎月1日の日本時間9時前は取得できない(400 E400QP0017)。来月分は取得できない。
'use strict';

const { jstNow, isConfigured } = require('./jinjerClient');
const { computeOffs, fetchAllPages } = require('./jinjerOffs');
const { resolveEmployees, MONTH_WAIT_CODE, MONTH_WAIT_MESSAGE } = require('./jinjerAttendance');

const DEADLINE_MS = 3 * 60 * 1000;
const TTL_CURRENT_MS = 30 * 60 * 1000;
const TTL_PAST_MS = 6 * 60 * 60 * 1000;
const RETRY_AFTER_FAIL_MS = 60 * 1000;
const MAX_PAST_MONTHS = 3;   // 現在の月からさかのぼれる月数(jinjerの取得上限を守るため)
const cache = new Map();     // month → { data, at } 成功した結果
const failed = new Map();    // month → { message, at }
const inflight = new Map();  // month → Promise

/** 'YYYY-MM' の月の日数 */
function daysInMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** 月の前後 n か月(月の文字列)。n は負でもよい */
function shiftMonth(month, n) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** 休みの1件を、画面に出す1マスにする。全日=休暇、半休=午前休/午後休、時間休=時間休、休日=休日。振休は furi: true */
function cellOf(r) {
  if (r.kind === 'holiday') return { t: 'holiday', label: '休日' };
  const label = r.label === '休み' ? (r.furikyu ? '振休' : '休暇') : String(r.label).startsWith('時間休') ? '時間休' : r.label;
  return { t: 'leave', label, pending: r.status === 'pending', furi: !!r.furikyu };
}

/** 月の、社員×日の休みを求める(純粋な関数。テスト用に切り出し)。
    戻り値: Map(employee_id → { 'YYYY-MM-DD': cell })。休みの無い人は入らない */
function computeMonth(leaveData, scheduleData, month) {
  const byEmp = new Map();
  for (let d = 1; d <= daysInMonth(month); d++) {
    const date = `${month}-${String(d).padStart(2, '0')}`;
    for (const r of computeOffs(leaveData, scheduleData, date)) {
      if (!byEmp.has(r.employee_id)) byEmp.set(r.employee_id, {});
      byEmp.get(r.employee_id)[date] = cellOf(r);
    }
  }
  return byEmp;
}

/** 勤務予定のある・休暇のある社員の一覧(休みの無い人も、表に出すために)。employee_id の配列 */
function listEmployeeIds(leaveData, scheduleData) {
  const ids = new Set();
  for (const e of scheduleData || []) if (Array.isArray(e.work_schedules) && e.work_schedules.length) ids.add(String(e.employee_id));
  for (const e of leaveData || []) if ((e.requested_day_offs || []).length) ids.add(String(e.employee_id));
  return [...ids];
}

async function build(month) {
  const signal = AbortSignal.timeout(DEADLINE_MS);
  const deadline = Date.now() + DEADLINE_MS;
  const leaveData = await fetchAllPages('/v2/employees/requested-day-offs', month, deadline, signal);
  const scheduleData = await fetchAllPages('/v2/employees/work-schedules', month, deadline, signal);
  const cells = computeMonth(leaveData, scheduleData, month);
  const ids = listEmployeeIds(leaveData, scheduleData);
  let emps;
  try { emps = await resolveEmployees(ids, signal); }
  catch (e) { console.error('jinjer社員情報(氏名・メール)の取得に失敗しました:', e.message || e); throw new Error('jinjerの社員情報(氏名・メール)を取得できませんでした'); }
  const people = [];
  for (const id of ids) {
    const e = emps.get(id) || {};
    if (!e.name && !e.email) continue; // jinjerに見つからない人(削除済みなど)は出さない
    people.push({ email: e.email || '', name: e.name || '', cells: cells.get(id) || {} }); // 社員番号は画面で使わないため返さない
  }
  people.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  return { month, days: daysInMonth(month), people, fetchedAt: new Date().toISOString() };
}

/** 指定月の休み表。戻り値: { ok: true, data, stale? } か { ok: false, status, message }。例外は投げない(→ E001) */
async function getMonth(month, { force = false } = {}) {
  if (!isConfigured()) return { ok: false, status: 404, message: 'jinjerのAPIキーが未設定です' };
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month || ''))) return { ok: false, status: 400, message: '月の指定(YYYY-MM)が正しくありません' };
  const current = jstNow().date.slice(0, 7);
  if (month > current) return { ok: false, status: 400, message: 'jinjerの仕様で、来月以降の勤務予定は取得できません(毎月1日の9時以降に、その月が取得できます)' };
  if (month < shiftMonth(current, -MAX_PAST_MONTHS)) return { ok: false, status: 400, message: `表示できるのは、${MAX_PAST_MONTHS}か月前までです` };
  const ttl = month === current ? TTL_CURRENT_MS : TTL_PAST_MS;
  const hit = cache.get(month);
  if (!force && hit && Date.now() - hit.at < ttl) return { ok: true, data: hit.data };
  const fail = failed.get(month);
  if (fail && Date.now() - fail.at < RETRY_AFTER_FAIL_MS) return hit ? { ok: true, data: hit.data, stale: fail.message } : { ok: false, status: 503, message: fail.message };
  if (!inflight.has(month)) {
    inflight.set(month, build(month).then(
      data => { cache.set(month, { data, at: Date.now() }); failed.delete(month); return null; },
      e => {
        const message = e && e.status === 400 && e.code === MONTH_WAIT_CODE ? MONTH_WAIT_MESSAGE
          : e && e.name === 'TimeoutError' ? 'jinjerへの接続がタイムアウトしました' : ((e && e.message) || '取り込みに失敗しました');
        if (!(e && e.code === MONTH_WAIT_CODE)) console.error('jinjer月間の休み表の取得に失敗しました:', (e && e.message) || e);
        failed.set(month, { message, at: Date.now() });
        return message;
      }
    ).finally(() => inflight.delete(month)));
  }
  const err = await inflight.get(month);
  const now = cache.get(month);
  if (!err && now) return { ok: true, data: now.data };
  return now ? { ok: true, data: now.data, stale: err } : { ok: false, status: 503, message: err || '取得できませんでした' };
}

/** 現在の月を先に取得しておく(初回の取得は1分以上かかるため、開いた人を待たせない)。起動の40秒後と、その後25分ごと。失敗しても次回に再試行 */
function startWarmer() {
  if (!isConfigured()) return;
  const tick = () => getMonth(jstNow().date.slice(0, 7), { force: true }).catch(e => console.error('jinjer月間の休み表の事前取得で例外:', e.message || e));
  setTimeout(tick, 40000);
  setInterval(tick, 25 * 60 * 1000).unref();
}

/** テスト用: キャッシュを空にする */
function resetCache() { cache.clear(); failed.clear(); inflight.clear(); }

module.exports = { startWarmer, getMonth, computeMonth, cellOf, daysInMonth, shiftMonth, resetCache };
