// 管理画面: お知らせ / 全社スケジュール / クイックリンク の CRUD
// データはサーバー(SQLite)に保存され、ポータルトップに即時反映される。
'use strict';

const CONFIG = {
  news: {
    label: 'お知らせ', hasBody: true,
    h1: 'カテゴリ', h2: 'タイトル', h3: '掲載日 / トップ掲載期限',
    fields: [
      { key: 'tag', label: 'カテゴリ', ph: '例: 重要 / 総務 / 安全' },
      { key: 'title', label: 'タイトル', ph: '例: 夏季休業期間のお知らせ' },
      { key: 'date', label: '掲載日', type: 'date' },
      { key: 'expires', label: 'トップ掲載期限(この日まで表示)', type: 'date' }
    ],
    cells: it => [it.tag, it.title, `${fmtMD(it.date)}${it.expires ? ` 〜 ${fmtMD(it.expires)}` : ''}`]
  },
  schedule: {
    label: '全社スケジュール', hasBody: true,
    h1: '日付', h2: '行事名', h3: '補足(場所など)',
    fields: [
      { key: 'date', label: '日付', type: 'date' },
      { key: 'title', label: '行事名', ph: '例: 全社朝会' },
      { key: 'sub', label: '補足(場所など)', ph: '例: 9:00– 全社員' }
    ],
    cells: it => [fmtMD(it.date), it.title, it.sub]
  },
  links: {
    label: 'クイックリンク', hasBody: false,
    h1: 'アイコン文字', h2: '名称', h3: 'リンク先URL',
    fields: [
      { key: 'char', label: 'アイコン文字(1文字)', ph: '例: 勤' },
      { key: 'label', label: '名称', ph: '例: 勤怠管理' },
      { key: 'url', label: 'リンク先URL', ph: '例: https://…' }
    ],
    cells: it => [it.char, it.label, it.url]
  },
  policies: {
    label: '社内規程', hasBody: false,
    h1: 'アイコン文字', h2: '名称', h3: 'リンク先URL',
    fields: [
      { key: 'char', label: 'アイコン文字(1文字)', ph: '例: 就' },
      { key: 'label', label: '名称', ph: '例: 就業規則' },
      { key: 'url', label: 'リンク先URL', ph: '例: https://…' }
    ],
    cells: it => [it.char, it.label, it.url]
  }
};

const state = {
  tab: 'news',
  data: { news: [], schedule: [], links: [], policies: [] },
  draft: null,    // 編集中の1件(null でモーダル閉)
  editId: null    // 編集対象のid(null で新規)
};

// ---- 出社日(A/B/C班ローテーション)年間カレンダー用のベスポーク管理タブ(2026-10-02追加) ----
// ドロップダウン選択(班の割当て)やファイルアップロード(CSV取込)は、上記の CONFIG/renderModal の
// 仕組み(どのkindも<input>で統一されている)に乗らないため、専用の描画関数を持つ別タブとして追加する
const BESPOKE_TABS = [
  { id: 'shift-teams', label: '当番表(A/B/C班)' },
  { id: 'work-calendar-import', label: '年間カレンダー取込' }
];
function isBespokeTab(tab) { return BESPOKE_TABS.some(t => t.id === tab); }

let shiftTeamsCache = null; // { people:[{name,email,department}], assignments:{email(小文字):{email,calendar_group,team}} }

/** 吉村一建設(@yoshimuraichi.com)の社員一覧(会議室・社用車の疑似メールは除外)+現在の班割当てを取得する。
    タブ切替のたびに再取得しないようキャッシュする(班を保存した際はキャッシュ自体を更新する) */
