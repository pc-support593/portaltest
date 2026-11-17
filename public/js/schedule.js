// スケジュール画面
// 個人のスケジュールは実データ(Graph /me/calendarView・/me/events)。
// 拠点別 会議室のスケジュールも実データ(Graph /me/calendar/getSchedule)。
// 会議室は実際のExchange会議室リソース(Room Mailbox)。予定作成時に「会議室を使用する」を
// チェックすると、その会議室を出席者(type: resource)として追加し、Exchange側が
// 空いていれば自動承諾・埋まっていれば自動辞退する(サンプルではなく実際の予約)。
'use strict';

const pad = n => String(n).padStart(2, '0');
// 予定の取得で、日本時間・本文は文字形式で受け取る。本文はHTMLが標準のため、指定しないと、本文(内容)が編集画面に出ない(2026-10-26・ユーザー報告)
const GRAPH_PREFER_TEXT_BODY = 'outlook.timezone="Tokyo Standard Time", outlook.body-content-type="text"';
const WDAYS = ['日', '月', '火', '水', '木', '金', '土'];

// isoDate は roomsData.js で定義(共有)

/** 'YYYY-MM-DD' → ローカル日付のDate(タイムゾーンずれを避けるため new Date(iso) は使わない) */
function parseISODate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function dateLabel(d) {
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日(${WDAYS[d.getDay()]})`;
}

// ---- 会議室マスタは js/roomsData.js で定義(rooms.html と共有。SITES/ROOMS/siteRooms/roomById) ----

// 拠点/区分け/部門の削除担当者(予約の削除権限を持つ担当者)。メールアドレスをID(拠点/区分け/部門ID)に
// 対応付ける。担当者が変わったら、この対応表を直接編集する(大文字小文字は区別しない)。
// 実際に削除できるようにするには、あわせて Exchange 側でその担当者に各会議室・社用車カレンダーの
// 編集権限(Add-MailboxFolderPermission -Identity "<会議室/社用車>:\Calendar" -User <担当者> -AccessRights Editor)
// を付与し、Entra ID のアプリに Calendars.ReadWrite.Shared 権限を追加(管理者の同意)する必要がある。
// 2026-08-22: 5拠点共通の担当者3名を設定(ユーザー指示)
const COMMON_SITE_REPS = ['k-iwatani@yumesumika.com', 'm-sakahara@yumesumika.com', 'y-nishida@yumesumika.com'];
// 2026-08-22: 3カテゴリ(ゆめすみか展示場・吉村一建設会議室・社用車)すべてで削除権限を持つ管理者(ユーザー指示)
const ADMIN_ALL_EMAIL = 'y-honda@yoshimuraichi.com';

const SITE_REPS = {
  hirano: [...COMMON_SITE_REPS, ADMIN_ALL_EMAIL],
  hanahaku: [...COMMON_SITE_REPS, ADMIN_ALL_EMAIL],
  nishinomiya: [...COMMON_SITE_REPS, ADMIN_ALL_EMAIL],
  nakamozu: [...COMMON_SITE_REPS, ADMIN_ALL_EMAIL],
  fukuda: [...COMMON_SITE_REPS, ADMIN_ALL_EMAIL],
  izumisano: [...COMMON_SITE_REPS, ADMIN_ALL_EMAIL]
};
// 吉村一建設会議室の区分け別担当者(現在はADMIN_ALL_EMAILのみ。個別担当者を追加する場合はここに追記)
const YOSHIMURA_REPS = {
  annex: [ADMIN_ALL_EMAIL], guest: [ADMIN_ALL_EMAIL], honsha: [ADMIN_ALL_EMAIL],
  ceo: [ADMIN_ALL_EMAIL], chairman: [ADMIN_ALL_EMAIL]
};
// 社用車の部門別担当者(現在はADMIN_ALL_EMAILのみ)
const CAR_REPS = {
  c_soumu: [ADMIN_ALL_EMAIL], c_kenchiku: [ADMIN_ALL_EMAIL], c_sekkei: [ADMIN_ALL_EMAIL],
  c_nishinomiya: [ADMIN_ALL_EMAIL], c_chihaya: [ADMIN_ALL_EMAIL], c_hirano: [ADMIN_ALL_EMAIL]
};

/** repsMap(ID→担当者メール配列)のうち、現在サインイン中のユーザーが担当を持つIDの配列を返す(共通処理) */
function myAdminIdsFrom(repsMap) {
  const email = ((Auth.me && Auth.me.email) || '').toLowerCase();
  if (!email) return [];
  return Object.keys(repsMap).filter(id => (repsMap[id] || []).some(e => e.toLowerCase() === email));
}
function myAdminSiteIds() { return myAdminIdsFrom(SITE_REPS); }
function myAdminYoshimuraIds() { return myAdminIdsFrom(YOSHIMURA_REPS); }
function myAdminCarIds() { return myAdminIdsFrom(CAR_REPS); }

const state = {
  date: new Date(),
  roomBusy: null, // { [roomId]: [{start, end, subject}] } 選択中の日の会議室の空き状況(実データ)
  personalEvents: [], // 直近に取得した個人の予定(編集フォームを開く際に参照)
  weekBase: null, // 週の予定で「‹ ›」で動かした週の基準日(null=選択中の日を含む週)。日付を切り替える・予定を保存するとnullに戻る
  view: 'week', // 表示: 'week'(日・週。会議室も含む今までの画面) | 'month'(自分の予定の月カレンダー。2026-11-17)
  monthBase: null, // 月の表示で見ている月の1日(null=選択中の日の月)
  monthEvents: [], // 直近に取得した、月のカレンダー(日曜始まりの6週以内)の自分の予定
  weekEvents: [], // 直近に取得した、選択中の日を含む週(日曜始まり)の自分の予定(週の予定の表示・編集フォームを開く際に参照)
  adminSiteIds: [], // サインイン中のユーザーが削除権限を持つ拠点(Auth.init後に確定)
  adminYoshimuraIds: [], // 同上・吉村一建設会議室の区分け
  adminCarIds: [], // 同上・社用車の部門
  gridTab: 'sites', // 予約状況の表示切り替え: 'sites'(ゆめすみか展示場) | 'cars'(社用車) | 'yoshimura'(吉村一建設会議室)
  yoshimuraBusy: null, // 吉村一建設会議室の空き状況(yoshimuraタブ表示時に取得)
  carsBusy: null // 社用車の空き状況(carsタブ表示時に取得)
};

// 予約状況の表示切り替えタブ。社用車・吉村一建設会議室はExchange側のリソース登録後に実装する(現在は準備中表示)。
// 見出しは「(選択中タブのlabel)の予約状況」に切り替わる
const GRID_TABS = [ // 表示順(ユーザー指示 2026-10-10): 吉村一建設 / ゆめすみか展示場 / 社用車
  { id: 'yoshimura', label: '吉村一建設会議室' },
  { id: 'sites', label: 'ゆめすみか展示場' },
  { id: 'cars', label: '社用車' }
];

// ---- 個人のスケジュール(実データ) ----

const PERSONAL_COLOR_CYCLE = [
  { color: '#2e6fc0', bg: '#f2f6fb', timeColor: '#2e6fc0' },
  { color: '#2e7d52', bg: '#f0f8f3', timeColor: '#2e7d52' },
  { color: '#d97b3f', bg: '#fdf5ee', timeColor: '#c96a2e' }
];

// devモード用のダミー(実際のGraph連携までの仮表示)
const DUMMY_PERSONAL_EVENTS = [
  { time: '10:00–11:00', title: '営業企画 定例ミーティング', place: 'オンライン', ...PERSONAL_COLOR_CYCLE[0] },
  { time: '13:30–14:00', title: '上期施策レビュー 事前打合せ', place: 'オンライン', ...PERSONAL_COLOR_CYCLE[1] },
  { time: '16:00–17:00', title: '部門横断プロジェクト キックオフ', place: '大会議室', ...PERSONAL_COLOR_CYCLE[2] }
];

async function fetchPersonalEvents(date) {
  if (Auth.mode !== 'entra') return DUMMY_PERSONAL_EVENTS;

  const dateStr = isoDate(date);
  const token = await Auth.getGraphToken(['Calendars.ReadWrite']);
  const url = 'https://graph.microsoft.com/v1.0/me/calendarView' +
    `?startDateTime=${encodeURIComponent(dateStr + 'T00:00:00+09:00')}` +
    `&endDateTime=${encodeURIComponent(dateStr + 'T23:59:59+09:00')}` +
    '&$select=id,subject,start,end,location,isAllDay,isOrganizer,attendees,body,categories,type,seriesMasterId&$orderby=start/dateTime';

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Prefer: GRAPH_PREFER_TEXT_BODY }
  });
  if (!res.ok) throw new Error(`予定表の取得に失敗しました(HTTP ${res.status})`);
  const data = await res.json();

  // 主催者かつ終日でない予定のみ変更可能(参加者としての予定はOutlookと同様に編集できない)
  return (data.value || []).map(mapGraphEvent);
}

/** Graphの予定1件を、画面(個人の予定・週の予定)で使う形にする。i=色の巡回用の通し番号 */
function mapGraphEvent(ev, i) {
  return ({
    id: ev.id,
    editable: !!ev.isOrganizer && !ev.isAllDay,
    isAllDay: ev.isAllDay,
    date: ev.start.dateTime.slice(0, 10),
    endDate: ev.end.dateTime.slice(0, 10), // 複数日にまたがる予定・終日の予定(終了日は含まない)を、週の予定の各日に割り当てるため
    start: ev.start.dateTime.slice(11, 16),
    end: ev.end.dateTime.slice(11, 16),
    time: ev.isAllDay ? '終日' : `${ev.start.dateTime.slice(11, 16)}–${ev.end.dateTime.slice(11, 16)}`,
    title: ev.subject || '(件名なし)',
    place: (ev.location && ev.location.displayName) || '',
    attendees: (ev.attendees || []).map(a => ({
      email: (a.emailAddress && a.emailAddress.address) || '',
      name: (a.emailAddress && a.emailAddress.name) || '',
      type: a.type
    })),
    bodyText: (ev.body && ev.body.contentType === 'text' && ev.body.content) || '',
    seriesMasterId: ev.seriesMasterId || '', // 繰り返しの予定の1回分のとき、元の予定のID(繰り返し全体の削除に使う)
    categories: ev.categories || [], // Outlookの分類項目(打ち合わせの区分の読み込み・保存で使う)
    ...PERSONAL_COLOR_CYCLE[i % PERSONAL_COLOR_CYCLE.length]
  });
}

function renderPersonalEvents(events) {
  const el = document.getElementById('personal-events');
  if (!events.length) {
    el.innerHTML = '<p style="margin:0;padding:6px 0;font-size:13px;color:#8a99a8">この日の予定はありません</p>';
    return;
  }
  el.innerHTML = events.map((e, i) => `
    <div ${e.editable ? `data-edit-event="${i}" title="クリックで変更"` : ''} style="display:flex;flex-direction:column;gap:3px;background:${e.bg};border-left:4px solid ${e.color};border-radius:8px;padding:11px 15px${e.editable ? ';cursor:pointer' : ''}">
      <div style="display:flex;align-items:baseline;gap:12px">
        <span style="font-size:13px;font-weight:700;color:${e.timeColor};white-space:nowrap">${esc(e.time)}</span>
        <span style="font-size:14px;font-weight:700">${esc(e.title)}</span>
      </div>
      ${e.place ? `<span style="font-size:12px;color:#6b7d8f">${linkify(e.place)}</span>` : ''}
    </div>`).join('');
  el.querySelectorAll('[data-edit-event]').forEach(card => card.addEventListener('click', () => {
    openEditForm(state.personalEvents[Number(card.dataset.editEvent)]);
  }));
}

async function loadAndRenderPersonal() {
  const el = document.getElementById('personal-events');
  el.innerHTML = '<p style="margin:0;padding:6px 0;font-size:13px;color:#8a99a8">読み込み中…</p>';
  try {
    state.personalEvents = await fetchPersonalEvents(state.date);
    renderPersonalEvents(state.personalEvents);
  } catch (e) {
    console.error(e);
    state.personalEvents = [];
    el.innerHTML = `<p style="margin:0;padding:6px 0;font-size:13px;color:#c05a5a">${esc(e.message || String(e))}</p>`;
  }
}

// ---- 週の予定(2026-10-15・ユーザー指示。「自分の予定」の下。日曜日始まり) ----
// 選んだ日を含む週(日曜〜土曜)の自分の予定を、日ごとの縦リストで表示する。終日の予定も含める。
// 日の行をクリックすると、その日が選ばれる(上の「自分の予定」・会議室の空き状況も切り替わる)。予定のクリックは「自分の予定」と同じ編集画面

/** 日付を含む週の日曜日(時刻は切り捨て) */
/** 週の予定で今表示している週の日曜日(「‹ ›」で動かしていなければ、選択中の日を含む週) */
function currentWeekSunday() {
  return weekStartOf(state.weekBase || state.date);
}

function weekStartOf(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() - d.getDay());
  return d;
}

/** 日曜日から始まる7日分の日付 */
function weekDatesFrom(sunday) {
  return Array.from({ length: 7 }, (_, i) => { const d = new Date(sunday); d.setDate(d.getDate() + i); return d; });
}

/** その日(dayKey='YYYY-MM-DD')にかかる予定か。複数日にまたがる予定・終日の予定(終了日は含まない。Graphの仕様)に対応 */
function eventCoversDay(ev, dayKey) {
  if (ev.date > dayKey) return false;
  if (ev.isAllDay) return dayKey < ev.endDate;
  if (ev.endDate > ev.date && ev.end === '00:00') return dayKey < ev.endDate; // 翌日0時ちょうどに終わる予定
  return dayKey <= ev.endDate;
}

/** 指定した週の自分の予定を取得する(予定が多い週に備えて、次のページも全て読む)。devモードは、選択中の日にダミーを置く */
async function fetchWeekEvents(sunday) {
  if (Auth.mode !== 'entra') return DUMMY_PERSONAL_EVENTS.map(e => ({ ...e, date: isoDate(state.date), endDate: isoDate(state.date), isAllDay: false, editable: false }));
  const next = new Date(sunday);
  next.setDate(next.getDate() + 7);
  const token = await Auth.getGraphToken(['Calendars.ReadWrite']);
  let url = 'https://graph.microsoft.com/v1.0/me/calendarView' +
    `?startDateTime=${encodeURIComponent(isoDate(sunday) + 'T00:00:00+09:00')}` +
    `&endDateTime=${encodeURIComponent(isoDate(next) + 'T00:00:00+09:00')}` +
    '&$select=id,subject,start,end,location,isAllDay,isOrganizer,attendees,body,categories,type,seriesMasterId&$orderby=start/dateTime&$top=100';
  const out = [];
  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Prefer: GRAPH_PREFER_TEXT_BODY } });
    if (!res.ok) throw new Error(`週の予定の取得に失敗しました(HTTP ${res.status})`);
    const data = await res.json();
    out.push(...(data.value || []));
    url = data['@odata.nextLink'] || null;
  }
  return out.map(mapGraphEvent);
}

function renderWeek() {
  const el = document.getElementById('week-events');
  const titleEl = document.getElementById('week-title');
  if (!el) return;
  const sunday = currentWeekSunday();
  const days = weekDatesFrom(sunday);
  const todayKey = isoDate(new Date());
  const selectedKey = isoDate(state.date);
  const fmt = d => `${d.getMonth() + 1}/${d.getDate()}`;
  const range = `${fmt(days[0])}〜${fmt(days[6])}`;
  if (titleEl) titleEl.textContent = isoDate(weekStartOf(new Date())) === isoDate(sunday) ? `今週の予定(${range})` : `${range}の予定`; // 取得中も、先にこの関数で週の見出しだけ更新する

  el.innerHTML = days.map(d => {
    const key = isoDate(d);
    const isToday = key === todayKey, isSelected = key === selectedKey;
    const idxs = state.weekEvents.map((e, i) => i).filter(i => eventCoversDay(state.weekEvents[i], key));
    const body = idxs.length ? idxs.map(i => {
      const e = state.weekEvents[i];
      const time = e.isAllDay ? '終日' : `${e.start}–${e.end}`;
      return `<div ${e.editable ? `data-week-event="${i}" title="クリックで変更"` : ''} style="display:flex;align-items:baseline;gap:8px;padding:3px 8px;border-left:3px solid ${e.color};background:${e.bg};border-radius:5px${e.editable ? ';cursor:pointer' : ''}">
          <span style="font-size:11px;font-weight:700;color:${e.timeColor};white-space:nowrap">${esc(time)}</span>
          <span style="font-size:12px;font-weight:500;color:#1c2b3a;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(e.title)}</span>
        </div>`;
    }).join('') : '<span style="font-size:12px;color:#b5c3d1">予定なし</span>';
    const dayColor = d.getDay() === 0 ? '#d64545' : d.getDay() === 6 ? '#1e5fa8' : '#1c2b3a';
    return `
    <div data-week-day="${key}" title="クリックでこの日の予定を表示" style="display:flex;gap:12px;align-items:flex-start;padding:8px 12px;border-bottom:1px solid #f2f5f9;cursor:pointer;${isSelected ? 'background:#f2f6fb;' : ''}${isToday ? 'box-shadow:inset 3px 0 0 #1e5fa8;' : ''}">
      <div style="width:64px;flex-shrink:0;font-size:12px;font-weight:700;color:${dayColor}">${fmt(d)}(${WDAYS[d.getDay()]})${isToday ? '<div style="font-size:10px;color:#1e5fa8">今日</div>' : ''}</div>
      <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:4px">${body}</div>
    </div>`;
  }).join('');

  el.querySelectorAll('[data-week-event]').forEach(item => item.addEventListener('click', ev => {
    ev.stopPropagation(); // 日の行のクリック(日付の切り替え)とは別に、予定の編集画面を開く
    openEditForm(state.weekEvents[Number(item.dataset.weekEvent)]);
  }));
  el.querySelectorAll('[data-week-day]').forEach(row => row.addEventListener('click', () => {
    const [y, m, dd] = row.dataset.weekDay.split('-').map(Number);
    state.date = new Date(y, m - 1, dd);
    state.weekBase = null;
    render();
  }));
}

async function loadAndRenderWeek() {
  const el = document.getElementById('week-events');
  if (!el) return;
  const sunday = currentWeekSunday();
  const key = isoDate(sunday);
  { const t = document.getElementById('week-title'); const days = weekDatesFrom(sunday); const f = d => `${d.getMonth() + 1}/${d.getDate()}`; const r = `${f(days[0])}〜${f(days[6])}`; if (t) t.textContent = isoDate(weekStartOf(new Date())) === key ? `今週の予定(${r})` : `${r}の予定`; }
  if (!state.weekEvents.length) el.innerHTML = '<p style="margin:0;padding:12px;font-size:13px;color:#8a99a8">読み込み中…</p>';
  try {
    const events = await withTimeout(fetchWeekEvents(sunday), 15000, '週の予定の取得が時間内に完了しませんでした');
    if (isoDate(currentWeekSunday()) !== key) return; // 取得中に別の週へ切り替えられた場合は、古い結果で描き替えない
    state.weekEvents = events;
    renderWeek();
  } catch (e) {
    console.error(e);
    if (isoDate(currentWeekSunday()) !== key) return; // 取得中に別の週へ切り替えられた場合は、古い取得の失敗で新しい週の表示を消さない
    state.weekEvents = [];
    el.innerHTML = `<p style="margin:0;padding:12px;font-size:13px;color:#c05a5a">${esc(e.message || String(e))}</p>`;
  }
}

// ---- 月の予定(2026-11-17・ユーザー指示。自分の予定だけ。会議室の月表示はなし) ----
// 日曜日始まりのカレンダー。1日のマスには、予定を3件まで(終日→開始の早い順)出し、それ以上は「+N件」。
// 日のマスのクリック(または「+N件」)で、その日を選んで「日・週」の画面へ。予定のクリックは、週の予定と同じ編集画面(変更できる予定だけ)
const MONTH_MAX_EVENTS = 3;

/** 月の表示で見ている月の1日 */
function currentMonthFirst() {
  const b = state.monthBase || state.date;
  return new Date(b.getFullYear(), b.getMonth(), 1);
}

/** その月のカレンダーの日付(日曜始まり。前後の月の日も含めて、7の倍数の日数) */
function monthGridDates(first) {
  const start = weekStartOf(first);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
  const n = Math.ceil((Math.round((last - start) / 86400000) + 1) / 7) * 7;
  return Array.from({ length: n }, (_, i) => { const d = new Date(start); d.setDate(d.getDate() + i); return d; });
}

/** 月のカレンダーの範囲の自分の予定を取得する(予定が多い月に備えて、次のページも全て読む)。devモードは、選択中の日にダミーを置く */
async function fetchMonthEvents(first) {
  if (Auth.mode !== 'entra') return DUMMY_PERSONAL_EVENTS.map(e => ({ ...e, date: isoDate(state.date), endDate: isoDate(state.date), isAllDay: false, editable: false }));
  const dates = monthGridDates(first);
  const end = new Date(dates[dates.length - 1]);
  end.setDate(end.getDate() + 1);
  const token = await Auth.getGraphToken(['Calendars.ReadWrite']);
  let url = 'https://graph.microsoft.com/v1.0/me/calendarView' +
    `?startDateTime=${encodeURIComponent(isoDate(dates[0]) + 'T00:00:00+09:00')}` +
    `&endDateTime=${encodeURIComponent(isoDate(end) + 'T00:00:00+09:00')}` +
    '&$select=id,subject,start,end,location,isAllDay,isOrganizer,attendees,body,categories,type,seriesMasterId&$orderby=start/dateTime&$top=100';
  const out = [];
  for (let page = 0; url; page++) {
    if (page >= 20) throw new Error('月の予定が多すぎて、全て取得できませんでした'); // 無限ループ防止(100件×20ページ)
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Prefer: GRAPH_PREFER_TEXT_BODY } });
    if (!res.ok) throw new Error(`月の予定の取得に失敗しました(HTTP ${res.status})`);
    const data = await res.json();
    out.push(...(data.value || []));
    url = data['@odata.nextLink'] || null;
  }
  return out.map(mapGraphEvent);
}

/** 月のカレンダーを描く(状態の monthEvents から。純粋に描画だけ) */
function renderMonth() {
  const grid = document.getElementById('month-grid');
  if (!grid) return;
  const first = currentMonthFirst();
  const dates = monthGridDates(first);
  const todayKey = isoDate(new Date()), selectedKey = isoDate(state.date);
  document.getElementById('month-title').textContent = `${first.getFullYear()}年${first.getMonth() + 1}月`;
  const head = WDAYS.map((w, i) => `<div class="mv-head" style="color:${i === 0 ? '#d64545' : i === 6 ? '#1e5fa8' : '#6b7d8f'}">${w}</div>`).join('');
  const cells = dates.map(d => {
    const key = isoDate(d);
    const idxs = state.monthEvents.map((e, i) => i).filter(i => eventCoversDay(state.monthEvents[i], key));
    idxs.sort((a, b) => {
      const ea = state.monthEvents[a], eb = state.monthEvents[b];
      return (eb.isAllDay ? 1 : 0) - (ea.isAllDay ? 1 : 0) || (ea.start || '').localeCompare(eb.start || '') || a - b;
    });
    const shown = idxs.slice(0, MONTH_MAX_EVENTS);
    const items = shown.map(i => {
      const e = state.monthEvents[i];
      const time = e.isAllDay ? '' : `<span class="mv-time">${esc(e.start || '')}</span> `;
      return `<div class="mv-ev" ${e.editable ? `data-month-event="${i}"` : ''} title="${esc((e.isAllDay ? '終日' : e.time) + ' ' + e.title)}${e.editable ? '(クリックで変更)' : ''}" style="border-left:3px solid ${e.color};background:${e.bg}${e.editable ? ';cursor:pointer' : ''}">${time}<span class="mv-title">${esc(e.title)}</span></div>`;
    }).join('');
    const more = idxs.length > shown.length ? `<div class="mv-more" data-month-goto="${key}" title="この日の予定をすべて表示(日・週の画面へ)">+${idxs.length - shown.length}件</div>` : '';
    const dow = d.getDay();
    const other = d.getMonth() !== first.getMonth();
    const numColor = dow === 0 ? '#d64545' : dow === 6 ? '#1e5fa8' : '#1c2b3a';
    return `<div class="mv-cell${other ? ' mv-other' : ''}${key === selectedKey ? ' mv-selected' : ''}" data-month-day="${key}" title="クリックでこの日の予定を作成">
      <div class="mv-num" data-month-goto="${key}" title="この日の予定を表示(日・週の画面へ)" style="color:${numColor}"><span${key === todayKey ? ' class="mv-today"' : ''}>${d.getDate()}</span></div>
      ${items}${more}
    </div>`;
  }).join('');
  grid.innerHTML = `<div class="mv-grid">${head}${cells}</div>`;

  grid.querySelectorAll('[data-month-event]').forEach(item => item.addEventListener('click', ev => {
    ev.stopPropagation(); // 日のマスのクリック(日付の選択)とは別に、予定の編集画面を開く
    openEditForm(state.monthEvents[Number(item.dataset.monthEvent)]);
  }));
  // 日のマスのクリック: その日の予定作成フォームを開く(会議室・社用車の予約もここから。作成後は月を読み直す)。
  // 日付の数字と「+N件」のクリック: その日を選んで「日・週」の画面へ(その日の予定をすべて見る)
  const dateOf = key => { const [y, m, dd] = key.split('-').map(Number); return new Date(y, m - 1, dd); };
  grid.querySelectorAll('[data-month-day]').forEach(cell => cell.addEventListener('click', () => {
    state.date = dateOf(cell.dataset.monthDay);
    renderMonth(); // 選んだ日の枠を更新(フォームを閉じたあとも、選んだ日が分かる)
    openCreateForm(state.date);
  }));
  grid.querySelectorAll('[data-month-goto]').forEach(el => el.addEventListener('click', ev => {
    ev.stopPropagation(); // 日のマスのクリック(予定の作成)とは別
    state.date = dateOf(el.dataset.monthGoto);
    setView('week');
  }));
}

async function loadAndRenderMonth() {
  const grid = document.getElementById('month-grid');
  if (!grid) return;
  const first = currentMonthFirst();
  const key = isoDate(first);
  if (!state.monthEvents.length) { // 先にカレンダーの枠だけ出す(取得を待たせて空白にしない)
    renderMonth();
  }
  const note = document.getElementById('month-note');
  if (note) note.remove();
  try {
    const events = await withTimeout(fetchMonthEvents(first), 20000, '月の予定の取得が時間内に完了しませんでした');
    if (state.view !== 'month' || isoDate(currentMonthFirst()) !== key) return; // 取得中に別の月・画面へ切り替えられた場合は、古い結果で描き替えない
    state.monthEvents = events;
    renderMonth();
  } catch (e) {
    console.error(e);
    if (state.view !== 'month' || isoDate(currentMonthFirst()) !== key) return;
    state.monthEvents = [];
    renderMonth();
    grid.insertAdjacentHTML('afterbegin', `<p id="month-note" style="margin:0;padding:10px 20px;font-size:13px;color:#c05a5a">${esc(e.message || String(e))}</p>`);
  }
}

/** 「日・週」と「月」の表示を切り替える。日のマスから戻るときは、選んだ日の画面を出す */
function setView(view) {
  state.view = view === 'month' ? 'month' : 'week';
  const month = state.view === 'month';
  document.getElementById('dw-grid').style.display = month ? 'none' : 'grid'; // inline の display:grid があるため hidden 属性は効かない
  document.getElementById('month-view').hidden = !month;
  ['prev-day', 'date-label', 'next-day', 'today-btn'].forEach(id => { document.getElementById(id).style.display = month ? 'none' : ''; }); // 日付送りは、月の表示では月の見出しの「‹ ›」を使う
  [['view-week', !month], ['view-month', month]].forEach(([id, on]) => {
    const b = document.getElementById(id);
    b.setAttribute('aria-pressed', String(on));
    b.style.background = on ? '#1e5fa8' : '#ffffff';
    b.style.color = on ? '#ffffff' : '#1c2b3a';
    b.style.fontWeight = on ? '700' : '500';
  });
  if (month) state.monthBase = new Date(state.date.getFullYear(), state.date.getMonth(), 1);
  else state.monthBase = null;
  render();
}

// ---- 拠点別 会議室スケジュール(実データ。会議室自身の予定表を直接取得) ----

/** 指定会議室群(会議室・社用車問わず)の1日分の予定を、各リソース自身の予定表(calendarView)から
    直接取得する(件名・予約者名・予定IDまで取れる。Calendars.ReadWrite.Shared権限+Reviewer権限が必要。
    2026-08-22: 全リソースにReviewer権限を付与済みのため、拠点代表者(SITE_REPS)以外でも使える)。
    1件ずつtry/catchし、失敗したリソースは空扱いにする(1件の失敗で全体を壊さない)。 */
async function fetchCalendarViewBusy(dateStr, rooms, token) {
  const map = {};
  await Promise.all(rooms.map(async room => {
    try {
      const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(room.email)}/calendarView` +
        `?startDateTime=${encodeURIComponent(dateStr + 'T00:00:00+09:00')}` +
        `&endDateTime=${encodeURIComponent(dateStr + 'T23:59:59+09:00')}` +
        '&$select=id,subject,start,end,organizer,showAs&$orderby=start/dateTime';
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.timezone="Tokyo Standard Time"' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      // 日をまたぐ予約は、この日の範囲(0:00〜24:00)に切り詰める(前日22:00〜今日8:00 → 00:00–08:00)。重複チェックにも使うため
      map[room.id] = (d.value || []).filter(ev => clipToDay(ev.start.dateTime, ev.end.dateTime, dateStr)).map(ev => ({
        ...clipToDay(ev.start.dateTime, ev.end.dateTime, dateStr),
        subject: ev.subject || '(件名なし)',
        organizer: (ev.organizer && ev.organizer.emailAddress && ev.organizer.emailAddress.name) || '',
        organizerEmail: (ev.organizer && ev.organizer.emailAddress && ev.organizer.emailAddress.address) || '',
        // tentative = このリソース側でまだ承諾していない仮の状態(この後、自動承諾または重複なら自動辞退される)
        tentative: ev.showAs === 'tentative',
        eventId: ev.id,
        roomEmail: room.email
      }));
    } catch (e) {
      console.error(`「${room.name}」の予定表取得に失敗しました`, e);
      map[room.id] = [];
    }
  }));
  await applyOrganizerFullNames(map);
  return map;
}

