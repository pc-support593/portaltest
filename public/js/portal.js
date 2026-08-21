// ポータルトップ画面
// お知らせ・全社スケジュール・クイックリンクはサーバー(管理画面で編集)から取得。
// 「今日の予定」「タスク・承認待ち」は Graph / 各システム連携までのダミー表示。
'use strict';

// カテゴリバッジ配色(デザイン確定値)
const TAG_STYLES = {
  '重要': ['#ffffff', '#d9534f'],
  '総務': ['#1e5fa8', '#e3edf8'],
  '安全': ['#2e7d52', '#e5f2ea'],
  '人事': ['#1e5fa8', '#e3edf8'],
  'IT': ['#8a6d1f', '#f7f0dc']
};
const DEFAULT_TAG = ['#1e5fa8', '#e3edf8'];

// クイックリンクのアイコン背景色(プロトタイプの8色を順に割り当て)
const LINK_COLORS = ['#1e5fa8', '#e08a2e', '#c05a5a', '#4a90b8', '#8a6d1f', '#7b5ea8', '#2e7d52', '#5a6a7a'];

// devモード用のダミー(色: 青/緑/橙)。entraモードでは実際のOutlook予定表(Graph /me/calendarView)に置き換える
const TODAY_EVENTS = [
  { time: '10:00–11:00', title: '営業企画 定例ミーティング', place: '会議室A / オンライン', color: '#2e6fc0', bg: '#f2f6fb', timeColor: '#2e6fc0' },
  { time: '13:30–14:00', title: '上期施策レビュー 事前打合せ', place: 'オンライン', color: '#2e7d52', bg: '#f0f8f3', timeColor: '#2e7d52' },
  { time: '16:00–17:00', title: '部門横断プロジェクト キックオフ', place: '大会議室', color: '#d97b3f', bg: '#fdf5ee', timeColor: '#c96a2e' }
];

// 実イベントに割り当てる配色(件数に応じて先頭から順に循環)
const EVENT_COLOR_CYCLE = [
  { color: '#2e6fc0', bg: '#f2f6fb', timeColor: '#2e6fc0' },
  { color: '#2e7d52', bg: '#f0f8f3', timeColor: '#2e7d52' },
  { color: '#d97b3f', bg: '#fdf5ee', timeColor: '#c96a2e' }
];

/** 今日の予定を取得する。devモードはダミー、entraモードは Graph /me/calendarView(本人の予定表・読み取りのみ) */
async function fetchTodayEvents() {
  if (Auth.mode !== 'entra') return TODAY_EVENTS;

  const pad = n => String(n).padStart(2, '0');
  const d = new Date();
  const dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const token = await Auth.getGraphToken(['Calendars.Read']);
  const url = 'https://graph.microsoft.com/v1.0/me/calendarView' +
    `?startDateTime=${encodeURIComponent(dateStr + 'T00:00:00')}` +
    `&endDateTime=${encodeURIComponent(dateStr + 'T23:59:59')}` +
    '&$select=subject,start,end,location,isAllDay&$orderby=start/dateTime';

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      // ローカル時刻(日本時間)で受け取る。yoshimuraichi.com は国内のみのため固定でよい
      Prefer: 'outlook.timezone="Tokyo Standard Time"'
    }
  });
  if (!res.ok) throw new Error(`予定表の取得に失敗しました(HTTP ${res.status})`);
  const data = await res.json();

  return (data.value || []).map((ev, i) => ({
    time: ev.isAllDay ? '終日' : `${ev.start.dateTime.slice(11, 16)}–${ev.end.dateTime.slice(11, 16)}`,
    title: ev.subject || '(件名なし)',
    place: (ev.location && ev.location.displayName) || '',
    ...EVENT_COLOR_CYCLE[i % EVENT_COLOR_CYCLE.length]
  }));
}

// 各システム連携までのダミー
const TASKS = [
  { kind: '承認', kindColor: '#b0721f', kindBg: '#fdf4e7', title: '出張旅費精算(田中 健太)', sub: '経費精算システム ・ 期限 7/18' },
  { kind: '承認', kindColor: '#b0721f', kindBg: '#fdf4e7', title: '有給休暇申請(鈴木 花子 8/3–8/5)', sub: '勤怠管理 ・ 期限 7/22' },
  { kind: '提出', kindColor: '#2f6f8f', kindBg: '#e5f0f7', title: '上期目標の自己評価入力', sub: '人事評価システム ・ 期限 7/25' },
  { kind: '回答', kindColor: '#2e7d52', kindBg: '#e5f2ea', title: '従業員満足度サーベイ', sub: '人事部 ・ 期限 7/31' }
];

