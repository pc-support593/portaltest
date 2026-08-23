// 会議室予約画面。2026-07-01〜08-23はフローズンなサンプル表示(操作不可)、
// 2026-08-24以降はentraモードでは実際のExchangeと連携する予約(schedule.htmlと同じ仕組み。
// 主催者本人のみ変更・取消可能)、devモードでは従来どおりサーバー(SQLite)保存のサンプル動作。
// それより前(2026-06-30以前)は曜日パターンのダミー予約+SQLite保存。
// 拠点・会議室マスタは js/roomsData.js で定義(schedule.html と共有)。
// 社内メンバー検索(searchMembers)は entraモードのみ実データ(Graph /users)。
'use strict';

const OWNER_BAR = '#f5b301';   // 主催
const MEMBER_BAR = '#00d2c6';  // 参加

// 2026-08-24以降の予約をExchangeと連携する(falseにするとSQLite保存の従来動作に戻せる)。
// 実際に連携が効くのは entraモードのときだけ(devモードはGraphを呼べないため常にSQLite動作)
const REAL_ROOMS_ENABLED = true;
const useRealRooms = () => REAL_ROOMS_ENABLED && Auth.mode === 'entra';
// メールアドレスの大文字小文字を無視して比較する(GraphのSMTPアドレスとEntraのUPNの表記差対策)
const sameEmail = (a, b) => !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();

let ME = { name: '' };
const now = new Date();
const state = {
  site: 'hirano',
  room: 'hirano1',
  ym: { y: now.getFullYear(), m: now.getMonth() },
  week: null,       // 週のみ表示中のインデックス
  day: null,        // 日別ポップアップ対象 {y, m, d}
  legacy: [],       // サーバー(SQLite)保存の予約(サンプル・旧データ)
  real: [],         // Exchangeから取得した実予約(2026-08-24以降・entraモードのみ)
  realErrors: [],   // 実予約の取得に失敗した会議室名
  bookings: [],     // legacy + real を結合した表示用配列(mergeBookings()で更新)
  form: null        // 予約フォーム(editId があれば変更モード)
};
let candidates = []; // メンバー検索の候補

// ---- ユーティリティ(SITES/ROOMS/PATTERNS/siteRooms/roomById/isoDate は roomsData.js で定義) ----
const pad = n => String(n).padStart(2, '0');
const WDAYS = ['日', '月', '火', '水', '木', '金', '土'];

/** 自分の関与: 'owner' | 'member' | null(同一性はメールで判定。パターンのダミーはフラグ) */
function statusOf(b) {
  if (b.mine || sameEmail(b.owner_email, ME.email)) return 'owner';
  if (b.part || (b.members || []).some(m => sameEmail(m.email, ME.email))) return 'member';
  return null;
}

/** 承諾待ち・自動辞退のバッジ(実予約のみ。会議室側の自動処理の反映待ち表示) */
function extraBadgeHtml(b) {
  if (!b.pending) return '';
  return b.declined
    ? '<span style="font-size:10px;font-weight:700;color:#ffffff;background:#c05a5a;border-radius:4px;padding:1px 6px;white-space:nowrap">自動辞退</span>'
    : '<span style="font-size:10px;font-weight:700;color:#4a3800;background:#f5b301;border-radius:4px;padding:1px 6px;white-space:nowrap">承諾待ち</span>';
}

function barColor(b, roomColor) {
  const st = statusOf(b);
  return st === 'owner' ? OWNER_BAR : st === 'member' ? MEMBER_BAR : roomColor;
}

function statusBadge(b) {
  const st = statusOf(b);
  if (st === 'owner') return '<span style="font-size:10px;font-weight:700;color:#4a3800;background:#f5b301;border-radius:4px;padding:1px 6px;white-space:nowrap">主催</span>';
  if (st === 'member') return '<span style="font-size:10px;font-weight:700;color:#00332f;background:#00d2c6;border-radius:4px;padding:1px 6px;white-space:nowrap">参加</span>';
  return '';
}

// ---- 拠点・会議室タブ ----

function renderSiteTabs() {
  const el = document.getElementById('site-tabs');
  el.innerHTML = '<span style="font-size:12px;font-weight:700;color:#8a99a8;margin-right:2px">拠点</span>' +
    SITES.map(s => {
      const sel = s.id === state.site;
      const n = siteRooms(s.id).length;
      return `
      <button class="hv-site" data-site="${s.id}" style="display:flex;align-items:baseline;gap:8px;border:1px solid ${sel ? '#1e5fa8' : '#dfe8f0'};background:${sel ? '#1e5fa8' : '#ffffff'};color:${sel ? '#ffffff' : '#1c2b3a'};font-weight:700;border-radius:9px;padding:10px 18px;font-size:13px;cursor:pointer;font-family:inherit">
        <span>${esc(s.name)}</span>
        <span style="font-size:11px;font-weight:500;color:${sel ? '#bcd4ef' : '#8a99a8'}">${n}室</span>
      </button>`;
    }).join('');
  el.querySelectorAll('[data-site]').forEach(b => b.addEventListener('click', () => {
    state.site = b.dataset.site;
    state.room = (siteRooms(state.site)[0] || {}).id || '__all';
    state.day = null; state.week = null;
    navigate();
  }));
}

function renderRoomTabs() {
  const el = document.getElementById('room-tabs');
  const rooms = siteRooms(state.site);
  const isAll = state.room === '__all';
  // 「全ての会議室」だけは従来デザインのまま(白地+色ドット・2行分の高さ)
  const allTabHtml = `
      <button class="hv-room" data-room="__all" style="display:flex;align-items:center;border:1px solid ${isAll ? '#2e6fc0' : '#eef1f5'};background:${isAll ? '#eef4fb' : '#ffffff'};border-radius:9px;padding:9px 16px;cursor:pointer;text-align:left;font-family:inherit">
        <span style="display:flex;flex-direction:column;gap:1px;line-height:1.35">
          <span style="font-size:13px;font-weight:700;color:#1c2b3a">全ての会議室</span>
          <span style="font-size:11px;color:#6b7d8f">${rooms.length}室をまとめて表示</span>
        </span>
      </button>`;
  // 各会議室は識別色で全面塗りつぶし+白文字。「全ての会議室」タブの高さに収まる2段組みで並べる
  // (grid-auto-flow:column + 2行。align-self:stretch で隣の全ての会議室タブと同じ高さに揃える)
  const roomBtnsHtml = rooms.map(r => {
    const sel = r.id === state.room;
    return `
      <button class="hv-roomfill" data-room="${r.id}" style="display:flex;align-items:center;border:2px solid ${sel ? '#1c2b3a' : 'transparent'};background:${r.color};border-radius:8px;padding:0 14px;cursor:pointer;font-family:inherit;white-space:nowrap">
        <span style="font-size:12px;font-weight:700;color:#ffffff">${esc(r.name)}</span>
      </button>`;
  }).join('');
  el.innerHTML = '<span style="font-size:12px;font-weight:700;color:#8a99a8;margin-right:2px">会議室</span>' +
    allTabHtml +
    `<div style="display:grid;grid-auto-flow:column;grid-template-rows:repeat(2,1fr);gap:6px;align-self:stretch;overflow-x:auto;max-width:100%">${roomBtnsHtml}</div>` +
    `<span style="margin-left:auto;display:flex;align-items:center;gap:14px">
      <span style="display:flex;align-items:center;gap:7px;font-size:11px;color:#6b7d8f"><span style="width:18px;height:10px;border-radius:3px;background:#f5b301"></span>主催</span>
      <span style="display:flex;align-items:center;gap:7px;font-size:11px;color:#6b7d8f"><span style="width:18px;height:10px;border-radius:3px;background:#00d2c6"></span>参加</span>
      <button id="new-booking" class="hv-btn-primary" style="border:none;background:#1e5fa8;color:#ffffff;font-weight:700;border-radius:9px;padding:10px 20px;font-size:13px;cursor:pointer;font-family:inherit">＋ 新規予約</button>
    </span>`;
  el.querySelectorAll('[data-room]').forEach(b => b.addEventListener('click', () => {
    state.room = b.dataset.room;
    state.day = null; state.week = null;
    render();
  }));
  el.querySelector('#new-booking').addEventListener('click', () => {
    const first = siteRooms(state.site)[0];
    openForm({
      isNew: true, site: state.site,
      room: state.room !== '__all' ? state.room : (first ? first.id : ''),
      date: defaultBookableDate(), start: '09:00', end: '10:00',
      title: '', members: [], guests: ''
    });
  });
}