async function loadShiftTeamsData() {
  if (shiftTeamsCache) return shiftTeamsCache;
  const token = await Auth.getGraphToken(['User.Read.All']);
  const domainFilter = "endsWith(mail,'@yoshimuraichi.com')";
  let url = 'https://graph.microsoft.com/v1.0/users' +
    '?$select=id,displayName,mail,department' +
    `&$filter=${encodeURIComponent(domainFilter)}` +
    '&$count=true&$orderby=displayName&$top=999';
  const raw = [];
  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, ConsistencyLevel: 'eventual' } });
    if (!res.ok) throw new Error(`社員一覧の取得に失敗しました(HTTP ${res.status})`);
    const data = await res.json();
    raw.push(...(data.value || []));
    url = data['@odata.nextLink'] || null;
  }
  const resourceEmails = new Set([...ROOMS, ...YOSHIMURA_ROOMS, ...CARS].map(r => r.email.toLowerCase()));
  const people = raw
    .filter(m => m.mail && !resourceEmails.has(m.mail.toLowerCase()))
    .map(m => ({ name: m.displayName || '(名前未設定)', email: m.mail, department: m.department || '' }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  const assignmentRows = await api('/api/shift-teams');
  const assignments = {};
  assignmentRows.forEach(r => { assignments[r.email.toLowerCase()] = r; });
  shiftTeamsCache = { people, assignments };
  return shiftTeamsCache;
}

async function renderShiftTeamsTab() {
  document.getElementById('table-head').innerHTML = `
    <span style="font-size:12px;color:#8a99a8;flex:1">氏名 / メールアドレス</span>
    <span style="font-size:12px;color:#8a99a8;width:110px">定休グループ</span>
    <span style="font-size:12px;color:#8a99a8;width:170px">班</span>`;
  const body = document.getElementById('table-body');
  body.innerHTML = '<div style="padding:32px 24px;text-align:center;font-size:13px;color:#8a99a8">読み込み中…</div>';
  let data;
  try {
    data = await loadShiftTeamsData();
  } catch (e) {
    body.innerHTML = `<div style="padding:24px;font-size:13px;color:#c05a5a">${esc(e.message || String(e))}</div>`;
    return;
  }
  if (state.tab !== 'shift-teams') return; // 取得中にタブが切り替わっていたら描き替えない

  body.innerHTML = data.people.map(p => {
    const current = data.assignments[p.email.toLowerCase()];
    const group = calendarGroupFor(p.email, p.department);
    const groupLabel = group === 'wednesday_off' ? '水曜定休' : '日曜定休';
    return `
    <div data-row="${esc(p.email)}" style="display:flex;align-items:center;gap:24px;padding:13px 24px;border-bottom:1px solid #f2f5f9">
      <span style="font-size:13px;flex:1;min-width:0;color:#1c2b3a">${esc(p.name)} <span style="color:#8a99a8;font-size:12px">${esc(p.email)}</span></span>
      <span style="font-size:12px;width:110px;color:#6b7d8f">${esc(groupLabel)}</span>
      <span style="width:170px;display:flex;align-items:center;gap:8px">
        <select class="in-input" data-team-select style="padding:6px 8px;font-size:12px">
          <option value="" ${!current ? 'selected' : ''}>未設定</option>
          <option value="A" ${current && current.team === 'A' ? 'selected' : ''}>A班</option>
          <option value="B" ${current && current.team === 'B' ? 'selected' : ''}>B班</option>
          <option value="C" ${current && current.team === 'C' ? 'selected' : ''}>C班</option>
        </select>
        <span data-save-result style="font-size:12px;white-space:nowrap"></span>
      </span>
    </div>`;
  }).join('');

  body.querySelectorAll('[data-row]').forEach(row => {
    const email = row.dataset.row;
    const select = row.querySelector('[data-team-select]');
    const resultEl = row.querySelector('[data-save-result]');
    select.addEventListener('change', async () => {
      resultEl.textContent = '保存中…'; resultEl.style.color = '#8a99a8';
      try {
        const person = shiftTeamsCache.people.find(p => p.email === email);
        const group = calendarGroupFor(person.email, person.department);
        if (select.value === '') {
          await api('/api/admin/shift-teams', { method: 'PUT', body: { email, unassign: true } });
          delete shiftTeamsCache.assignments[email.toLowerCase()];
        } else {
          await api('/api/admin/shift-teams', { method: 'PUT', body: { email, calendar_group: group, team: select.value } });
          shiftTeamsCache.assignments[email.toLowerCase()] = { email, calendar_group: group, team: select.value };
        }
        resultEl.textContent = '✓ 保存しました'; resultEl.style.color = '#2e7d52';
      } catch (e) {
        resultEl.textContent = `✗ ${e.message}`; resultEl.style.color = '#c05a5a';
      }
    });
  });
}

function renderCalendarImportTab() {
  document.getElementById('table-head').innerHTML = '';
  const body = document.getElementById('table-body');
  body.innerHTML = `
    <div style="padding:24px;display:flex;flex-direction:column;gap:14px;max-width:640px">
      <p style="margin:0;font-size:13px;color:#6b7d8f;line-height:1.8">
        CSVファイル(1行目は見出し行 <code>date,calendar_group,team,type,label</code> 固定)を選択して取り込んでください。<br>
        ・文字コードはUTF-8で保存してください(Excelの「CSV UTF-8(コンマ区切り)」形式を推奨)<br>
        ・ラベルにカンマ(,)は使わないでください。複数項目は読点「、」で区切ってください<br>
        ・取り込むと、ファイルに含まれる定休グループ・日付範囲の既存データは置き換わります(再取込で修正可能)
      </p>
      <input id="csv-file-input" type="file" accept=".csv,text/csv" style="font-size:13px">
      <button id="csv-import-btn" class="hv-btn-primary" style="align-self:flex-start;border:none;background:#1e5fa8;color:#ffffff;font-weight:700;border-radius:9px;padding:10px 22px;font-size:13px;cursor:pointer;font-family:inherit">取り込む</button>
      <div id="csv-import-result" style="font-size:13px;line-height:1.8"></div>
    </div>`;
  const fileInput = document.getElementById('csv-file-input');
  const resultEl = document.getElementById('csv-import-result');
  document.getElementById('csv-import-btn').addEventListener('click', () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) { resultEl.innerHTML = '<span style="color:#c05a5a">ファイルを選択してください</span>'; return; }
    const reader = new FileReader();
    reader.onload = async () => {
      resultEl.innerHTML = '取り込み中…';
      try {
        const data = await api('/api/admin/work-calendar/import', { method: 'POST', body: { csv: reader.result } });
        resultEl.innerHTML = `<span style="color:#2e7d52">✓ ${data.imported}件を取り込みました</span><br>` +
          data.groups.map(g => `${esc(g.calendar_group)}: ${esc(g.from)}〜${esc(g.to)}(${g.count}件)`).join('<br>');
      } catch (e) {
        const errors = (e.data && e.data.errors) || [];
        resultEl.innerHTML = `<span style="color:#c05a5a">✗ ${esc(e.message)}</span>` +
          (errors.length ? '<ul style="margin:6px 0 0;padding-left:20px;color:#c05a5a">' + errors.map(x => `<li>${esc(x)}</li>`).join('') + '</ul>' : '');
      }
    };
    reader.readAsText(file, 'UTF-8');
  });
}

