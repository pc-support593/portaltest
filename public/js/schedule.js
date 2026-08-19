// スケジュール画面
// 個人のスケジュールは実データ(Graph /me/calendarView・/me/events)。予定作成フォームで「会議室を使用する」を
// チェックすると拠点・会議室を選び、サンプル予約(サーバーSQLite保存。rooms.htmlと同じ仕組み)を確保した上でOutlookに反映する。
// 拠点別の会議室スケジュールはサンプル表示(rooms.html と同じ roomsData.js のダミーデータ + サーバー保存の予約)。予定作成モーダル内にも同じ表示を出す(siteGridHtml)。
'use strict';

const state = {
  date: new Date(),
  allBookings: [] // 会議室予約サンプル(サーバー保存分)。roomsData.js の bookingsFor に渡す
};

const pad = n => String(n).padStart(2, '0');
const WDAYS = ['日', '月', '火', '水', '木', '金', '土'];

function dateLabel(d) {
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日(${WDAYS[d.getDay()]})`;
}

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

  const dateStr = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const token = await Auth.getGraphToken(['Calendars.ReadWrite']);
  const url = 'https://graph.microsoft.com/v1.0/me/calendarView' +
    `?startDateTime=${encodeURIComponent(dateStr + 'T00:00:00')}` +
    `&endDateTime=${encodeURIComponent(dateStr + 'T23:59:59')}` +
    '&$select=subject,start,end,location,isAllDay&$orderby=start/dateTime';

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.timezone="Tokyo Standard Time"' }
  });
  if (!res.ok) throw new Error(`予定表の取得に失敗しました(HTTP ${res.status})`);
  const data = await res.json();

  return (data.value || []).map((ev, i) => ({
    time: ev.isAllDay ? '終日' : `${ev.start.dateTime.slice(11, 16)}–${ev.end.dateTime.slice(11, 16)}`,
    title: ev.subject || '(件名なし)',
    place: (ev.location && ev.location.displayName) || '',
    ...PERSONAL_COLOR_CYCLE[i % PERSONAL_COLOR_CYCLE.length]
  }));
}

function renderPersonalEvents(events) {
  const el = document.getElementById('personal-events');
  if (!events.length) {
    el.innerHTML = '<p style="margin:0;padding:6px 0;font-size:13px;color:#8a99a8">この日の予定はありません</p>';
    return;
  }
  el.innerHTML = events.map(e => `
    <div style="display:flex;flex-direction:column;gap:3px;background:${e.bg};border-left:4px solid ${e.color};border-radius:8px;padding:11px 15px">
      <div style="display:flex;align-items:baseline;gap:12px">
        <span style="font-size:13px;font-weight:700;color:${e.timeColor};white-space:nowrap">${esc(e.time)}</span>
        <span style="font-size:14px;font-weight:700">${esc(e.title)}</span>
      </div>
      ${e.place ? `<span style="font-size:12px;color:#6b7d8f">${esc(e.place)}</span>` : ''}
    </div>`).join('');
}

async function loadAndRenderPersonal() {
  const el = document.getElementById('personal-events');
  el.innerHTML = '<p style="margin:0;padding:6px 0;font-size:13px;color:#8a99a8">読み込み中…</p>';
  try {
    renderPersonalEvents(await fetchPersonalEvents(state.date));
  } catch (e) {
    console.error(e);
    el.innerHTML = `<p style="margin:0;padding:6px 0;font-size:13px;color:#c05a5a">${esc(e.message || String(e))}</p>`;
  }
}

// ---- 拠点別 会議室スケジュール(サンプル。メイン画面と予定作成モーダルの両方で使う) ----

/** 指定日の拠点別・会議室別スケジュールHTML(純粋関数寄り。DOM直書きはしない) */
function siteGridHtml(date) {
  return SITES.map(s => {
    const rooms = siteRooms(s.id);
    const all = [];
    rooms.forEach(r => bookingsFor(r.id, date, state.allBookings).forEach(b => all.push({ ...b, roomName: r.name, roomColor: r.color })));
    all.sort((x, y) => x.start.localeCompare(y.start));
    const rows = all.length
      ? all.map(b => `
        <div style="display:flex;align-items:center;gap:8px;background:${b.roomColor};border-radius:6px;padding:6px 10px">
          <span style="font-size:11px;font-weight:700;color:#ffffff;white-space:nowrap">${esc(b.start)}–${esc(b.end)}</span>
          <span style="font-size:11px;font-weight:700;color:rgba(255,255,255,0.85);white-space:nowrap">${esc(b.roomName)}</span>
          <span style="font-size:12px;font-weight:500;color:#ffffff;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(b.title)}</span>
        </div>`).join('')
      : '<p style="margin:0;padding:4px 0;font-size:12px;color:#8a99a8">この日の予約はありません</p>';
    return `
    <div style="border:1px solid #eef1f5;border-radius:10px;overflow:hidden;display:flex;flex-direction:column">
      <div style="padding:11px 15px;background:#f7fafd;display:flex;align-items:center;gap:8px;border-bottom:1px solid #eef1f5">
        <span style="font-size:13px;font-weight:700;color:#1c2b3a">${esc(s.name)}</span>
        <span style="font-size:11px;color:#8a99a8;margin-left:auto">${rooms.length}室</span>
      </div>
      <div style="padding:10px 15px;display:flex;flex-direction:column;gap:6px">${rows}</div>
    </div>`;
  }).join('');
}

function renderSiteGrid() {
  document.getElementById('site-grid').innerHTML = siteGridHtml(state.date);
}

/** 'YYYY-MM-DD' → ローカル日付のDate(タイムゾーンずれを避けるため new Date(iso) は使わない) */
function parseISODate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// ---- 予定作成モーダル(会議室を含めない、実データとしてOutlookに反映) ----

function hourOptions() {
  const opts = [];
  for (let h = 8; h <= 20; h++) { opts.push(`${pad(h)}:00`); opts.push(`${pad(h)}:30`); }
  return opts;
}

let formState = null;
let memberCandidates = []; // 社内メンバー検索の候補

function openCreateForm() {
  const d = state.date;
  const firstSite = SITES[0];
  formState = {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    start: '10:00', end: '11:00', title: '', place: '', members: [], guests: '', error: '',
    useRoom: false, site: firstSite.id, room: (siteRooms(firstSite.id)[0] || {}).id || ''
  };
  memberCandidates = [];
  renderModal();
}

function closeForm() {
  formState = null;
  renderModal();
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
        各拠点のスケジュール(${esc(f.date.split('-').slice(1).map(Number).join('/'))})
      </div>
      <div style="padding:10px 15px;display:flex;flex-direction:column;gap:8px;max-height:220px;overflow-y:auto">${siteGridHtml(parseISODate(f.date))}</div>
    </div>` : '';

  root.innerHTML = `
  <div id="form-overlay" style="position:fixed;inset:0;background:rgba(20,40,65,0.5);display:flex;align-items:center;justify-content:center;padding:24px;z-index:110">
    <div id="form-box" style="background:#ffffff;border-radius:16px;box-shadow:0 12px 40px rgba(15,35,60,0.3);max-width:520px;width:100%;max-height:88vh;display:flex;flex-direction:column;overflow:hidden">
      <div style="display:flex;align-items:center;gap:12px;padding:20px 26px;border-bottom:1px solid #e4ebf2">
        <h3 style="margin:0;font-size:17px;font-weight:700">予定を作成</h3>
        <button class="hv-close" data-close style="margin-left:auto;border:none;background:#f0f4f8;border-radius:8px;width:32px;height:32px;cursor:pointer;color:#6b7d8f;font-size:15px;flex-shrink:0">✕</button>
      </div>
      <div style="padding:20px 26px;display:flex;flex-direction:column;gap:14px;overflow-y:auto">
        <p style="margin:0;font-size:12px;color:#8a99a8">作成すると実際にあなたのOutlook予定表に反映されます。${f.useRoom ? '会議室はサンプル予約(この画面限定の仮の空き状況)として確保されます。' : ''}</p>
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
          <span style="font-size:10px;font-weight:700;color:#8a6d1f;background:#f7f0dc;border-radius:4px;padding:1px 7px">サンプル表示</span>
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
        <button id="f-submit" class="hv-btn-primary" style="border:none;background:#1e5fa8;color:#ffffff;font-weight:700;border-radius:9px;padding:10px 24px;font-size:13px;cursor:pointer;font-family:inherit">作成する</button>
      </div>
    </div>
  </div>`;

  root.querySelector('#form-overlay').addEventListener('click', closeForm);
  root.querySelector('#form-box').addEventListener('click', e => e.stopPropagation());
  root.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeForm));
  root.querySelector('#f-title').addEventListener('input', e => { f.title = e.target.value; });
  // 日付変更は会議室使用時に拠点スケジュール表示を最新化する必要があるため毎回モーダルを再描画する
  root.querySelector('#f-date').addEventListener('change', e => { f.date = e.target.value; renderModal(); });
  root.querySelector('#f-start').addEventListener('change', e => { f.start = e.target.value; });
  root.querySelector('#f-end').addEventListener('change', e => { f.end = e.target.value; });
  const placeInput = root.querySelector('#f-place');
  if (placeInput) placeInput.addEventListener('input', e => { f.place = e.target.value; });
  root.querySelector('#f-guests').addEventListener('input', e => { f.guests = e.target.value; });
  root.querySelector('#f-submit').addEventListener('click', submitCreateForm);

  root.querySelector('#f-use-room').addEventListener('change', e => {
    f.useRoom = e.target.checked;
    if (f.useRoom && !f.room) f.room = (siteRooms(f.site)[0] || {}).id || '';
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
  submitBtn.textContent = '作成中…';

  const room = f.useRoom ? roomById(f.room) : null;
  const site = room ? SITES.find(s => s.id === room.site) : null;
  let bookingId = null;
  try {
    if (room) {
      // 会議室の確保(サンプル: サーバーSQLite保存。同時間帯の重複はサーバー側で409エラーになる)
      const booking = await api('/api/bookings', {
        method: 'POST',
        body: { room: room.id, date: f.date, start: f.start, end: f.end, title: f.title.trim(), members: f.members, guests: f.guests }
      });
      bookingId = booking.id;
    }

    const token = await Auth.getGraphToken(['Calendars.ReadWrite']);
    const body = {
      subject: f.title.trim(),
      start: { dateTime: `${f.date}T${f.start}:00`, timeZone: 'Tokyo Standard Time' },
      end: { dateTime: `${f.date}T${f.end}:00`, timeZone: 'Tokyo Standard Time' },
      // 社内メンバーはメールが確定しているのでOutlookの出席者として招待する。外部参加者はメール不要のフリーワードのため招待はできず、本文にメモとして記載する
      attendees: f.members.map(m => ({ emailAddress: { address: m.email }, type: 'required' }))
    };
    const placeName = room ? `${site.name} ${room.name}` : f.place.trim();
    if (placeName) body.location = { displayName: placeName };
    if (f.guests.trim()) body.body = { contentType: 'text', content: `外部参加者: ${f.guests.trim()}` };

    const res = await fetch('https://graph.microsoft.com/v1.0/me/events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      throw new Error(err?.error?.message || `予定の作成に失敗しました(HTTP ${res.status})`);
    }

    if (bookingId != null) state.allBookings = await api('/api/bookings');
    // 作成した予定を含む日付に切り替えて再読み込み
    const [yy, mm, dd] = f.date.split('-').map(Number);
    state.date = new Date(yy, mm - 1, dd);
    closeForm();
    render();
  } catch (e) {
    // Outlook側の予定作成に失敗した場合、先に確保した会議室予約だけが孤立して残らないよう取り消す
    if (bookingId != null) {
      try { await api(`/api/bookings/${bookingId}`, { method: 'DELETE' }); } catch { /* 取消にも失敗した場合はそのまま残る(rooms.htmlから手動取消可能) */ }
    }
    errEl.textContent = e.message || String(e);
    submitBtn.disabled = false;
    submitBtn.textContent = '作成する';
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
  renderSiteGrid();
  await loadAndRenderPersonal();
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
    }

    state.allBookings = await api('/api/bookings');
    await render();
  } catch (e) {
    console.error(e);
    document.getElementById('personal-events').innerHTML =
      `<p style="margin:0;padding:6px 0;font-size:13px;color:#c05a5a">読み込みに失敗しました: ${esc(e.message || e)}</p>`;
  }
})();
