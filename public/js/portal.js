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
    '&$select=id,subject,start,end,location,isAllDay,isOrganizer&$orderby=start/dateTime';

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
    id: ev.id,
    // 主催者かつ終日でない予定のみ変更可能(schedule.jsと同じ基準。クリックでスケジュール画面の変更フォームへ)
    editable: !!ev.isOrganizer && !ev.isAllDay,
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
        ${(m.attachments || []).length ? `
        <div style="margin-top:18px;padding-top:14px;border-top:1px solid #eef1f5">
          <div style="font-size:12px;font-weight:700;color:#6b7d8f;margin-bottom:8px">添付ファイル</div>
          <div style="display:flex;flex-direction:column;gap:6px">
            ${m.attachments.map((a, i) => `
            <button class="hv-btn-light" data-attach="${i}" type="button" style="display:flex;align-items:center;gap:8px;text-align:left;border:1px solid #c8dcf0;background:#ffffff;border-radius:8px;padding:8px 12px;cursor:pointer;color:#1e5fa8;font-size:13px;font-family:inherit">
              <span>📎</span><span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(a.name)}</span>
              <span style="margin-left:auto;font-size:11px;color:#8a99a8;white-space:nowrap">${esc(fmtFileSize(a.size))}</span>
            </button>`).join('')}
          </div>
        </div>` : ''}
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
  root.querySelectorAll('[data-attach]').forEach(b => b.addEventListener('click', () => {
    const a = m.attachments[Number(b.dataset.attach)];
    downloadAttachment(a.id, a.name);
  }));
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
  openModal({ tag: n.tag, tagColor: ts[0], tagBg: ts[1], date: `${fmtMD(n.date)} 掲載`, title: n.title, body: n.body, owner: n.owner || '総務部', attachments: n.attachments || [] });
}