// ---- カレンダー ----

function buildCells() {
  const { y, m } = state.ym;
  const first = new Date(y, m, 1);
  const start = new Date(y, m, 1 - ((first.getDay() + 6) % 7)); // 月曜起点
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    if (i >= 35 && d.getMonth() !== m) break;
    cells.push(d);
  }
  return cells;
}

function renderCalendar() {
  const el = document.getElementById('calendar-card');
  const isAll = state.room === '__all';
  const rooms = siteRooms(state.site);
  const site = SITES.find(s => s.id === state.site);
  const room = isAll
    ? { name: '全ての会議室', meta: `${rooms.length}室すべての予約を表示`, color: '#5a6a7a' }
    : roomById(state.room) || rooms[0];
  const { y, m } = state.ym;
  const today = new Date();

  const cells = buildCells();
  const weekCount = Math.ceil(cells.length / 7);
  const weekMode = typeof state.week === 'number' && state.week < weekCount;
  const visibleWeeks = weekMode ? [state.week] : Array.from({ length: weekCount }, (_, i) => i);

  const weekdayRow = ['月', '火', '水', '木', '金', '土', '日'].map((l, i) =>
    `<span style="padding:9px 0;text-align:center;font-size:12px;font-weight:700;color:${i === 6 ? '#c05a5a' : i === 5 ? '#2f6f8f' : '#6b7d8f'}">${l}</span>`
  ).join('');

  const weekRows = visibleWeeks.map(wi => {
    const days = cells.slice(wi * 7, wi * 7 + 7);
    const sel = weekMode;
    const cellsHtml = days.map(d => {
      const inMonth = d.getMonth() === m;
      const isToday = d.toDateString() === today.toDateString();
      const dow = d.getDay();
      let bks = [];
      if (inMonth) {
        if (isAll) {
          rooms.forEach(r => bookingsFor(r.id, d, state.bookings).forEach(b => bks.push({ ...b, roomName: r.name, roomColor: r.color })));
          bks.sort((x, yb) => x.start.localeCompare(yb.start));
        } else {
          bks = bookingsFor(room && roomById(state.room) ? state.room : rooms[0].id, d, state.bookings);
        }
      }
      const bg = !inMonth ? '#fbfcfd' : dow === 0 ? '#fdf7f7' : dow === 6 ? '#f7fafd' : '#ffffff';
      const dateColor = !inMonth ? '#c5cfda' : isToday ? '#ffffff' : dow === 0 ? '#c05a5a' : dow === 6 ? '#2f6f8f' : '#1c2b3a';
      const chips = bks.map(b => {
        const rc = b.roomColor || room.color;
        // デザインサンプル・旧データは誰でも編集可能(ユーザー指示 2026-08-20)。
        // 2026-08-24以降の実予約(b.editable===false)は主催者本人のみ(Exchangeが強制)
        const own = !!b.user && b.editable !== false;
        return `
        <span ${own ? `data-chip-edit="${esc(b.id)}" title="クリックで変更・取消" ` : ''}style="display:flex;flex-direction:column;background:${rc};border-left:4px solid ${barColor(b, rc)};border-radius:4px;padding:4px 7px;line-height:1.35${own ? ';cursor:pointer' : ''}${b.pending ? ';opacity:0.65' : ''}">
          <span style="display:flex;align-items:center;gap:5px;flex-wrap:wrap">
            <span style="font-size:10px;font-weight:700;color:rgba(255,255,255,0.93)">${esc(b.start)}–${esc(b.end)}</span>
            <span style="font-size:10px;font-weight:700;color:rgba(255,255,255,0.93);word-break:normal;overflow-wrap:break-word">/ ${esc(b.roomName || room.name)}</span>
            ${statusBadge(b)}${extraBadgeHtml(b)}
            <span style="font-size:10px;font-weight:700;color:rgba(255,255,255,0.93)">${esc(surname(b.owner))}</span>
          </span>
          <span style="font-size:11px;font-weight:500;color:#ffffff;word-break:normal;overflow-wrap:break-word">${esc(b.title)}</span>
        </span>`;
      }).join('');
      return `
      <button class="hv-cell" ${inMonth ? `data-date="${isoDate(d)}"` : ''} style="display:flex;flex-direction:column;gap:4px;align-items:stretch;min-height:118px;border:none;border-right:1px solid #f2f5f9;border-bottom:1px solid #f2f5f9;background:${bg};padding:7px 8px;cursor:pointer;text-align:left;font-family:inherit">
        <span style="display:flex;align-items:center;gap:6px">
          <span style="font-size:13px;font-weight:700;color:${dateColor};background:${isToday ? '#1e5fa8' : 'transparent'};border-radius:50%;width:22px;height:22px;display:flex;align-items:center;justify-content:center">${d.getDate()}</span>
          <span style="font-size:10px;color:#a8b5c2;margin-left:auto">${inMonth && bks.length ? `${bks.length}件` : ''}</span>
        </span>
        ${chips}
      </button>`;
    }).join('');
    return `
    <div style="display:grid;grid-template-columns:46px repeat(7,1fr)">
      <button class="hv-week" data-week="${wi}" style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;border:none;border-right:1px solid #e8edf3;border-bottom:1px solid #f2f5f9;background:${sel ? '#1e5fa8' : '#f7fafd'};cursor:pointer;font-family:inherit;padding:6px 2px">
        <span style="font-size:11px;font-weight:700;color:${sel ? '#ffffff' : '#6b7d8f'};writing-mode:vertical-rl;letter-spacing:0.08em">${sel ? '月間' : `第${wi + 1}週`}</span>
      </button>
      ${cellsHtml}
    </div>`;
  }).join('');

  const weekDays = weekMode ? cells.slice(state.week * 7, state.week * 7 + 7) : [];
  const weekBanner = weekMode ? `
    <div style="display:flex;align-items:center;gap:12px;padding:10px 20px;background:#eef4fb;border-bottom:1px solid #dbe7f4">
      <span style="font-size:12px;font-weight:700;color:#1e5fa8">${weekDays[0].getDate()}日〜${weekDays[weekDays.length - 1].getDate()}日の週を表示中</span>
      <button id="exit-week" class="hv-btn-light" style="margin-left:auto;border:1px solid #c8dcf0;background:#ffffff;border-radius:7px;padding:5px 14px;cursor:pointer;color:#1e5fa8;font-size:12px;font-weight:700;font-family:inherit">月間表示に戻る</button>
    </div>` : '';

  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:14px;padding:15px 20px;border-bottom:1px solid #e8edf3;flex-wrap:wrap">
      <span style="display:flex;align-items:center;gap:9px">
        <span style="width:12px;height:12px;border-radius:4px;background:${room.color}"></span>
        <h2 style="margin:0;font-size:16px;font-weight:700;white-space:nowrap">${esc(state.room === '__all' ? `${site.name} ・ 全ての会議室` : `${site.name} ${room.name}`)}</h2>
        <span style="font-size:12px;color:#6b7d8f;white-space:nowrap">${esc(room.meta)}</span>
      </span>
      <span style="display:flex;align-items:center;gap:6px;margin-left:auto">
        <button id="prev-month" class="hv-btn-light" style="border:1px solid #dfe8f0;background:#ffffff;border-radius:8px;width:32px;height:32px;cursor:pointer;color:#1e5fa8;font-size:14px;font-family:inherit">‹</button>
        <span style="font-size:15px;font-weight:700;min-width:118px;text-align:center;white-space:nowrap">${y}年 ${m + 1}月</span>
        <button id="next-month" class="hv-btn-light" style="border:1px solid #dfe8f0;background:#ffffff;border-radius:8px;width:32px;height:32px;cursor:pointer;color:#1e5fa8;font-size:14px;font-family:inherit">›</button>
        <button id="this-month" class="hv-btn-plain" style="border:1px solid #dfe8f0;background:#ffffff;border-radius:8px;padding:7px 14px;margin-left:6px;cursor:pointer;color:#1c2b3a;font-size:12px;font-weight:500;font-family:inherit">今月</button>
        <button id="export-csv" class="hv-btn-plain" style="border:1px solid #dfe8f0;background:#ffffff;border-radius:8px;padding:7px 14px;cursor:pointer;color:#1c2b3a;font-size:12px;font-weight:500;font-family:inherit">CSV出力</button>
      </span>
    </div>
    ${weekBanner}
    <div style="display:grid;grid-template-columns:46px repeat(7,1fr);border-bottom:1px solid #e8edf3">
      <span></span>${weekdayRow}
    </div>
    ${weekRows}
    ${calendarFooterHtml()}`;

  const shift = n => {
    const d = new Date(y, m + n, 1);
    state.ym = { y: d.getFullYear(), m: d.getMonth() };
    state.day = null; state.week = null;
    navigate();
  };
  el.querySelector('#prev-month').addEventListener('click', () => shift(-1));
  el.querySelector('#next-month').addEventListener('click', () => shift(1));
  el.querySelector('#this-month').addEventListener('click', () => {
    state.ym = { y: today.getFullYear(), m: today.getMonth() };
    state.day = null; state.week = null;
    navigate();
  });
  el.querySelector('#export-csv').addEventListener('click', exportCsv);
  const exitBtn = el.querySelector('#exit-week');
  if (exitBtn) exitBtn.addEventListener('click', () => { state.week = null; render(); });
  el.querySelectorAll('[data-week]').forEach(b => b.addEventListener('click', () => {
    const wi = Number(b.dataset.week);
    state.week = weekMode && state.week === wi ? null : wi;
    state.day = null;
    render();
  }));
  el.querySelectorAll('[data-date]').forEach(b => b.addEventListener('click', () => {
    const [yy, mm, dd] = b.dataset.date.split('-').map(Number);
    state.day = { y: yy, m: mm - 1, d: dd };
    renderModals();
  }));
  // 自分の予約チップはクリックで直接「変更・取消」フォームを開く(セルの日別ポップアップより優先)
  el.querySelectorAll('[data-chip-edit]').forEach(chip => chip.addEventListener('click', e => {
    e.stopPropagation();
    openEditBooking(chip.dataset.chipEdit);
  }));
}

// ---- CSV出力(表示中の拠点・会議室の当月分) ----

function exportCsv() {
  const site = SITES.find(s => s.id === state.site);
  const rooms = state.room === '__all' ? siteRooms(state.site) : [roomById(state.room)];
  const { y, m } = state.ym;
  const last = new Date(y, m + 1, 0).getDate();
  const rows = [['拠点', '会議室', '日付', '曜日', '開始', '終了', '件名', '予約者']];
  for (let d = 1; d <= last; d++) {
    const date = new Date(y, m, d);
    rooms.forEach(r => bookingsFor(r.id, date, state.bookings).forEach(b => {
      rows.push([site.name, r.name, isoDate(date), WDAYS[date.getDay()], b.start, b.end, b.title, b.owner]);
    }));
  }
  // BOM付きUTF-8(Excel対応)。=+-@ 始まりのセルは ' を前置(Excel数式インジェクション対策)
  const cell = c => {
    let v = String(c);
    if (/^[=+\-@]/.test(v)) v = "'" + v;
    return `"${v.replace(/"/g, '""')}"`;
  };
  const csv = '﻿' + rows.map(r => r.map(cell).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `会議室予約_${site.name}_${y}${pad(m + 1)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---- 日別ポップアップ ----

function renderDayModal() {
  if (!state.day) return '';
  const isAll = state.room === '__all';
  const rooms = siteRooms(state.site);
  const site = SITES.find(s => s.id === state.site);
  const room = isAll ? { name: '全ての会議室', meta: `${rooms.length}室すべての予約を表示`, color: '#5a6a7a' } : roomById(state.room);
  const dd = new Date(state.day.y, state.day.m, state.day.d);
  const title = `${state.day.m + 1}月${state.day.d}日(${WDAYS[dd.getDay()]}) の空き状況`;

  let slotsHtml = '';
  if (isAll) {
    const all = [];
    rooms.forEach(r => bookingsFor(r.id, dd, state.bookings).forEach(b => all.push({ ...b, roomName: r.name, roomColor: r.color })));
    all.sort((x, yb) => x.start.localeCompare(yb.start));
    slotsHtml = all.length ? all.map(b => slotRow({
      time: `${b.start}–${b.end}`, label: b.title, owner: b.owner, booked: true,
      bg: b.roomColor, bar: barColor(b, b.roomColor), roomLabel: b.roomName, badge: statusBadge(b) + extraBadgeHtml(b),
      editable: !!b.user && b.editable !== false, id: b.id, pending: !!b.pending
    })).join('') : `
      <div style="display:flex;align-items:center;gap:14px;background:#fbfcfd;border-left:6px solid #e8edf3;border-radius:8px;padding:10px 14px">
        <span style="font-size:13px;font-weight:500;color:#8a99a8">この日の予約はありません</span>
      </div>`;
  } else {
    const bks = bookingsFor(state.room, dd, state.bookings);
    const parts = [];
    // 予約可能時間 8:00〜21:00。30分単位のスロット表示(ユーザー指示 2026-08-22。最終スロットは 20:30–21:00)
    for (let min = 8 * 60; min < 21 * 60; min += 30) {
      const label = `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
      const slotEnd = `${pad(Math.floor((min + 30) / 60))}:${pad((min + 30) % 60)}`;
      // 区間重なり判定(ゼロ埋めHH:MMなので文字列比較でよい)
      const hit = bks.find(b => b.start < slotEnd && b.end > label);
      parts.push(hit
        ? slotRow({
            time: label, label: hit.title, owner: hit.owner, booked: true,
            bg: room.color, bar: barColor(hit, room.color), roomLabel: room.name, badge: statusBadge(hit) + extraBadgeHtml(hit),
            editable: !!hit.user && hit.editable !== false, id: hit.id, pending: !!hit.pending
          })
        : slotRow({ time: label, label: '空き', booked: false, start: label }));
    }
    slotsHtml = parts.join('');
  }

  return `
  <div data-overlay="day" style="position:fixed;inset:0;background:rgba(20,40,65,0.45);display:flex;align-items:center;justify-content:center;padding:24px;z-index:100">
    <div data-stop style="background:#ffffff;border-radius:16px;box-shadow:0 12px 40px rgba(15,35,60,0.3);max-width:600px;width:100%;max-height:82vh;display:flex;flex-direction:column;overflow:hidden">
      <div style="display:flex;align-items:flex-start;gap:12px;padding:20px 26px 16px;border-bottom:1px solid #e4ebf2">
        <div style="display:flex;flex-direction:column;gap:6px;min-width:0">
          <span style="display:flex;align-items:center;gap:9px">
            <span style="width:10px;height:10px;border-radius:3px;background:${room.color}"></span>
            <span style="font-size:12px;color:#6b7d8f">${esc(`${site.name} ${room.name}`)} ・ ${esc(room.meta)}</span>
          </span>
          <h3 style="margin:0;font-size:19px;font-weight:700">${esc(title)}</h3>
        </div>
        <button class="hv-close" data-close-day style="margin-left:auto;border:none;background:#f0f4f8;border-radius:8px;width:32px;height:32px;cursor:pointer;color:#6b7d8f;font-size:15px;flex-shrink:0">✕</button>
      </div>
      <div style="padding:16px 26px;overflow-y:auto;display:flex;flex-direction:column;gap:6px">${slotsHtml}</div>
      <div style="padding:14px 26px;border-top:1px solid #e4ebf2;display:flex;align-items:center;gap:10px">
        <span style="font-size:12px;color:#8a99a8">予約は Outlook の予定表に反映されます</span>
        <span style="margin-left:auto;display:flex;gap:10px">
          ${!isAll ? '<button id="quick-book" class="hv-btn-primary" style="border:none;background:#1e5fa8;color:#ffffff;border-radius:8px;padding:8px 20px;cursor:pointer;font-size:13px;font-weight:700;font-family:inherit">＋ 時間を指定して予約</button>' : ''}
          <button class="hv-btn-plain" data-close-day style="border:1px solid #dfe8f0;background:#ffffff;border-radius:8px;padding:8px 20px;cursor:pointer;color:#1c2b3a;font-size:13px;font-weight:500;font-family:inherit">閉じる</button>
        </span>
      </div>
    </div>
  </div>`;
}

