// スケジュール画面
// 個人のスケジュールは実データ(Graph /me/calendarView・/me/events)。
// 拠点別 会議室のスケジュールも実データ(Graph /me/calendar/getSchedule)。
// 会議室は実際のExchange会議室リソース(Room Mailbox)。予定作成時に「会議室を使用する」を
// チェックすると、その会議室を出席者(type: resource)として追加し、Exchange側が
// 空いていれば自動承諾・埋まっていれば自動辞退する(サンプルではなく実際の予約)。
'use strict';

const pad = n => String(n).padStart(2, '0');
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

const state = {
  date: new Date(),
  roomBusy: null, // { [roomId]: [{start, end, subject}] } 選択中の日の会議室の空き状況(実データ)
  personalEvents: [] // 直近に取得した個人の予定(編集フォームを開く際に参照)
};

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
    `?startDateTime=${encodeURIComponent(dateStr + 'T00:00:00')}` +
    `&endDateTime=${encodeURIComponent(dateStr + 'T23:59:59')}` +
    '&$select=id,subject,start,end,location,isAllDay,isOrganizer,attendees,body&$orderby=start/dateTime';

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.timezone="Tokyo Standard Time"' }
  });
  if (!res.ok) throw new Error(`予定表の取得に失敗しました(HTTP ${res.status})`);
  const data = await res.json();

  // 主催者かつ終日でない予定のみ変更可能(参加者としての予定はOutlookと同様に編集できない)
  return (data.value || []).map((ev, i) => ({
    id: ev.id,
    editable: !!ev.isOrganizer && !ev.isAllDay,
    isAllDay: ev.isAllDay,
    date: ev.start.dateTime.slice(0, 10),
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
    ...PERSONAL_COLOR_CYCLE[i % PERSONAL_COLOR_CYCLE.length]
  }));
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
      ${e.place ? `<span style="font-size:12px;color:#6b7d8f">${esc(e.place)}</span>` : ''}
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

// ---- 拠点別 会議室スケジュール(実データ。Graph getSchedule) ----