async function loadAll() {
  const content = await api('/api/content');
  state.data = content;
}

function renderTabs() {
  const el = document.getElementById('tab-row');
  const configButtons = Object.keys(CONFIG).map(k => {
    const sel = k === state.tab;
    return `
    <button class="hv-site" data-tab="${k}" style="display:flex;align-items:baseline;gap:7px;border:1px solid ${sel ? '#1e5fa8' : '#dfe8f0'};background:${sel ? '#1e5fa8' : '#ffffff'};color:${sel ? '#ffffff' : '#1c2b3a'};font-weight:700;border-radius:9px;padding:11px 20px;font-size:13px;cursor:pointer;font-family:inherit">
      <span>${CONFIG[k].label}</span>
      <span style="font-size:11px;font-weight:500;color:${sel ? '#bcd4ef' : '#8a99a8'}">${(state.data[k] || []).length}件</span>
    </button>`;
  }).join('');
  const bespokeButtons = BESPOKE_TABS.map(t => {
    const sel = t.id === state.tab;
    return `
    <button class="hv-site" data-tab="${t.id}" style="border:1px solid ${sel ? '#1e5fa8' : '#dfe8f0'};background:${sel ? '#1e5fa8' : '#ffffff'};color:${sel ? '#ffffff' : '#1c2b3a'};font-weight:700;border-radius:9px;padding:11px 20px;font-size:13px;cursor:pointer;font-family:inherit">${esc(t.label)}</button>`;
  }).join('');
  el.innerHTML = configButtons + bespokeButtons +
    (isBespokeTab(state.tab) ? '' : '<button id="add-new" class="hv-btn-primary" style="margin-left:auto;border:none;background:#1e5fa8;color:#ffffff;font-weight:700;border-radius:9px;padding:11px 22px;font-size:13px;cursor:pointer;font-family:inherit">＋ 新規追加</button>');
  el.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => {
    state.tab = b.dataset.tab; state.draft = null; state.editId = null;
    render();
  }));
  const addBtn = el.querySelector('#add-new');
  if (addBtn) addBtn.addEventListener('click', () => {
    state.draft = {}; state.editId = null;
    renderModal();
  });
}

