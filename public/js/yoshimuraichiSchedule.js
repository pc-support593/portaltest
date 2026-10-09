// 吉村一建設スタッフ予定ページ(2026-10-08追加。ユーザー指示)。ゆめすみかスタッフ予定(yumesumikaSchedule.js)と
// 同じ仕組みで、@yoshimuraichi.com のスタッフを、部署ごとのMS365グループのメンバーシップで分けて、
// 全員の予定を「日単位×2週間」の表で表示する。
// 必要なGraph権限は、ゆめすみか側と同じ(GroupMember.Read.All=グループメンバー取得、Calendars.ReadWrite.Shared=予定取得。
// いずれも同意済み。新規権限なし)。予定の件名まで表示するには、各スタッフの個人カレンダーにReviewer権限が必要
// (未付与の場合はその人の行に「取得失敗」と表示される。powershell.txt 8番)。
// ページ下の会議室予約状況は、ゆめすみか(展示場=タブごとに会議室が決まる)と異なり、吉村一建設の会議室は
// 人のグループと対応しないため、スタッフのタブとは別に、会議室専用のタブ(区分けごと)で切り替えて表示する
// (ユーザー指示 2026-10-08: 最初は全区分けを縦に並べていたが、タブで分けて表示する形に変更)。
// 会議室マスタは roomsData.js の YOSHIMURA_GROUPS / YOSHIMURA_ROOMS / yoshimuraGroupRooms を使う。
'use strict';

const WDAYS = ['日', '月', '火', '水', '木', '金', '土'];

// 部署ごとのMS365グループ(ユーザー提供・2026-10-08。タブはこの並び順)。メンバーを変えたいときは
// グループのメンバーを変更する(コードの修正は不要)。グループを増やすときはここに1行足す
const STAFF_GROUPS = [
  { id: 'soumu', name: '総務部', groupMail: 'soumu@yoshimuraichi.com' },
  { id: 'fudosan', name: '不動産部', groupMail: 'fudosan@yoshimuraichi.com' },
  { id: 'sekkei_kikaku', name: '設計企画部', groupMail: 'sekkei_kikaku@yoshimuraichi.com' },
  { id: 'koubai', name: '購買部', groupMail: 'koubai@yoshimuraichi.com' },
  { id: 'customer', name: 'カスタマーサポート室', groupMail: 'customer@yoshimuraichi.com' },
  { id: 'exterior', name: 'エクステリア事業係', groupMail: 'exterior@yoshimuraichi.com' },
  { id: 'logistics', name: '物流事業係', groupMail: 'logistics@yoshimuraichi.com' },
  { id: 'carpenter', name: 'フレミング大工', groupMail: 'carpenter@yoshimuraichi.com' },
  { id: 'kenchiku', name: '建築営業部', groupMail: 'kenchiku@yoshimuraichi.com' },
  { id: 'koumu_1', name: '工務部(本社)', groupMail: 'koumu_1@yoshimuraichi.com' },
  { id: 'koumu_2', name: '工務部(平野)', groupMail: 'koumu_2@yoshimuraichi.com' },
  { id: 'koumu_3', name: '工務部(西宮)', groupMail: 'koumu_3@yoshimuraichi.com' },
  { id: 'reform', name: 'リフォーム部', groupMail: 'reform@yoshimuraichi.com' }
];

const DAYS_SPAN = 14; // 2週間分

/** 表示名から「(吉村一建設)」「(ゆめすみか)」などの会社名の括弧書きを取り除く(名前が長くて切れて見えるため。2026-10-08・ユーザー指示) */
function displayName(name) {
  return String(name || '').replace(/s*[(（][^)）]*(吉村一建設|ゆめすみか)[^)）]*[)）]s*/g, ' ').replace(/s+/g, ' ').trim() || String(name || '');
}

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
  groupTab: STAFF_GROUPS[0].id,
  date: new Date(),    // 表示する2週間の開始日(会議室セクションは、このうち開始日ぶんを表示する)
  members: {},         // groupId -> [{id,name,email}] (グループ切替のたびに取得。日付切替では再取得しない)
  busy: null,          // email -> { byDate: { 'YYYY-MM-DD': [{time,subject}] } } | { error }
  roomsBusy: null,     // roomId -> [{start,end,subject,organizer,tentative}] | null(取得失敗) / 全体がnullなら読み込み中
  roomsDateKey: null,  // roomsBusy を取得した日付(同じ日のタブ切替では再取得しない)
  roomTab: YOSHIMURA_GROUPS[0].id // 会議室セクションで選択中の区分け(スタッフのタブとは独立)
};