let modalData = null;

function openModal(m) {
  modalData = m;
  renderModal();
}

function closeModal() {
  modalData = null;
  renderModal();
}

function renderModal() {
  const root = document.getElementById('modal-root');
  if (!modalData) { root.innerHTML = ''; return; }
  const m = modalData;
  root.innerHTML = `
  <div id="modal-overlay" style="position:fixed;inset:0;background:rgba(20,40,65,0.45);display:flex;align-items:center;justify-content:center;padding:24px;z-index:100">
    <div id="modal-box" style="background:#ffffff;border-radius:16px;box-shadow:0 12px 40px rgba(15,35,60,0.3);max-width:640px;width:100%;max-height:80vh;display:flex;flex-direction:column;overflow:hidden">
      <div style="display:flex;align-items:flex-start;gap:12px;padding:22px 26px 16px;border-bottom:1px solid #e4ebf2">
        <div style="display:flex;flex-direction:column;gap:8px;min-width:0">
          <div style="display:flex;align-items:center;gap:10px">
            <span style="font-size:11px;font-weight:700;color:${m.tagColor};background:${m.tagBg};border-radius:4px;padding:2px 8px">${esc(m.tag)}</span>
            <span style="font-size:12px;color:#6b7d8f">${esc(m.date)}</span>
          </div>
          <h3 style="margin:0;font-size:19px;font-weight:700;line-height:1.4">${esc(m.title)}</h3>
        </div>
        <button class="hv-close" data-close style="margin-left:auto;border:none;background:#f0f4f8;border-radius:8px;width:32px;height:32px;cursor:pointer;color:#6b7d8f;font-size:15px;flex-shrink:0">✕</button>
      </div>
      <div style="padding:20px 26px;overflow-y:auto">
        <p style="margin:0;font-size:14px;line-height:1.9;white-space:pre-wrap">${esc(m.body)}</p>
      </div>
      <div style="padding:14px 26px;border-top:1px solid #e4ebf2;display:flex;align-items:center">
        <span style="font-size:12px;color:#8a99a8">発信: ${esc(m.owner)}</span>
        <button class="hv-btn-plain" data-close style="margin-left:auto;border:1px solid #dfe8f0;background:#ffffff;border-radius:8px;padding:8px 20px;cursor:pointer;color:#1c2b3a;font-size:13px;font-weight:500;font-family:inherit">閉じる</button>
      </div>
    </div>
  </div>`;
  root.querySelector('#modal-overlay').addEventListener('click', closeModal);
  root.querySelector('#modal-box').addEventListener('click', e => e.stopPropagation());
  root.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeModal));
}

