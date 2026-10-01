// ゆめすみかスタッフ予定ページ(2026-10-01追加。ユーザー指示)。
// @yumesumika.com のスタッフだけを対象に、展示場(+設計)ごとのMS365グループのメンバー全員の
// その日の予定を、Outlookのスケジューリングアシスタントのようなタイムライン表で表示する。
// メンバーの判定は Entra ID の department 属性ではなく、実際に運用されているMS365グループの
// メンバーシップを使う(ユーザー指示 2026-09-30〜10-01)。
// 必要な追加Graph権限: GroupMember.Read.All(委任。グループメンバー一覧の取得に必要。要管理者同意)。
// 予定の件名まで表示するには、各スタッフの個人カレンダーにもReviewer権限の付与が必要
// (会議室と同じ要領。未実行の場合は403になりその人の行にエラー表示。powershell.txt参照)。
'use strict';

const pad = n => String(n).padStart(2, '0');
const WDAYS = ['日', '月', '火', '水', '木', '金', '土'];

function dateLabel(d) {
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日(${WDAYS[d.getDay()]})`;
}

// 展示場(+設計)ごとのMS365グループ。泉佐野は対応するグループが未作成のため対象外
// (ユーザー指示 2026-10-01。グループが用意され次第ここに追記する)
const SHOWROOM_GROUPS = [
  { id: 'fukuda', name: '福田展示場', groupMail: 'yumesumika_1@yumesumika.com' },
  { id: 'nakamozu', name: '中百舌鳥展示場', groupMail: 'yumesumika_2@yumesumika.com' },
  { id: 'hirano', name: '平野展示場', groupMail: 'yumesumika_3@yumesumika.com' },
  { id: 'hanahaku', name: '花博展示場', groupMail: 'yumesumika_4@yumesumika.com' },
  { id: 'nishinomiya', name: '西宮展示場', groupMail: 'yumesumika_5@yumesumika.com' },
  { id: 'sekkei', name: '設計', groupMail: 'yumesumika_6@yumesumika.com' }
];

const DAY_START = 8 * 60, DAY_END = 21 * 60, DAY_SPAN = DAY_END - DAY_START; // 8:00〜21:00
const HOUR_MARKS = Array.from({ length: (DAY_END - DAY_START) / 60 + 1 }, (_, i) => 8 + i);

const state = {
  groupTab: SHOWROOM_GROUPS[0].id,
  date: new Date(),
  members: {}, // groupId -> [{id,name,email}] (グループ切替のたびに取得。日付切替では再取得しない)
  busy: null   // email -> [{start,end,subject}] | null(取得失敗)
};

/** Graphのエラーレスポンスから可能な限り具体的なメッセージを取り出す */
async function graphErrorMessage(res, fallback) {
  try {
    const data = await res.json();
    if (data && data.error && data.error.message) return `${fallback}: ${data.error.message}`;
  } catch { /* 本文がJSONでない場合はフォールバックのみ */ }
  return fallback;
}

/** メールアドレスからMS365グループを特定し、そのメンバー一覧(社内メンバーのみ)を取得する */
async function fetchGroupMembers(groupMail) {
  const token = await Auth.getGraphToken(['GroupMember.Read.All']);
  const groupUrl = 'https://graph.microsoft.com/v1.0/groups' +
    `?$filter=${encodeURIComponent(`mail eq '${groupMail}'`)}&$select=id,displayName`;
  const groupRes = await fetch(groupUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (!groupRes.ok) throw new Error(await graphErrorMessage(groupRes, `グループの取得に失敗しました(HTTP ${groupRes.status})`));
  const groupData = await groupRes.json();
  const group = (groupData.value || [])[0];
  if (!group) throw new Error(`グループが見つかりませんでした(${groupMail})`);

  let url = `https://graph.microsoft.com/v1.0/groups/${group.id}/members?$select=id,displayName,mail&$top=200`;
  const members = [];
  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(await graphErrorMessage(res, `メンバー一覧の取得に失敗しました(HTTP ${res.status})`));
    const data = await res.json();
    members.push(...(data.value || []));
    url = data['@odata.nextLink'] || null;
  }
  const collator = (a, b) => (a.displayName || '').localeCompare(b.displayName || '', 'ja');
  return members.filter(m => m.mail).sort(collator).map(m => ({ id: m.id, name: m.displayName || '(名前未設定)', email: m.mail }));
}

/** Graphのエラーレスポンスから可能な限り具体的なメッセージを取り出す
    (HTTPステータスだけだと原因切り分けに時間がかかるため。2026-10-02追加) */
async function graphErrorMessage(res) {
  try {
    const data = await res.json();
    if (data && data.error) return `HTTP ${res.status}: ${data.error.code || ''} ${data.error.message || ''}`.trim();
  } catch { /* 本文がJSONでない場合はステータスのみ */ }
  return `HTTP ${res.status}`;
}

/** 指定日の各メンバーの予定(終日予定は除く)を並行取得する。1人ずつtry/catchし、
    失敗した人は busy[email] = { error } にする(権限未設定等。1人の失敗で全体を壊さない) */