/** Graphのエラーレスポンスから可能な限り具体的なメッセージを取り出す */
async function graphErrorMessage(res) {
  try {
    const data = await res.json();
    if (data && data.error) return `HTTP ${res.status}: ${data.error.code || ''} ${data.error.message || ''}`.trim();
  } catch { /* 本文がJSONでない場合はステータスのみ */ }
  return `HTTP ${res.status}`;
}

/** メールアドレスからMS365グループを特定し、そのメンバー一覧(ユーザーのみ)を取得する。
    ゆめすみか側と異なり、グループの中に別のグループ(入れ子)が含まれていても、ユーザーだけに絞る */
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
  const isUser = m => (m['@odata.type'] || '#microsoft.graph.user') === '#microsoft.graph.user';
  const collator = (a, b) => (a.displayName || '').localeCompare(b.displayName || '', 'ja');
  return members.filter(m => isUser(m) && m.mail).sort(collator).map(m => ({ id: m.id, name: m.displayName || '(名前未設定)', email: m.mail }));
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
          (byDate[dateKey] ||= []).push({ time: ev.start.dateTime.slice(11, 16), end: ev.end.dateTime.slice(11, 16), subject: ev.subject || '(件名なし)' });
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

/** 指定日の各会議室の予約状況(件名・予約者名)を並行取得する。1件ずつtry/catchし、失敗した会議室は null にする */
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