/** 指定日の全会議室(33室)の空き状況+予約者名を取得。devモードは空({}) */
async function fetchRoomBusy(date) {
  if (Auth.mode !== 'entra') return {};
  const token = await Auth.getGraphToken(['Calendars.ReadWrite', 'Calendars.ReadWrite.Shared']);
  return fetchCalendarViewBusy(isoDate(date), ROOMS, token);
}

/** 吉村一建設会議室(10室)の空き状況+予約者名を取得する。マスタは roomsData.js の YOSHIMURA_ROOMS */
async function fetchYoshimuraBusy(date) {
  if (Auth.mode !== 'entra') return {};
  const token = await Auth.getGraphToken(['Calendars.ReadWrite', 'Calendars.ReadWrite.Shared']);
  return fetchCalendarViewBusy(isoDate(date), YOSHIMURA_ROOMS, token);
}

/** 社用車(9台)の空き状況+予約者名を取得する。マスタは roomsData.js の CARS */
async function fetchCarsBusy(date) {
  if (Auth.mode !== 'entra') return {};
  const token = await Auth.getGraphToken(['Calendars.ReadWrite', 'Calendars.ReadWrite.Shared']);
  return fetchCalendarViewBusy(isoDate(date), CARS, token);
}

/** 拠点/区分け/部門別カードのHTML(ゆめすみか展示場・吉村一建設会議室・社用車で共通処理)。
    busyMap が null なら読み込み中表示。adminIds に含まれるグループには「担当」バッジ+各予約に削除ボタンを出す。 */
