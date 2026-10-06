// 年間カレンダー閲覧ページ(2026-10-02追加。ユーザー指示)。
// A/B/C班ローテーションの祝日・行事・出勤番/振替休日を月単位のカレンダーグリッドで閲覧する。
// roomsData.js は読み込まない(SITES/ROOMS等とのグローバル衝突を避けるため。isoDateはここに複製する)。
'use strict';

const WDAYS = ['日', '月', '火', '水', '木', '金', '土'];
const GROUPS = [
  { id: 'sunday_off', name: '日曜定休' },
  { id: 'wednesday_off', name: '水曜定休' }
];
// 定休グループごとの「本来の休日」の曜日(0=日曜〜6=土曜)。DBの内容に関係なく曜日だけで色付けする
const OFF_WEEKDAY = { sunday_off: 0, wednesday_off: 3 };

function isoDate(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const state = {
  group: GROUPS[0].id,
  month: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  rowsByDate: null // null = 読み込み中。{ 'YYYY-MM-DD': [{team,type,label}] }
};

function monthLabel(d) { return `${d.getFullYear()}年${d.getMonth() + 1}月`; }

/** 表示中の月の最初/最後の日(Dateオブジェクト)を返す */
function monthRange(d) {
  return { first: new Date(d.getFullYear(), d.getMonth(), 1), last: new Date(d.getFullYear(), d.getMonth() + 1, 0) };
}

function renderGroupTabs() {
  const el = document.getElementById('group-tabs');
  el.innerHTML = GROUPS.map(g => {
    const sel = g.id === state.group;
    return `<button class="hv-site" data-group="${g.id}" style="border:1px solid ${sel ? '#1e5fa8' : '#dfe8f0'};background:${sel ? '#1e5fa8' : '#ffffff'};color:${sel ? '#ffffff' : '#1c2b3a'};font-weight:700;border-radius:9px;padding:8px 18px;font-size:13px;cursor:pointer;font-family:inherit;white-space:nowrap">${esc(g.name)}</button>`;
  }).join('');
  el.querySelectorAll('[data-group]').forEach(b => b.addEventListener('click', () => {
    if (state.group === b.dataset.group) return;
    state.group = b.dataset.group;
    load();
  }));
}

/** 1マス(1日)ぶんのラベル表示。祝日・行事(team='')と各班の出勤番/振替休日を、
    同じ日に複数あっても全て積み上げて表示する */
function dayLabelsHtml(rows) {
  if (!rows || !rows.length) return '';
  return rows.map(r => {
    const isShift = r.type === 'shift_work' || r.type === 'shift_off';
    const bg = r.type === 'shift_work' ? '#fdf4e7' : r.type === 'shift_off' ? '#e9f1fa' : '#f0f4f8';
    const color = r.type === 'shift_work' ? '#b0721f' : r.type === 'shift_off' ? '#1e5fa8' : '#4a5a6a';
    return `<div title="${esc(r.label)}" style="font-size:10px;font-weight:700;color:${color};background:${bg};border-radius:4px;padding:1px 5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px">${esc(isShift ? `${r.team}班 ${r.type === 'shift_work' ? '出勤' : '振休'}` : r.label)}</div>`;
  }).join('');
}

function renderGrid() {
  const el = document.getElementById('calendar-grid');
  document.getElementById('month-label').textContent = monthLabel(state.month);
  if (Auth.mode !== 'entra') {
    el.innerHTML = '<p style="margin:0;padding:24px 0;font-size:13px;color:#8a99a8">devモードでは年間カレンダーを確認できません(Entra IDでのサインインが必要です)</p>';
    return;
  }
  if (!state.rowsByDate) {
    el.innerHTML = '<p style="margin:0;padding:24px 0;font-size:13px;color:#8a99a8">読み込み中…</p>';
    return;
  }
  const { first, last } = monthRange(state.month);
  const offWeekday = OFF_WEEKDAY[state.group];
  const leadingBlanks = first.getDay();
  const totalDays = last.getDate();

  const header = WDAYS.map(w => `<div style="text-align:center;font-size:11px;font-weight:700;color:#8a99a8;padding:6px 0">${w}</div>`).join('');
  const blanks = Array.from({ length: leadingBlanks }, () => '<div></div>').join('');
  const days = Array.from({ length: totalDays }, (_, i) => {
    const day = i + 1;
    const d = new Date(state.month.getFullYear(), state.month.getMonth(), day);
    const key = isoDate(d);
    const isOff = d.getDay() === offWeekday;
    const rows = state.rowsByDate[key] || [];
    return `
    <div style="min-height:88px;border:1px solid #eef1f5;border-radius:6px;padding:4px 6px;${isOff ? 'background:#fdecec;border-color:#f6d3d3' : ''}">
      <div style="font-size:12px;font-weight:700;color:${isOff ? '#d64545' : '#1c2b3a'}">${day}</div>
      ${dayLabelsHtml(rows)}
    </div>`;
  }).join('');

  el.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:2px">${header}</div>
    <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:6px;margin-top:4px">${blanks}${days}</div>`;
}

async function load() {
  renderGroupTabs();
  state.rowsByDate = null;
  renderGrid();
  if (Auth.mode !== 'entra') return;
  const { first, last } = monthRange(state.month);
  try {
    const rows = await api(`/api/work-calendar?group=${encodeURIComponent(state.group)}&from=${isoDate(first)}&to=${isoDate(last)}`);
    const byDate = {};
    rows.forEach(r => { (byDate[r.date] ||= []).push(r); });
    state.rowsByDate = byDate;
  } catch (e) {
    console.error(e);
    document.getElementById('calendar-grid').innerHTML =
      `<p style="margin:0;padding:24px 0;font-size:13px;color:#c05a5a">${esc(e.message || String(e))}</p>`;
    return;
  }
  renderGrid();
}

function shiftMonth(n) {
  state.month = new Date(state.month.getFullYear(), state.month.getMonth() + n, 1);
  load();
}

/** 自分の定休グループを既定選択にする(portal.jsのrenderShiftBadgeと同じ方式。
    devモード・取得失敗時はGROUPS[0]のまま=タブで手動選択すればよい) */
async function detectDefaultGroup() {
  if (Auth.mode !== 'entra') return;
  try {
    const token = await Auth.getGraphToken(['User.Read']);
    const res = await fetch('https://graph.microsoft.com/v1.0/me?$select=department', {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) return;
    const me = await res.json();
    const group = calendarGroupFor(Auth.me.email, me.department || '');
    if (group) state.group = group;
  } catch { /* 取得失敗時は既定(GROUPS[0])のまま。タブで手動選択できる */ }
}

(async function init() {
  try {
    await Auth.init();
    await detectDefaultGroup();
    document.getElementById('prev-month').addEventListener('click', () => shiftMonth(-1));
    document.getElementById('next-month').addEventListener('click', () => shiftMonth(1));
    document.getElementById('today-btn').addEventListener('click', () => {
      state.month = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
      load();
    });
    await load();
  } catch (e) {
    console.error(e);
    document.getElementById('calendar-grid').innerHTML =
      `<p style="margin:0;padding:24px 0;font-size:13px;color:#c05a5a">読み込みに失敗しました: ${esc(e.message || e)}</p>`;
  }
})();