/** 1つの区分けの会議室カード群のHTML(表示のみ。削除機能は無い) */
function roomCardsHtml(rooms, busyMap) {
  return rooms.map(r => {
    const items = busyMap[r.id];
    const body = items === null || items === undefined
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

/** 会議室予約状況セクション: 区分け(アネックスプラザ・ゲストプラザ・本社・社長室・会長室)のタブで切り替えて表示する。
    スタッフのタブとは独立。全10室は日付ごとに1回だけ取得し、区分けの切替では取得し直さない */
function renderRooms() {
  const wrap = document.getElementById('rooms-wrap');
  if (Auth.mode !== 'entra') { wrap.style.display = 'none'; return; }
  wrap.style.display = '';
  const d = windowDates(state.date)[0];
  document.getElementById('rooms-title').textContent = `吉村一建設会議室の予約状況(${d.getMonth() + 1}/${d.getDate()})`;

  const tabs = document.getElementById('rooms-tabs');
  tabs.innerHTML = YOSHIMURA_GROUPS.map(g => {
    const sel = g.id === state.roomTab;
    return `<button class="hv-site" data-room-tab="${g.id}" style="border:1px solid ${sel ? '#1e5fa8' : '#dfe8f0'};background:${sel ? '#1e5fa8' : '#ffffff'};color:${sel ? '#ffffff' : '#1c2b3a'};font-weight:700;border-radius:9px;padding:8px 18px;font-size:13px;cursor:pointer;font-family:inherit;white-space:nowrap">${esc(g.name)}</button>`;
  }).join('');
  tabs.querySelectorAll('[data-room-tab]').forEach(b => b.addEventListener('click', () => {
    if (state.roomTab === b.dataset.roomTab) return;
    state.roomTab = b.dataset.roomTab;
    renderRooms();
  }));

  const section = document.getElementById('rooms-section');
  if (!state.roomsBusy) { section.innerHTML = '<p style="margin:0;padding:8px 0;font-size:13px;color:#8a99a8">読み込み中…</p>'; return; }
  section.innerHTML = roomCardsHtml(yoshimuraGroupRooms(state.roomTab), state.roomsBusy);
}

/** 1人・1日ぶんのマスのHTML */
function dayCellHtml(entry, dateKey, isToday) {
  const base = `flex:1;min-width:200px;padding:6px 6px;border-bottom:1px solid #f2f5f9;border-left:1px solid #f5f7fa;${isToday ? 'background:#f2f6fb' : ''}`;
  if (!entry || entry.error) {
    return `<div style="${base}"><span style="font-size:10px;color:#c05a5a">取得失敗</span></div>`;
  }
  const items = (entry.byDate[dateKey] || []).slice().sort((a, b) => a.time.localeCompare(b.time));
  if (!items.length) return `<div style="${base}"></div>`;
  const body = items.map(it =>
    `<div title="${esc(it.time)}${it.end ? '–' + esc(it.end) : ''} ${esc(it.subject)}" style="font-size:11px;color:#1c2b3a;line-height:1.5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"><span style="font-weight:700;color:#1e5fa8">${esc(it.time)}${it.end ? '–' + esc(it.end) : ''}</span> ${esc(it.subject)}</div>`
  ).join('');
  return `<div style="${base}display:flex;flex-direction:column;gap:2px">${body}</div>`;
}

function renderGroupTabs() {
  const title = document.getElementById('group-title');
  const current = STAFF_GROUPS.find(g => g.id === state.groupTab) || STAFF_GROUPS[0];
  if (title) title.textContent = `${current.name}のスタッフ予定`;
  const el = document.getElementById('group-tabs');
  el.innerHTML = STAFF_GROUPS.map(g => {
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
    <div style="width:140px;flex-shrink:0;position:sticky;left:0;z-index:2;background:#ffffff"></div>
    ${dates.map(d => {
      const key = isoDate(d);
      return `<div style="flex:1;min-width:200px;text-align:center;font-size:11px;font-weight:700;color:${key === todayKey ? '#1e5fa8' : '#6b7d8f'};padding:6px 4px;border-bottom:1px solid #eef1f5;${key === todayKey ? 'background:#f2f6fb' : ''}">${d.getMonth() + 1}/${d.getDate()}(${WDAYS[d.getDay()]})</div>`;
    }).join('')}
  </div>`;
  const rows = members.map(p => {
    const entry = state.busy[p.email];
    return `<div style="display:flex;border-bottom:1px solid #f2f5f9">
      <div title="${esc(p.name)}" style="width:140px;flex-shrink:0;position:sticky;left:0;z-index:2;background:#ffffff;box-shadow:1px 0 0 #eef1f5;font-size:12px;font-weight:700;color:#1c2b3a;padding:7px 10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(displayName(p.name))}</div>
      ${dates.map(d => dayCellHtml(entry, isoDate(d), isoDate(d) === todayKey)).join('')}
    </div>`;
  }).join('');
  el.innerHTML = `<div style="overflow-x:auto"><div style="min-width:3000px">${header}${rows}</div></div>`;
}

async function loadMembers() {
  if (state.members[state.groupTab]) return;
  const group = STAFF_GROUPS.find(g => g.id === state.groupTab);
  try {
    state.members[state.groupTab] = await fetchGroupMembers(group.groupMail);
  } catch (e) {
    console.error(e);
    document.getElementById('timeline').innerHTML = `<p style="margin:0;padding:8px 0;font-size:13px;color:#c05a5a">${esc(e.message || String(e))}</p>`;
    throw e;
  }
}

/** 会議室の予約状況を読み込む。同じ日のタブ切替では取得し直さない(全タブで同じ内容のため) */
async function loadRooms() {
  const key = isoDate(windowDates(state.date)[0]);
  if (state.roomsBusy && state.roomsDateKey === key) { renderRooms(); return; }
  state.roomsBusy = null;
  renderRooms();
  const busy = await fetchRoomsBusy(key, YOSHIMURA_ROOMS);
  state.roomsBusy = busy;
  state.roomsDateKey = key;
  renderRooms();
}

async function render() {
  document.getElementById('date-label').textContent = windowLabel(state.date);
  renderGroupTabs();
  state.busy = null;
  renderTimeline();
  if (Auth.mode !== 'entra') { renderRooms(); return; }

  const roomsPromise = loadRooms(); // 会議室はメンバー取得と並行して読み込む(1件の失敗で全体を止めない)

  try {
    await loadMembers();
  } catch {
    // メンバー一覧のエラーメッセージは loadMembers 内で表示済み。会議室セクションは独立して継続する
    await roomsPromise;
    return;
  }
  renderTimeline();
  const members = state.members[state.groupTab];
  const tab = state.groupTab;
  const busy = await fetchPeopleBusy(state.date, members);
  if (state.groupTab !== tab) return; // 取得中に別のタブへ切り替えられた場合は、古い結果で描き替えない
  state.busy = busy;
  renderTimeline();
  await roomsPromise;
}

/** 表示する2週間を前後にずらす */
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
  const tab = state.groupTab;
  try {
    if (members) {
      const busy = await fetchPeopleBusy(state.date, members);
      if (state.groupTab === tab && JSON.stringify(busy) !== JSON.stringify(state.busy)) {
        state.busy = busy;
        renderTimeline();
      }
    }
    const key = isoDate(windowDates(state.date)[0]);
    const roomsBusy = await fetchRoomsBusy(key, YOSHIMURA_ROOMS);
    if (isoDate(windowDates(state.date)[0]) === key && JSON.stringify(roomsBusy) !== JSON.stringify(state.roomsBusy)) {
      state.roomsBusy = roomsBusy;
      state.roomsDateKey = key;
      renderRooms();
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
