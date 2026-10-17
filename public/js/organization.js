// 社員名簿画面(旧「組織図」。2026-09-10に名称変更・ユーザー指示)。
// Entra IDのdepartment属性で部門ごとにメンバーをグループ化して表示する
// (2026-09-08: manager属性によるツリー表示を試みたが、Entra ID側でmanagerが
// 未設定の社員が多く「ただの一覧」になってしまったため、ユーザー指示によりこの方式に変更)。
// 役職(jobTitle)に「会長」「社長」「専務」を含む社員は部門を無視してその役職を部門扱いにし、
// 先頭(会長→社長→専務の順)に表示する。department が空欄の社員は表示しない(2026-09-10)。
// 2列表示(2026-09-10・ユーザー指示): メールアドレスが @yumesumika.com の社員は右列(ゆめすみか)、
// それ以外は左列に表示する。PERSON_OVERRIDES(メールアドレス指定)がある人はメールドメインより
// そちらを優先する(実務はゆめすみかだがメールドメインが@yoshimuraichi.comの人向け)。
// 会議室・社用車(Exchangeリソースメールボックス)は roomsData.js の実マスタと突き合わせて除外する
// (accountEnabledでの判定は、この組織のリソースメールボックスが有効化されたままのため機能しなかった)。
'use strict';

// 部門ごとの取得・組み立て(fetchOrgUsers / buildGroups / loadOrgData など)は orgData.js(出勤状況と共用)

const state = { left: [], right: [], failedLeft: [], failedRight: [] }; // 各列: [{ dept, members: [{name,email,phone}] }]。failed*=取得に失敗したグループ名

function renderColumn(elId, groups, failedGroups) {
  const el = document.getElementById(elId);
  if (Auth.mode !== 'entra') {
    el.innerHTML = '<p style="margin:0;padding:24px 20px;font-size:13px;color:#8a99a8">devモードでは組織情報を確認できません(Entra IDでのサインインが必要です)</p>';
    return;
  }
  const notice = (failedGroups && failedGroups.length)
    ? `<p style="margin:0;padding:10px 20px;font-size:12px;color:#c05a5a;background:#fdf4f4;border-bottom:1px solid #f3dede">次のグループを取得できませんでした(該当する方が表示されていない可能性があります): ${esc(failedGroups.join('、'))}</p>`
    : '';
  if (!groups.length) {
    el.innerHTML = notice + '<p style="margin:0;padding:24px 20px;font-size:13px;color:#8a99a8">該当するメンバーが見つかりませんでした</p>';
    return;
  }
  el.innerHTML = notice + groups.map(g => `
    <div style="border-bottom:8px solid #f7fafd">
      <div style="padding:13px 20px;background:#f7fafd;display:flex;align-items:center;gap:9px;border-bottom:1px solid #e8edf3">
        <h3 style="margin:0;font-size:14px;font-weight:700">${esc(g.dept)}</h3>
        <span style="font-size:11px;color:#8a99a8">${g.members.length}名</span>
      </div>
      ${g.members.map(m => `
      <div class="member-row" style="display:flex;align-items:center;gap:14px;padding:11px 20px;border-bottom:1px solid #f2f5f9">
        <div style="width:32px;height:32px;border-radius:50%;background:#4a7fc0;color:#ffffff;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0">${esc(m.name.charAt(0))}</div>
        <span class="member-name" style="font-size:13px;font-weight:700;color:#1c2b3a;min-width:110px">${esc(displayName(m.name))}</span>
        <span class="member-email" style="font-size:12px;color:#6b7d8f;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${m.email ? `<a href="mailto:${esc(m.email)}" style="color:#1e5fa8;text-decoration:none" onmouseover="this.style.textDecoration='underline'" onmouseout="this.style.textDecoration='none'">${esc(m.email)}</a>` : ''}</span>
        <span class="member-phone" style="font-size:12px;color:#6b7d8f;white-space:nowrap;flex-shrink:0;text-align:right">${esc(m.phone || '未登録')}</span>
      </div>`).join('')}
    </div>`).join('');
}

function renderAll() {
  renderColumn('org-left', state.left, state.failedLeft);
  renderColumn('org-right', state.right, state.failedRight);
}

async function loadAndRender() {
  if (Auth.mode !== 'entra') { renderAll(); return; }
  const loading = '<p style="margin:0;padding:24px 20px;font-size:13px;color:#8a99a8">読み込み中…</p>';
  document.getElementById('org-left').innerHTML = loading;
  document.getElementById('org-right').innerHTML = loading;
  try {
    Object.assign(state, await loadOrgData());
    renderAll();
  } catch (e) {
    console.error(e);
    state.left = []; state.right = []; state.failedLeft = []; state.failedRight = [];
    const msg = `<p style="margin:0;padding:24px 20px;font-size:13px;color:#c05a5a">${esc(e.message || String(e))}</p>`;
    document.getElementById('org-left').innerHTML = msg;
    document.getElementById('org-right').innerHTML = msg;
  }
}

// 自動リフレッシュ(共通方針: 2分間隔・非表示タブはスキップ・差分があるときだけ静かに差し替え)
async function autoRefresh() {
  if (document.hidden || Auth.mode !== 'entra') return;
  try {
    const next = await loadOrgData();
    if (JSON.stringify(next) !== JSON.stringify({ left: state.left, right: state.right, failedLeft: state.failedLeft, failedRight: state.failedRight })) {
      Object.assign(state, next);
      renderAll();
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
    const msg = `<p style="margin:0;padding:24px 20px;font-size:13px;color:#c05a5a">読み込みに失敗しました: ${esc(e.message || e)}</p>`;
    document.getElementById('org-left').innerHTML = msg;
    document.getElementById('org-right').innerHTML = msg;
  }
})();
