// ゆめすみかスタッフ予定ページ(2026-10-01追加。ユーザー指示)。
// @yumesumika.com のスタッフだけを対象に、展示場(+設計)ごとのMS365グループのメンバー全員の
// 予定を表示する。メンバーの判定は Entra ID の department 属性ではなく、実際に運用されている
// MS365グループのメンバーシップを使う(ユーザー指示 2026-09-30〜10-01)。
// 表示形式は「日単位×2週間」の表(2026-10-02変更。ユーザー指示: 時間単位ではなく日単位で
// 2週分を見たい)。各日のマスには、その日の予定の件名を簡潔に並べる(複数件は改行)。
// 必要な追加Graph権限: GroupMember.Read.All(委任。グループメンバー一覧の取得に必要。要管理者同意)。
// 「本社」タブ(2026-10-02追加)のみMS365グループを介さず、指定されたメールアドレスを直接
// メンバーとして扱う(ユーザー指示。表示名の取得は既存のUser.Read.Allで足り新規権限は不要)。
// 予定の件名まで表示するには、各スタッフの個人カレンダーにもReviewer権限の付与が必要
// (会議室と同じ要領。未実行の場合は403になりその人の行にエラー表示。powershell.txt参照)。
// スタッフ予定の下に、その拠点の会議室予約状況も表示する(2026-10-02追加。ユーザー指示。
// ゆめすみか展示場の5拠点タブのみ対象。「本社」タブはメンバー表示のみでよいとのこと)。
'use strict';

const WDAYS = ['日', '月', '火', '水', '木', '金', '土'];

// 展示場(+設計)ごとのMS365グループ。泉佐野は対応するグループが未作成のため対象外
// (ユーザー指示 2026-10-01。グループが用意され次第ここに追記する)。
// 設計(sekkei)は hidden:true で一旦タブから非表示にしている(ユーザー指示 2026-10-02。
// 後で使う可能性があるため、仕組み(グループ定義・取得ロジック)はそのまま残す。
// 再表示する場合は hidden: true の行を削除するだけでよい)
// 「本社」(honsha)はMS365グループを介さず、指定された特定メンバーを直接扱う
// (ユーザー指示 2026-10-02。groupMailの代わりにmembers配列を持たせる)
const SHOWROOM_GROUPS = [
  { id: 'fukuda', name: '福田展示場', groupMail: 'yumesumika_1@yumesumika.com' },
  { id: 'nakamozu', name: '中百舌鳥展示場', groupMail: 'yumesumika_2@yumesumika.com' },
  { id: 'hirano', name: '平野展示場', groupMail: 'yumesumika_3@yumesumika.com' },
  { id: 'hanahaku', name: '花博展示場', groupMail: 'yumesumika_4@yumesumika.com' },
  { id: 'nishinomiya', name: '西宮展示場', groupMail: 'yumesumika_5@yumesumika.com' },
  { id: 'sekkei', name: '設計', groupMail: 'yumesumika_6@yumesumika.com', hidden: true },
  { id: 'honsha', name: '本社', members: ['n-morishita@yoshimuraichi.com', 'e-sekiya@yoshimuraichi.com'] }
];

/** タブに表示する(非表示扱いでない)グループ一覧 */
function visibleGroups() { return SHOWROOM_GROUPS.filter(g => !g.hidden); }

const DAYS_SPAN = 14; // 2週間分

/** 表示開始日から14日分の日付配列を返す(時刻は切り捨て) */
function windowDates(startDate) {
  const base = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
  return Array.from({ length: DAYS_SPAN }, (_, i) => {
    const d = new Date(base);
    d.setDate(d.getDate() + i);
    return d;
  });
}

function windowLabel(startDate) {
  const dates = windowDates(startDate);
  const first = dates[0], last = dates[dates.length - 1];
  const fmt = d => `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日(${WDAYS[d.getDay()]})`;
  return `${fmt(first)} 〜 ${first.getFullYear() === last.getFullYear() ? `${last.getMonth() + 1}月${last.getDate()}日(${WDAYS[last.getDay()]})` : fmt(last)}`;
}

const state = {
  groupTab: visibleGroups()[0].id,
  date: new Date(), // 表示する2週間の開始日(会議室セクションは、このうち開始日ぶんを表示する)
  members: {},      // groupId -> [{id,name,email}] (グループ切替のたびに取得。日付切替では再取得しない)
  busy: null,       // email -> { byDate: { 'YYYY-MM-DD': [{time,subject}] } } | { error }
  roomsBusy: null   // roomId -> [{start,end,subject,organizer,tentative}] | null(読み込み中)
};