function resourceGridHtml(groups, roomsInGroup, unit, busyMap, adminIds) {
  if (!busyMap) return '<p style="margin:0;padding:8px 0;font-size:13px;color:#8a99a8">読み込み中…</p>';
  adminIds = adminIds || [];
  return groups.map(g => {
    const isAdmin = adminIds.includes(g.id);
    const rooms = roomsInGroup(g.id);
    const rows = rooms.flatMap(r => (busyMap[r.id] || []).map(b => ({ ...b, room: r })))
      .sort((a, b) => a.start.localeCompare(b.start))
      .map(b => `
      <div style="display:flex;align-items:center;gap:8px;background:${b.room.color};border-radius:6px;padding:6px 10px${b.tentative ? ';opacity:0.65' : ''}">
        <span style="font-size:11px;font-weight:700;color:#ffffff;white-space:nowrap">${esc(b.start)}–${esc(b.end)}</span>
        <span style="font-size:12px;font-weight:500;color:#ffffff;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(b.room.name)}${b.subject ? ' ・ ' + esc(b.subject) : ''}${b.organizer ? ' ・ ' + esc(b.organizer) : ''}</span>
        ${b.tentative ? '<span style="font-size:10px;font-weight:700;color:#4a3800;background:#f5b301;border-radius:4px;padding:1px 6px;white-space:nowrap;flex-shrink:0">承諾待ち</span>' : ''}
        ${isAdmin && b.eventId ? `<button data-delete-booking="${esc(b.roomEmail)}|${esc(b.eventId)}" title="この予約を削除" style="border:none;background:rgba(255,255,255,0.25);color:#ffffff;border-radius:5px;width:20px;height:20px;font-size:11px;cursor:pointer;font-family:inherit;flex-shrink:0;line-height:1">✕</button>` : ''}
      </div>`);
    const body = rows.length ? rows.join('') : '<p style="margin:0;padding:4px 0;font-size:12px;color:#8a99a8">この日の予約はありません</p>';
    return `
    <div style="border:1px solid #eef1f5;border-radius:10px;overflow:hidden;display:flex;flex-direction:column">
      <div style="padding:11px 15px;background:#f7fafd;display:flex;align-items:center;gap:8px;border-bottom:1px solid #eef1f5">
        <span style="font-size:13px;font-weight:700;color:#1c2b3a">${esc(g.name)}</span>
        ${isAdmin ? '<span style="font-size:10px;font-weight:700;color:#1e5fa8;background:#e9f1fa;border-radius:4px;padding:1px 7px;white-space:nowrap">担当</span>' : ''}
        <span style="font-size:11px;color:#8a99a8;margin-left:auto">${rooms.length}${esc(unit)}</span>
      </div>
      <div style="padding:10px 15px;display:flex;flex-direction:column;gap:6px">${body}</div>
    </div>`;
  }).join('');
}
const yoshimuraGridHtml = (busyMap, adminIds) => resourceGridHtml(YOSHIMURA_GROUPS, yoshimuraGroupRooms, '室', busyMap, adminIds);
const carsGridHtml = (busyMap, adminIds) => resourceGridHtml(CAR_GROUPS, carGroupRooms, '台', busyMap, adminIds);
const siteGridHtml = (busyMap, adminIds) => resourceGridHtml(SITES, siteRooms, '室', busyMap, adminIds);