/** トップのお知らせ欄: 掲載日が今日以降のものだけ表示。過ぎたものは「すべて見る」から(ユーザー指示 2026-08-21) */
function renderNews(news) {
  const el = document.getElementById('news-list');
  if (!news.length) {
    el.innerHTML = '<p style="margin:0;padding:12px 20px;font-size:13px;color:#8a99a8">現在表示中のお知らせはありません(過去のお知らせは「過去のお知らせ」から確認できます)</p>';
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

/** メンバー個人の並びに沿ってタイルを並べる。保存が無い項目・保存後に追加された項目は、登録順(IDの順)で末尾 */
function orderTiles(items, savedIds) {
  const pos = new Map((savedIds || []).map((id, i) => [id, i]));
  return items
    .map((it, i) => ({ it, i, p: pos.has(it.id) ? pos.get(it.id) : null }))
    .sort((a, b) => {
      if (a.p !== null && b.p !== null) return a.p - b.p;
      if (a.p !== null) return -1;
      if (b.p !== null) return 1;
      return a.i - b.i;
    })
    .map(x => x.it);
}

/** クイックリンク(業務システムリンク)・社内規程で共用のタイル表示(仕組みは同一。2026-09-07: 社内規程を追加する際に共通化)。
    kind('links'|'policies')と savedIds で、メンバー個人の並びを適用し、ドラッグ&ドロップで並べ替えて保存できる(2026-10-09) */
function renderTileGrid(elId, items, kind, savedIds) {
  const el = document.getElementById(elId);
  el.innerHTML = orderTiles(items, savedIds).map(l => {
    // 色はリンクごとに固定(並べ替えても色が入れ替わらないよう、登録順の位置で決める)
    const colorIdx = items.indexOf(l);
    // 外部システム(http/https)へのリンクは新しいタブで開く。ポータル内の遷移(rooms.html等)は同じタブのまま
    const external = /^https?:\/\//i.test(l.url || '');
    return `
    <a href="${esc(l.url || '#')}"${external ? ' target="_blank" rel="noopener"' : ''} data-tile-id="${esc(String(l.id))}" draggable="true" title="ドラッグして並べ替え" class="hv-tile" style="display:flex;flex-direction:column;align-items:center;gap:10px;border:1px solid #e4eaf1;border-radius:10px;padding:22px 8px;color:#1c2b3a">
      <span style="width:38px;height:38px;border-radius:10px;background:${LINK_COLORS[colorIdx % LINK_COLORS.length]};color:#ffffff;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:700">${esc(l.char)}</span>
      <span style="font-size:13px;font-weight:500">${esc(l.label)}</span>
    </a>`;
  }).join('');
  if (kind) setupTileDnD(el, kind);
}

/** タイルのドラッグ&ドロップ(HTML5 DnD)。ドロップ位置は、カーソルが乗っているタイルの左右どちら寄りかで決め、
    終了時に並びをサーバーへ保存する(失敗しても画面の並びはそのまま。次回表示で保存済みの並びに戻る) */
function setupTileDnD(grid, kind) {
  let dragged = null;
  grid.addEventListener('dragstart', e => {
    const tile = e.target.closest && e.target.closest('[data-tile-id]');
    if (!tile) return;
    dragged = tile;
    tile.style.opacity = '0.45';
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', tile.dataset.tileId);
  });
  grid.addEventListener('dragover', e => {
    if (!dragged) return;
    e.preventDefault();
    const over = e.target.closest && e.target.closest('[data-tile-id]');
    if (!over || over === dragged) return;
    const rect = over.getBoundingClientRect();
    const before = (e.clientX - rect.left) < rect.width / 2;
    grid.insertBefore(dragged, before ? over : over.nextSibling);
  });
  grid.addEventListener('drop', e => { if (dragged) e.preventDefault(); });
  grid.addEventListener('dragend', async () => {
    if (!dragged) return;
    dragged.style.opacity = '';
    dragged = null;
    const ids = [...grid.querySelectorAll('[data-tile-id]')].map(t => Number(t.dataset.tileId)).filter(Number.isInteger);
    try {
      await api('/api/tile-order', { method: 'PUT', body: { kind, ids } });
    } catch (e) {
      console.error('リンクの並びの保存に失敗しました', e);
    }
  });
}

function renderTodayEvents(events) {
  const el = document.getElementById('today-events');
  if (!events.length) {
    el.innerHTML = '<p style="margin:0;padding:6px 0;font-size:13px;color:#8a99a8">本日の予定はありません</p>';
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
  // 自分が主催の予定は、クリックでスケジュール画面の変更フォームを開く
  el.querySelectorAll('[data-edit-event]').forEach(card => card.addEventListener('click', () => {
    const ev = events[Number(card.dataset.editEvent)];
    location.href = `schedule.html?edit=${encodeURIComponent(ev.id)}`;
  }));
}

/** 全社スケジュール1件の詳細モーダルを開く */
function openScheduleDetail(s) {
  openModal({ tag: '全社行事', tagColor: '#2f6f8f', tagBg: '#e5f0f7', date: `${fmtMD(s.date)} ・ ${s.sub}`, title: s.title, body: s.body, owner: '総務部', attachments: s.attachments || [] });
}

/** トップの全社スケジュール欄: 選択中の月のものだけ表示(既定は今月。ユーザー指示 2026-08-21・月の切り替えは2026-10-08追加)。
    月は◀▶・月選択・「今月」で切り替える。全期間は「年間予定表」から。ymは'YYYY-MM' */
function renderSchedule(schedule, ym) {
  const el = document.getElementById('schedule-list');
  if (!schedule.length) {
    const [y, m] = String(ym || '').split('-').map(Number);
    const label = y && m ? `${y}年${m}月の` : 'この月の';
    el.innerHTML = `<p style="margin:0;padding:12px 20px;font-size:13px;color:#8a99a8">${label}全社スケジュールはありません(他の月は上の切り替え、全期間は「年間予定表」から確認できます)</p>`;
    return;
  }
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
    openScheduleDetail(schedule[Number(btn.dataset.sch)]);
  }));
}