/** 会議室予約状況セクションを出すタブ(ゆめすみか展示場の5拠点のみ。本社・設計は対象外。
    ユーザー指示 2026-10-02: 「本社」タブはメンバー表示のみでよい)。
    roomsData.js の SITES/siteRooms(ゆめすみか展示場マスタ)をそのまま使う */
function roomsForTab(groupTab) {
  const site = SITES.find(s => s.id === groupTab);
  if (!site) return null;
  return { label: site.name, rooms: siteRooms(site.id) };
}

/** Graphのエラーレスポンスから可能な限り具体的なメッセージを取り出す
    (HTTPステータスだけだと原因切り分けに時間がかかるため) */
async function graphErrorMessage(res) {
  try {
    const data = await res.json();
    if (data && data.error) return `HTTP ${res.status}: ${data.error.code || ''} ${data.error.message || ''}`.trim();
  } catch { /* 本文がJSONでない場合はステータスのみ */ }
  return `HTTP ${res.status}`;
}

/** メールアドレスからMS365グループを特定し、そのメンバー一覧(社内メンバーのみ)を取得する */
async function fetchGroupMembers(groupMail) {
  const token = await Auth.getGraphToken(['GroupMember.Read.All']);
  const groupUrl = 'https://graph.microsoft.com/v1.0/groups' +
    `?$filter=${encodeURIComponent(`mail eq '${groupMail}'`)}&$select=id,displayName`;
  const groupRes = await fetch(groupUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (!groupRes.ok) throw new Error(`グループの取得に失敗しました(${await graphErrorMessage(groupRes)})`);
  const groupData = await groupRes.json();
  const group = (groupData.value || [])[0];
  if (!group) throw new Error(`グループが見つかりませんでした(${groupMail})`);

  let url = `https://graph.microsoft.com/v1.0/groups/${group.id}/members?$select=id,displayName,mail&$top=200`;
  const members = [];
  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`メンバー一覧の取得に失敗しました(${await graphErrorMessage(res)})`);
    const data = await res.json();
    members.push(...(data.value || []));
    url = data['@odata.nextLink'] || null;
  }
  const collator = (a, b) => (a.displayName || '').localeCompare(b.displayName || '', 'ja');
  return members.filter(m => m.mail).sort(collator).map(m => ({ id: m.id, name: m.displayName || '(名前未設定)', email: m.mail }));
}

/** 指定したメールアドレスのユーザー情報(表示名)を個別に取得する(MS365グループを介さない
    固定メンバーリスト用。2026-10-02追加。既存のUser.Read.Allで足りるため新規権限は不要)。
    1人ずつtry/catchし、取得に失敗した人はメールアドレスをそのまま表示名にする */
async function fetchStaticMembers(emails) {
  const token = await Auth.getGraphToken(['User.Read.All']);
  const results = await Promise.all(emails.map(async email => {
    try {
      const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(email)}?$select=id,displayName,mail`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) throw new Error(await graphErrorMessage(res));
      const u = await res.json();
      return { id: u.id, name: u.displayName || email, email: u.mail || email };
    } catch (e) {
      console.error(`「${email}」のユーザー情報取得に失敗しました`, e);
      return { id: email, name: email, email };
    }
  }));
  const collator = (a, b) => (a.name || '').localeCompare(b.name || '', 'ja');
  return results.sort(collator);
}

/** 表示中の2週間ぶんの予定(終日予定は除く)を、メンバーごとに1回のcalendarView呼び出しで
    まとめて取得し、日付(YYYY-MM-DD)ごとにグルーピングする。1人ずつtry/catchし、
    失敗した人は busy[email] = { error } にする(権限未設定等。1人の失敗で全体を壊さない) */
async function fetchPeopleBusy(startDate, people) {
  const token = await Auth.getGraphToken(['Calendars.ReadWrite.Shared']);
  const endDate = new Date(startDate);
  endDate.setDate(endDate.getDate() + DAYS_SPAN);
  const map = {};
  await Promise.all(people.map(async person => {
    try {
      const byDate = {};
      let url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(person.email)}/calendarView` +
        `?startDateTime=${encodeURIComponent(isoDate(startDate) + 'T00:00:00')}` +
        `&endDateTime=${encodeURIComponent(isoDate(endDate) + 'T00:00:00')}` +
        '&$select=subject,start,end,isAllDay&$orderby=start/dateTime&$top=200';
      while (url) {
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.timezone="Tokyo Standard Time"' } });
        if (!res.ok) throw new Error(await graphErrorMessage(res));
        const data = await res.json();
        (data.value || []).filter(ev => !ev.isAllDay).forEach(ev => {
          const dateKey = ev.start.dateTime.slice(0, 10);
          (byDate[dateKey] ||= []).push({ time: ev.start.dateTime.slice(11, 16), subject: ev.subject || '(件名なし)' });
        });
        url = data['@odata.nextLink'] || null;
      }
      map[person.email] = { byDate };
    } catch (e) {
      console.error(`「${person.name}」の予定取得に失敗しました`, e);
      map[person.email] = { error: e.message || String(e) };
    }
  }));
  return map;
}

