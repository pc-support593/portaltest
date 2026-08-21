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

// 拠点代表者(その拠点の会議室予約を削除できる担当者)。メールアドレスを拠点IDに対応付ける。
// 担当者が変わったら、この対応表を直接編集する(大文字小文字は区別しない)。
// 実際に削除できるようにするには、あわせて Exchange 側でその担当者に各会議室カレンダーの
// 編集権限(Add-MailboxFolderPermission -Identity "<会議室>:\Calendar" -User <担当者> -AccessRights Editor)
// を付与し、Entra ID のアプリに Calendars.ReadWrite.Shared 権限を追加(管理者の同意)する必要がある。
const SITE_REPS = {
  hirano: [],       // 例: ['jimu-hirano@yoshimuraichi.com']
  hanahaku: [],
  nishinomiya: [],
  nakamozu: [],
  fukuda: []
};

/** 現在サインイン中のユーザーが担当拠点(削除権限あり)を持っていれば、そのIDの配列を返す */
function myAdminSiteIds() {
  const email = ((Auth.me && Auth.me.email) || '').toLowerCase();
  if (!email) return [];
  return SITES.filter(s => (SITE_REPS[s.id] || []).some(e => e.toLowerCase() === email)).map(s => s.id);
}

const state = {
  date: new Date(),
  roomBusy: null, // { [roomId]: [{start, end, subject}] } 選択中の日の会議室の空き状況(実データ)
  personalEvents: [], // 直近に取得した個人の予定(編集フォームを開く際に参照)
  adminSiteIds: [] // サインイン中のユーザーが削除権限を持つ拠点(Auth.init後に確定)
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

/** 指定日の全会議室の空き状況を取得。devモードは空({})。
    adminSiteIds に含まれる拠点の会議室は、削除操作に必要な実データ(予定ID・主催者)を
    Calendars.ReadWrite.Shared 権限で直接取得する(それ以外はプライバシー保護のため空き状況のみ)。 */
async function fetchRoomBusy(date, adminSiteIds) {
  if (Auth.mode !== 'entra') return {};
  adminSiteIds = adminSiteIds || [];

  const dateStr = isoDate(date);
  const adminRoomIds = new Set(ROOMS.filter(r => adminSiteIds.includes(r.site)).map(r => r.id));
  const normalRooms = ROOMS.filter(r => !adminRoomIds.has(r.id));
  const scopes = adminRoomIds.size ? ['Calendars.ReadWrite', 'Calendars.ReadWrite.Shared'] : ['Calendars.ReadWrite'];
  const token = await Auth.getGraphToken(scopes);
  const map = {};

  if (normalRooms.length) {
    const res = await fetch('https://graph.microsoft.com/v1.0/me/calendar/getSchedule', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'outlook.timezone="Tokyo Standard Time"' },
      body: JSON.stringify({
        schedules: normalRooms.map(r => r.email),
        startTime: { dateTime: `${dateStr}T00:00:00`, timeZone: 'Tokyo Standard Time' },
        endTime: { dateTime: `${dateStr}T23:59:59`, timeZone: 'Tokyo Standard Time' },
        availabilityViewInterval: 30
      })
    });
    if (!res.ok) throw new Error(`会議室の空き状況の取得に失敗しました(HTTP ${res.status})`);
    const data = await res.json();

    const roomByEmail = new Map(normalRooms.map(r => [r.email.toLowerCase(), r]));
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
  }

  // 担当拠点の会議室: getScheduleではなく会議室自身の予定表を直接取得(削除に必要な予定ID・主催者が得られる)
  for (const room of ROOMS.filter(r => adminRoomIds.has(r.id))) {
    try {
      const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(room.email)}/calendarView` +
        `?startDateTime=${encodeURIComponent(dateStr + 'T00:00:00')}` +
        `&endDateTime=${encodeURIComponent(dateStr + 'T23:59:59')}` +
        '&$select=id,subject,start,end,organizer&$orderby=start/dateTime';
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.timezone="Tokyo Standard Time"' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      map[room.id] = (d.value || []).map(ev => ({
        start: ev.start.dateTime.slice(11, 16),
        end: ev.end.dateTime.slice(11, 16),
        subject: ev.subject || '(件名なし)',
        eventId: ev.id,
        roomEmail: room.email,
        organizer: (ev.organizer && ev.organizer.emailAddress && ev.organizer.emailAddress.name) || ''
      }));
    } catch (e) {
      console.error(`会議室「${room.name}」の予定表取得に失敗しました`, e);
      map[room.id] = [];
    }
  }

  return map;
}

/** 拠点別カードのHTML。roomBusyMap が null なら読み込み中表示。adminSiteIds の拠点には削除ボタンを出す。 */
function siteGridHtml(roomBusyMap, adminSiteIds) {
  if (!roomBusyMap) return '<p style="margin:0;padding:8px 0;font-size:13px;color:#8a99a8">読み込み中…</p>';
  adminSiteIds = adminSiteIds || [];
  return SITES.map(s => {
    const isAdmin = adminSiteIds.includes(s.id);
    const rooms = siteRooms(s.id);
    const rows = rooms.flatMap(r => (roomBusyMap[r.id] || []).map(b => ({ ...b, room: r })))
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
        <span style="font-size:13px;font-weight:700;color:#1c2b3a">${esc(s.name)}</span>
        ${isAdmin ? '<span style="font-size:10px;font-weight:700;color:#1e5fa8;background:#e9f1fa;border-radius:4px;padding:1px 7px;white-space:nowrap">担当拠点</span>' : ''}
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
    state.roomBusy = await fetchRoomBusy(state.date, state.adminSiteIds);
    el.innerHTML = siteGridHtml(state.roomBusy, state.adminSiteIds);
    bindSiteGridActions(el);
  } catch (e) {
    console.error(e);
    state.roomBusy = {};
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
    useRoom: false, site: firstSite.id, room: '', // 会議室は空き一覧のチップから選ぶ(自動選択しない)
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
    room: matchedRoom ? matchedRoom.id : '',
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

/** 予定作成フォーム内: 選択中の拠点・時間帯で空いている会議室だけをチップ表示(クリックで選択)。
    変更時は自分の元の予約時間帯を「埋まっている」扱いにしない(submitCreateFormの重複チェックと同じ基準)。 */
function freeRoomsHtml(f) {
  if (!f.roomBusy) return '<p style="margin:0;font-size:13px;color:#8a99a8">読み込み中…</p>';
  if (f.start >= f.end) return '<p style="margin:0;font-size:13px;color:#c05a5a">終了時刻は開始時刻より後にしてください</p>';
  const isOwnOriginalSlot = (roomId, it) => f.orig && f.orig.room === roomId && f.orig.date === f.date
    && it.start === f.orig.start && it.end === f.orig.end;
  const free = siteRooms(f.site).filter(r =>
    !(f.roomBusy[r.id] || []).some(it => it.start < f.end && it.end > f.start && !isOwnOriginalSlot(r.id, it))
  );
  if (!free.length) return '<p style="margin:0;font-size:13px;color:#c05a5a">この時間帯に空いている会議室はありません。時間帯または拠点を変更してください</p>';
  return `<div style="display:flex;flex-wrap:wrap;gap:6px">${free.map(r => `
    <button data-pick-room="${r.id}" class="hv-roomfill" style="border:2px solid ${r.id === f.room ? '#1c2b3a' : 'transparent'};background:${r.color};border-radius:8px;padding:7px 12px;cursor:pointer;font-family:inherit">
      <span style="font-size:12px;font-weight:700;color:#ffffff">${esc(r.name)}</span>
    </button>`).join('')}</div>`;
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

  const selectedRoom = f.room ? roomById(f.room) : null;
  const roomSection = f.useRoom ? `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px">
      <label style="display:flex;flex-direction:column;gap:5px">
        <span style="font-size:12px;font-weight:700;color:#6b7d8f">拠点</span>
        <select id="f-site" class="in-input">${SITES.map(s => `<option value="${s.id}" ${s.id === f.site ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
      </label>
      <label style="display:flex;flex-direction:column;gap:5px">
        <span style="font-size:12px;font-weight:700;color:#6b7d8f">会議室</span>
        <input id="f-room-display" class="in-input" readonly tabindex="-1"
          value="${esc(selectedRoom ? selectedRoom.name : '')}" placeholder="下の空き一覧から選択してください"
          style="background:${selectedRoom ? '#eef4fb' : '#f5f8fb'};cursor:default;${selectedRoom ? 'font-weight:700;color:#1c2b3a' : ''}">
      </label>
    </div>
    <div style="border:1px solid #eef1f5;border-radius:10px;overflow:hidden">
      <div style="padding:9px 15px;background:#f7fafd;border-bottom:1px solid #eef1f5;font-size:12px;font-weight:700;color:#6b7d8f">
        ${esc((SITES.find(s => s.id === f.site) || {}).name || '')} の空いている会議室(${esc(f.date.split('-').slice(1).map(Number).join('/'))} ${esc(f.start)}–${esc(f.end)})
      </div>
      <div style="padding:10px 15px;max-height:220px;overflow-y:scroll">${freeRoomsHtml(f)}</div>
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
      <div style="padding:16px 26px;border-top:1px solid #e4ebf2;display:flex;gap:10px;align-items:center">
        ${f.eventId ? '<button id="f-delete" class="hv-btn-danger" style="border:1px solid #f0d5d5;background:#fbeeee;color:#c05a5a;font-weight:500;border-radius:9px;padding:10px 16px;font-size:13px;cursor:pointer;font-family:inherit">この予定を削除</button>' : ''}
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
  root.querySelector('#f-date').addEventListener('change', e => {
    f.date = e.target.value;
    if (f.useRoom && Auth.mode === 'entra') refreshFormRoomBusy();
    else renderModal();
  });
  root.querySelector('#f-start').addEventListener('change', e => {
    f.start = e.target.value;
    if (f.useRoom) renderModal(); // 空いている会議室の表示を選択時間帯に追随させる
  });
  root.querySelector('#f-end').addEventListener('change', e => {
    f.end = e.target.value;
    if (f.useRoom) renderModal();
  });
  const placeInput = root.querySelector('#f-place');
  if (placeInput) placeInput.addEventListener('input', e => { f.place = e.target.value; });
  root.querySelector('#f-guests').addEventListener('input', e => { f.guests = e.target.value; });
  root.querySelector('#f-submit').addEventListener('click', submitCreateForm);
  const deleteBtn = root.querySelector('#f-delete');
  if (deleteBtn) deleteBtn.addEventListener('click', deleteEvent);

  root.querySelector('#f-use-room').addEventListener('change', e => {
    f.useRoom = e.target.checked;
    if (f.useRoom && f.roomBusy == null && Auth.mode === 'entra') { refreshFormRoomBusy(); return; }
    renderModal();
  });
  const siteSel = root.querySelector('#f-site');
  if (siteSel) siteSel.addEventListener('change', e => {
    f.site = e.target.value;
    f.room = ''; // 拠点を切り替えたら会議室は空き一覧から選び直す
    renderModal();
  });
  // 空いている会議室チップのクリックで会議室を選択(「会議室」欄に反映。欄自体は読み取り専用で直接入力不可)
  root.querySelectorAll('[data-pick-room]').forEach(b => b.addEventListener('click', () => {
    f.room = b.dataset.pickRoom;
    renderModal();
  }));

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
  renderDateNav();
  await Promise.all([loadAndRenderPersonal(), loadAndRenderSiteGrid()]);
}

// 自動リフレッシュ(共通方針: 2分間隔・モーダル表示中と非表示タブはスキップ・差分があるときだけ静かに差し替え)
async function autoRefresh() {
  if (formState || document.hidden) return;
  const dateKey = isoDate(state.date); // 取得中に日付が切り替わったら結果を破棄するためのガード
  try {
    const [events, busy] = await Promise.all([
      fetchPersonalEvents(state.date),
      fetchRoomBusy(state.date, state.adminSiteIds)
    ]);
    if (formState || isoDate(state.date) !== dateKey) return;
    if (JSON.stringify(events) !== JSON.stringify(state.personalEvents)) {
      state.personalEvents = events;
      renderPersonalEvents(events);
    }
    if (JSON.stringify(busy) !== JSON.stringify(state.roomBusy)) {
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

    if (Auth.mode === 'entra') setInterval(autoRefresh, 2 * 60 * 1000);
  } catch (e) {
    console.error(e);
    document.getElementById('personal-events').innerHTML =
      `<p style="margin:0;padding:6px 0;font-size:13px;color:#c05a5a">読み込みに失敗しました: ${esc(e.message || e)}</p>`;
  }
})();
