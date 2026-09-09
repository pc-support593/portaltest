// 組織図画面。
// Entra IDのdepartment属性で部門ごとにメンバーをグループ化して表示する
// (2026-09-08: manager属性によるツリー表示を試みたが、Entra ID側でmanagerが
// 未設定の社員が多く「ただの一覧」になってしまったため、ユーザー指示によりこの方式に変更)。
// 会議室・社用車(Exchangeリソースメールボックス)は roomsData.js の実マスタと突き合わせて除外する
// (accountEnabledでの判定は、この組織のリソースメールボックスが有効化されたままのため機能しなかった)。
'use strict';

// roomsData.js の実マスタ(ROOMS/YOSHIMURA_ROOMS/CARS)のメールアドレス一覧。
// 組織図には「人」だけを出したいため、これらは取得結果から除外する
const RESOURCE_EMAILS = new Set(
  [...ROOMS, ...YOSHIMURA_ROOMS, ...CARS].map(r => r.email.toLowerCase())
);

const state = { groups: [] }; // [{ dept, members: [{name,email,phone}] }]

/** Graphのエラーレスポンスから可能な限り具体的なメッセージを取り出す */
async function graphErrorMessage(res, fallback) {
  try {
    const data = await res.json();
    if (data && data.error && data.error.message) return `${fallback}: ${data.error.message}`;
  } catch { /* 本文がJSONでない場合はフォールバックのみ */ }
  return fallback;
}

/** 社内の2ドメインの社員一覧を取得する(検索機能と同じ絞り込み)。
    会議室・社用車はEntra ID上は accountEnabled: true のままのため、
    accountEnabledでは除外できず、roomsData.jsの実マスタのメールアドレスと突き合わせて除外する */
async function fetchOrgUsers() {
  if (Auth.mode !== 'entra') return [];
  const token = await Auth.getGraphToken(['User.Read.All']);
  const domainFilter = "endsWith(mail,'@yoshimuraichi.com') or endsWith(mail,'@yumesumika.com')";
  let url = 'https://graph.microsoft.com/v1.0/users' +
    '?$select=id,displayName,mail,department,businessPhones,mobilePhone' +
    `&$filter=${encodeURIComponent(domainFilter)}` +
    '&$count=true&$top=999';

  const rows = [];
  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, ConsistencyLevel: 'eventual' } });
    if (!res.ok) throw new Error(await graphErrorMessage(res, `組織情報の取得に失敗しました(HTTP ${res.status})`));
    const data = await res.json();
    rows.push(...(data.value || []));
    url = data['@odata.nextLink'] || null;
  }

  return rows
    .filter(u => !RESOURCE_EMAILS.has((u.mail || '').toLowerCase()))
    .map(u => ({
      name: u.displayName || '(名前未設定)',
      email: u.mail || '',
      dept: u.department || '',
      phone: (u.businessPhones && u.businessPhones[0]) || u.mobilePhone || ''
    }));
}

const UNASSIGNED_LABEL = '(部門未設定)';

/** department属性ごとにグループ化する。空欄は UNASSIGNED_LABEL にまとめ、常に末尾に置く */
function groupByDepartment(users) {
  const byDept = new Map();
  users.forEach(u => {
    const key = u.dept || UNASSIGNED_LABEL;
    if (!byDept.has(key)) byDept.set(key, []);
    byDept.get(key).push(u);
  });
  const collator = (a, b) => a.name.localeCompare(b.name, 'ja');
  const depts = [...byDept.keys()].filter(d => d !== UNASSIGNED_LABEL).sort((a, b) => a.localeCompare(b, 'ja'));
  if (byDept.has(UNASSIGNED_LABEL)) depts.push(UNASSIGNED_LABEL);
  return depts.map(dept => ({ dept, members: byDept.get(dept).sort(collator) }));
}

function renderGroups() {
  const el = document.getElementById('org-tree');
  if (Auth.mode !== 'entra') {
    el.innerHTML = '<p style="margin:0;padding:24px 20px;font-size:13px;color:#8a99a8">devモードでは組織情報を確認できません(Entra IDでのサインインが必要です)</p>';
    return;
  }
  if (!state.groups.length) {
    el.innerHTML = '<p style="margin:0;padding:24px 20px;font-size:13px;color:#8a99a8">組織情報が見つかりませんでした</p>';
    return;
  }
  el.innerHTML = state.groups.map(g => `
    <div style="border-bottom:8px solid #f7fafd">
      <div style="padding:13px 20px;background:#f7fafd;display:flex;align-items:center;gap:9px;border-bottom:1px solid #e8edf3">
        <h2 style="margin:0;font-size:14px;font-weight:700">${esc(g.dept)}</h2>
        <span style="font-size:11px;color:#8a99a8">${g.members.length}名</span>
      </div>
      ${g.members.map(m => `
      <div style="display:flex;align-items:center;gap:14px;padding:11px 20px;border-bottom:1px solid #f2f5f9">
        <div style="width:32px;height:32px;border-radius:50%;background:#4a7fc0;color:#ffffff;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0">${esc(m.name.charAt(0))}</div>
        <span style="font-size:13px;font-weight:700;color:#1c2b3a;min-width:120px">${esc(m.name)}</span>
        <span style="font-size:12px;color:#6b7d8f;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(m.email)}</span>
        <span style="font-size:12px;color:#6b7d8f;white-space:nowrap">${esc(m.phone || '未登録')}</span>
      </div>`).join('')}
    </div>`).join('');
}

async function loadAndRender() {
  const el = document.getElementById('org-tree');
  if (Auth.mode !== 'entra') { renderGroups(); return; }
  el.innerHTML = '<p style="margin:0;padding:24px 20px;font-size:13px;color:#8a99a8">読み込み中…</p>';
  try {
    state.groups = groupByDepartment(await fetchOrgUsers());
    renderGroups();
  } catch (e) {
    console.error(e);
    state.groups = [];
    el.innerHTML = `<p style="margin:0;padding:24px 20px;font-size:13px;color:#c05a5a">${esc(e.message || String(e))}</p>`;
  }
}

// 自動リフレッシュ(共通方針: 2分間隔・非表示タブはスキップ・差分があるときだけ静かに差し替え)
async function autoRefresh() {
  if (document.hidden || Auth.mode !== 'entra') return;
  try {
    const groups = groupByDepartment(await fetchOrgUsers());
    if (JSON.stringify(groups) !== JSON.stringify(state.groups)) {
      state.groups = groups;
      renderGroups();
    }
  } catch { /* 自動更新の失敗は静かに無視(次回に再試行) */ }
}

(async function init() {
  try {
    await Auth.init();
    await loadAndRender();
    setInterval(autoRefresh, 2 * 60 * 1000);
  } catch (e) {
    console.error(e);
    document.getElementById('org-tree').innerHTML =
      `<p style="margin:0;padding:24px 20px;font-size:13px;color:#c05a5a">読み込みに失敗しました: ${esc(e.message || e)}</p>`;
  }
})();