function slotRow(s) {
  if (s.booked) {
    return `
    <div style="display:flex;align-items:center;gap:14px;background:${s.bg};border-left:6px solid ${s.bar};border-radius:8px;padding:10px 14px${s.pending ? ';opacity:0.65' : ''}">
      <span style="display:flex;flex-direction:column;gap:2px;min-width:0">
        <span style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span style="font-size:12px;font-weight:700;color:rgba(255,255,255,0.93)">${esc(s.time)}</span>
          <span style="font-size:12px;color:rgba(255,255,255,0.93)">/</span>
          <span style="font-size:12px;font-weight:700;color:#ffffff;background:rgba(255,255,255,0.18);border-radius:5px;padding:2px 8px">${esc(s.roomLabel)}</span>
          ${s.badge}
        </span>
        <span style="font-size:13px;font-weight:700;color:#ffffff">${esc(s.label)}<span style="font-weight:500;color:rgba(255,255,255,0.93)"> ・ ${esc(s.owner)}</span></span>
      </span>
      <span style="margin-left:auto;flex-shrink:0;display:flex;gap:8px">
        ${s.editable ? `
          <button class="hv-btn-light" data-edit-id="${esc(s.id)}" style="font-size:12px;font-weight:700;color:#1e5fa8;background:#ffffff;border:1px solid #c8dcf0;border-radius:7px;padding:5px 14px;white-space:nowrap;cursor:pointer;font-family:inherit">変更</button>
          <button class="hv-btn-danger" data-cancel-id="${esc(s.id)}" style="font-size:12px;font-weight:500;color:#a8b5c2;background:#ffffff;border:1px solid #e4eaf1;border-radius:7px;padding:5px 14px;white-space:nowrap;cursor:pointer;font-family:inherit">取消</button>` : ''}
      </span>
    </div>`;
  }
  return `
  <div style="display:flex;align-items:center;gap:14px;background:#fbfcfd;border-left:6px solid #e8edf3;border-radius:8px;padding:10px 14px">
    <span style="display:flex;flex-direction:column;gap:2px;min-width:0">
      <span style="font-size:12px;font-weight:700;color:#8a99a8">${esc(s.time)}</span>
      <span style="font-size:13px;font-weight:500;color:#8a99a8">空き</span>
    </span>
    <span style="margin-left:auto;flex-shrink:0">
      <button class="hv-btn-light" data-book-start="${esc(s.start)}" style="font-size:12px;font-weight:700;color:#1e5fa8;background:#ffffff;border:1px solid #c8dcf0;border-radius:7px;padding:5px 14px;white-space:nowrap;cursor:pointer;font-family:inherit">予約する</button>
    </span>
  </div>`;
}