/** 指定日の全会議室の空き状況を1回のGraph呼び出しで取得。devモードは空({})。 */
async function fetchRoomBusy(date) {
  if (Auth.mode !== 'entra') return {};

  const dateStr = isoDate(date);
  const token = await Auth.getGraphToken(['Calendars.ReadWrite']);
  const res = await fetch('https://graph.microsoft.com/v1.0/me/calendar/getSchedule', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'outlook.timezone="Tokyo Standard Time"' },
    body: JSON.stringify({
      schedules: ROOMS.map(r => r.email),
      startTime: { dateTime: `${dateStr}T00:00:00`, timeZone: 'Tokyo Standard Time' },
      endTime: { dateTime: `${dateStr}T23:59:59`, timeZone: 'Tokyo Standard Time' },
      availabilityViewInterval: 30
    })
  });
  if (!res.ok) throw new Error(`会議室の空き状況の取得に失敗しました(HTTP ${res.status})`);
  const data = await res.json();

  const roomByEmail = new Map(ROOMS.map(r => [r.email.toLowerCase(), r]));
  const map = {};
  (data.value || []).forEach(v => {
    const room = roomByEmail.get(String(v.scheduleId || '').toLowerCase());
    if (!room) return;
    const items = (v.scheduleItems || [])
      .filter(it => it.status && it.status !== 'free')
      .map(it => ({
        start: it.start.dateTime.slice(11, 16),
        end: it.end.dateTime.slice(11, 16),
        subject: it.subject || '',
        // tentative = 会議室がまだ承諾していない仮の状態(この後、自動承諾または重複なら自動辞退される)
        tentative: it.status === 'tentative'
      }))
      .sort((a, b) => a.start.localeCompare(b.start));
    // 同一予定の重複表示を除去(自動承諾処理中は同じ予定が仮+確定で二重に返ることがある。
    // 件名・状態まで同じもののみ除去し、異なる予定が同時刻にある場合は両方表示する)
    const seen = new Set();
    map[room.id] = items.filter(it => {
      const key = `${it.start}-${it.end}-${it.tentative}-${it.subject}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });
  return map;
}

/** 拠点別カードのHTML。roomBusyMap が null なら読み込み中表示。純粋関数。 */
function siteGridHtml(roomBusyMap) {
  if (!roomBusyMap) return '<p style="margin:0;padding:8px 0;font-size:13px;color:#8a99a8">読み込み中…</p>';
  return SITES.map(s => {
    const rooms = siteRooms(s.id);
    const rows = rooms.flatMap(r => (roomBusyMap[r.id] || []).map(b => ({ ...b, room: r })))
      .sort((a, b) => a.start.localeCompare(b.start))
      .map(b => `
      <div style="display:flex;align-items:center;gap:8px;background:${b.room.color};border-radius:6px;padding:6px 10px${b.tentative ? ';opacity:0.65' : ''}">
        <span style="font-size:11px;font-weight:700;color:#ffffff;white-space:nowrap">${esc(b.start)}–${esc(b.end)}</span>
        <span style="font-size:12px;font-weight:500;color:#ffffff;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(b.room.name)}${b.subject ? ' ・ ' + esc(b.subject) : ''}</span>
        ${b.tentative ? '<span style="font-size:10px;font-weight:700;color:#4a3800;background:#f5b301;border-radius:4px;padding:1px 6px;white-space:nowrap;flex-shrink:0">承諾待ち</span>' : ''}
      </div>`);
    const body = rows.length ? rows.join('') : '<p style="margin:0;padding:4px 0;font-size:12px;color:#8a99a8">この日の予約はありません</p>';
    return `
    <div style="border:1px solid #eef1f5;border-radius:10px;overflow:hidden;display:flex;flex-direction:column">
      <div style="padding:11px 15px;background:#f7fafd;display:flex;align-items:center;gap:8px;border-bottom:1px solid #eef1f5">
        <span style="font-size:13px;font-weight:700;color:#1c2b3a">${esc(s.name)}</span>
        <span style="font-size:11px;color:#8a99a8;margin-left:auto">${rooms.length}室</span>
      </div>
      <div style="padding:10px 15px;display:flex;flex-direction:column;gap:6px">${body}</div>
    </div>`;
  }).join('');
}

async function loadAndRenderSiteGrid() {
  const el = document.getElementById('site-grid');
  if (Auth.mode !== 'entra') {
    el.innerHTML = '<p style="margin:0;padding:8px 0;font-size:13px;color:#8a99a8">devモードでは会議室の空き状況を確認できません(Entra IDでのサインインが必要です)</p>';
    state.roomBusy = {};
    return;
  }
  el.innerHTML = siteGridHtml(null);
  try {
    state.roomBusy = await fetchRoomBusy(state.date);
    el.innerHTML = siteGridHtml(state.roomBusy);
  } catch (e) {
    console.error(e);
    state.roomBusy = {};
    el.innerHTML = `<p style="margin:0;padding:8px 0;font-size:13px;color:#c05a5a">${esc(e.message || String(e))}</p>`;
  }
}

// ---- 予定作成モーダル(個人の予定。任意で実際の会議室を出席者として追加) ----

function hourOptions() {
  // 予約可能時間は 8:00〜21:00(30分刻み)
  const opts = [];
  for (let h = 8; h <= 20; h++) { opts.push(`${pad(h)}:00`); opts.push(`${pad(h)}:30`); }
  opts.push('21:00');
  return opts;
}

let formState = null;
let memberCandidates = []; // 社内メンバー検索の候補

function openCreateForm() {
  const d = state.date;
  const firstSite = SITES[0];
  formState = {
    eventId: null, orig: null,
    date: isoDate(d),
    start: '10:00', end: '11:00', title: '', place: '', members: [], guests: '', error: '',
    useRoom: false, site: firstSite.id, room: (siteRooms(firstSite.id)[0] || {}).id || '',
    // 選択中の日と主画面の日が同じなら取得済みのroomBusyを再利用、違えば読み込み中から始める
    roomBusy: isoDate(d) === isoDate(state.date) ? state.roomBusy : null
  };
  memberCandidates = [];
  renderModal();
  if (formState.roomBusy == null && Auth.mode === 'entra') refreshFormRoomBusy();
}

/** 個人のスケジュール一覧のクリックから、既存の予定を変更モードで開く */
function openEditForm(ev) {
  // 会議室(resource出席者)を、メールアドレスの一致でこちらのROOMSマスタに逆引きする
  const roomEmails = new Set(ROOMS.map(r => r.email.toLowerCase()));
  const roomAttendee = ev.attendees.find(a => a.type === 'resource' || roomEmails.has((a.email || '').toLowerCase()));
  const matchedRoom = roomAttendee ? ROOMS.find(r => r.email.toLowerCase() === roomAttendee.email.toLowerCase()) : null;
  // 社内メンバー欄には「会議室でも自分自身でもない出席者」だけを復元する。
  // 会議室が required 側に混入していた場合にメンバー扱いで再送する(=会議室が二重に招待される)ことを防ぐ
  const myEmail = ((Auth.me && Auth.me.email) || '').toLowerCase();
  const members = ev.attendees
    .filter(a => a.type !== 'resource')
    .filter(a => a.email && !roomEmails.has(a.email.toLowerCase()) && a.email.toLowerCase() !== myEmail)
    .map(a => ({ name: a.name || a.email, email: a.email }));
  // 外部参加者メモは本文に「外部参加者: ...」の形で保存しているため復元を試みる(復元できなければ空欄)
  const guestsMatch = /^外部参加者: ([\s\S]*)$/.exec(ev.bodyText.trim());

  formState = {
    eventId: ev.id,
    // 変更前の会議室・時間帯(重複の事前チェックで「自分自身の既存予約」を重複扱いしないために使う)
    orig: { room: matchedRoom ? matchedRoom.id : null, date: ev.date, start: ev.start, end: ev.end },
    date: ev.date, start: ev.start, end: ev.end, title: ev.title,
    place: matchedRoom ? '' : ev.place, members, guests: guestsMatch ? guestsMatch[1].trim() : '', error: '',
    useRoom: !!matchedRoom,
    site: matchedRoom ? matchedRoom.site : SITES[0].id,
    room: matchedRoom ? matchedRoom.id : (siteRooms(SITES[0].id)[0] || {}).id || '',
    roomBusy: isoDate(parseISODate(ev.date)) === isoDate(state.date) ? state.roomBusy : null
  };
  memberCandidates = [];
  renderModal();
  if (formState.useRoom && formState.roomBusy == null && Auth.mode === 'entra') refreshFormRoomBusy();
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
  try { busy = await fetchRoomBusy(parseISODate(f.date)); } catch { busy = {}; }
  if (formState === f) { f.roomBusy = busy; renderModal(); }
}

function renderModal() {
  const root = document.getElementById('modal-root');
  if (!formState) { root.innerHTML = ''; return; }
  const f = formState;
  const opts = hourOptions();
  const selOpts = v => opts.map(o => `<option value="${o}" ${o === v ? 'selected' : ''}>${o}</option>`).join('');
  const memberChips = f.members.map((mb, i) => `
    <span style="display:flex;align-items:center;gap:6px;background:#e9f1fa;border:1px solid #c8dcf0;border-radius:16px;padding:3px 10px 3px 4px">
      <span style="width:22px;height:22px;border-radius:50%;background:#4a7fc0;color:#ffffff;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700">${esc(mb.name.charAt(0))}</span>
      <span style="font-size:12px;font-weight:500;color:#1c2b3a">${esc(mb.name)}</span>
      <button data-rm-member="${i}" style="border:none;background:transparent;cursor:pointer;color:#6b7d8f;font-size:11px;padding:0 2px">✕</button>
    </span>`).join('');

  const roomSection = f.useRoom ? `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px">
      <label style="display:flex;flex-direction:column;gap:5px">
        <span style="font-size:12px;font-weight:700;color:#6b7d8f">拠点</span>
        <select id="f-site" class="in-input">${SITES.map(s => `<option value="${s.id}" ${s.id === f.site ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
      </label>
      <label style="display:flex;flex-direction:column;gap:5px">
        <span style="font-size:12px;font-weight:700;color:#6b7d8f">会議室</span>
        <select id="f-room" class="in-input">${siteRooms(f.site).map(r => `<option value="${r.id}" ${r.id === f.room ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select>
      </label>
    </div>
    <div style="border:1px solid #eef1f5;border-radius:10px;overflow:hidden">
      <div style="padding:9px 15px;background:#f7fafd;border-bottom:1px solid #eef1f5;font-size:12px;font-weight:700;color:#6b7d8f">
        拠点の空き状況(${esc(f.date.split('-').slice(1).map(Number).join('/'))})
      </div>
      <div style="padding:10px 15px;display:flex;flex-direction:column;gap:8px;max-height:220px;overflow-y:auto">${siteGridHtml(f.roomBusy)}</div>
    </div>` : '';

  root.innerHTML = `
  <div id="form-overlay" style="position:fixed;inset:0;background:rgba(20,40,65,0.5);display:flex;align-items:center;justify-content:center;padding:24px;z-index:110">
    <div id="form-box" style="background:#ffffff;border-radius:16px;box-shadow:0 12px 40px rgba(15,35,60,0.3);max-width:520px;width:100%;max-height:88vh;display:flex;flex-direction:column;overflow:hidden">
      <div style="display:flex;align-items:center;gap:12px;padding:20px 26px;border-bottom:1px solid #e4ebf2">
        <h3 style="margin:0;font-size:17px;font-weight:700">${f.eventId ? '予定を変更' : '予定を作成'}</h3>
        <button class="hv-close" data-close style="margin-left:auto;border:none;background:#f0f4f8;border-radius:8px;width:32px;height:32px;cursor:pointer;color:#6b7d8f;font-size:15px;flex-shrink:0">✕</button>
      </div>
      <div style="padding:20px 26px;display:flex;flex-direction:column;gap:14px;overflow-y:auto">
        <p style="margin:0;font-size:12px;color:#8a99a8">${f.eventId ? '変更を保存すると実際にあなたのOutlook予定表に反映されます。' : '作成すると実際にあなたのOutlook予定表に反映されます。'}${f.useRoom ? '会議室は実際のExchangeリソースとして招待され、空いていれば自動承諾、埋まっていれば自動辞退されます。' : ''}</p>
        <label style="display:flex;flex-direction:column;gap:5px">
          <span style="font-size:12px;font-weight:700;color:#6b7d8f">件名</span>
          <input id="f-title" class="in-input" value="${esc(f.title)}" placeholder="例: 営業企画 定例MTG">
        </label>
        <label style="display:flex;flex-direction:column;gap:5px">
          <span style="font-size:12px;font-weight:700;color:#6b7d8f">日付</span>
          <input id="f-date" type="date" class="in-input" value="${esc(f.date)}">
        </label>
        <div style="display:flex;gap:12px;align-items:flex-end">
          <label style="display:flex;flex-direction:column;gap:5px;flex:1">
            <span style="font-size:12px;font-weight:700;color:#6b7d8f">開始</span>
            <select id="f-start" class="in-input">${selOpts(f.start)}</select>
          </label>
          <span style="font-size:14px;color:#8a99a8;padding-bottom:10px">〜</span>
          <label style="display:flex;flex-direction:column;gap:5px;flex:1">
            <span style="font-size:12px;font-weight:700;color:#6b7d8f">終了</span>
            <select id="f-end" class="in-input">${selOpts(f.end)}</select>
          </label>
        </div>
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" id="f-use-room" ${f.useRoom ? 'checked' : ''}>
          <span style="font-size:13px;font-weight:500;color:#1c2b3a">会議室を使用する</span>
          <span style="font-size:10px;font-weight:700;color:#2f6f8f;background:#e5f0f7;border-radius:4px;padding:1px 7px">Exchange 連携</span>
        </label>
        ${roomSection}
        ${!f.useRoom ? `
        <label style="display:flex;flex-direction:column;gap:5px">
          <span style="font-size:12px;font-weight:700;color:#6b7d8f">場所(任意・自由入力)</span>
          <input id="f-place" class="in-input" value="${esc(f.place)}" placeholder="例: オンライン">
        </label>` : ''}
        <div style="display:flex;flex-direction:column;gap:5px;position:relative">
          <span style="display:flex;align-items:center;gap:8px">
            <span style="font-size:12px;font-weight:700;color:#6b7d8f">社内メンバー(任意)</span>
            ${Auth.mode === 'entra'
              ? '<span style="font-size:10px;font-weight:700;color:#2f6f8f;background:#e5f0f7;border-radius:4px;padding:1px 7px">Microsoft 365</span>'
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
      <div style="padding:16px 26px;border-top:1px solid #e4ebf2;display:flex;gap:10px;justify-content:flex-end">
        <button class="hv-btn-plain" data-close style="border:1px solid #dfe8f0;background:#ffffff;color:#6b7d8f;font-weight:500;border-radius:9px;padding:10px 18px;font-size:13px;cursor:pointer;font-family:inherit">キャンセル</button>
        <button id="f-submit" class="hv-btn-primary" style="border:none;background:#1e5fa8;color:#ffffff;font-weight:700;border-radius:9px;padding:10px 24px;font-size:13px;cursor:pointer;font-family:inherit">${f.eventId ? '変更を保存' : '作成する'}</button>
      </div>
    </div>
  </div>`;

  root.querySelector('#form-overlay').addEventListener('click', closeForm);
  root.querySelector('#form-box').addEventListener('click', e => e.stopPropagation());
  root.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeForm));
  root.querySelector('#f-title').addEventListener('input', e => { f.title = e.target.value; });
  root.querySelector('#f-date').addEventListener('change', e => {
    f.date = e.target.value;
    if (f.useRoom && Auth.mode === 'entra') refreshFormRoomBusy();
    else renderModal();
  });
  root.querySelector('#f-start').addEventListener('change', e => { f.start = e.target.value; });
  root.querySelector('#f-end').addEventListener('change', e => { f.end = e.target.value; });
  const placeInput = root.querySelector('#f-place');
  if (placeInput) placeInput.addEventListener('input', e => { f.place = e.target.value; });
  root.querySelector('#f-guests').addEventListener('input', e => { f.guests = e.target.value; });
  root.querySelector('#f-submit').addEventListener('click', submitCreateForm);

  root.querySelector('#f-use-room').addEventListener('change', e => {
    f.useRoom = e.target.checked;
    if (f.useRoom) {
      if (!f.room) f.room = (siteRooms(f.site)[0] || {}).id || '';
      if (f.roomBusy == null && Auth.mode === 'entra') { refreshFormRoomBusy(); return; }
    }
    renderModal();
  });
  const siteSel = root.querySelector('#f-site');
  if (siteSel) siteSel.addEventListener('change', e => {
    f.site = e.target.value;
    f.room = (siteRooms(f.site)[0] || {}).id || '';
    renderModal();
  });
  const roomSel = root.querySelector('#f-room');
  if (roomSel) roomSel.addEventListener('change', e => { f.room = e.target.value; });

  let memberSearchTimer = null;
  root.querySelector('#f-member-input').addEventListener('input', e => {
    const q = e.target.value.trim();
    clearTimeout(memberSearchTimer);
    if (!q) { memberCandidates = []; renderMemberCandidates(); return; }
    memberSearchTimer = setTimeout(async () => {
      try {
        memberCandidates = (await searchMembers(q))
          .filter(c => !f.members.some(m => m.email === c.email));
        renderMemberCandidates();
      } catch { /* 検索失敗時は候補を出さない */ }
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
  if (!f.title.trim()) { errEl.textContent = '件名を入力してください'; return; }
  if (f.start >= f.end) { errEl.textContent = '終了時刻は開始時刻より後にしてください'; return; }
  if (f.useRoom && !f.room) { errEl.textContent = '会議室を選択してください'; return; }

  const submitBtn = document.getElementById('f-submit');
  submitBtn.disabled = true;
  submitBtn.textContent = f.eventId ? '保存中…' : '作成中…';

  const room = f.useRoom ? roomById(f.room) : null;
  const site = room ? SITES.find(s => s.id === room.site) : null;
  try {
    // 会議室の重複を事前チェック(最新の空き状況を取り直して判定)。重複していたら予定自体を作らない。
    // なお同時刻に他の人が予約した直後などチェックをすり抜けた場合は、従来どおりExchange側が最終判定して自動辞退する
    if (room && Auth.mode === 'entra') {
      submitBtn.textContent = '空き状況を確認中…';
      const busy = (await fetchRoomBusy(parseISODate(f.date)))[room.id] || [];
      const isOwnOriginalSlot = it => f.orig && f.orig.room === room.id && f.orig.date === f.date
        && it.start === f.orig.start && it.end === f.orig.end;
      const conflict = busy.find(it => it.start < f.end && it.end > f.start && !isOwnOriginalSlot(it));
      if (conflict) {
        throw new Error(`この時間帯は既に予約があります(${conflict.start}–${conflict.end})。別の時間帯または会議室を選択してください`);
      }
      submitBtn.textContent = f.eventId ? '保存中…' : '作成中…';
    }

    const token = await Auth.getGraphToken(['Calendars.ReadWrite']);
    const attendees = f.members.map(m => ({ emailAddress: { address: m.email }, type: 'required' }));
    // 会議室は実際のExchangeリソースの出席者として追加する(サンプルではなく本物の予約)
    if (room) attendees.push({ emailAddress: { address: room.email, name: `${site.name} ${room.name}` }, type: 'resource' });

    const body = {
      subject: f.title.trim(),
      start: { dateTime: `${f.date}T${f.start}:00`, timeZone: 'Tokyo Standard Time' },
      end: { dateTime: `${f.date}T${f.end}:00`, timeZone: 'Tokyo Standard Time' },
      attendees
    };
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
    if (f.guests.trim()) body.body = { contentType: 'text', content: `外部参加者: ${f.guests.trim()}` };

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
    const [yy, mm, dd] = f.date.split('-').map(Number);
    state.date = new Date(yy, mm - 1, dd);
    closeForm();
    render();
  } catch (e) {
    errEl.textContent = e.message || String(e);
    submitBtn.disabled = false;
    submitBtn.textContent = f.eventId ? '変更を保存' : '作成する';
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
  renderDateNav();
  await Promise.all([loadAndRenderPersonal(), loadAndRenderSiteGrid()]);
}

(async function init() {
  try {
    await Auth.init();

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
      document.getElementById('personal-badge').textContent = 'devモード(ダミー)';
      document.getElementById('site-badge').textContent = 'devモード(未接続)';
    }

    await render();
  } catch (e) {
    console.error(e);
    document.getElementById('personal-events').innerHTML =
      `<p style="margin:0;padding:6px 0;font-size:13px;color:#c05a5a">読み込みに失敗しました: ${esc(e.message || e)}</p>`;
  }
})();