/** 予約状況の表示切り替えタブ(ゆめすみか展示場/社用車/吉村一建設会議室)を描画する。
    見出し(#grid-title)も選択中のタブに合わせて「(タブ名)の予約状況」に切り替える */
function renderGridTabs() {
  // 見出し(#grid-title)は固定文言「会議室・社用車の空き状況」。予約ボタンの文言だけ選択中のタブに連動させる
  // 予約ページへのリンクも選択中のタブに連動させる
  const roomsLink = document.getElementById('rooms-link');
  if (roomsLink) {
    if (state.gridTab === 'cars') {
      roomsLink.style.display = '';
      roomsLink.href = 'rooms.html?view=cars';
      roomsLink.textContent = '社用車を予約する →';
    } else if (state.gridTab === 'yoshimura') {
      roomsLink.style.display = '';
      roomsLink.href = 'rooms.html?view=yoshimura';
      roomsLink.textContent = '吉村一建設会議室を予約する →';
    } else {
      roomsLink.style.display = '';
      roomsLink.href = 'rooms.html';
      roomsLink.textContent = 'ゆめすみか展示場を予約する →';
    }
  }
  // 「吉村一建設スタッフ予定へ」「ゆめすみかスタッフ予定へ」は、切り替えに関わらず常に2つとも表示する(上の操作行。ユーザー指示 2026-10-10)
  const el = document.getElementById('grid-tabs');
  if (!el) return;
  el.innerHTML = GRID_TABS.map(t => {
    const sel = t.id === state.gridTab;
    return `
    <button class="hv-site" data-grid-tab="${t.id}" style="border:1px solid ${sel ? '#1e5fa8' : '#dfe8f0'};background:${sel ? '#1e5fa8' : '#ffffff'};color:${sel ? '#ffffff' : '#1c2b3a'};font-weight:700;border-radius:9px;padding:8px 18px;font-size:13px;cursor:pointer;font-family:inherit;white-space:nowrap">${esc(t.label)}</button>`;
  }).join('');
  el.querySelectorAll('[data-grid-tab]').forEach(b => b.addEventListener('click', () => {
    if (state.gridTab === b.dataset.gridTab) return;
    state.gridTab = b.dataset.gridTab;
    renderGridTabs();
    loadAndRenderSiteGrid();
  }));
}

async function loadAndRenderSiteGrid() {
  const el = document.getElementById('site-grid');

  // 社用車(9台・部門別カード。実データ)
  if (state.gridTab === 'cars') {
    if (Auth.mode !== 'entra') {
      el.innerHTML = '<p style="margin:0;padding:8px 0;font-size:13px;color:#8a99a8">devモードでは社用車の空き状況を確認できません(Entra IDでのサインインが必要です)</p>';
      return;
    }
    el.innerHTML = carsGridHtml(null);
    try {
      state.carsBusy = await fetchCarsBusy(state.date);
      if (state.gridTab !== 'cars') return; // 取得中にタブが切り替わったら描き替えない
      el.innerHTML = carsGridHtml(state.carsBusy, state.adminCarIds);
      bindSiteGridActions(el);
    } catch (e) {
      console.error(e);
      state.carsBusy = {};
      if (state.gridTab !== 'cars') return;
      el.innerHTML = `<p style="margin:0;padding:8px 0;font-size:13px;color:#c05a5a">${esc(e.message || String(e))}</p>`;
    }
    return;
  }
  // 吉村一建設会議室(10室・区分け別カード。実データ)
  if (state.gridTab === 'yoshimura') {
    if (Auth.mode !== 'entra') {
      el.innerHTML = '<p style="margin:0;padding:8px 0;font-size:13px;color:#8a99a8">devモードでは会議室の空き状況を確認できません(Entra IDでのサインインが必要です)</p>';
      return;
    }
    el.innerHTML = yoshimuraGridHtml(null);
    try {
      state.yoshimuraBusy = await fetchYoshimuraBusy(state.date);
      if (state.gridTab !== 'yoshimura') return; // 取得中にタブが切り替わったら描き替えない
      el.innerHTML = yoshimuraGridHtml(state.yoshimuraBusy, state.adminYoshimuraIds);
      bindSiteGridActions(el);
    } catch (e) {
      console.error(e);
      state.yoshimuraBusy = {};
      if (state.gridTab !== 'yoshimura') return;
      el.innerHTML = `<p style="margin:0;padding:8px 0;font-size:13px;color:#c05a5a">${esc(e.message || String(e))}</p>`;
    }
    return;
  }

  if (Auth.mode !== 'entra') {
    el.innerHTML = '<p style="margin:0;padding:8px 0;font-size:13px;color:#8a99a8">devモードでは会議室の空き状況を確認できません(Entra IDでのサインインが必要です)</p>';
    state.roomBusy = {};
    return;
  }
  el.innerHTML = siteGridHtml(null);
  try {
    state.roomBusy = await fetchRoomBusy(state.date);
    if (state.gridTab !== 'sites') return; // 取得中にタブが切り替わったら描き替えない
    el.innerHTML = siteGridHtml(state.roomBusy, state.adminSiteIds);
    bindSiteGridActions(el);
  } catch (e) {
    console.error(e);
    state.roomBusy = {};
    if (state.gridTab !== 'sites') return;
    el.innerHTML = `<p style="margin:0;padding:8px 0;font-size:13px;color:#c05a5a">${esc(e.message || String(e))}</p>`;
  }
}

/** 拠点別カード内の削除ボタン(担当拠点の会議室予約を管理者権限で削除)を有効化する */
function bindSiteGridActions(root) {
  root.querySelectorAll('[data-delete-booking]').forEach(btn => btn.addEventListener('click', async () => {
    const [roomEmail, eventId] = btn.dataset.deleteBooking.split('|');
    if (!confirm('この会議室予約を削除しますか?(主催者に取消の通知が送られます)')) return;
    btn.disabled = true;
    try {
      const token = await Auth.getGraphToken(['Calendars.ReadWrite.Shared']);
      const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(roomEmail)}/events/${encodeURIComponent(eventId)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok && res.status !== 404) throw new Error(`削除に失敗しました(HTTP ${res.status})`);
      await loadAndRenderSiteGrid();
    } catch (e) {
      alert(e.message || String(e));
      btn.disabled = false;
    }
  }));
}

// ---- 予定作成モーダル(個人の予定。任意で実際の会議室を出席者として追加) ----

function hourOptions() {
  // 予約可能時間は 8:00〜23:00(30分刻み。2026-11-12・ユーザー指示で21:00→23:00。rooms.js と同じ)
  const opts = [];
  for (let h = 8; h <= 22; h++) { opts.push(`${pad(h)}:00`); opts.push(`${pad(h)}:30`); }
  opts.push('23:00');
  return opts;
}