/** 指定日の各会議室の予約状況(件名・予約者名)を並行取得する(schedule.jsの
    fetchCalendarViewBusyと同じ処理。このページではschedule.jsを読み込んでいないため
    同等の処理をここに持つ)。1件ずつtry/catchし、失敗した会議室は空扱いにする */
async function fetchRoomsBusy(dateStr, rooms) {
  const token = await Auth.getGraphToken(['Calendars.ReadWrite.Shared']);
  const map = {};
  await Promise.all(rooms.map(async room => {
    try {
      const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(room.email)}/calendarView` +
        `?startDateTime=${encodeURIComponent(dateStr + 'T00:00:00')}` +
        `&endDateTime=${encodeURIComponent(dateStr + 'T23:59:59')}` +
        '&$select=id,subject,start,end,organizer,showAs&$orderby=start/dateTime';
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.timezone="Tokyo Standard Time"' } });
      if (!r.ok) throw new Error(await graphErrorMessage(r));
      const d = await r.json();
      map[room.id] = (d.value || []).map(ev => ({
        start: ev.start.dateTime.slice(11, 16),
        end: ev.end.dateTime.slice(11, 16),
        subject: ev.subject || '(件名なし)',
        organizer: (ev.organizer && ev.organizer.emailAddress && ev.organizer.emailAddress.name) || '',
        tentative: ev.showAs === 'tentative'
      }));
    } catch (e) {
      console.error(`「${room.name}」の予約状況取得に失敗しました`, e);
      map[room.id] = null;
    }
  }));
  return map;
}

/** 会議室予約状況セクションのHTML(拠点内の各会議室をカード表示。schedule.jsの
    resourceGridHtmlを簡略化したもの。このページに削除機能は無いため表示のみ) */
function roomsSectionHtml(rooms, busyMap) {
  if (!busyMap) return '<p style="margin:0;padding:8px 0;font-size:13px;color:#8a99a8">読み込み中…</p>';
  return rooms.map(r => {
    const items = busyMap[r.id];
    const body = items === null
      ? '<p style="margin:0;padding:4px 0;font-size:12px;color:#c05a5a">取得に失敗しました</p>'
      : !items.length
        ? '<p style="margin:0;padding:4px 0;font-size:12px;color:#8a99a8">この日の予約はありません</p>'
        : items.map(b => `
          <div style="display:flex;align-items:center;gap:8px;background:${r.color};border-radius:6px;padding:6px 10px${b.tentative ? ';opacity:0.65' : ''}">
            <span style="font-size:11px;font-weight:700;color:#ffffff;white-space:nowrap">${esc(b.start)}–${esc(b.end)}</span>
            <span style="font-size:12px;font-weight:500;color:#ffffff;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(b.subject)}${b.organizer ? ' ・ ' + esc(b.organizer) : ''}</span>
            ${b.tentative ? '<span style="font-size:10px;font-weight:700;color:#4a3800;background:#f5b301;border-radius:4px;padding:1px 6px;white-space:nowrap;flex-shrink:0">承諾待ち</span>' : ''}
          </div>`).join('');
    return `
    <div style="border:1px solid #eef1f5;border-radius:10px;overflow:hidden;display:flex;flex-direction:column">
      <div style="padding:9px 15px;background:#f7fafd;border-bottom:1px solid #eef1f5">
        <span style="font-size:13px;font-weight:700;color:#1c2b3a">${esc(r.name)}</span>
      </div>
      <div style="padding:10px 15px;display:flex;flex-direction:column;gap:6px">${body}</div>
    </div>`;
  }).join('');
}

function renderRooms() {
  const wrap = document.getElementById('rooms-wrap');
  const info = roomsForTab(state.groupTab);
  if (!info || Auth.mode !== 'entra') { wrap.style.display = 'none'; return; }
  wrap.style.display = '';
  document.getElementById('rooms-title').textContent = `${info.label}の会議室予約状況(${windowDates(state.date)[0].getMonth() + 1}/${windowDates(state.date)[0].getDate()})`;
  document.getElementById('rooms-section').innerHTML = roomsSectionHtml(info.rooms, state.roomsBusy);
}

/** 1人・1日ぶんのマスのHTML */
function dayCellHtml(entry, dateKey, isToday) {
  const base = `flex:1;min-width:100px;padding:6px 6px;border-bottom:1px solid #f2f5f9;border-left:1px solid #f5f7fa;${isToday ? 'background:#f2f6fb' : ''}`;
  if (!entry || entry.error) {
    return `<div style="${base}"><span style="font-size:10px;color:#c05a5a">取得失敗</span></div>`;
  }
  const items = (entry.byDate[dateKey] || []).slice().sort((a, b) => a.time.localeCompare(b.time));
  if (!items.length) return `<div style="${base}"></div>`;
  const body = items.map(it =>
    `<div title="${esc(it.time)} ${esc(it.subject)}" style="font-size:11px;color:#1c2b3a;line-height:1.5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(it.subject)}</div>`
  ).join('');
  return `<div style="${base}display:flex;flex-direction:column;gap:2px">${body}</div>`;
}

function renderGroupTabs() {
  const title = document.getElementById('group-title');
  const current = SHOWROOM_GROUPS.find(g => g.id === state.groupTab) || SHOWROOM_GROUPS[0];
  if (title) title.textContent = `${current.name}のスタッフ予定`;
  const el = document.getElementById('group-tabs');
  el.innerHTML = visibleGroups().map(g => {
    const sel = g.id === state.groupTab;
    return `<button class="hv-site" data-group-tab="${g.id}" style="border:1px solid ${sel ? '#1e5fa8' : '#dfe8f0'};background:${sel ? '#1e5fa8' : '#ffffff'};color:${sel ? '#ffffff' : '#1c2b3a'};font-weight:700;border-radius:9px;padding:8px 18px;font-size:13px;cursor:pointer;font-family:inherit;white-space:nowrap">${esc(g.name)}</button>`;
  }).join('');
  el.querySelectorAll('[data-group-tab]').forEach(b => b.addEventListener('click', () => {
    if (state.groupTab === b.dataset.groupTab) return;
    state.groupTab = b.dataset.groupTab;
    state.members = {}; // タブ切替時はメンバー一覧も取得し直す
    render();
  }));
}

function renderTimeline() {
  const el = document.getElementById('timeline');
  if (Auth.mode !== 'entra') {
    el.innerHTML = '<p style="margin:0;padding:8px 0;font-size:13px;color:#8a99a8">devモードではスタッフ予定を確認できません(Entra IDでのサインインが必要です)</p>';
    return;
  }
  const members = state.members[state.groupTab];
  if (!members) { el.innerHTML = '<p style="margin:0;padding:8px 0;font-size:13px;color:#8a99a8">読み込み中…</p>'; return; }
  if (!members.length) { el.innerHTML = '<p style="margin:0;padding:8px 0;font-size:13px;color:#8a99a8">このグループにメンバーが見つかりませんでした</p>'; return; }
  if (!state.busy) { el.innerHTML = '<p style="margin:0;padding:8px 0;font-size:13px;color:#8a99a8">予定を取得中…</p>'; return; }

  const dates = windowDates(state.date);
  const todayKey = isoDate(new Date());
  const header = `<div style="display:flex">
    <div style="width:140px;flex-shrink:0"></div>
    ${dates.map(d => {
      const key = isoDate(d);
      return `<div style="flex:1;min-width:100px;text-align:center;font-size:11px;font-weight:700;color:${key === todayKey ? '#1e5fa8' : '#6b7d8f'};padding:6px 4px;border-bottom:1px solid #eef1f5;${key === todayKey ? 'background:#f2f6fb' : ''}">${d.getMonth() + 1}/${d.getDate()}(${WDAYS[d.getDay()]})</div>`;
    }).join('')}
  </div>`;
  const rows = members.map(p => {
    const entry = state.busy[p.email];
    return `<div style="display:flex;border-bottom:1px solid #f2f5f9">
      <div style="width:140px;flex-shrink:0;font-size:12px;font-weight:700;color:#1c2b3a;padding:7px 10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.name)}</div>
      ${dates.map(d => dayCellHtml(entry, isoDate(d), isoDate(d) === todayKey)).join('')}
    </div>`;
  }).join('');
  el.innerHTML = `<div style="overflow-x:auto"><div style="min-width:1600px">${header}${rows}</div></div>`;
}

async function loadMembers() {
  if (state.members[state.groupTab]) return;
  const group = SHOWROOM_GROUPS.find(g => g.id === state.groupTab);
  try {
    state.members[state.groupTab] = group.members
      ? await fetchStaticMembers(group.members)
      : await fetchGroupMembers(group.groupMail);
  } catch (e) {
    console.error(e);
    document.getElementById('timeline').innerHTML = `<p style="margin:0;padding:8px 0;font-size:13px;color:#c05a5a">${esc(e.message || String(e))}</p>`;
    throw e;
  }
}

async function render() {
  document.getElementById('date-label').textContent = windowLabel(state.date);
  renderGroupTabs();
  state.busy = null;
  state.roomsBusy = null;
  renderTimeline();
  renderRooms();
  if (Auth.mode !== 'entra') return;

  const roomsInfo = roomsForTab(state.groupTab);
  const roomsPromise = roomsInfo ? fetchRoomsBusy(isoDate(state.date), roomsInfo.rooms) : Promise.resolve(null);

  try {
    await loadMembers();
  } catch {
    // メンバー一覧のエラーメッセージは loadMembers 内で表示済み。会議室セクションは独立して継続する
    state.roomsBusy = await roomsPromise;
    renderRooms();
    return;
  }
  renderTimeline();
  const members = state.members[state.groupTab];
  const [busy, roomsBusy] = await Promise.all([fetchPeopleBusy(state.date, members), roomsPromise]);
  state.busy = busy;
  state.roomsBusy = roomsBusy;
  renderTimeline();
  renderRooms();
}

/** 表示する2週間を前後にずらす(2026-10-02変更: 1日ずつではなく2週間単位でずらす) */
function shiftWindow(n) {
  const d = new Date(state.date);
  d.setDate(d.getDate() + n * DAYS_SPAN);
  state.date = d;
  render();
}

// 自動リフレッシュ(共通方針: 2分間隔・非表示タブはスキップ・差分があるときだけ静かに差し替え)
async function autoRefresh() {
  if (document.hidden || Auth.mode !== 'entra') return;
  const members = state.members[state.groupTab];
  const roomsInfo = roomsForTab(state.groupTab);
  try {
    if (members) {
      const busy = await fetchPeopleBusy(state.date, members);
      if (JSON.stringify(busy) !== JSON.stringify(state.busy)) {
        state.busy = busy;
        renderTimeline();
      }
    }
    if (roomsInfo) {
      const roomsBusy = await fetchRoomsBusy(isoDate(state.date), roomsInfo.rooms);
      if (JSON.stringify(roomsBusy) !== JSON.stringify(state.roomsBusy)) {
        state.roomsBusy = roomsBusy;
        renderRooms();
      }
    }
  } catch { /* 自動更新の失敗は静かに無視(次回に再試行) */ }
}

(async function init() {
  try {
    await Auth.init();
    document.getElementById('prev-day').title = '前の2週間';
    document.getElementById('next-day').title = '次の2週間';
    document.getElementById('prev-day').addEventListener('click', () => shiftWindow(-1));
    document.getElementById('next-day').addEventListener('click', () => shiftWindow(1));
    document.getElementById('today-btn').addEventListener('click', () => { state.date = new Date(); render(); });
    await render();
    if (Auth.mode === 'entra') setInterval(autoRefresh, 2 * 60 * 1000);
  } catch (e) {
    console.error(e);
    document.getElementById('timeline').innerHTML =
      `<p style="margin:0;padding:8px 0;font-size:13px;color:#c05a5a">読み込みに失敗しました: ${esc(e.message || e)}</p>`;
  }
})();