// ---- 予約フォーム ----

function hourOptions() {
  // 予約可能時間は 8:00〜21:00(30分刻み)
  const opts = [];
  for (let h = 8; h <= 20; h++) { opts.push(`${pad(h)}:00`); opts.push(`${pad(h)}:30`); }
  opts.push('21:00');
  return opts;
}

/** 'HH:MM' の1時間後を返す(上限21:00)。開始時間選択時の終了時間の自動設定に使う */
function plusOneHour(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const total = Math.min(h * 60 + m + 60, 21 * 60);
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

function openForm(form) {
  state.form = form;
  candidates = [];
  renderModals();
}

/** 自分の予約を変更モードで開く(カレンダーチップ・日別ポップアップ共通) */
function openEditBooking(id) {
  const bk = state.bookings.find(x => String(x.id) === String(id));
  if (!bk) return;
  const room = roomById(bk.room);
  state.day = null;
  openForm({
    editId: bk.id, site: room ? room.site : state.site, room: bk.room, date: bk.date,
    start: bk.start, end: bk.end, title: bk.title,
    members: (bk.members || []).slice(), guests: bk.guests || '',
    source: bk.source || 'legacy', myEventId: bk.myEventId || null
  });
}

function formError(f) {
  if (!f.room) return '会議室を選択してください';
  if (f.start >= f.end) return '終了時刻は開始時刻より後にしてください';
  // 2026-07-01〜2026-08-23はフローズンなサンプル期間のため予約操作を行わない(ユーザー指示 2026-08-21)
  if (f.date <= SAMPLE_HISTORY_END) return 'この期間(8月23日以前)はサンプル表示のため予約の作成・変更はできません';
  // 2026-08-24以降(実予約)は、Exchangeが過去日時の会議室予約を処理しないため作成・変更できない
  if (useRealRooms()) {
    const todayIso = isoDate(new Date());
    const nowHHMM = `${pad(new Date().getHours())}:${pad(new Date().getMinutes())}`;
    if (f.date < todayIso || (f.date === todayIso && f.end <= nowHHMM)) {
      return '過去の日時は予約できません(Exchangeが会議室の予約を処理しません)';
    }
  }
  return '';
}

function renderFormModal() {
  const f = state.form;
  if (!f) return '';
  const isEdit = !!f.editId;
  const site = SITES.find(s => s.id === (f.site || state.site));
  const room = roomById(f.room);
  const opts = hourOptions();
  const selOpts = v => opts.map(o => `<option value="${o}" ${o === v ? 'selected' : ''}>${o}</option>`).join('');

  const target = f.isNew ? `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px">
      <label style="display:flex;flex-direction:column;gap:5px">
        <span style="font-size:12px;font-weight:700;color:#6b7d8f">展示場</span>
        <select id="form-site" class="in-input">${SITES.map(s => `<option value="${s.id}" ${s.id === f.site ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
      </label>
      <label style="display:flex;flex-direction:column;gap:5px">
        <span style="font-size:12px;font-weight:700;color:#6b7d8f">会議室</span>
        <select id="form-room" class="in-input">${siteRooms(f.site).map(r => `<option value="${r.id}" ${r.id === f.room ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select>
      </label>
      <label style="display:flex;flex-direction:column;gap:5px">
        <span style="font-size:12px;font-weight:700;color:#6b7d8f">日付</span>
        <input type="date" id="form-date" class="in-input" value="${esc(f.date)}">
      </label>
    </div>` : `
    <div style="display:flex;align-items:center;gap:10px;background:#f5f8fb;border-radius:9px;padding:11px 15px">
      <span style="font-size:13px;font-weight:700">${esc(site.name)} ${esc(room ? room.name : '')}</span>
      <span style="margin-left:auto;font-size:13px;color:#6b7d8f">${esc(f.date.split('-').slice(1).map(Number).join('/'))}</span>
    </div>`;

  const chips = f.members.map((mb, i) => `
    <span style="display:flex;align-items:center;gap:6px;background:#e9f1fa;border:1px solid #c8dcf0;border-radius:16px;padding:3px 10px 3px 4px">
      <span style="width:22px;height:22px;border-radius:50%;background:#4a7fc0;color:#ffffff;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700">${esc(mb.name.charAt(0))}</span>
      <span style="font-size:12px;font-weight:500;color:#1c2b3a">${esc(mb.name)}</span>
      <button data-rm-member="${i}" style="border:none;background:transparent;cursor:pointer;color:#6b7d8f;font-size:11px;padding:0 2px">✕</button>
    </span>`).join('');

  return `
  <div data-overlay="form" style="position:fixed;inset:0;background:rgba(20,40,65,0.5);display:flex;align-items:center;justify-content:center;padding:24px;z-index:110">
    <div data-stop style="background:#ffffff;border-radius:16px;box-shadow:0 12px 40px rgba(15,35,60,0.3);max-width:520px;width:100%;max-height:88vh;display:flex;flex-direction:column;overflow:hidden">
      <div style="display:flex;align-items:center;gap:12px;padding:20px 26px;border-bottom:1px solid #e4ebf2">
        <h3 style="margin:0;font-size:17px;font-weight:700">${isEdit ? '予約を変更' : '会議室を予約'}</h3>
        <button class="hv-close" data-close-form style="margin-left:auto;border:none;background:#f0f4f8;border-radius:8px;width:32px;height:32px;cursor:pointer;color:#6b7d8f;font-size:15px;flex-shrink:0">✕</button>
      </div>
      <div style="padding:20px 26px;display:flex;flex-direction:column;gap:14px;overflow-y:auto">
        ${target}
        <label style="display:flex;flex-direction:column;gap:5px">
          <span style="font-size:12px;font-weight:700;color:#6b7d8f">件名</span>
          <input id="form-title" class="in-input" value="${esc(f.title)}" placeholder="例: 営業企画 定例MTG">
        </label>
        <div style="display:flex;gap:12px;align-items:flex-end">
          <label style="display:flex;flex-direction:column;gap:5px;flex:1">
            <span style="font-size:12px;font-weight:700;color:#6b7d8f">開始</span>
            <select id="form-start" class="in-input">${selOpts(f.start)}</select>
          </label>
          <span style="font-size:14px;color:#8a99a8;padding-bottom:10px">〜</span>
          <label style="display:flex;flex-direction:column;gap:5px;flex:1">
            <span style="font-size:12px;font-weight:700;color:#6b7d8f">終了</span>
            <select id="form-end" class="in-input">${selOpts(f.end)}</select>
          </label>
        </div>
        <div style="display:flex;flex-direction:column;gap:5px;position:relative">
          <span style="display:flex;align-items:center;gap:8px">
            <span style="font-size:12px;font-weight:700;color:#6b7d8f">社内メンバー</span>
            ${Auth.mode === 'entra'
              ? '<span style="font-size:10px;font-weight:700;color:#2f6f8f;background:#e5f0f7;border-radius:4px;padding:1px 7px">Microsoft 365</span>'
              : '<span style="font-size:10px;font-weight:700;color:#8a6d1f;background:#f7f0dc;border-radius:4px;padding:1px 7px">サンプル表示</span>'}
          </span>
          ${f.members.length ? `<div style="display:flex;flex-wrap:wrap;gap:6px;padding:2px 0">${chips}</div>` : ''}
          <input id="member-input" class="in-input" placeholder="${Auth.mode === 'entra' ? '名前・メールで検索' : '名前・部署・メールで検索'}" autocomplete="off">
          <div id="member-cands" style="position:absolute;top:100%;left:0;right:0;z-index:10"></div>
        </div>
        <label style="display:flex;flex-direction:column;gap:5px">
          <span style="font-size:12px;font-weight:700;color:#6b7d8f">外部参加者(任意)</span>
          <input id="form-guests" class="in-input" value="${esc(f.guests)}" placeholder="例: ○○商事 山田様 2名">
        </label>
        <span id="form-error" style="font-size:12px;color:#c05a5a">${formError(f)}</span>
      </div>
      <div style="padding:16px 26px;border-top:1px solid #e4ebf2;display:flex;gap:10px;align-items:center">
        ${isEdit ? '<button id="form-delete" class="hv-btn-danger" style="border:1px solid #f0d5d5;background:#fbeeee;color:#c05a5a;font-weight:500;border-radius:9px;padding:10px 16px;font-size:13px;cursor:pointer;font-family:inherit">この予約を取消</button>' : ''}
        <span style="margin-left:auto;display:flex;gap:10px">
          <button class="hv-btn-plain" data-close-form style="border:1px solid #dfe8f0;background:#ffffff;color:#6b7d8f;font-weight:500;border-radius:9px;padding:10px 18px;font-size:13px;cursor:pointer;font-family:inherit">キャンセル</button>
          <button id="form-submit" class="hv-btn-primary" style="border:none;background:#1e5fa8;color:#ffffff;font-weight:700;border-radius:9px;padding:10px 24px;font-size:13px;cursor:pointer;font-family:inherit">${isEdit ? '変更を保存' : '予約する'}</button>
        </span>
      </div>
    </div>
  </div>`;
}

function renderCandidates() {
  const box = document.getElementById('member-cands');
  if (!box) return;
  if (!candidates.length) { box.innerHTML = ''; return; }
  box.innerHTML = `
  <div style="background:#ffffff;border:1px solid #dfe8f0;border-radius:10px;box-shadow:0 6px 20px rgba(15,35,60,0.15);overflow:hidden;margin-top:4px">
    ${candidates.map((c, i) => `
      <button class="hv-cand" data-add-member="${i}" style="display:flex;align-items:center;gap:10px;width:100%;border:none;background:transparent;padding:9px 14px;cursor:pointer;text-align:left;font-family:inherit;${i < candidates.length - 1 ? 'border-bottom:1px solid #f2f5f9;' : ''}">
        <span style="width:26px;height:26px;border-radius:50%;background:#4a7fc0;color:#ffffff;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0">${esc(c.name.charAt(0))}</span>
        <span style="display:flex;flex-direction:column;line-height:1.35;min-width:0">
          <span style="font-size:13px;font-weight:500;color:#1c2b3a">${esc(c.name)}</span>
          <span style="font-size:11px;color:#6b7d8f">${c.dept ? `${esc(c.dept)} ・ ` : ''}${esc(c.email)}</span>
        </span>
      </button>`).join('')}
  </div>`;
  box.querySelectorAll('[data-add-member]').forEach(b => b.addEventListener('click', () => {
    const c = candidates[Number(b.dataset.addMember)];
    if (!state.form.members.some(m => m.email === c.email)) state.form.members.push(c);
    candidates = [];
    renderModals();
  }));
}

// searchMembers() は common.js で定義(schedule.js の参加者選択と共用)

let searchTimer = null;
function bindFormEvents(root) {
  const f = state.form;
  const on = (id, ev, fn) => { const el = root.querySelector('#' + id); if (el) el.addEventListener(ev, fn); };

  on('form-site', 'change', e => { f.site = e.target.value; f.room = (siteRooms(f.site)[0] || {}).id || ''; renderModals(); });
  on('form-room', 'change', e => { f.room = e.target.value; updateFormError(); });
  on('form-date', 'change', e => { f.date = e.target.value; });
  on('form-title', 'input', e => { f.title = e.target.value; });
  on('form-guests', 'input', e => { f.guests = e.target.value; });
  on('form-start', 'change', e => {
    f.start = e.target.value;
    f.end = plusOneHour(f.start); // 終了時間を開始+1時間に自動設定(ユーザー指示 2026-08-22)
    renderModals(); // 終了時間セレクトの表示を更新
  });
  on('form-end', 'change', e => { f.end = e.target.value; updateFormError(); });

  on('member-input', 'input', e => {
    const q = e.target.value.trim();
    clearTimeout(searchTimer);
    if (!q) { candidates = []; renderCandidates(); return; }
    searchTimer = setTimeout(async () => {
      try {
        candidates = (await searchMembers(q))
          .filter(c => !f.members.some(m => m.email === c.email) && c.email !== ME.email);
        renderCandidates();
      } catch { /* 検索失敗時は候補を出さない */ }
    }, 180);
  });

  root.querySelectorAll('[data-rm-member]').forEach(b => b.addEventListener('click', () => {
    f.members.splice(Number(b.dataset.rmMember), 1);
    renderModals();
  }));

  on('form-submit', 'click', submitForm);
  on('form-delete', 'click', async () => {
    if (f.source === 'graph') {
      if (!confirm('この予約を取消しますか?(会議室や参加者には取消の通知が送られます)')) return;
      try {
        const token = await Auth.getGraphToken(['Calendars.ReadWrite']);
        const res = await fetch(`https://graph.microsoft.com/v1.0/me/events/${f.myEventId}`, {
          method: 'DELETE', headers: { Authorization: `Bearer ${token}` }
        });
        if (!res.ok && res.status !== 404) throw new Error(`削除に失敗しました(HTTP ${res.status})`);
        state.form = null;
        await loadBookings();
        render();
      } catch (err) { alert(err.message || String(err)); }
      return;
    }
    if (!confirm('この予約を取消しますか?')) return;
    try {
      await api(`/api/bookings/${f.editId}`, { method: 'DELETE' });
      state.form = null;
      await loadBookings();
      render();
    } catch (err) { alert(err.message); }
  });
}

function updateFormError() {
  const el = document.getElementById('form-error');
  if (el && state.form) el.textContent = formError(state.form);
}

async function submitForm() {
  const f = state.form;
  const err = formError(f) || (!f.title.trim() ? '件名を入力してください' : '');
  if (err) {
    const el = document.getElementById('form-error');
    if (el) el.textContent = err;
    return;
  }
  if (useRealRooms() && f.date > SAMPLE_HISTORY_END) await submitRealForm(f);
  else await submitLegacyForm(f);
}

/** 保存後は対象の拠点・会議室・月へ切り替えて結果を表示する(モーダルは閉じる) */
function afterSaveSwitchTo(f) {
  const room = roomById(f.room);
  state.site = room ? room.site : state.site;
  state.room = f.room;
  const [yy, mm] = f.date.split('-').map(Number);
  state.ym = { y: yy, m: mm - 1 };
  state.week = null; state.day = null; state.form = null;
}

/** サンプル・旧データ(SQLite保存)の作成・変更 */
async function submitLegacyForm(f) {
  const payload = {
    room: f.room, date: f.date, start: f.start, end: f.end,
    title: f.title, members: f.members, guests: f.guests
  };
  try {
    if (f.editId) await api(`/api/bookings/${f.editId}`, { method: 'PUT', body: payload });
    else await api('/api/bookings', { method: 'POST', body: payload });
    afterSaveSwitchTo(f);
    await loadBookings();
    render();
  } catch (e2) {
    const el = document.getElementById('form-error');
    if (el) el.textContent = e2.message;
  }
}

/** 2026-08-24以降の実予約(Exchange連携)の作成・変更。schedule.jsのsubmitCreateFormと同じ方式 */
async function submitRealForm(f) {
  const errEl = document.getElementById('form-error');
  const submitBtn = document.getElementById('form-submit');
  submitBtn.disabled = true;
  submitBtn.textContent = f.editId ? '保存中…' : '作成中…';

  const room = roomById(f.room);
  const site = SITES.find(s => s.id === room.site);
  try {
    // 重複の事前チェック(最新状況を取り直して判定)。変更時は自分の元の枠を重複扱いしない
    submitBtn.textContent = '空き状況を確認中…';
    const { rows: busyRows } = await fetchRealRoomBookings([room], f.date, f.date);
    const isOwnOriginalSlot = b => f.myEventId && b.myEventId === f.myEventId;
    const conflict = busyRows.find(b => b.start < f.end && b.end > f.start && !isOwnOriginalSlot(b));
    if (conflict) {
      throw new Error(`この時間帯は既に予約があります(${conflict.start}–${conflict.end})。別の時間帯または会議室を選択してください`);
    }
    submitBtn.textContent = f.editId ? '保存中…' : '作成中…';

    const token = await Auth.getGraphToken(['Calendars.ReadWrite', 'Calendars.ReadWrite.Shared']);
    const attendees = f.members.map(m => ({ emailAddress: { address: m.email }, type: 'required' }));
    // 会議室は実際のExchangeリソースの出席者として追加する(サンプルではなく本物の予約)
    attendees.push({ emailAddress: { address: room.email, name: `${site.name} ${room.name}` }, type: 'resource' });

    const body = {
      subject: f.title.trim(),
      start: { dateTime: `${f.date}T${f.start}:00`, timeZone: 'Tokyo Standard Time' },
      end: { dateTime: `${f.date}T${f.end}:00`, timeZone: 'Tokyo Standard Time' },
      attendees
    };
    // locationEmailAddressで会議室本体と紐づける(文字列だけだと自動承諾時に場所が二重表記になる。schedule.jsと同じ対策)
    const loc = { displayName: `${site.name} ${room.name}`, locationEmailAddress: room.email, locationType: 'conferenceRoom' };
    body.location = loc;
    body.locations = [loc];
    if (f.guests.trim()) body.body = { contentType: 'text', content: `外部参加者: ${f.guests.trim()}` };

    const url = f.myEventId
      ? `https://graph.microsoft.com/v1.0/me/events/${f.myEventId}`
      : 'https://graph.microsoft.com/v1.0/me/events';
    const res = await fetch(url, {
      method: f.myEventId ? 'PATCH' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      throw new Error(err?.error?.message || `予定の${f.myEventId ? '変更' : '作成'}に失敗しました(HTTP ${res.status})`);
    }

    afterSaveSwitchTo(f);
    await loadBookings(); // 直後の取得で「承諾待ち」として即座に表示させる
    render();
    scheduleDelayedRefresh(); // 会議室側の自動承諾反映(数秒〜数十秒)を待って再取得し、確定表示に切り替える
  } catch (e) {
    errEl.textContent = e.message || String(e);
    submitBtn.disabled = false;
    submitBtn.textContent = f.editId ? '変更を保存' : '予約する';
  }
}

/** 会議室側の自動承諾/辞退の反映待ちで、少し時間を置いて再取得する(モーダルが開いていれば見送る) */
function scheduleDelayedRefresh() {
  const refresh = () => loadBookings().then(ok => { if (ok && !state.form) renderCalendar(); }).catch(() => {});
  setTimeout(refresh, 2500);
  setTimeout(refresh, 8000);
}

// ---- モーダルの描画・イベント ----

function renderModals() {
  const root = document.getElementById('modal-root');
  root.innerHTML = renderDayModal() + renderFormModal();

  root.querySelectorAll('[data-stop]').forEach(el => el.addEventListener('click', e => e.stopPropagation()));
  const dayOverlay = root.querySelector('[data-overlay="day"]');
  if (dayOverlay) dayOverlay.addEventListener('click', () => { state.day = null; renderModals(); });
  const formOverlay = root.querySelector('[data-overlay="form"]');
  if (formOverlay) formOverlay.addEventListener('click', () => { state.form = null; renderModals(); });
  root.querySelectorAll('[data-close-day]').forEach(b => b.addEventListener('click', () => { state.day = null; renderModals(); }));
  root.querySelectorAll('[data-close-form]').forEach(b => b.addEventListener('click', () => { state.form = null; renderModals(); }));

  // 日別ポップアップ内の操作(30分単位のスロットから予約。終了は開始+1時間を自動設定)
  root.querySelectorAll('[data-book-start]').forEach(b => b.addEventListener('click', () => {
    const start = b.dataset.bookStart;
    const d = state.day;
    openForm({
      site: state.site, room: state.room, date: isoDate(new Date(d.y, d.m, d.d)),
      start, end: plusOneHour(start), title: '', members: [], guests: ''
    });
  }));
  root.querySelectorAll('[data-cancel-id]').forEach(b => b.addEventListener('click', async () => {
    const row = state.bookings.find(x => String(x.id) === String(b.dataset.cancelId));
    if (!confirm(row && row.source === 'graph' ? 'この予約を取消しますか?(会議室や参加者には取消の通知が送られます)' : 'この予約を取消しますか?')) return;
    try {
      if (row && row.source === 'graph') {
        const token = await Auth.getGraphToken(['Calendars.ReadWrite']);
        const res = await fetch(`https://graph.microsoft.com/v1.0/me/events/${row.myEventId}`, {
          method: 'DELETE', headers: { Authorization: `Bearer ${token}` }
        });
        if (!res.ok && res.status !== 404) throw new Error(`削除に失敗しました(HTTP ${res.status})`);
      } else {
        await api(`/api/bookings/${b.dataset.cancelId}`, { method: 'DELETE' });
      }
      await loadBookings();
      render();
      renderModals();
    } catch (err) { alert(err.message || String(err)); }
  }));
  root.querySelectorAll('[data-edit-id]').forEach(b => b.addEventListener('click', () => {
    openEditBooking(b.dataset.editId);
  }));

  const formRoot = root.querySelector('[data-overlay="form"]');
  if (formRoot) bindFormEvents(formRoot);
}

// ---- 実データ(Exchange)連携。2026-08-24以降・entraモードのみ有効 ----

/** 'YYYY-MM-DD' の翌日を返す */
function nextIsoDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return isoDate(new Date(y, m - 1, d + 1));
}

/** 新規予約フォームの初期日付。今日がサンプル期間中(〜8/23)なら実予約可能な直近日(8/24)に補正する */
function defaultBookableDate() {
  const todayIso = isoDate(new Date());
  if (todayIso >= SAMPLE_HISTORY_START && todayIso <= SAMPLE_HISTORY_END) return nextIsoDate(SAMPLE_HISTORY_END);
  return todayIso;
}

/** カレンダーの表示範囲(前月末〜翌月頭の余白日を含む42枠。buildCellsと同じ範囲) */
function gridRange() {
  const cells = buildCells();
  return { from: isoDate(cells[0]), to: isoDate(cells[cells.length - 1]) };
}

/** fetch + @odata.nextLink 追従(最大5ページ)。GraphのcalendarViewは既定10件/ページのため必須 */
async function graphGetAll(url, token) {
  let all = [];
  let next = url;
  for (let i = 0; i < 5 && next; i++) {
    const res = await fetch(next, {
      headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.timezone="Tokyo Standard Time", odata.maxpagesize=200' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    all = all.concat(data.value || []);
    next = data['@odata.nextLink'] || null;
  }
  return all;
}

/** 終日・複数日の予定はendを'24:00'にクランプする(そのままだと00:00–00:00表示になるため) */
function clampEventTimes(ev) {
  const startDate = ev.start.dateTime.slice(0, 10);
  const endDate = ev.end.dateTime.slice(0, 10);
  const start = ev.start.dateTime.slice(11, 16);
  let end = ev.end.dateTime.slice(11, 16);
  if (ev.isAllDay || endDate > startDate) end = '24:00';
  return { date: startDate, start, end };
}

/** Graphのattendeesから「社内メンバー」欄を再構成する(会議室・自分自身を除外) */
function attendeesToMembers(attendees, myEmail) {
  const roomEmails = new Set(ROOMS.map(r => r.email.toLowerCase()));
  return (attendees || [])
    .filter(a => a.type !== 'resource')
    .map(a => ({ email: (a.emailAddress && a.emailAddress.address) || '', name: (a.emailAddress && a.emailAddress.name) || '' }))
    .filter(a => a.email && !roomEmails.has(a.email.toLowerCase()) && !sameEmail(a.email, myEmail));
}

/** 本文の「外部参加者: ...」表記を復元する(schedule.jsと同じ規約) */
function guestsFromBody(bodyContent) {
  const m = /^外部参加者: ([\s\S]*)$/.exec(String(bodyContent || '').trim());
  return m ? m[1].trim() : '';
}

/** 自分の予定表から会議室を出席者に含む予定を取得し、iCalUId+開始時刻をキーにしたMapを返す。
    会議室側のcalendarViewで取れるIDは会議室メールボックス側のコピーのIDで /me/events/{id} には
    使えないため、自分のコピーのID(myEventId)をここで別途取得して突き合わせる。 */
async function fetchMyRoomEvents(from, to, token) {
  const myEmail = (ME && ME.email) || '';
  const url = 'https://graph.microsoft.com/v1.0/me/calendarView' +
    `?startDateTime=${encodeURIComponent(from + 'T00:00:00')}` +
    `&endDateTime=${encodeURIComponent(to + 'T23:59:59')}` +
    '&$select=id,iCalUId,subject,start,end,attendees,body,isAllDay,type,isOrganizer&$orderby=start/dateTime&$top=200';
  const events = await graphGetAll(url, token);
  const map = new Map();
  events.forEach(ev => {
    const roomAttendee = (ev.attendees || []).find(a => a.type === 'resource');
    if (!roomAttendee || !ev.iCalUId) return;
    const roomEmail = (roomAttendee.emailAddress && roomAttendee.emailAddress.address) || '';
    const room = ROOMS.find(r => sameEmail(r.email, roomEmail));
    if (!room) return;
    const { date, start, end } = clampEventTimes(ev);
    const key = `${ev.iCalUId}|${ev.start.dateTime.slice(0, 16)}`;
    map.set(key, {
      id: ev.id, roomId: room.id, isOrganizer: !!ev.isOrganizer, type: ev.type,
      date, start, end, title: ev.subject || '(件名なし)',
      members: attendeesToMembers(ev.attendees, myEmail),
      guests: guestsFromBody(ev.body && ev.body.contentType === 'text' ? ev.body.content : ''),
      roomResponse: (roomAttendee.status && roomAttendee.status.response) || 'none'
    });
  });
  return map;
}

/** 指定会議室群の指定期間の実予約(Exchange)を取得する。会議室ごとにtry/catchし、
    失敗した会議室は空扱い+errorsに名前を記録する(1室の失敗で全体を壊さない)。
    自分が作成直後で会議室側にまだ反映されていない予約は「承諾待ち」として別途表示する。 */
async function fetchRealRoomBookings(rooms, from, to) {
  if (!useRealRooms() || !rooms.length) return { rows: [], errors: [] };

  const token = await Auth.getGraphToken(['Calendars.ReadWrite', 'Calendars.ReadWrite.Shared']);
  const mine = await fetchMyRoomEvents(from, to, token).catch(() => new Map());

  const errors = [];
  const perRoom = await Promise.all(rooms.map(async room => {
    try {
      const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(room.email)}/calendarView` +
        `?startDateTime=${encodeURIComponent(from + 'T00:00:00')}` +
        `&endDateTime=${encodeURIComponent(to + 'T23:59:59')}` +
        '&$select=id,iCalUId,subject,start,end,organizer,type,isAllDay&$orderby=start/dateTime&$top=200';
      const events = await graphGetAll(url, token);
      return events.map(ev => {
        const { date, start, end } = clampEventTimes(ev);
        const key = `${ev.iCalUId}|${ev.start.dateTime.slice(0, 16)}`;
        const mineEv = mine.get(key);
        return {
          id: `graph:${room.id}:${ev.id}`, source: 'graph',
          room: room.id, date, start, end,
          title: ev.subject || '(件名なし)',
          owner: (ev.organizer && ev.organizer.emailAddress && ev.organizer.emailAddress.name) || '',
          owner_email: (ev.organizer && ev.organizer.emailAddress && ev.organizer.emailAddress.address) || '',
          members: (mineEv && mineEv.members) || [],
          guests: (mineEv && mineEv.guests) || '',
          myEventId: (mineEv && mineEv.id) || null,
          editable: !!(mineEv && mineEv.id && mineEv.isOrganizer && ev.type === 'singleInstance')
        };
      });
    } catch (e) {
      console.error(`会議室「${room.name}」の予約取得に失敗しました`, e);
      errors.push(room.name);
      return [];
    }
  }));
  const rows = perRoom.flat();

  // 会議室側にまだ反映されていない自分の予約(承諾待ち)を追加する。既に反映済みのものと重複しないようにする
  const seenKeys = new Set(rows.map(r => `${r.room}|${r.date}|${r.start}|${r.end}`));
  const roomIdSet = new Set(rooms.map(r => r.id));
  const pending = [];
  mine.forEach(mineEv => {
    if (!roomIdSet.has(mineEv.roomId)) return;
    if (seenKeys.has(`${mineEv.roomId}|${mineEv.date}|${mineEv.start}|${mineEv.end}`)) return;
    pending.push({
      id: `pending:${mineEv.id}`, source: 'graph',
      room: mineEv.roomId, date: mineEv.date, start: mineEv.start, end: mineEv.end,
      title: mineEv.title, owner: (ME && ME.name) || '', owner_email: (ME && ME.email) || '',
      members: mineEv.members, guests: mineEv.guests, myEventId: mineEv.id,
      editable: mineEv.isOrganizer && mineEv.type === 'singleInstance',
      pending: true, declined: mineEv.roomResponse === 'declined'
    });
  });

  return { rows: rows.concat(pending), errors };
}

/** 拠点別の「今どういう状態か」の説明文(実データ・サンプルの区別を必ず示す。CLAUDE.mdルール4) */
function calendarFooterHtml() {
  const today = new Date();
  const modeNote = useRealRooms()
    ? '7/1〜8/23はサンプル表示(操作不可)。8/24以降は実際のExchange予約です(件名・主催者はExchangeから取得)。'
    : (Auth.mode === 'entra'
      ? '7/1〜8/23はサンプル表示(操作不可)。8/24以降はEntra IDでのサインイン後に実データ連携が有効になります。'
      : 'デザインサンプル表示です(Entra IDでサインインすると8/24以降が実データになります)。');
  const errorNote = (state.realErrors && state.realErrors.length)
    ? `<div style="width:100%;font-size:12px;color:#c05a5a;background:#fbeeee;border-radius:6px;padding:6px 10px">一部の会議室の予約を取得できませんでした(${esc(state.realErrors.join('、'))})。管理者に会議室カレンダーの参照権限(Reviewer)の付与を依頼してください。</div>`
    : '';
  return `
    <div style="padding:12px 20px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <span style="font-size:12px;color:#8a99a8">左端の「第N週」ボタンでその週だけを表示できます。${esc(modeNote)}</span>
      <span style="margin-left:auto;font-size:12px;color:#8a99a8">最終同期 ${pad(today.getHours())}:${pad(today.getMinutes())}</span>
      ${errorNote}
    </div>`;
}

// ---- 初期化 ----

function mergeBookings() {
  state.bookings = state.legacy.concat(state.real);
}

let loadSeq = 0;

/** サンプル・旧データ(SQLite)+ 実予約(Exchange。entraモードかつ8/24以降のみ)を取得する。
    連続クリック等で追い越された古い呼び出しの結果は捨てる(戻り値falseで判定)。 */
async function loadBookings() {
  const seq = ++loadSeq;
  const legacyUrl = useRealRooms() ? `/api/bookings?from=2000-01-01&to=${SAMPLE_HISTORY_END}` : '/api/bookings';
  const { from, to } = gridRange();
  const rooms = (useRealRooms() && to > SAMPLE_HISTORY_END) ? siteRooms(state.site) : [];
  const realFrom = from > SAMPLE_HISTORY_END ? from : nextIsoDate(SAMPLE_HISTORY_END);

  const [legacy, real] = await Promise.all([
    api(legacyUrl),
    rooms.length ? fetchRealRoomBookings(rooms, realFrom, to) : Promise.resolve({ rows: [], errors: [] })
  ]);
  if (seq !== loadSeq) return false; // 追い越された古い結果は捨てる
  state.legacy = legacy;
  state.real = real.rows;
  state.realErrors = real.errors;
  mergeBookings();
  return true;
}

/** 拠点・月の切り替え時: 即座に再描画しつつ、裏で最新データを取得してカレンダーだけ差し替える
    (render()全体だとフォームモーダルが開いていた場合に消えてしまうため) */
function navigate() {
  render();
  loadBookings().then(ok => { if (ok && !state.form) renderCalendar(); }).catch(() => {});
}

function render() {
  renderSiteTabs();
  renderRoomTabs();
  renderCalendar();
  renderModals();
}

// 自動リフレッシュ(共通方針: 2分間隔・モーダル表示中と非表示タブはスキップ・差分があるときだけ静かに差し替え)
async function autoRefresh() {
  if (state.day || state.form || document.hidden) return;
  try {
    const prev = JSON.stringify(state.bookings);
    const ok = await loadBookings();
    if (!ok || state.day || state.form) return; // 取得中にモーダルが開いたら描き替えない(次回に反映)
    if (JSON.stringify(state.bookings) !== prev) render();
  } catch { /* 自動更新の失敗は静かに無視(次回に再試行) */ }
}

(async function init() {
  try {
    ME = await Auth.init();
    const badge = document.getElementById('exchange-badge');
    if (badge) {
      badge.textContent = useRealRooms() ? 'Exchange 連携(8/24以降)'
        : Auth.mode === 'entra' ? 'Exchange 連携(準備中)' : 'デザインサンプル';
    }
    await loadBookings();
    render();

    setInterval(autoRefresh, 2 * 60 * 1000);
  } catch (e) {
    console.error(e);
    document.getElementById('calendar-card').innerHTML =
      `<div style="padding:24px;font-size:13px;color:#c05a5a">読み込みに失敗しました: ${esc(e.message || e)}</div>`;
  }
})();