async function fetchPeopleBusy(dateStr, people) {
  const token = await Auth.getGraphToken(['Calendars.ReadWrite.Shared']);
  const map = {};
  await Promise.all(people.map(async person => {
    try {
      const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(person.email)}/calendarView` +
        `?startDateTime=${encodeURIComponent(dateStr + 'T00:00:00')}` +
        `&endDateTime=${encodeURIComponent(dateStr + 'T23:59:59')}` +
        '&$select=subject,start,end,isAllDay&$orderby=start/dateTime';
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.timezone="Tokyo Standard Time"' } });
      if (!res.ok) throw new Error(await graphErrorMessage(res));
      const data = await res.json();
      map[person.email] = {
        items: (data.value || [])
          .filter(ev => !ev.isAllDay)
          .map(ev => ({ start: ev.start.dateTime.slice(11, 16), end: ev.end.dateTime.slice(11, 16), subject: ev.subject || '(件名なし)' }))
      };
    } catch (e) {
      console.error(`「${person.name}」の予定取得に失敗しました`, e);
      map[person.email] = { error: e.message || String(e) };
    }
  }));
  return map;
}

function minutesOf(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** タイムライン1人分の予定バーのHTML(8:00〜21:00の範囲にクランプして配置) */
function busyBarsHtml(entry) {
  if (!entry || entry.error) {
    const detail = entry && entry.error ? esc(entry.error) : '';
    return `<span style="font-size:11px;color:#c05a5a">予定の取得に失敗しました${detail ? `(${detail})` : ''}</span>`;
  }
  return entry.items.map(it => {
    const startMin = Math.max(DAY_START, Math.min(DAY_END, minutesOf(it.start)));
    const endMin = Math.max(DAY_START, Math.min(DAY_END, minutesOf(it.end)));
    if (endMin <= startMin) return '';
    const left = (startMin - DAY_START) / DAY_SPAN * 100;
    const width = (endMin - startMin) / DAY_SPAN * 100;
    return `<div title="${esc(it.start)}–${esc(it.end)} ${esc(it.subject)}" style="position:absolute;top:3px;bottom:3px;left:${left}%;width:${width}%;background:#2e6fc0;border-radius:4px;padding:0 6px;display:flex;align-items:center;overflow:hidden">
      <span style="font-size:11px;color:#ffffff;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(it.subject)}</span>
    </div>`;
  }).join('');
}

function renderGroupTabs() {
  const title = document.getElementById('group-title');
  const current = SHOWROOM_GROUPS.find(g => g.id === state.groupTab) || SHOWROOM_GROUPS[0];
  if (title) title.textContent = `${current.name}のスタッフ予定`;
  const el = document.getElementById('group-tabs');
  el.innerHTML = SHOWROOM_GROUPS.map(g => {
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

  const header = `<div style="display:flex;margin-left:150px;position:relative;height:20px;border-bottom:1px solid #eef1f5">
    ${HOUR_MARKS.map(h => `<span style="position:absolute;left:${(h * 60 - DAY_START) / DAY_SPAN * 100}%;font-size:11px;color:#8a99a8;transform:translateX(-50%)">${h}</span>`).join('')}
  </div>`;
  const rows = members.map(p => `
    <div style="display:flex;align-items:stretch;border-bottom:1px solid #f2f5f9;min-height:34px">
      <div style="width:150px;flex-shrink:0;font-size:12px;font-weight:700;color:#1c2b3a;padding:7px 10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.name)}</div>
      <div style="position:relative;flex:1;background-image:repeating-linear-gradient(to right, #f2f5f9 0, #f2f5f9 1px, transparent 1px, transparent ${100 / (DAY_SPAN / 60)}%)">
        ${busyBarsHtml(state.busy[p.email])}
      </div>
    </div>`).join('');
  el.innerHTML = `<div style="overflow-x:auto"><div style="min-width:900px">${header}${rows}</div></div>`;
}

async function loadMembers() {
  if (state.members[state.groupTab]) return;
  const group = SHOWROOM_GROUPS.find(g => g.id === state.groupTab);
  try {
    state.members[state.groupTab] = await fetchGroupMembers(group.groupMail);
  } catch (e) {
    console.error(e);
    document.getElementById('timeline').innerHTML = `<p style="margin:0;padding:8px 0;font-size:13px;color:#c05a5a">${esc(e.message || String(e))}</p>`;
    throw e;
  }
}

async function render() {
  document.getElementById('date-label').textContent = dateLabel(state.date);
  renderGroupTabs();
  state.busy = null;
  renderTimeline();
  if (Auth.mode !== 'entra') return;
  try {
    await loadMembers();
  } catch { return; } // エラーメッセージは loadMembers 内で表示済み
  renderTimeline();
  const members = state.members[state.groupTab];
  state.busy = await fetchPeopleBusy(isoDate(state.date), members);
  renderTimeline();
}

function shiftDay(n) {
  const d = new Date(state.date);
  d.setDate(d.getDate() + n);
  state.date = d;
  render();
}

// 自動リフレッシュ(共通方針: 2分間隔・非表示タブはスキップ・差分があるときだけ静かに差し替え)
async function autoRefresh() {
  if (document.hidden || Auth.mode !== 'entra') return;
  const members = state.members[state.groupTab];
  if (!members) return;
  try {
    const busy = await fetchPeopleBusy(isoDate(state.date), members);
    if (JSON.stringify(busy) !== JSON.stringify(state.busy)) {
      state.busy = busy;
      renderTimeline();
    }
  } catch { /* 自動更新の失敗は静かに無視(次回に再試行) */ }
}

(async function init() {
  try {
    await Auth.init();
    document.getElementById('prev-day').addEventListener('click', () => shiftDay(-1));
    document.getElementById('next-day').addEventListener('click', () => shiftDay(1));
    document.getElementById('today-btn').addEventListener('click', () => { state.date = new Date(); render(); });
    await render();
    if (Auth.mode === 'entra') setInterval(autoRefresh, 2 * 60 * 1000);
  } catch (e) {
    console.error(e);
    document.getElementById('timeline').innerHTML =
      `<p style="margin:0;padding:8px 0;font-size:13px;color:#c05a5a">読み込みに失敗しました: ${esc(e.message || e)}</p>`;
  }
})();