function renderTable() {
  if (state.tab === 'shift-teams') { renderShiftTeamsTab(); return; }
  if (state.tab === 'work-calendar-import') { renderCalendarImportTab(); return; }
  const cfg = CONFIG[state.tab];
  const items = state.data[state.tab] || [];
  document.getElementById('table-head').innerHTML = `
    <span style="font-size:12px;color:#8a99a8;width:90px;flex-shrink:0">${cfg.h1}</span>
    <span style="font-size:12px;color:#8a99a8;flex:1">${cfg.h2}</span>
    <span style="font-size:12px;color:#8a99a8;width:150px">${cfg.h3}</span>
    <span style="width:150px"></span>`;
  const body = document.getElementById('table-body');
  body.innerHTML = items.length ? items.map(it => {
    const c = cfg.cells(it);
    return `
    <div style="display:flex;align-items:center;gap:24px;padding:13px 24px;border-bottom:1px solid #f2f5f9">
      <span style="font-size:13px;width:90px;flex-shrink:0;color:#1c2b3a">${esc(c[0])}</span>
      <span style="font-size:13px;flex:1;min-width:0;color:#1c2b3a">${esc(c[1])}</span>
      <span style="font-size:13px;width:150px;color:#6b7d8f">${esc(c[2])}</span>
      <span style="width:150px;display:flex;gap:8px;justify-content:flex-end;flex-shrink:0">
        <button class="hv-btn-light" data-edit="${it.id}" style="border:1px solid #c8dcf0;background:#ffffff;border-radius:7px;padding:5px 16px;cursor:pointer;color:#1e5fa8;font-size:12px;font-weight:500;font-family:inherit">編集</button>
        <button class="hv-btn-danger" data-del="${it.id}" style="border:1px solid #e4eaf1;background:#ffffff;border-radius:7px;padding:5px 16px;cursor:pointer;color:#a8b5c2;font-size:12px;font-weight:500;font-family:inherit">削除</button>
      </span>
    </div>`;
  }).join('') :
  '<div style="padding:32px 24px;text-align:center;font-size:13px;color:#8a99a8">登録がありません。「＋ 新規追加」から追加してください。</div>';

  body.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => {
    const it = items.find(x => String(x.id) === b.dataset.edit);
    state.draft = { ...it }; state.editId = it.id;
    renderModal();
  }));
  body.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('この項目を削除しますか?')) return;
    try {
      await api(`/api/admin/${state.tab}/${b.dataset.del}`, { method: 'DELETE' });
      await loadAll();
      render();
    } catch (e) { alert(e.message); }
  }));
}