/** 'HH:MM' の1時間後を返す(上限23:00)。開始時間選択時の終了時間の自動設定に使う */
function plusOneHour(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const total = Math.min(h * 60 + m + 60, 23 * 60);
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

let formState = null;
let memberCandidates = []; // 社内メンバー検索の候補
let memberSearchSeq = 0; // 検索の通し番号(古い応答を捨てる)

// ---- 予定作成フォームで選べるリソース種別(2026-08-22追加) ----
// 「ゆめすみか展示場」「吉村一建設会議室」「社用車」のいずれかを選び、その配下の
// 拠点/区分け/部門 → 会議室・社用車 の順で選択する。3マスタとも roomsData.js で定義。
const RESOURCE_TYPES = [
  { id: 'yumesumika', label: 'ゆめすみか展示場', itemLabel: '会議室', siteLabel: '拠点', sites: SITES, rooms: ROOMS },
  { id: 'yoshimura', label: '吉村一建設会議室', itemLabel: '会議室', siteLabel: '区分け', sites: YOSHIMURA_GROUPS, rooms: YOSHIMURA_ROOMS.map(r => ({ ...r, site: r.group })) },
  { id: 'cars', label: '社用車', itemLabel: '社用車', siteLabel: '部門', sites: CAR_GROUPS, rooms: CARS.map(r => ({ ...r, site: r.group })) }
];
function resourceMaster(type) { return RESOURCE_TYPES.find(t => t.id === type) || null; }
function resourceRoomById(id) {
  for (const t of RESOURCE_TYPES) { const r = t.rooms.find(x => x.id === id); if (r) return r; }
  return null;
}
/** 指定リソース種別の1日分の空き状況(件名・予約者名まで)を取得。devモードは空({}) */
async function fetchResourceBusy(date, type) {
  const master = resourceMaster(type);
  if (!master || Auth.mode !== 'entra') return {};
  const token = await Auth.getGraphToken(['Calendars.ReadWrite', 'Calendars.ReadWrite.Shared']);
  return fetchCalendarViewBusy(isoDate(date), master.rooms, token);
}

function openCreateForm(date) { // date=月の表示で日のマスを選んだときの日付(ボタンのクリックでは Event が渡るので、Date のときだけ使う)
  const d = date instanceof Date ? date : state.date;
  formState = {
    eventId: null, orig: null,
    date: isoDate(d),
    start: '10:00', end: '11:00', title: '', content: '', place: '', members: [], guests: '', error: '',
    resourceType: '', site: '', room: '', // 会議室・社用車は空き一覧のチップから選ぶ(自動選択しない)
    roomBusy: null,
    // 複数の日程(2026-11-17): mode=single(1日だけ)|range(連続した日)|repeat(繰り返し)
    mode: 'single', endDate: '', rangeKind: 'continuous', repKind: 'daily', weekdays: [], weekdaysOnly: false, monthlyKind: 'day', endMode: 'count', repEndDate: '', repCount: 4,
    kind: '', origKind: '', origCategories: [] // 打ち合わせの区分(Outlookの分類項目)
  };
  memberCandidates = [];
  renderModal();
  refreshKindsInForm();
}

/** 区分の一覧を読み込み、開いているフォームに反映する(初めての読み込みで一覧が変わったときだけ描き直す)。変更のときは、保存済みの分類項目から、選択中の区分を決める */
function refreshKindsInForm() {
  const before = MEETING_KINDS.length;
  loadMeetingKinds().then(() => {
    const f = formState;
    if (!f) return;
    let changed = MEETING_KINDS.length !== before;
    if (f.origKind === null) { // 変更で開いた直後(一覧の読み込み前)。保存済みの分類項目から区分を決める
      f.origKind = kindOfCategories(f.origCategories, MEETING_KINDS);
      f.kind = f.origKind;
      changed = true;
    }
    if (changed) renderModal();
  });
}

/** 個人のスケジュール一覧のクリックから、既存の予定を変更モードで開く */
/** 「内容(任意)」の下に出す、内容に書かれたURLのリンク(入力の欄はURLをリンクにできないため、別に並べる。クリックで新しいタブ。URLが無ければ空) */
function contentLinksHtml(content) {
  const urls = extractUrls(content, 10);
  return urls.length ? `<span style="font-size:11px;color:#8a99a8">内容のリンク(クリックで新しいタブで開きます)</span>${eventLinksHtml(urls)}` : '';
}

function openEditForm(ev) {
  // 会議室・社用車(resource出席者)を、メールアドレスの一致で3マスタから逆引きする
  const roomEmails = new Set(RESOURCE_TYPES.flatMap(t => t.rooms.map(r => r.email.toLowerCase())));
  const roomAttendee = ev.attendees.find(a => a.type === 'resource' || roomEmails.has((a.email || '').toLowerCase()));
  let matchedRoom = null, matchedType = '';
  if (roomAttendee) {
    for (const t of RESOURCE_TYPES) {
      const found = t.rooms.find(r => r.email.toLowerCase() === roomAttendee.email.toLowerCase());
      if (found) { matchedRoom = found; matchedType = t.id; break; }
    }
  }
  // 社内メンバー欄には「会議室・社用車でも自分自身でもない出席者」だけを復元する。
  // resourceがrequired側に混入していた場合にメンバー扱いで再送する(=二重に招待される)ことを防ぐ
  const myEmail = ((Auth.me && Auth.me.email) || '').toLowerCase();
  const members = ev.attendees
    .filter(a => a.type !== 'resource')
    .filter(a => a.email && !roomEmails.has(a.email.toLowerCase()) && a.email.toLowerCase() !== myEmail)
    .map(a => ({ name: a.name || a.email, email: a.email }));
  // 本文には「内容」と「外部参加者: ...」をまとめて保存しているため、両方を復元する
  const { content, guests } = decodeEventBody(ev.bodyText);

  formState = {
    eventId: ev.id,
    // 変更前の会議室・時間帯(重複の事前チェックで「自分自身の既存予約」を重複扱いしないために使う)
    orig: { room: matchedRoom ? matchedRoom.id : null, date: ev.date, start: ev.start, end: ev.end },
    date: ev.date, start: ev.start, end: ev.end, title: ev.title, content,
    origBody: encodeEventBody(content, guests), // 変更前の本文(内容を変えていなければ、保存のとき本文には触れない)
    place: matchedRoom ? '' : ev.place, members, guests, error: '',
    resourceType: matchedType,
    site: matchedRoom ? matchedRoom.site : '',
    room: matchedRoom ? matchedRoom.id : '',
    roomBusy: null,
    mode: 'single', seriesMasterId: ev.seriesMasterId || '',
    origCategories: ev.categories || [], origKind: null, kind: '' // 区分は、一覧の読み込み後に分類項目から決める(refreshKindsInForm)
  };
  memberCandidates = [];
  renderModal();
  refreshKindsInForm();
  refreshMemberNames();
  if (formState.resourceType && Auth.mode === 'entra') refreshFormRoomBusy();
}

/** 編集画面の「社内メンバー」の名前を「姓 名」にする(2026-11-05・ユーザー指示)。取得できない人は、予定にある表示名のまま。保存はメールアドレスだけなので、名前の置き換えは保存内容に影響しない */
async function refreshMemberNames() {
  const f = formState;
  if (!f || !f.members.length) return;
  const names = await resolveFullNames(f.members.map(m => m.email));
  if (formState !== f) return;
  let changed = false;
  f.members.forEach(m => { const n = names.get(String(m.email || '').toLowerCase()); if (n && n !== m.name) { m.name = n; changed = true; } });
  if (changed) renderModal();
}

function closeForm() {
  formState = null;
  renderModal();
}

async function refreshFormRoomBusy() {
  const f = formState;
  if (!f) return;
  f.roomBusy = null;
  renderModal();
  let busy;
  try { busy = await fetchResourceBusy(parseISODate(f.date), f.resourceType); } catch { busy = {}; }
  if (formState === f) { f.roomBusy = busy; renderModal(); }
}

/** 予定作成フォーム内: 選択中の拠点/区分け/部門・時間帯で空いている会議室・社用車をプルダウンの選択肢にする
    (2026-09-07: チップのクリック選択からプルダウン選択に変更。ユーザー指示)。
    変更時は自分の元の予約時間帯を「埋まっている」扱いにしない(submitCreateFormの重複チェックと同じ基準)。 */
function roomOptionsHtml(f) {
  const master = resourceMaster(f.resourceType);
  if (!master) return '';
  if (f.mode && f.mode !== 'single') { // 複数の日程: 1日分の空きでは絞らない(全ての日の空きは、作成するときに確認する)
    return `<option value="" ${f.room ? '' : 'selected'} disabled>選択してください(空きは作成時に全ての日を確認)</option>` +
      master.rooms.filter(r => r.site === f.site).map(r => `<option value="${r.id}" ${r.id === f.room ? 'selected' : ''}>${esc(r.name)}</option>`).join('');
  }
  if (!f.roomBusy) return '<option value="">読み込み中…</option>';
  if (f.start >= f.end) return '<option value="">終了時刻は開始時刻より後にしてください</option>';
  const isOwnOriginalSlot = (roomId, it) => f.orig && f.orig.room === roomId && f.orig.date === f.date
    && it.start === f.orig.start && it.end === f.orig.end;
  const free = master.rooms.filter(r => r.site === f.site).filter(r =>
    !(f.roomBusy[r.id] || []).some(it => it.start < f.end && it.end > f.start && !isOwnOriginalSlot(r.id, it))
  );
  if (!free.length) return `<option value="">この時間帯に空いている${esc(master.itemLabel)}はありません</option>`;
  return `<option value="" ${f.room ? '' : 'selected'} disabled>選択してください</option>` +
    free.map(r => `<option value="${r.id}" ${r.id === f.room ? 'selected' : ''}>${esc(r.name)}</option>`).join('');
}

// ---- 複数の日程(連続した日・繰り返し。2026-11-17・ユーザー指示。作成のときだけ。計算は recurrence.js) ----
// 「1日だけ」=従来 / 「連続した日」=期間ずっと(ひと続き)か、毎日同じ時間帯 / 「繰り返し」=毎日・毎週・毎月。最長2か月
// 会議室・社用車は、作る前に全ての回の空きを調べ、1日でも空いていなければ、予定も予約も作らない(重なる日を一覧で出す)

const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

/** 複数日程の入力(formState)から、recurrence.js の expandOccurrences に渡す条件を作る */
function recurrenceSpecOf(f) {
  if (f.mode === 'range') return { start: f.date, kind: 'daily', weekdaysOnly: false, endMode: 'date', endDate: f.endDate };
  return { start: f.date, kind: f.repKind, weekdays: f.weekdays, weekdaysOnly: f.weekdaysOnly, monthly: f.monthlyKind, endMode: f.endMode, endDate: f.repEndDate, count: f.repCount };
}

/** 作成の前に、予定が入る各回と、Graph に送る開始・終了(と繰り返し)を決める。
    戻り値: { error } か { firstDate, startDT, endDT, recurrence(なければnull), intervals:[{date,start,end}], lastDate } */
function planMultiSchedule(f) {
  if (f.mode === 'range' && f.rangeKind === 'continuous') {
    if (!f.endDate) return { error: '終了日を入力してください' };
    if (f.endDate < f.date) return { error: '終了日は開始日以降にしてください' };
    const limit = addMonthsISO(f.date, MAX_MONTHS);
    if (f.endDate > limit) return { error: `終了日は開始日から${MAX_MONTHS}か月以内(${limit}まで)にしてください` };
    const start = `${f.date}T${f.start}`, end = `${f.endDate}T${f.end}`;
    if (start >= end) return { error: '終了の日時は、開始の日時より後にしてください' };
    return { firstDate: f.date, startDT: start, endDT: end, recurrence: null, intervals: [{ date: f.date, start, end }], lastDate: f.endDate };
  }
  if (f.start >= f.end) return { error: '終了時刻は開始時刻より後にしてください' };
  const spec = recurrenceSpecOf(f);
  const r = expandOccurrences(spec);
  if (r.error) return { error: r.error };
  const intervals = r.dates.map(d => ({ date: d, start: `${d}T${f.start}`, end: `${d}T${f.end}` }));
  return {
    firstDate: r.dates[0], startDT: intervals[0].start, endDT: intervals[0].end,
    recurrence: r.dates.length > 1 ? buildRecurrence(spec, r.dates) : null, // 1回だけになる場合は、繰り返しにしない
    intervals, lastDate: r.dates[r.dates.length - 1]
  };
}

/** 会議室・社用車1つの、指定した期間(開始日〜最終日)の既存の予約を取得する(日時のまま。次のページも読む)。取得できなければ例外 */
async function fetchRoomIntervals(room, fromDate, lastDate, token) {
  let url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(room.email)}/calendarView` +
    `?startDateTime=${encodeURIComponent(fromDate + 'T00:00:00+09:00')}` +
    `&endDateTime=${encodeURIComponent(addDaysISO(lastDate, 1) + 'T00:00:00+09:00')}` +
    '&$select=start,end,isCancelled&$orderby=start/dateTime&$top=100';
  const out = [];
  for (let page = 0; url; page++) {
    if (page >= 20) throw new Error('予約が多すぎて、空き状況を全て取得できませんでした');
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.timezone="Tokyo Standard Time"' } });
    if (!res.ok) throw new Error(`${room.name}の空き状況を取得できませんでした(HTTP ${res.status})。予定は作成していません`);
    const data = await res.json();
    (data.value || []).filter(ev => !ev.isCancelled).forEach(ev => out.push({ start: ev.start.dateTime.slice(0, 16), end: ev.end.dateTime.slice(0, 16) }));
    url = data['@odata.nextLink'] || null;
  }
  return out;
}

/** 重なる回の一覧の文(長いときは先頭の数件+「ほかN日」) */
function conflictMessage(conflicts, itemLabel) {
  const show = conflicts.slice(0, 8).map(iv => {
    const [y, m, d] = iv.date.split('-').map(Number);
    return `${m}/${d}(${WEEKDAY_LABELS[dowOfISO(iv.date)]}) ${iv.start.slice(11)}–${iv.end.slice(11)}`;
  });
  const rest = conflicts.length > show.length ? ` ほか${conflicts.length - show.length}回` : '';
  return `次の日は、${itemLabel}が空いていません。予定も予約も作成していません: ${show.join('、')}${rest}`;
}

/** 日程の種類の入力欄(作成のときだけ出す。「日付」の欄の前後)。f=formState */
function scheduleModeHtml(f) {
  const lab = 'font-size:12px;font-weight:700;color:#6b7d8f';
  const sel = (v, opts) => opts.map(([val, text]) => `<option value="${val}" ${val === v ? 'selected' : ''}>${esc(text)}</option>`).join('');
  const modeSel = `
    <label style="display:flex;flex-direction:column;gap:5px;flex:1;min-width:0">
      <span style="${lab}">日程</span>
      <select id="f-mode" class="in-input">${sel(f.mode, [['single', '1日だけ'], ['range', '連続した日(複数日)'], ['repeat', '繰り返し(毎日・毎週・毎月)']])}</select>
    </label>`;
  if (f.mode === 'single') return { top: modeSel, afterDate: '' };
  const limit = /^\d{4}-\d{2}-\d{2}$/.test(f.date) ? addMonthsISO(f.date, MAX_MONTHS) : '';
  const hint = `<span style="font-size:11px;color:#8a99a8">最長${MAX_MONTHS}か月(開始日から${MAX_MONTHS}か月後の同じ日${limit ? `=${limit}` : ''}まで)。会議室・社用車は、全ての日が空いているときだけ作成します(1日でも空いていなければ、予定も予約も作りません)。</span>`;
  let body = '';
  if (f.mode === 'range') {
    body = `
      <label style="display:flex;flex-direction:column;gap:5px">
        <span style="${lab}">終了日</span>
        <input id="f-end-date" type="date" class="in-input" value="${esc(f.endDate)}">
      </label>
      <label style="display:flex;flex-direction:column;gap:5px">
        <span style="${lab}">時間の入れ方</span>
        <select id="f-range-kind" class="in-input">${sel(f.rangeKind, [['continuous', '期間ずっと(開始日の開始時刻から、終了日の終了時刻まで、ひと続き)'], ['daily', '毎日同じ時間帯(各日の開始〜終了の時刻)']])}</select>
      </label>`;
  } else {
    const nth = f.date ? nthOfMonth(f.date) : 1;
    const dow = f.date ? WEEKDAY_LABELS[dowOfISO(f.date)] : '';
    const dom = f.date ? recParse(f.date).getDate() : '';
    let kindBody = '';
    if (f.repKind === 'daily') kindBody = `<label style="display:flex;align-items:center;gap:6px;font-size:13px"><input id="f-weekdays-only" type="checkbox" ${f.weekdaysOnly ? 'checked' : ''}> 平日だけ(土日を除く)</label>`;
    else if (f.repKind === 'weekly') kindBody = `<div style="display:flex;gap:8px;flex-wrap:wrap">${WEEKDAY_LABELS.map((w, i) => `<label style="display:flex;align-items:center;gap:3px;font-size:13px"><input type="checkbox" data-wd="${i}" ${f.weekdays.includes(i) ? 'checked' : ''}>${w}</label>`).join('')}</div>`;
    else kindBody = `<select id="f-monthly-kind" class="in-input">${sel(f.monthlyKind, [['day', `毎月${dom}日`], ['nth', `毎月 第${nth}${dow}曜日`]])}</select>`;
    body = `
      <label style="display:flex;flex-direction:column;gap:5px">
        <span style="${lab}">繰り返し</span>
        <select id="f-rep-kind" class="in-input">${sel(f.repKind, [['daily', '毎日'], ['weekly', '毎週'], ['monthly', '毎月']])}</select>
      </label>
      ${kindBody}
      <div style="display:flex;gap:12px;align-items:flex-end">
        <label style="display:flex;flex-direction:column;gap:5px;flex:1">
          <span style="${lab}">終わり</span>
          <select id="f-end-mode" class="in-input">${sel(f.endMode, [['count', '回数で指定'], ['date', '終了日で指定']])}</select>
        </label>
        ${f.endMode === 'count'
          ? `<label style="display:flex;flex-direction:column;gap:5px;flex:1"><span style="${lab}">回数</span><input id="f-rep-count" type="number" min="1" max="62" class="in-input" value="${esc(String(f.repCount))}"></label>`
          : `<label style="display:flex;flex-direction:column;gap:5px;flex:1"><span style="${lab}">終了日</span><input id="f-rep-end" type="date" class="in-input" value="${esc(f.repEndDate)}"></label>`}
      </div>`;
  }
  return { top: modeSel, afterDate: `<div style="display:flex;flex-direction:column;gap:12px;padding:12px 14px;background:#f7f9fc;border:1px solid #e4ebf2;border-radius:10px">${body}${hint}</div>` };
}

/** 複数日程の入力欄のイベント(renderModal の最後で呼ぶ) */
function bindScheduleMode(root, f) {
  const on = (id, ev, fn) => { const el = root.querySelector(id); if (el) el.addEventListener(ev, fn); };
  on('#f-mode', 'change', e => {
    f.mode = e.target.value;
    f.room = ''; f.roomBusy = null; // 空きの出し方が変わるので、会議室は選び直す
    if (f.mode === 'range' && !f.endDate) f.endDate = addDaysISO(f.date, 1);
    if (f.mode === 'repeat' && f.repKind === 'weekly' && !f.weekdays.length && f.date) f.weekdays = [dowOfISO(f.date)];
    if (f.mode === 'single' && f.resourceType && Auth.mode === 'entra') { refreshFormRoomBusy(); return; }
    renderModal();
  });
  on('#f-end-date', 'change', e => { f.endDate = e.target.value; });
  on('#f-range-kind', 'change', e => { f.rangeKind = e.target.value; });
  on('#f-rep-kind', 'change', e => {
    f.repKind = e.target.value;
    if (f.repKind === 'weekly' && !f.weekdays.length && f.date) f.weekdays = [dowOfISO(f.date)];
    renderModal();
  });
  on('#f-weekdays-only', 'change', e => { f.weekdaysOnly = e.target.checked; });
  root.querySelectorAll('[data-wd]').forEach(cb => cb.addEventListener('change', () => {
    const i = Number(cb.dataset.wd);
    f.weekdays = cb.checked ? [...new Set([...f.weekdays, i])] : f.weekdays.filter(x => x !== i);
  }));
  on('#f-monthly-kind', 'change', e => { f.monthlyKind = e.target.value; });
  on('#f-end-mode', 'change', e => { f.endMode = e.target.value; renderModal(); });
  on('#f-rep-count', 'input', e => { f.repCount = e.target.value; });
  on('#f-rep-end', 'change', e => { f.repEndDate = e.target.value; });
}

/** 繰り返しの予定(の1回分を開いたとき)を、繰り返し全体まとめて削除する(主催者のみ。会議室・参加者にはキャンセル通知が送られる) */
async function deleteSeries() {
  const f = formState;
  if (!f || !f.seriesMasterId) return;
  if (!confirm('繰り返しの予定を、すべて削除しますか?(この1回分だけでなく、全ての回が消えます。会議室や参加者には取消の通知が送られます)')) return;
  const btn = document.getElementById('f-delete-series');
  const errEl = document.getElementById('f-error');
  btn.disabled = true;
  btn.textContent = '削除中…';
  try {
    const token = await Auth.getGraphToken(['Calendars.ReadWrite']);
    const res = await fetch(`https://graph.microsoft.com/v1.0/me/events/${f.seriesMasterId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok && res.status !== 404) {
      const err = await res.json().catch(() => null);
      throw new Error(err?.error?.message || `予定の削除に失敗しました(HTTP ${res.status})`);
    }
    closeForm();
    render();
  } catch (e) {
    errEl.textContent = e.message || String(e);
    btn.disabled = false;
    btn.textContent = '繰り返し全体を削除';
  }
}

