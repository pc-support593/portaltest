// 予定の「複数の日程」(連続した日・繰り返し)の計算(2026-11-17・ユーザー指示)。画面に依存しない純粋な関数だけを置く(tests/unit.js で確認)
// 日付は 'YYYY-MM-DD'(日本時間のカレンダー上の日付)、日時は 'YYYY-MM-DDTHH:MM'(同じ形なので文字列のまま大小比較できる)

const MAX_MONTHS = 2; // 複数日程の最長(開始日から2か月後の同じ日まで。ユーザー指示)
const GRAPH_DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function recParse(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(y, m - 1, d);
}
function recIso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function addDaysISO(iso, n) {
  const d = recParse(iso);
  d.setDate(d.getDate() + n);
  return recIso(d);
}
/** n か月後の同じ日(その月に無い日は、その月の末日。例: 12/31の2か月後=2/28) */
function addMonthsISO(iso, n) {
  const d = recParse(iso);
  const day = d.getDate();
  const t = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const last = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
  t.setDate(Math.min(day, last));
  return recIso(t);
}
function dowOfISO(iso) { return recParse(iso).getDay(); }
/** その日が、月の何回目のその曜日か(1〜5) */
function nthOfMonth(iso) { return Math.ceil(recParse(iso).getDate() / 7); }

/** 複数日程の入力から、実際に予定が入る日の一覧を作る。
    spec = { start, kind: 'daily'|'weekly'|'monthly', weekdays: [0-6](weekly), weekdaysOnly(daily: 土日を除く), monthly: 'day'|'nth',
             endMode: 'date'|'count', endDate, count }
    戻り値: { dates: ['YYYY-MM-DD', ...], limit: 'YYYY-MM-DD', error: '' }。error が空でなければ作れない(dates は空) */
function expandOccurrences(spec) {
  const fail = error => ({ dates: [], limit: '', error });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(spec.start || '')) return fail('開始日を入力してください');
  const limit = addMonthsISO(spec.start, MAX_MONTHS);
  const startDow = dowOfISO(spec.start);
  const startDom = recParse(spec.start).getDate();
  if (spec.kind === 'weekly' && !(spec.weekdays || []).length) return fail('曜日を1つ以上選んでください');
  if (spec.kind === 'monthly') {
    if (spec.monthly === 'nth' && nthOfMonth(spec.start) === 5) return fail('第5の曜日は選べません。「毎月◯日」にするか、開始日を変えてください');
    if (spec.monthly !== 'nth' && startDom > 28) return fail('29〜31日の「毎月◯日」は選べません。「第◯◯曜日」にするか、開始日を変えてください');
  }
  let until = limit;
  if (spec.endMode === 'count') {
    if (!(Number(spec.count) >= 1)) return fail('回数を1以上で入力してください');
  } else {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(spec.endDate || '')) return fail('終了日を入力してください');
    if (spec.endDate < spec.start) return fail('終了日は開始日以降にしてください');
    if (spec.endDate > limit) return fail(`終了日は開始日から${MAX_MONTHS}か月以内(${limit}まで)にしてください`);
    until = spec.endDate;
  }
  const matches = iso => {
    const dow = dowOfISO(iso);
    if (spec.kind === 'daily') return spec.weekdaysOnly ? dow >= 1 && dow <= 5 : true;
    if (spec.kind === 'weekly') return spec.weekdays.includes(dow);
    if (spec.monthly === 'nth') return dow === startDow && nthOfMonth(iso) === nthOfMonth(spec.start);
    return recParse(iso).getDate() === startDom;
  };
  const dates = [];
  const want = spec.endMode === 'count' ? Math.floor(Number(spec.count)) : Infinity;
  for (let d = spec.start; d <= until && dates.length < want; d = addDaysISO(d, 1)) if (matches(d)) dates.push(d);
  if (!dates.length) return fail('条件に合う日がありません');
  if (spec.endMode === 'count' && dates.length < want) return fail(`指定の回数(${want}回)は、${MAX_MONTHS}か月以内(${limit}まで)に収まりません(${dates.length}回まで)`);
  return { dates, limit, error: '' };
}

/** Graph の予定に付ける繰り返し(recurrence)。dates は expandOccurrences の結果(最初の日=予定の開始日、最後の日=繰り返しの終わり) */
function buildRecurrence(spec, dates) {
  let pattern;
  if (spec.kind === 'daily' && !spec.weekdaysOnly) pattern = { type: 'daily', interval: 1 };
  else if (spec.kind === 'daily') pattern = { type: 'weekly', interval: 1, daysOfWeek: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'], firstDayOfWeek: 'sunday' };
  else if (spec.kind === 'weekly') pattern = { type: 'weekly', interval: 1, daysOfWeek: [...spec.weekdays].sort((a, b) => a - b).map(i => GRAPH_DAYS[i]), firstDayOfWeek: 'sunday' };
  else if (spec.monthly === 'nth') pattern = { type: 'relativeMonthly', interval: 1, daysOfWeek: [GRAPH_DAYS[dowOfISO(spec.start)]], index: ['first', 'second', 'third', 'fourth'][nthOfMonth(spec.start) - 1] };
  else pattern = { type: 'absoluteMonthly', interval: 1, dayOfMonth: recParse(spec.start).getDate() };
  return { pattern, range: { type: 'endDate', startDate: dates[0], endDate: dates[dates.length - 1], recurrenceTimeZone: 'Tokyo Standard Time' } };
}

/** 予定の各回(intervals: [{ date, start, end }] = 'YYYY-MM-DDTHH:MM')のうち、会議室・社用車の既存の予約(busy: [{ start, end }])と重なる回を返す */
function findRangeConflicts(intervals, busy) {
  return intervals.filter(iv => (busy || []).some(b => b.start < iv.end && b.end > iv.start));
}