function renderGreeting(user) {
  const d = new Date();
  const w = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
  const h = d.getHours();
  const greeting = h < 11 ? 'おはようございます' : h < 18 ? 'こんにちは' : 'お疲れさまです';
  document.getElementById('greeting').textContent = `${greeting}、${surname(user.name)}さん`;
  document.getElementById('today').textContent = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日(${w})`;
}

/** お知らせ1件の詳細モーダルを開く */
function openNewsDetail(n) {
  const ts = TAG_STYLES[n.tag] || DEFAULT_TAG;
  openModal({ tag: n.tag, tagColor: ts[0], tagBg: ts[1], date: `${fmtMD(n.date)} 掲載`, title: n.title, body: n.body, owner: n.owner || '総務部' });
}

/** トップのお知らせ欄: 掲載日が今日以降のものだけ表示。過ぎたものは「すべて見る」から(ユーザー指示 2026-08-21) */
function renderNews(news) {
  const el = document.getElementById('news-list');
  if (!news.length) {
    el.innerHTML = '<p style="margin:0;padding:12px 20px;font-size:13px;color:#8a99a8">現在表示中のお知らせはありません(過去のお知らせは「すべて見る」から確認できます)</p>';
    return;
  }
  el.innerHTML = news.map((n, i) => {
    const ts = TAG_STYLES[n.tag] || DEFAULT_TAG;
    return `
    <button class="hv-row" data-news="${i}" style="display:flex;align-items:center;gap:12px;padding:11px 20px;border:none;border-bottom:1px solid #f2f5f9;background:transparent;text-align:left;cursor:pointer;font-family:inherit;width:100%">
      <span style="font-size:11px;font-weight:700;color:${ts[0]};background:${ts[1]};border-radius:4px;padding:2px 8px;white-space:nowrap">${esc(n.tag)}</span>
      <span style="font-size:13px;color:#1c2b3a">${esc(n.title)}</span>
      <span style="margin-left:auto;font-size:12px;color:#8a99a8;white-space:nowrap">${esc(fmtMD(n.date))}</span>
    </button>`;
  }).join('');
  el.querySelectorAll('[data-news]').forEach(btn => btn.addEventListener('click', () => {
    openNewsDetail(news[Number(btn.dataset.news)]);
  }));
}

/** 「すべて見る」: 過去分も含む全お知らせの一覧モーダル。行クリックで詳細を開く */
function openNewsListModal(allNews) {
  const root = document.getElementById('modal-root');
  modalData = { _list: true }; // 自動リフレッシュのスキップ判定(modalData)に乗せるためのダミー
  const sorted = allNews.slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  root.innerHTML = `
  <div id="modal-overlay" style="position:fixed;inset:0;background:rgba(20,40,65,0.45);display:flex;align-items:center;justify-content:center;padding:24px;z-index:100">
    <div id="modal-box" style="background:#ffffff;border-radius:16px;box-shadow:0 12px 40px rgba(15,35,60,0.3);max-width:640px;width:100%;max-height:80vh;display:flex;flex-direction:column;overflow:hidden">
      <div style="display:flex;align-items:center;gap:12px;padding:20px 26px;border-bottom:1px solid #e4ebf2">
        <h3 style="margin:0;font-size:17px;font-weight:700">すべてのお知らせ</h3>
        <span style="font-size:12px;color:#8a99a8">${sorted.length}件(過去の掲載分を含む)</span>
        <button class="hv-close" data-close style="margin-left:auto;border:none;background:#f0f4f8;border-radius:8px;width:32px;height:32px;cursor:pointer;color:#6b7d8f;font-size:15px;flex-shrink:0">✕</button>
      </div>
      <div style="overflow-y:auto;display:flex;flex-direction:column">
        ${sorted.length ? sorted.map((n, i) => {
          const ts = TAG_STYLES[n.tag] || DEFAULT_TAG;
          return `
          <button class="hv-row" data-all-news="${i}" style="display:flex;align-items:center;gap:12px;padding:12px 26px;border:none;border-bottom:1px solid #f2f5f9;background:transparent;text-align:left;cursor:pointer;font-family:inherit;width:100%">
            <span style="font-size:11px;font-weight:700;color:${ts[0]};background:${ts[1]};border-radius:4px;padding:2px 8px;white-space:nowrap">${esc(n.tag)}</span>
            <span style="font-size:13px;color:#1c2b3a">${esc(n.title)}</span>
            <span style="margin-left:auto;font-size:12px;color:#8a99a8;white-space:nowrap">${esc(fmtMD(n.date))}</span>
          </button>`;
        }).join('') : '<p style="margin:0;padding:24px 26px;font-size:13px;color:#8a99a8">お知らせはありません</p>'}
      </div>
      <div style="padding:14px 26px;border-top:1px solid #e4ebf2;display:flex">
        <button class="hv-btn-plain" data-close style="margin-left:auto;border:1px solid #dfe8f0;background:#ffffff;border-radius:8px;padding:8px 20px;cursor:pointer;color:#1c2b3a;font-size:13px;font-weight:500;font-family:inherit">閉じる</button>
      </div>
    </div>
  </div>`;
  root.querySelector('#modal-overlay').addEventListener('click', closeModal);
  root.querySelector('#modal-box').addEventListener('click', e => e.stopPropagation());
  root.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeModal));
  root.querySelectorAll('[data-all-news]').forEach(btn => btn.addEventListener('click', () => {
    openNewsDetail(sorted[Number(btn.dataset.allNews)]);
  }));
}

function renderLinks(links) {
  const el = document.getElementById('quick-links');
  el.innerHTML = links.map((l, i) => {
    // 外部システム(http/https)へのリンクは新しいタブで開く。ポータル内の遷移(rooms.html等)は同じタブのまま
    const external = /^https?:\/\//i.test(l.url || '');
    return `
    <a href="${esc(l.url || '#')}"${external ? ' target="_blank" rel="noopener"' : ''} class="hv-tile" style="display:flex;flex-direction:column;align-items:center;gap:10px;border:1px solid #e4eaf1;border-radius:10px;padding:22px 8px;color:#1c2b3a">
      <span style="width:38px;height:38px;border-radius:10px;background:${LINK_COLORS[i % LINK_COLORS.length]};color:#ffffff;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:700">${esc(l.char)}</span>
      <span style="font-size:13px;font-weight:500">${esc(l.label)}</span>
    </a>`;
  }).join('');
}

function renderTodayEvents(events) {
  const el = document.getElementById('today-events');
  if (!events.length) {
    el.innerHTML = '<p style="margin:0;padding:6px 0;font-size:13px;color:#8a99a8">本日の予定はありません</p>';
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

function renderSchedule(schedule) {
  const el = document.getElementById('schedule-list');
  el.innerHTML = schedule.map((s, i) => {
    const [month, day] = fmtMD(s.date).split('/');
    return `
    <button class="hv-row" data-sch="${i}" style="display:flex;align-items:center;gap:14px;padding:10px 20px;border:none;border-bottom:1px solid #f2f5f9;background:transparent;text-align:left;cursor:pointer;font-family:inherit;width:100%">
      <span style="display:flex;flex-direction:column;align-items:center;background:#eef3f9;border-radius:8px;padding:5px 0;width:46px;line-height:1.25;flex-shrink:0">
        <span style="font-size:10px;color:#6b7d8f">${esc(month)}月</span>
        <span style="font-size:16px;font-weight:700;color:#1e5fa8">${esc(day || '')}</span>
      </span>
      <span style="display:flex;flex-direction:column;gap:1px">
        <span style="font-size:13px;font-weight:700;color:#1c2b3a">${esc(s.title)}</span>
        <span style="font-size:12px;color:#6b7d8f">${esc(s.sub)}</span>
      </span>
      <span style="margin-left:auto;color:#b5c3d1;font-size:13px">›</span>
    </button>`;
  }).join('');
  el.querySelectorAll('[data-sch]').forEach(btn => btn.addEventListener('click', () => {
    const s = schedule[Number(btn.dataset.sch)];
    openModal({ tag: '全社行事', tagColor: '#2f6f8f', tagBg: '#e5f0f7', date: `${fmtMD(s.date)} ・ ${s.sub}`, title: s.title, body: s.body, owner: '総務部' });
  }));
}

function renderTasks() {
  document.getElementById('task-count').textContent = `${TASKS.length}件`;
  document.getElementById('task-list').innerHTML = TASKS.map((t, i) => `
    <div style="display:flex;align-items:center;gap:12px;padding:11px 20px;${i < TASKS.length - 1 ? 'border-bottom:1px solid #f2f5f9' : ''}">
      <span style="font-size:11px;font-weight:700;color:${t.kindColor};background:${t.kindBg};border-radius:4px;padding:2px 8px;white-space:nowrap">${esc(t.kind)}</span>
      <div style="display:flex;flex-direction:column;gap:1px;min-width:0">
        <span style="font-size:13px;font-weight:500">${esc(t.title)}</span>
        <span style="font-size:12px;color:#6b7d8f">${esc(t.sub)}</span>
      </div>
      <a href="#" class="hv-btn-light" style="margin-left:auto;font-size:12px;font-weight:500;border:1px solid #c8dcf0;border-radius:7px;padding:5px 14px;white-space:nowrap">確認</a>
    </div>`).join('');
}

// ---- セクション配置(ドラッグ&ドロップ。並び順はサーバーに保存し、他端末でも同じ配置になる) ----

let draggedSection = null;

function sectionIdsOf(col) {
  return Array.from(col.children).map(el => el.dataset.section);
}

function applyLayout(layout) {
  const colLeft = document.getElementById('col-left');
  const colRight = document.getElementById('col-right');
  (layout.left || []).forEach(id => {
    const el = document.getElementById(`sec-${id}`);
    if (el) colLeft.appendChild(el);
  });
  (layout.right || []).forEach(id => {
    const el = document.getElementById(`sec-${id}`);
    if (el) colRight.appendChild(el);
  });
}

async function saveLayout() {
  const colLeft = document.getElementById('col-left');
  const colRight = document.getElementById('col-right');
  try {
    await api('/api/layout', { method: 'PUT', body: { left: sectionIdsOf(colLeft), right: sectionIdsOf(colRight) } });
  } catch (e) {
    console.error('レイアウトの保存に失敗しました', e);
  }
}

function initDragAndDrop() {
  const cols = [document.getElementById('col-left'), document.getElementById('col-right')];

  document.querySelectorAll('[data-section]').forEach(section => {
    // ドラッグハンドル以外を掴んだ場合は draggable を外し、本文中のクリック操作(お知らせ行など)を阻害しない
    section.addEventListener('mousedown', e => {
      section.draggable = !!e.target.closest('.drag-handle');
    });
    section.addEventListener('dragstart', e => {
      draggedSection = section;
      section.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', section.dataset.section);
    });
    section.addEventListener('dragend', () => {
      section.classList.remove('dragging');
      section.draggable = false;
      draggedSection = null;
      saveLayout();
    });
    section.addEventListener('dragover', e => {
      e.preventDefault();
      if (!draggedSection || draggedSection === section) return;
      const rect = section.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height / 2;
      section.parentElement.insertBefore(draggedSection, before ? section : section.nextSibling);
    });
  });

  cols.forEach(col => {
    col.addEventListener('dragover', e => {
      e.preventDefault();
      if (!draggedSection) return;
      if (draggedSection.parentElement !== col && !e.target.closest('[data-section]')) col.appendChild(draggedSection);
    });
    col.addEventListener('drop', e => e.preventDefault());
  });
}

(async function init() {
  try {
    const user = await Auth.init();
    renderGreeting(user);
    // 「管理」リンクはPortal.Adminロールを持つユーザーのみ表示(実際のCRUD操作はサーバー側requireAdminでも強制済み)
    if ((user.roles || []).includes('Portal.Admin')) {
      const adminLink = document.getElementById('admin-nav-link');
      if (adminLink) adminLink.style.display = '';
    }
    renderTasks();
    const content = await api('/api/content');
    // トップのお知らせ表示ルール: 掲載期限(expires)が入力されていればその日まで表示。
    // 未入力なら従来どおり掲載日が過ぎたら非表示(日付なしは表示継続)。全件は「すべて見る」から
    const pad = n => String(n).padStart(2, '0');
    const now = new Date();
    const todayIso = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    renderNews(content.news.filter(n => n.expires ? n.expires >= todayIso : (!n.date || n.date >= todayIso)));
    const allLink = document.getElementById('news-all-link');
    if (allLink) allLink.addEventListener('click', e => {
      e.preventDefault();
      openNewsListModal(content.news);
    });
    renderSchedule(content.schedule);
    renderLinks(content.links);
  } catch (e) {
    console.error(e);
    document.getElementById('greeting').textContent = '読み込みに失敗しました';
    document.getElementById('today').textContent = String(e.message || e);
    return;
  }

  // 配置の並び順はニュース等と独立して失敗しうるため、取得に失敗しても既定の並びのままドラッグ操作は有効にする
  try {
    applyLayout(await api('/api/layout'));
  } catch (e) {
    console.error('配置の取得に失敗しました', e);
  }
  initDragAndDrop();

  // 予定表はニュース等と独立して失敗しうるため(権限未同意など)、別枠でエラー表示する
  let lastTodayEvents = [];
  try {
    lastTodayEvents = await fetchTodayEvents();
    renderTodayEvents(lastTodayEvents);
  } catch (e) {
    console.error(e);
    document.getElementById('today-events').innerHTML =
      `<p style="margin:0;padding:6px 0;font-size:13px;color:#c05a5a">${esc(e.message || String(e))}</p>`;
  }

  // 自動リフレッシュ(共通方針: 2分間隔・モーダル表示中と非表示タブはスキップ・差分があるときだけ静かに差し替え)
  if (Auth.mode === 'entra') {
    setInterval(async () => {
      if (document.hidden || modalData) return;
      try {
        const events = await fetchTodayEvents();
        if (JSON.stringify(events) !== JSON.stringify(lastTodayEvents)) {
          lastTodayEvents = events;
          renderTodayEvents(events);
        }
      } catch { /* 自動更新の失敗は静かに無視(次回に再試行) */ }
    }, 2 * 60 * 1000);
  }
})();