/** 全社スケジュール欄の月の切り替え(◀ ▶・月選択・今月)。選択中の月の項目(日付なしは全月で表示)を日付順に描画する */
function setupScheduleMonthNav(items, currentYm) {
  const input = document.getElementById('schedule-month-input');
  let ym = currentYm;
  const draw = () => {
    input.value = ym;
    const inMonth = items.filter(s => !s.date || String(s.date).slice(0, 7) === ym);
    inMonth.sort((a, b) => (a.date ? 0 : 1) - (b.date ? 0 : 1) || String(a.date).localeCompare(String(b.date)));
    renderSchedule(inMonth, ym);
  };
  const shift = n => {
    const [y, m] = ym.split('-').map(Number);
    const d = new Date(y, m - 1 + n, 1);
    ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    draw();
  };
  document.getElementById('schedule-prev').addEventListener('click', () => shift(-1));
  document.getElementById('schedule-next').addEventListener('click', () => shift(1));
  document.getElementById('schedule-this-month').addEventListener('click', () => { ym = currentYm; draw(); });
  input.addEventListener('change', () => { if (/^\d{4}-\d{2}$/.test(input.value)) { ym = input.value; draw(); } });
  draw();
}

/** 「年間予定表」: 全期間の全社スケジュールを月ごとにまとめた一覧モーダル。行クリックで詳細を開く */
function openScheduleListModal(allSchedule) {
  const root = document.getElementById('modal-root');
  modalData = { _list: true }; // 自動リフレッシュのスキップ判定(modalData)に乗せるためのダミー
  const sorted = allSchedule.slice().sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  let lastYm = null;
  const rowsHtml = sorted.map((s, i) => {
    const ym = String(s.date || '').slice(0, 7); // YYYY-MM
    const [y, mo] = ym.split('-').map(Number);
    const header = ym && ym !== lastYm
      ? `<div style="padding:10px 26px 6px;background:#f7fafd;border-bottom:1px solid #eef1f5;font-size:12px;font-weight:700;color:#1e5fa8">${y}年 ${mo}月</div>`
      : '';
    lastYm = ym || lastYm;
    const [month, day] = fmtMD(s.date).split('/');
    return header + `
    <button class="hv-row" data-all-sch="${i}" style="display:flex;align-items:center;gap:14px;padding:10px 26px;border:none;border-bottom:1px solid #f2f5f9;background:transparent;text-align:left;cursor:pointer;font-family:inherit;width:100%">
      <span style="display:flex;flex-direction:column;align-items:center;background:#eef3f9;border-radius:8px;padding:5px 0;width:46px;line-height:1.25;flex-shrink:0">
        <span style="font-size:10px;color:#6b7d8f">${esc(month)}月</span>
        <span style="font-size:16px;font-weight:700;color:#1e5fa8">${esc(day || '')}</span>
      </span>
      <span style="display:flex;flex-direction:column;gap:1px;min-width:0">
        <span style="font-size:13px;font-weight:700;color:#1c2b3a">${esc(s.title)}</span>
        <span style="font-size:12px;color:#6b7d8f">${esc(s.sub)}</span>
      </span>
      <span style="margin-left:auto;color:#b5c3d1;font-size:13px">›</span>
    </button>`;
  }).join('');
  root.innerHTML = `
  <div id="modal-overlay" style="position:fixed;inset:0;background:rgba(20,40,65,0.45);display:flex;align-items:center;justify-content:center;padding:24px;z-index:100">
    <div id="modal-box" style="background:#ffffff;border-radius:16px;box-shadow:0 12px 40px rgba(15,35,60,0.3);max-width:640px;width:100%;max-height:80vh;display:flex;flex-direction:column;overflow:hidden">
      <div style="display:flex;align-items:center;gap:12px;padding:20px 26px;border-bottom:1px solid #e4ebf2">
        <h3 style="margin:0;font-size:17px;font-weight:700">年間予定表</h3>
        <span style="font-size:12px;color:#8a99a8">${sorted.length}件(全期間)</span>
        <button class="hv-close" data-close style="margin-left:auto;border:none;background:#f0f4f8;border-radius:8px;width:32px;height:32px;cursor:pointer;color:#6b7d8f;font-size:15px;flex-shrink:0">✕</button>
      </div>
      <div style="overflow-y:auto;display:flex;flex-direction:column">
        ${sorted.length ? rowsHtml : '<p style="margin:0;padding:24px 26px;font-size:13px;color:#8a99a8">全社スケジュールはありません</p>'}
      </div>
      <div style="padding:14px 26px;border-top:1px solid #e4ebf2;display:flex">
        <button class="hv-btn-plain" data-close style="margin-left:auto;border:1px solid #dfe8f0;background:#ffffff;border-radius:8px;padding:8px 20px;cursor:pointer;color:#1c2b3a;font-size:13px;font-weight:500;font-family:inherit">閉じる</button>
      </div>
    </div>
  </div>`;
  root.querySelector('#modal-overlay').addEventListener('click', closeModal);
  root.querySelector('#modal-box').addEventListener('click', e => e.stopPropagation());
  root.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeModal));
  root.querySelectorAll('[data-all-sch]').forEach(btn => btn.addEventListener('click', () => {
    openScheduleDetail(sorted[Number(btn.dataset.allSch)]);
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

// ---- ヘッダー社内検索(人 + ポータル内ページ。2026-09-07追加。追加のGraph権限は不要:
//      人検索は既存の searchMembers=User.Read.All、ページ検索はクライアント内の固定一覧) ----

function renderSearchResults(pages, members, query) {
  const box = document.getElementById('header-search-results');
  if (!query) { box.style.display = 'none'; box.innerHTML = ''; return; }
  if (!pages.length && !members.length) {
    box.innerHTML = '<p style="margin:0;padding:14px 16px;font-size:12px;color:#8a99a8">一致する結果がありません</p>';
    box.style.display = '';
    return;
  }
  const pagesHtml = pages.length ? `
    <div style="font-size:11px;font-weight:700;color:#8a99a8;padding:10px 16px 4px">ページ</div>
    ${pages.map((p, i) => `
      <a href="${esc(p.url)}" data-search-page="${i}" class="hv-row" style="display:flex;align-items:center;gap:10px;padding:9px 16px;text-decoration:none;color:#1c2b3a;font-size:13px">
        <span style="color:#1e5fa8">⊞</span>${esc(p.title)}
      </a>`).join('')}` : '';
  const membersHtml = members.length ? `
    <div style="font-size:11px;font-weight:700;color:#8a99a8;padding:10px 16px 4px">人</div>
    ${members.map((m, i) => `
      <a href="mailto:${esc(m.email)}" data-search-member="${i}" class="hv-row" style="display:flex;flex-direction:column;gap:1px;padding:9px 16px;text-decoration:none;color:#1c2b3a">
        <span style="font-size:13px;font-weight:500">${esc(m.name)}${m.dept ? `<span style="font-weight:400;color:#6b7d8f"> ・ ${esc(m.dept)}</span>` : ''}</span>
        <span style="font-size:11px;color:#8a99a8">${esc(m.email)}</span>
      </a>`).join('')}` : '';
  box.innerHTML = pagesHtml + membersHtml;
  box.style.display = '';
}

function initHeaderSearch() {
  const input = document.getElementById('header-search-input');
  const box = document.getElementById('header-search-results');
  if (!input || !box) return;
  let debounceTimer = null;
  let seq = 0;

  input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    const query = input.value.trim();
    if (!query) { renderSearchResults([], [], ''); return; }
    debounceTimer = setTimeout(async () => {
      const mySeq = ++seq;
      const pages = searchPortalPages(query);
      let members = [];
      try {
        members = await searchMembers(query);
      } catch (e) {
        console.error('社内検索(人)に失敗しました', e);
      }
      if (mySeq !== seq) return; // 入力中に別の検索が走った場合、古い結果は捨てる
      renderSearchResults(pages, members, query);
    }, 250);
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('.portal-search')) { box.style.display = 'none'; }
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') { box.style.display = 'none'; input.blur(); }
  });
  input.addEventListener('focus', () => {
    if (box.innerHTML && input.value.trim()) box.style.display = '';
  });
}

