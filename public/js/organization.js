// 組織図画面。現時点では総務部のみ対応(ユーザー指示 2026-08-22。他部門は追って追加)。
// Entra ID(Graph /users?$filter=department eq '...')から氏名・メール・電話番号を取得して表示する。
// 部署(department)取得には User.Read.All 権限が必要(User.ReadBasic.All からの引き上げ、要管理者同意)。
'use strict';

// 表示する部門の一覧。増やす場合はここに1行追加するだけでよい(department の表記はEntra ID側と完全一致させること)
const DEPARTMENTS = [
  { id: 'soumu', name: '総務部' }
];

const state = { members: [] };

function renderDeptCard() {
  const el = document.getElementById('dept-card');
  const dept = DEPARTMENTS[0];

  if (Auth.mode !== 'entra') {
    el.innerHTML = `
    <div style="padding:15px 20px;border-bottom:1px solid #e8edf3">
      <h2 style="margin:0;font-size:15px;font-weight:700">${esc(dept.name)}</h2>
    </div>
    <p style="margin:0;padding:24px 20px;font-size:13px;color:#8a99a8">devモードでは組織情報を確認できません(Entra IDでのサインインが必要です)</p>`;
    return;
  }

  const rows = state.members.map(m => `
    <div style="display:flex;align-items:center;gap:14px;padding:12px 20px;border-bottom:1px solid #f2f5f9">
      <div style="width:34px;height:34px;border-radius:50%;background:#4a7fc0;color:#ffffff;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;flex-shrink:0">${esc(m.name.charAt(0))}</div>
      <span style="font-size:13px;font-weight:700;color:#1c2b3a;min-width:120px">${esc(m.name)}</span>
      <span style="font-size:12px;color:#6b7d8f;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(m.email)}</span>
      <span style="font-size:12px;color:#6b7d8f;white-space:nowrap">${esc(m.phone || '未登録')}</span>
    </div>`).join('');

  el.innerHTML = `
    <div style="padding:15px 20px;border-bottom:1px solid #e8edf3;display:flex;align-items:center;gap:9px">
      <h2 style="margin:0;font-size:15px;font-weight:700">${esc(dept.name)}</h2>
      <span style="font-size:11px;color:#8a99a8">${state.members.length}名</span>
    </div>
    ${state.members.length ? rows : '<p style="margin:0;padding:24px 20px;font-size:13px;color:#8a99a8">該当するメンバーが見つかりませんでした</p>'}`;
}

async function loadAndRender() {
  const el = document.getElementById('dept-card');
  if (Auth.mode !== 'entra') { renderDeptCard(); return; }
  el.innerHTML = '<p style="margin:0;padding:24px 20px;font-size:13px;color:#8a99a8">読み込み中…</p>';
  try {
    state.members = await fetchDepartmentMembers(DEPARTMENTS[0].name);
    renderDeptCard();
  } catch (e) {
    console.error(e);
    state.members = [];
    el.innerHTML = `<p style="margin:0;padding:24px 20px;font-size:13px;color:#c05a5a">${esc(e.message || String(e))}</p>`;
  }
}

// 自動リフレッシュ(共通方針: 2分間隔・非表示タブはスキップ・差分があるときだけ静かに差し替え)
async function autoRefresh() {
  if (document.hidden || Auth.mode !== 'entra') return;
  try {
    const prev = JSON.stringify(state.members);
    const members = await fetchDepartmentMembers(DEPARTMENTS[0].name);
    if (JSON.stringify(members) !== prev) { state.members = members; renderDeptCard(); }
  } catch { /* 自動更新の失敗は静かに無視(次回に再試行) */ }
}

(async function init() {
  try {
    await Auth.init();
    await loadAndRender();
    setInterval(autoRefresh, 2 * 60 * 1000);
  } catch (e) {
    console.error(e);
    document.getElementById('dept-card').innerHTML =
      `<p style="margin:0;padding:24px 20px;font-size:13px;color:#c05a5a">読み込みに失敗しました: ${esc(e.message || e)}</p>`;
  }
})();