function renderModal() {
  const root = document.getElementById('modal-root');
  if (isBespokeTab(state.tab) || !state.draft) { root.innerHTML = ''; return; }
  const cfg = CONFIG[state.tab];
  const d = state.draft;
  const isEdit = state.editId != null;
  const body = d.body || '';
  root.innerHTML = `
  <div id="admin-overlay" style="position:fixed;inset:0;background:rgba(20,40,65,0.45);display:flex;align-items:center;justify-content:center;padding:24px;z-index:100">
    <div id="admin-box" style="background:#ffffff;border-radius:16px;box-shadow:0 12px 40px rgba(15,35,60,0.3);max-width:620px;width:100%;max-height:85vh;display:flex;flex-direction:column;overflow:hidden">
      <div style="display:flex;align-items:center;gap:12px;padding:20px 26px;border-bottom:1px solid #e4ebf2">
        <h3 style="margin:0;font-size:17px;font-weight:700">${cfg.label} — ${isEdit ? '編集' : '新規追加'}</h3>
        <button class="hv-close" data-cancel style="margin-left:auto;border:none;background:#f0f4f8;border-radius:8px;width:32px;height:32px;cursor:pointer;color:#6b7d8f;font-size:15px;flex-shrink:0">✕</button>
      </div>
      <div style="padding:20px 26px;overflow-y:auto;display:flex;flex-direction:column;gap:14px">
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px">
          ${cfg.fields.map(f => `
          <label style="display:flex;flex-direction:column;gap:5px">
            <span style="font-size:12px;font-weight:700;color:#6b7d8f">${f.label}</span>
            <input class="in-input" type="${f.type || 'text'}" data-field="${f.key}" value="${esc(d[f.key] || '')}" placeholder="${esc(f.ph || '')}">
          </label>`).join('')}
        </div>
        ${cfg.hasBody ? `
        <label style="display:flex;flex-direction:column;gap:5px">
          <span style="display:flex;align-items:baseline;gap:10px">
            <span style="font-size:12px;font-weight:700;color:#6b7d8f">本文(詳細画面に表示)</span>
            <span id="body-count" style="margin-left:auto;font-size:12px;color:${body.length >= 500 ? '#c05a5a' : '#8a99a8'}">${body.length} / 500文字</span>
          </span>
          <textarea id="body-input" class="in-input" rows="7" maxlength="500" placeholder="詳細を入力してください(最大500文字)。改行もそのまま表示されます。" style="line-height:1.7;resize:vertical">${esc(body)}</textarea>
        </label>` : ''}
        <span id="admin-error" style="font-size:12px;color:#c05a5a"></span>
      </div>
      <div style="padding:16px 26px;border-top:1px solid #e4ebf2;display:flex;gap:10px;justify-content:flex-end">
        <button class="hv-btn-plain" data-cancel style="border:1px solid #dfe8f0;background:#ffffff;color:#6b7d8f;font-weight:500;border-radius:9px;padding:10px 18px;font-size:13px;cursor:pointer;font-family:inherit">キャンセル</button>
        <button id="admin-save" class="hv-btn-primary" style="border:none;background:#1e5fa8;color:#ffffff;font-weight:700;border-radius:9px;padding:10px 24px;font-size:13px;cursor:pointer;font-family:inherit">${isEdit ? '更新する' : '追加する'}</button>
      </div>
    </div>
  </div>`;

  const close = () => { state.draft = null; state.editId = null; renderModal(); };
  root.querySelector('#admin-overlay').addEventListener('click', close);
  root.querySelector('#admin-box').addEventListener('click', e => e.stopPropagation());
  root.querySelectorAll('[data-cancel]').forEach(b => b.addEventListener('click', close));

  root.querySelectorAll('[data-field]').forEach(inp => inp.addEventListener('input', () => {
    state.draft[inp.dataset.field] = inp.value;
  }));
  const bodyInput = root.querySelector('#body-input');
  if (bodyInput) bodyInput.addEventListener('input', () => {
    state.draft.body = bodyInput.value.slice(0, 500);
    const counter = root.querySelector('#body-count');
    counter.textContent = `${state.draft.body.length} / 500文字`;
    counter.style.color = state.draft.body.length >= 500 ? '#c05a5a' : '#8a99a8';
  });

  root.querySelector('#admin-save').addEventListener('click', async () => {
    const cfg2 = CONFIG[state.tab];
    const payload = {};
    cfg2.fields.forEach(f => payload[f.key] = (state.draft[f.key] || '').trim());
    if (cfg2.hasBody) payload.body = (state.draft.body || '').slice(0, 500);
    if (!cfg2.fields.some(f => payload[f.key])) {
      root.querySelector('#admin-error').textContent = 'いずれかの項目を入力してください';
      return;
    }
    try {
      if (isEdit) await api(`/api/admin/${state.tab}/${state.editId}`, { method: 'PUT', body: payload });
      else await api(`/api/admin/${state.tab}`, { method: 'POST', body: payload });
      state.draft = null; state.editId = null;
      await loadAll();
      render();
    } catch (e) {
      root.querySelector('#admin-error').textContent = e.message;
    }
  });
}

function render() {
  renderTabs();
  renderTable();
  renderModal();
}

(async function init() {
  try {
    const user = await Auth.init();
    // URLを直接開かれた場合の保護(表示のみ。実際のCRUD操作はサーバー側requireAdminで強制済み)
    if (!(user.roles || []).includes('Portal.Admin')) {
      document.getElementById('tab-row').style.display = 'none';
      document.querySelector('#tab-row').parentElement.querySelector('section').innerHTML =
        '<div style="padding:48px 24px;text-align:center;font-size:14px;color:#6b7d8f">この画面は Entra ID のアプリロール「Portal.Admin」を持つユーザーのみ利用できます。</div>';
      return;
    }
    await loadAll();
    render();
  } catch (e) {
    console.error(e);
    document.getElementById('table-body').innerHTML =
      `<div style="padding:24px;font-size:13px;color:#c05a5a">読み込みに失敗しました: ${esc(e.message || e)}</div>`;
  }
})();