// ---- 出社日(A/B/C班ローテーション)バッジ(2026-10-02追加。ユーザー指示) ----

let myCalendarGroupPromise = null;
/** 自分の定休グループ(sunday_off / wednesday_off)。devモードは null(絞り込みなし)。
    部署はGraph /me から取得(User.Read。サインイン時に同意済み)。バッジと全社スケジュールの絞り込みで共用 */
function getMyCalendarGroup() {
  if (!myCalendarGroupPromise) {
    myCalendarGroupPromise = (async () => {
      if (Auth.mode !== 'entra') return null;
      const token = await Auth.getGraphToken(['User.Read']);
      const res = await fetch('https://graph.microsoft.com/v1.0/me?$select=department', {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) throw new Error(`自分のプロフィール取得に失敗しました(HTTP ${res.status})`);
      const me = await res.json();
      return calendarGroupFor(Auth.me.email, me.department || '');
    })();
    myCalendarGroupPromise.catch(() => { myCalendarGroupPromise = null; }); // 失敗は次回再試行できるようにする
  }
  return myCalendarGroupPromise;
}

/** 全社スケジュール1件が自分に表示されるか(calendar_scope が both か、自分の定休グループと一致)。
    グループ不明(devモード・取得失敗)のときは絞り込まず全件表示する */
function scheduleVisibleFor(s, myGroup) {
  return !myGroup || !s.calendar_scope || s.calendar_scope === 'both' || s.calendar_scope === myGroup;
}

/** 「こんにちは、〜さん」の横に「〜班出勤日」バッジを表示する。対象は@yoshimuraichi.comの
    社員のみ(isShiftTeamEligible)。本日、自分の定休グループ(calendarGroupFor)で出勤番
    (shift_work)の班があれば表示し、クリックするとその班の出勤者一覧(today-attendance.html)
    へ遷移する。同日に複数班が出勤番のケースを排除しないため、該当する班をすべて表示する */
async function renderShiftBadge() {
  const el = document.getElementById('shift-badge');
  if (!el || Auth.mode !== 'entra' || !isShiftTeamEligible((Auth.me && Auth.me.email) || '')) return;

  const group = await getMyCalendarGroup();
  if (!group) return;

  const pad = n => String(n).padStart(2, '0');
  const now = new Date();
  const todayIso = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const rows = await api(`/api/work-calendar?group=${encodeURIComponent(group)}&from=${todayIso}&to=${todayIso}`);
  const shiftWorkRows = rows.filter(r => r.type === 'shift_work' && r.team);
  if (!shiftWorkRows.length) return;

  el.innerHTML = shiftWorkRows.map(r => `
    <a href="today-attendance.html?team=${encodeURIComponent(r.team)}&group=${encodeURIComponent(group)}" style="font-size:12px;font-weight:700;color:#1e5fa8;background:#e9f1fa;border-radius:12px;padding:4px 12px;text-decoration:none;white-space:nowrap">${esc(r.team)}班出勤日</a>`).join('');
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
    // 並びは掲載日の新しい順(同じ日は後から登録したものが上。掲載日なしは末尾)。「過去のお知らせ」の一覧と同じ並び
    const topNews = content.news
      .filter(n => n.expires ? n.expires >= todayIso : (!n.date || n.date >= todayIso))
      .sort((a, b) => (a.date ? 0 : 1) - (b.date ? 0 : 1) || String(b.date || '').localeCompare(String(a.date || '')) || b.id - a.id);
    renderNews(topNews);
    const allLink = document.getElementById('news-all-link');
    if (allLink) allLink.addEventListener('click', e => {
      e.preventDefault();
      openNewsListModal(content.news);
    });
    // 全社スケジュールは今月分だけトップに表示(日付なしは表示継続)。全期間は「年間予定表」から
    const thisYm = todayIso.slice(0, 7);
    const myGroup = await getMyCalendarGroup().catch(() => null);
    const mySchedule = content.schedule.filter(s => scheduleVisibleFor(s, myGroup));
    setupScheduleMonthNav(mySchedule, thisYm);
    const schAllLink = document.getElementById('schedule-all-link');
    if (schAllLink) schAllLink.addEventListener('click', e => {
      e.preventDefault();
      openScheduleListModal(mySchedule);
    });
    // メンバー個人のリンクの並び(取得に失敗しても登録順で表示する)
    const savedOrder = async kind => (await api(`/api/tile-order?kind=${kind}`).catch(() => ({ ids: [] }))).ids || [];
    const [linkOrder, policyOrder] = await Promise.all([savedOrder('links'), savedOrder('policies')]);
    renderTileGrid('quick-links', content.links, 'links', linkOrder);
    renderTileGrid('policy-links', content.policies, 'policies', policyOrder);
    initHeaderSearch();
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

  // 出社日バッジはニュース等と独立して失敗しうるため、失敗しても他の表示を壊さない
  try {
    await renderShiftBadge();
  } catch (e) {
    console.error('出社日バッジの表示に失敗しました', e);
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