function renderModal() {
  const root = document.getElementById('modal-root');
  if (!formState) { root.innerHTML = ''; return; }
  const f = formState;
  const opts = hourOptions();
  // 開始は最後(23:00)を除く(開始23:00では終了が選べず、必ず「終了時刻は開始時刻より後に」のエラーになるため。2026-11-12)
  const selOpts = (v, list = opts) => list.map(o => `<option value="${o}" ${o === v ? 'selected' : ''}>${o}</option>`).join('');
  const memberChips = f.members.map((mb, i) => `
    <span style="display:flex;align-items:center;gap:6px;background:#e9f1fa;border:1px solid #c8dcf0;border-radius:16px;padding:3px 10px 3px 4px">
      <span style="width:22px;height:22px;border-radius:50%;background:#4a7fc0;color:#ffffff;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700">${esc(mb.name.charAt(0))}</span>
      <span style="font-size:12px;font-weight:500;color:#1c2b3a">${esc(mb.name)}</span>
      <button data-rm-member="${i}" style="border:none;background:transparent;cursor:pointer;color:#6b7d8f;font-size:11px;padding:0 2px">✕</button>
    </span>`).join('');

  const activeMaster = resourceMaster(f.resourceType);
  const sm = f.eventId ? { top: '', afterDate: '' } : scheduleModeHtml(f); // 複数の日程の入力欄(作成のときだけ)
  const roomSection = activeMaster ? `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px">
      <label style="display:flex;flex-direction:column;gap:5px">
        <span style="font-size:12px;font-weight:700;color:#6b7d8f">${esc(activeMaster.siteLabel)}</span>
        <select id="f-site" class="in-input">${activeMaster.sites.map(s => `<option value="${s.id}" ${s.id === f.site ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
      </label>
      <label style="display:flex;flex-direction:column;gap:5px">
        <span style="font-size:12px;font-weight:700;color:#6b7d8f">${esc(activeMaster.itemLabel)}(空いているもののみ表示)</span>
        <select id="f-room" class="in-input">${roomOptionsHtml(f)}</select>
      </label>
    </div>` : '';

  root.innerHTML = `
  <div id="form-overlay" style="position:fixed;inset:0;background:rgba(20,40,65,0.5);display:flex;align-items:center;justify-content:center;padding:24px;z-index:110">
    <div id="form-box" style="background:#ffffff;border-radius:16px;box-shadow:0 12px 40px rgba(15,35,60,0.3);max-width:520px;width:100%;max-height:88vh;display:flex;flex-direction:column;overflow:hidden">
      <div style="display:flex;align-items:center;gap:12px;padding:20px 26px;border-bottom:1px solid #e4ebf2">
        <h3 style="margin:0;font-size:17px;font-weight:700">${f.eventId ? '予定を変更' : '予定を作成'}</h3>
        <button class="hv-close" data-close style="margin-left:auto;border:none;background:#f0f4f8;border-radius:8px;width:32px;height:32px;cursor:pointer;color:#6b7d8f;font-size:15px;flex-shrink:0">✕</button>
      </div>
      <div style="padding:20px 26px;display:flex;flex-direction:column;gap:14px;overflow-y:auto">
        <p style="margin:0;font-size:12px;color:#8a99a8">${f.eventId ? '変更を保存すると、あなたの予定に反映されます。' : '作成すると、あなたの予定に反映されます。'}${f.seriesMasterId ? '繰り返しの予定です。変更・削除は、この1回分だけに反映されます(全体を消すときは「繰り返し全体を削除」)。' : ''}${activeMaster ? `${esc(activeMaster.itemLabel)}は招待され、空いていれば自動承諾、埋まっていれば自動辞退されます。` : ''}</p>
        <label style="display:flex;flex-direction:column;gap:5px">
          <span style="font-size:12px;font-weight:700;color:#6b7d8f">件名/お客様名</span>
          <input id="f-title" class="in-input" value="${esc(f.title)}" placeholder="例: 営業企画 定例MTG">
        </label>
        <label style="display:flex;flex-direction:column;gap:5px">
          <span style="font-size:12px;font-weight:700;color:#6b7d8f">内容(任意)</span>
          <textarea id="f-content" class="in-input" rows="3" placeholder="打合せの目的・議題など" style="resize:vertical">${esc(f.content)}</textarea>
        </label>
        <div id="f-content-links" style="display:flex;flex-direction:column;gap:2px;margin-top:-6px">${contentLinksHtml(f.content)}</div>
        <div style="display:flex;gap:12px;align-items:flex-end"><!-- 日付と日程は1行(2026-11-17・ユーザー指示) -->
          <label style="display:flex;flex-direction:column;gap:5px;flex:1;min-width:0">
            <span style="font-size:12px;font-weight:700;color:#6b7d8f">${f.mode && f.mode !== 'single' ? '開始日' : '日付'}</span>
            <input id="f-date" type="date" class="in-input" value="${esc(f.date)}">
          </label>
          ${sm.top}
        </div>
        <div style="display:flex;gap:12px;align-items:flex-end">
          <label style="display:flex;flex-direction:column;gap:5px;flex:1">
            <span style="font-size:12px;font-weight:700;color:#6b7d8f">開始</span>
            <select id="f-start" class="in-input">${selOpts(f.start, opts.slice(0, -1))}</select>
          </label>
          <span style="font-size:14px;color:#8a99a8;padding-bottom:10px">〜</span>
          <label style="display:flex;flex-direction:column;gap:5px;flex:1">
            <span style="font-size:12px;font-weight:700;color:#6b7d8f">終了</span>
            <select id="f-end" class="in-input">${selOpts(f.end)}</select>
          </label>
        </div>
        ${sm.afterDate}
        <label style="display:flex;flex-direction:column;gap:5px">
          <span style="font-size:12px;font-weight:700;color:#6b7d8f">会議室・社用車(任意)</span>
          <select id="f-resource-type" class="in-input">
            <option value="" ${!f.resourceType ? 'selected' : ''}>使用しない</option>
            ${RESOURCE_TYPES.map(t => `<option value="${t.id}" ${f.resourceType === t.id ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}
          </select>
        </label>
        ${roomSection}
        ${!activeMaster ? `
        <label style="display:flex;flex-direction:column;gap:5px">
          <span style="font-size:12px;font-weight:700;color:#6b7d8f">場所(任意・自由入力)</span>
          <input id="f-place" class="in-input" value="${esc(f.place)}" placeholder="例: オンライン">
        </label>` : ''}
        ${meetingKindVisible(f.resourceType, f.kind) ? meetingKindFieldHtml('f-kind', f.kind) : ''}
        <div style="display:flex;flex-direction:column;gap:5px;position:relative">
          <span style="display:flex;align-items:center;gap:8px">
            <span style="font-size:12px;font-weight:700;color:#6b7d8f">社内メンバー(任意)</span>
            ${Auth.mode === 'entra'
              ? ''
              : '<span style="font-size:10px;font-weight:700;color:#8a6d1f;background:#f7f0dc;border-radius:4px;padding:1px 7px">サンプル表示</span>'}
          </span>
          ${f.members.length ? `<div style="display:flex;flex-wrap:wrap;gap:6px;padding:2px 0">${memberChips}</div>` : ''}
          <input id="f-member-input" class="in-input" placeholder="${Auth.mode === 'entra' ? '名前・メールで検索' : '名前・部署・メールで検索'}" autocomplete="off">
          <div id="f-member-cands" style="position:absolute;top:100%;left:0;right:0;z-index:10"></div>
        </div>
        <label style="display:flex;flex-direction:column;gap:5px">
          <span style="font-size:12px;font-weight:700;color:#6b7d8f">外部参加者(任意・自由入力)</span>
          <input id="f-guests" class="in-input" value="${esc(f.guests)}" placeholder="例: ○○商事 山田様 2名">
        </label>
        <span id="f-error" style="font-size:12px;color:#c05a5a">${esc(f.error)}</span>
      </div>
      <div style="padding:16px 26px;border-top:1px solid #e4ebf2;display:flex;gap:10px;align-items:center">
        ${f.eventId ? '<button id="f-delete" class="hv-btn-danger" style="border:1px solid #f0d5d5;background:#fbeeee;color:#c05a5a;font-weight:500;border-radius:9px;padding:10px 16px;font-size:13px;cursor:pointer;font-family:inherit">この予定を削除</button>' : ''}
        ${f.seriesMasterId ? '<button id="f-delete-series" class="hv-btn-danger" style="border:1px solid #f0d5d5;background:#fbeeee;color:#c05a5a;font-weight:500;border-radius:9px;padding:10px 16px;font-size:13px;cursor:pointer;font-family:inherit">繰り返し全体を削除</button>' : ''}
        <span style="margin-left:auto;display:flex;gap:10px">
          <button class="hv-btn-plain" data-close style="border:1px solid #dfe8f0;background:#ffffff;color:#6b7d8f;font-weight:500;border-radius:9px;padding:10px 18px;font-size:13px;cursor:pointer;font-family:inherit">キャンセル</button>
          <button id="f-submit" class="hv-btn-primary" style="border:none;background:#1e5fa8;color:#ffffff;font-weight:700;border-radius:9px;padding:10px 24px;font-size:13px;cursor:pointer;font-family:inherit">${f.eventId ? '変更を保存' : '作成する'}</button>
        </span>
      </div>
    </div>
  </div>`;

  root.querySelector('#form-overlay').addEventListener('click', closeForm);
  root.querySelector('#form-box').addEventListener('click', e => e.stopPropagation());
  root.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeForm));
  root.querySelector('#f-title').addEventListener('input', e => { f.title = e.target.value; });
  root.querySelector('#f-content').addEventListener('input', e => { f.content = e.target.value; root.querySelector('#f-content-links').innerHTML = contentLinksHtml(f.content); });
  root.querySelector('#f-date').addEventListener('change', e => {
    f.date = e.target.value;
    if (f.resourceType && Auth.mode === 'entra' && f.mode === 'single') refreshFormRoomBusy();
    else renderModal();
  });
  root.querySelector('#f-start').addEventListener('change', e => {
    f.start = e.target.value;
    f.end = plusOneHour(f.start); // 終了時間を開始+1時間に自動設定(ユーザー指示 2026-08-22)
    renderModal(); // 終了時間の表示と空いている会議室・社用車の表示を更新
  });
  root.querySelector('#f-end').addEventListener('change', e => {
    f.end = e.target.value;
    if (f.resourceType) renderModal();
  });
  const placeInput = root.querySelector('#f-place');
  if (placeInput) placeInput.addEventListener('input', e => { f.place = e.target.value; });
  root.querySelector('#f-guests').addEventListener('input', e => { f.guests = e.target.value; });
  root.querySelector('#f-submit').addEventListener('click', submitCreateForm);
  const deleteBtn = root.querySelector('#f-delete');
  if (deleteBtn) deleteBtn.addEventListener('click', deleteEvent);
  const seriesBtn = root.querySelector('#f-delete-series');
  if (seriesBtn) seriesBtn.addEventListener('click', deleteSeries);
  bindScheduleMode(root, f);

  const kindSel = root.querySelector('#f-kind');
  if (kindSel) kindSel.addEventListener('change', e => { f.kind = e.target.value; });
  root.querySelector('#f-resource-type').addEventListener('change', e => {
    f.resourceType = e.target.value;
    const newMaster = resourceMaster(f.resourceType);
    // 拠点/区分け/部門は先頭を既定選択にする(<select>はselected指定が無くても先頭を自動選択するため、
    // f.siteを空のままにすると表示上の選択と内部状態がずれ、会議室一覧が出ない不具合になっていた)
    f.site = newMaster ? newMaster.sites[0].id : '';
    f.room = ''; f.roomBusy = null;
    if (f.resourceType && Auth.mode === 'entra' && f.mode === 'single') { refreshFormRoomBusy(); return; }
    renderModal();
  });
  const siteSel = root.querySelector('#f-site');
  if (siteSel) siteSel.addEventListener('change', e => {
    f.site = e.target.value;
    f.room = ''; // 拠点を切り替えたら会議室は選び直す
    renderModal();
  });
  const roomSel = root.querySelector('#f-room');
  if (roomSel) roomSel.addEventListener('change', e => {
    f.room = e.target.value;
  });

  let memberSearchTimer = null;
  root.querySelector('#f-member-input').addEventListener('input', e => {
    const q = e.target.value.trim();
    clearTimeout(memberSearchTimer);
    if (!q) { memberSearchSeq++; memberCandidates = []; renderMemberCandidates(); return; } // 空にしたら、走っている検索の応答も捨てる
    memberSearchTimer = setTimeout(async () => {
      const mySeq = ++memberSearchSeq;
      try {
        const found = (await searchMembers(q))
          .filter(c => !f.members.some(m => m.email === c.email));
        if (mySeq !== memberSearchSeq) return; // 入力中に別の検索が走った場合、古い結果は捨てる
        memberCandidates = found;
        renderMemberCandidates();
      } catch { if (mySeq === memberSearchSeq) { memberCandidates = []; renderMemberCandidates(); } /* 検索失敗時は候補を出さない(新しい検索があれば、そちらを優先) */ }
    }, 180);
  });
  root.querySelectorAll('[data-rm-member]').forEach(b => b.addEventListener('click', () => {
    f.members.splice(Number(b.dataset.rmMember), 1);
    renderModal();
  }));
}

function renderMemberCandidates() {
  const box = document.getElementById('f-member-cands');
  if (!box) return;
  if (!memberCandidates.length) { box.innerHTML = ''; return; }
  box.innerHTML = `
  <div style="background:#ffffff;border:1px solid #dfe8f0;border-radius:10px;box-shadow:0 6px 20px rgba(15,35,60,0.15);overflow:hidden;margin-top:4px">
    ${memberCandidates.map((c, i) => `
      <button class="hv-cand" data-add-member="${i}" style="display:flex;align-items:center;gap:10px;width:100%;border:none;background:transparent;padding:9px 14px;cursor:pointer;text-align:left;font-family:inherit;${i < memberCandidates.length - 1 ? 'border-bottom:1px solid #f2f5f9;' : ''}">
        <span style="width:26px;height:26px;border-radius:50%;background:#4a7fc0;color:#ffffff;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0">${esc(c.name.charAt(0))}</span>
        <span style="display:flex;flex-direction:column;line-height:1.35;min-width:0">
          <span style="font-size:13px;font-weight:500;color:#1c2b3a">${esc(c.name)}</span>
          <span style="font-size:11px;color:#6b7d8f">${c.dept ? `${esc(c.dept)} ・ ` : ''}${esc(c.email)}</span>
        </span>
      </button>`).join('')}
  </div>`;
  box.querySelectorAll('[data-add-member]').forEach(b => b.addEventListener('click', () => {
    const c = memberCandidates[Number(b.dataset.addMember)];
    if (!formState.members.some(m => m.email === c.email)) formState.members.push(c);
    memberCandidates = [];
    renderModal();
  }));
}

async function submitCreateForm() {
  const f = formState;
  const errEl = document.getElementById('f-error');
  if (!f.title.trim()) { errEl.textContent = '件名/お客様名を入力してください'; return; }
  const multi = !f.eventId && f.mode && f.mode !== 'single'; // 複数の日程(連続した日・繰り返し)。開始・終了の前後の確認は、planMultiSchedule で行う
  if (!multi && f.start >= f.end) { errEl.textContent = '終了時刻は開始時刻より後にしてください'; return; }
  const activeMaster = resourceMaster(f.resourceType);
  if (activeMaster && !f.room) { errEl.textContent = `${activeMaster.itemLabel}を選択してください`; return; }

  const submitBtn = document.getElementById('f-submit');
  submitBtn.disabled = true;
  submitBtn.textContent = f.eventId ? '保存中…' : '作成中…';

  const room = activeMaster ? resourceRoomById(f.room) : null;
  const site = room ? activeMaster.sites.find(s => s.id === room.site) : null;
  try {
    // 会議室・社用車の重複を事前チェック(最新の空き状況を取り直して判定)。重複していたら予定自体を作らない。
    // なお同時刻に他の人が予約した直後などチェックをすり抜けた場合は、従来どおりExchange側が最終判定して自動辞退する
    let plan = null; // 複数の日程のときの、各回の日時・繰り返し
    if (multi) {
      plan = planMultiSchedule(f);
      if (plan.error) throw new Error(plan.error);
      if (room && Auth.mode === 'entra') { // 全ての回の空きを確認し、1回でも重なれば、予定も予約も作らない
        submitBtn.textContent = '空き状況を確認中…';
        const tk = await Auth.getGraphToken(['Calendars.ReadWrite', 'Calendars.ReadWrite.Shared']);
        const busyList = await fetchRoomIntervals(room, plan.firstDate, plan.lastDate, tk);
        const conflicts = findRangeConflicts(plan.intervals, busyList);
        if (conflicts.length) throw new Error(conflictMessage(conflicts, activeMaster.itemLabel));
        submitBtn.textContent = '作成中…';
      }
    } else if (room && Auth.mode === 'entra') {
      submitBtn.textContent = '空き状況を確認中…';
      const busy = (await fetchResourceBusy(parseISODate(f.date), f.resourceType))[room.id] || [];
      const isOwnOriginalSlot = it => f.orig && f.orig.room === room.id && f.orig.date === f.date
        && it.start === f.orig.start && it.end === f.orig.end;
      const conflict = busy.find(it => it.start < f.end && it.end > f.start && !isOwnOriginalSlot(it));
      if (conflict) {
        throw new Error(`この時間帯は既に予約があります(${conflict.start}–${conflict.end})。別の時間帯または${activeMaster.itemLabel}を選択してください`);
      }
      submitBtn.textContent = f.eventId ? '保存中…' : '作成中…';
    }

    const token = await Auth.getGraphToken(['Calendars.ReadWrite']);
    const attendees = f.members.map(m => ({ emailAddress: { address: m.email }, type: 'required' }));
    // 会議室は実際のExchangeリソースの出席者として追加する(サンプルではなく本物の予約)
    if (room) attendees.push({ emailAddress: { address: room.email, name: `${site.name} ${room.name}` }, type: 'resource' });

    const body = {
      subject: f.title.trim(),
      start: { dateTime: plan ? `${plan.startDT}:00` : `${f.date}T${f.start}:00`, timeZone: 'Tokyo Standard Time' },
      end: { dateTime: plan ? `${plan.endDT}:00` : `${f.date}T${f.end}:00`, timeZone: 'Tokyo Standard Time' },
      attendees
    };
    if (plan && plan.recurrence) body.recurrence = plan.recurrence; // 繰り返し(毎日・毎週・毎月。終わりは最後の日)
    // 場所の設定。会議室の場合はメールアドレスで会議室本体と紐づける(文字列だけだと
    // Exchangeが同一の会議室と認識できず、自動承諾時に場所が二重に追記されてしまう)。
    // locations(複数形)も同時に送って場所一覧を丸ごと置き換える(変更時の古い場所の残留・重複を掃除するため)
    if (room) {
      const loc = { displayName: `${site.name} ${room.name}`, locationEmailAddress: room.email, locationType: 'conferenceRoom' };
      body.location = loc;
      body.locations = [loc];
    } else if (f.place.trim()) {
      const loc = { displayName: f.place.trim() };
      body.location = loc;
      body.locations = [loc];
    } else if (f.eventId) {
      // 変更で場所を空にした場合はクリア
      body.location = { displayName: '' };
      body.locations = [];
    }
    const bodyText = encodeEventBody(f.content, f.guests);
    // 変更のときは、内容(と外部参加者)を変えたときだけ本文を送る(変えていないのに送ると、書式つきの本文や会議案内が、文字だけに置き換わる・消える)
    const norm = x => String(x).split(String.fromCharCode(13, 10)).join(String.fromCharCode(10)); // 改行コード(CRLFとLF)の違いだけでは、変更とみなさない
    if (f.eventId ? norm(bodyText) !== norm(f.origBody) : bodyText) body.body = { contentType: 'text', content: bodyText };

    // 打ち合わせの区分: 作成は選んだときだけ、変更は区分を変えたときだけ、分類項目を送る(ほかの分類項目は残す)
    if (f.eventId ? (f.origKind !== null && f.kind !== f.origKind) : !!f.kind) body.categories = categoriesWithKind(f.origCategories, MEETING_KINDS, f.kind);

    const url = f.eventId
      ? `https://graph.microsoft.com/v1.0/me/events/${f.eventId}`
      : 'https://graph.microsoft.com/v1.0/me/events';
    const res = await fetch(url, {
      method: f.eventId ? 'PATCH' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      throw new Error(err?.error?.message || `予定の${f.eventId ? '変更' : '作成'}に失敗しました(HTTP ${res.status})`);
    }

    // 作成した予定を含む日付に切り替えて再読み込み(会議室の自動承諾/辞退の反映には数秒かかる場合がある)
    const [yy, mm, dd] = (plan ? plan.firstDate : f.date).split('-').map(Number);
    state.date = new Date(yy, mm - 1, dd);
    closeForm();
    render();
  } catch (e) {
    errEl.textContent = e.message || String(e);
    submitBtn.disabled = false;
    submitBtn.textContent = f.eventId ? '変更を保存' : '作成する';
  }
}

/** 編集中の予定をOutlookから削除する(主催者のみ。会議室・参加者にはキャンセル通知が送られる) */
async function deleteEvent() {
  const f = formState;
  if (!f || !f.eventId) return;
  if (!confirm('この予定を削除しますか?(会議室や参加者には取消の通知が送られます)')) return;

  const deleteBtn = document.getElementById('f-delete');
  const errEl = document.getElementById('f-error');
  deleteBtn.disabled = true;
  deleteBtn.textContent = '削除中…';
  try {
    const token = await Auth.getGraphToken(['Calendars.ReadWrite']);
    const res = await fetch(`https://graph.microsoft.com/v1.0/me/events/${f.eventId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok && res.status !== 404) { // 404 = 既に削除済み。成功扱いにする
      const err = await res.json().catch(() => null);
      throw new Error(err?.error?.message || `予定の削除に失敗しました(HTTP ${res.status})`);
    }
    closeForm();
    render();
  } catch (e) {
    errEl.textContent = e.message || String(e);
    deleteBtn.disabled = false;
    deleteBtn.textContent = 'この予定を削除';
  }
}

// ---- 初期化 ----

function renderDateNav() {
  document.getElementById('date-label').textContent = dateLabel(state.date);
}

function shiftDay(n) {
  const d = new Date(state.date);
  d.setDate(d.getDate() + n);
  state.date = d;
  render();
}

async function render() {
  state.weekBase = null; // 日付の切り替え・予定の保存のあとは、選択中の日を含む週に戻す
  if (state.view === 'month') { // 月の表示中は、月のカレンダーだけを読み直す(予定の保存・削除のあとも、ここを通る)
    state.monthEvents = [];
    await loadAndRenderMonth();
    return;
  }
  renderDateNav();
  renderGridTabs();
  await Promise.all([loadAndRenderPersonal(), loadAndRenderSiteGrid(), loadAndRenderWeek()]);
}

// 自動リフレッシュ(共通方針: 2分間隔・モーダル表示中と非表示タブはスキップ・差分があるときだけ静かに差し替え)
async function autoRefresh() {
  if (formState || document.hidden) return;
  if (state.view === 'month') { // 月の表示中は、月の予定だけを静かに更新する
    const key = isoDate(currentMonthFirst());
    try {
      const events = await withTimeout(fetchMonthEvents(currentMonthFirst()), 20000, '月の予定の取得が時間内に完了しませんでした');
      if (formState || state.view !== 'month' || isoDate(currentMonthFirst()) !== key) return;
      if (JSON.stringify(events) !== JSON.stringify(state.monthEvents)) { state.monthEvents = events; renderMonth(); }
    } catch { /* 次回に再試行 */ }
    return;
  }
  const dateKey = isoDate(state.date); // 取得中に日付が切り替わったら結果を破棄するためのガード
  const tabKey = state.gridTab;       // 取得中にタブが切り替わったら予約状況の描き替えは見送る
  try {
    // 週の予定も静かに更新する(失敗しても他の更新は続ける)
    const weekKey = isoDate(currentWeekSunday());
    withTimeout(fetchWeekEvents(currentWeekSunday()), 15000, '週の予定の取得が時間内に完了しませんでした').then(weekEvents => {
      if (formState || isoDate(currentWeekSunday()) !== weekKey) return;
      if (JSON.stringify(weekEvents) !== JSON.stringify(state.weekEvents)) { state.weekEvents = weekEvents; renderWeek(); }
    }).catch(() => { /* 次回に再試行 */ });
    const [events, busy] = await Promise.all([
      fetchPersonalEvents(state.date),
      tabKey === 'yoshimura' ? fetchYoshimuraBusy(state.date)
        : tabKey === 'cars' ? fetchCarsBusy(state.date)
        : tabKey === 'sites' ? fetchRoomBusy(state.date)
        : Promise.resolve(null)
    ]);
    if (formState || isoDate(state.date) !== dateKey) return;
    if (JSON.stringify(events) !== JSON.stringify(state.personalEvents)) {
      state.personalEvents = events;
      renderPersonalEvents(events);
    }
    if (state.gridTab !== tabKey || busy == null) return;
    if (tabKey === 'yoshimura') {
      if (JSON.stringify(busy) !== JSON.stringify(state.yoshimuraBusy)) {
        state.yoshimuraBusy = busy;
        const grid = document.getElementById('site-grid');
        grid.innerHTML = yoshimuraGridHtml(busy, state.adminYoshimuraIds);
        bindSiteGridActions(grid);
      }
    } else if (tabKey === 'cars') {
      if (JSON.stringify(busy) !== JSON.stringify(state.carsBusy)) {
        state.carsBusy = busy;
        const grid = document.getElementById('site-grid');
        grid.innerHTML = carsGridHtml(busy, state.adminCarIds);
        bindSiteGridActions(grid);
      }
    } else if (JSON.stringify(busy) !== JSON.stringify(state.roomBusy)) {
      state.roomBusy = busy;
      const grid = document.getElementById('site-grid');
      grid.innerHTML = siteGridHtml(busy, state.adminSiteIds);
      bindSiteGridActions(grid);
    }
  } catch { /* 自動更新の失敗は静かに無視(次回に再試行) */ }
}

(async function init() {
  try {
    await Auth.init();
    state.adminSiteIds = myAdminSiteIds();
    state.adminYoshimuraIds = myAdminYoshimuraIds();
    state.adminCarIds = myAdminCarIds();

    // サインインしたアカウントのドメインで予約状況の初期タブを切り替える(ユーザー指示 2026-08-22)
    // @yoshimuraichi.com → 吉村一建設会議室 / @yumesumika.com → ゆめすみか展示場
    const myDomain = ((Auth.me && Auth.me.email) || '').toLowerCase().split('@')[1] || '';
    if (myDomain === 'yoshimuraichi.com') state.gridTab = 'yoshimura';
    else if (myDomain === 'yumesumika.com') state.gridTab = 'sites';

    // 週の予定の「‹ ›」: 表示する週だけを前後に動かす(選択中の日・上の「自分の予定」・会議室の空き状況は変えない)
    const shiftWeek = n => {
      const base = new Date(currentWeekSunday());
      base.setDate(base.getDate() + 7 * n);
      state.weekBase = base;
      state.weekEvents = [];
      loadAndRenderWeek();
    };
    document.getElementById('week-prev').addEventListener('click', () => shiftWeek(-1));
    document.getElementById('week-next').addEventListener('click', () => shiftWeek(1));
    document.getElementById('week-this').addEventListener('click', () => { state.weekBase = new Date(); state.weekEvents = []; loadAndRenderWeek(); }); // 今日を含む週へ
    // 月の表示(2026-11-17): 「‹ ›」は表示する月だけを動かす。「今月」は今日を含む月へ
    const shiftMonth = n => { const f = currentMonthFirst(); state.monthBase = new Date(f.getFullYear(), f.getMonth() + n, 1); state.monthEvents = []; loadAndRenderMonth(); };
    document.getElementById('view-week').addEventListener('click', () => { if (state.view !== 'week') setView('week'); });
    document.getElementById('view-month').addEventListener('click', () => { if (state.view !== 'month') setView('month'); });
    document.getElementById('month-prev').addEventListener('click', () => shiftMonth(-1));
    document.getElementById('month-next').addEventListener('click', () => shiftMonth(1));
    document.getElementById('month-this').addEventListener('click', () => { const n = new Date(); state.monthBase = new Date(n.getFullYear(), n.getMonth(), 1); state.monthEvents = []; loadAndRenderMonth(); });
    document.getElementById('prev-day').addEventListener('click', () => shiftDay(-1));
    document.getElementById('next-day').addEventListener('click', () => shiftDay(1));
    document.getElementById('today-btn').addEventListener('click', () => { state.date = new Date(); render(); });

    const createBtn = document.getElementById('create-event');
    if (Auth.mode === 'entra') {
      createBtn.addEventListener('click', openCreateForm);
    } else {
      createBtn.disabled = true;
      createBtn.title = 'devモードでは予定を作成できません';
      createBtn.style.opacity = '0.5';
      createBtn.style.cursor = 'not-allowed';
    }

    await render();

    // トップ画面の「今日の予定」から ?edit=<予定ID> で来た場合、その予定の変更フォームを開く。
    // 該当する予定が無い(削除済み・変更不可)ときは何もしない。再読み込みで開き直さないようURLから外す
    const editId = new URLSearchParams(location.search).get('edit');
    if (editId) {
      history.replaceState(null, '', location.pathname);
      const target = (state.personalEvents || []).find(ev => ev.id === editId && ev.editable);
      if (target) openEditForm(target);
    }

    if (Auth.mode === 'entra') setInterval(autoRefresh, 2 * 60 * 1000);
  } catch (e) {
    console.error(e);
    document.getElementById('personal-events').innerHTML =
      `<p style="margin:0;padding:6px 0;font-size:13px;color:#c05a5a">読み込みに失敗しました: ${esc(e.message || e)}</p>`;
  }
})();
