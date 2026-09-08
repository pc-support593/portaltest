// 組織図画面(2026-09-08: ツリー構造に変更。ユーザー指示)。
// Entra ID の manager 属性(上長)を正として、全社の階層構造を自動的に組み立てて表示する。
// department 属性(部門名の文字列一致)には依存しない(手動の対象部門一覧を持たない)。
// 権限は既存の User.Read.All のみで足りる(manager の読み取りに追加スコープは不要)。
'use strict';

const state = { tree: [], expanded: new Set(), rootCount: 0, totalCount: 0 };

/** Graphのエラーレスポンスから可能な限り具体的なメッセージを取り出す(HTTPステータスだけだと
    原因が分からず切り分けに時間がかかるため。2026-09-08追加) */
async function graphErrorMessage(res, fallback) {
  try {
    const data = await res.json();
    if (data && data.error && data.error.message) return `${fallback}: ${data.error.message}`;
  } catch { /* 本文がJSONでない場合はフォールバックのみ */ }
  return fallback;
}

/** 会議室・社用車(Equipment/Roomメールボックス)はサインイン不可のため accountEnabled=false で除外。
    対象は社内の2ドメインのみ(検索機能と同じ絞り込み。ユーザー指示 2026-09-07)。
    マネージャーは一覧取得とは別に、ユーザーごとに `/users/{id}/manager` で個別取得する
    (2026-09-08: 当初 $expand=manager を一覧取得に付けていたが、advanced query($filter の endsWith
    + $count)との組み合わせでHTTP 400になったため撤回。$expand無しの一覧取得+個別のmanager取得に変更。
    manager未設定のユーザーは404が返る仕様のため、404はエラー扱いにせず「マネージャーなし」として扱う) */
async function fetchOrgUsers() {
  if (Auth.mode !== 'entra') return [];
  const token = await Auth.getGraphToken(['User.Read.All']);
  const domainFilter = "accountEnabled eq true and (endsWith(mail,'@yoshimuraichi.com') or endsWith(mail,'@yumesumika.com'))";
  let url = 'https://graph.microsoft.com/v1.0/users' +
    '?$select=id,displayName,mail,jobTitle,department,businessPhones,mobilePhone' +
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

  // マネージャーの個別取得(同時実行数を絞って一斉リクエストによるスロットリングを避ける)
  const CONCURRENCY = 8;
  const managerIds = new Array(rows.length).fill(null);
  let next = 0;
  async function worker() {
    while (next < rows.length) {
      const i = next++;
      try {
        const r = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(rows[i].id)}/manager?$select=id`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (r.ok) managerIds[i] = (await r.json()).id || null;
        // 404 = マネージャー未設定(正常な状態。エラーにしない)。それ以外の失敗もマネージャーなし扱いで続行
      } catch { /* 個別の失敗は無視して続行(1件の失敗で全体を壊さない) */ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker));

  return rows.map((u, i) => ({
    id: u.id,
    name: u.displayName || '(名前未設定)',
    email: u.mail || '',
    title: u.jobTitle || '',
    dept: u.department || '',
    phone: (u.businessPhones && u.businessPhones[0]) || u.mobilePhone || '',
    managerId: managerIds[i]
  }));
}

/** manager(上長)属性から親子関係を組み立てる。マネージャーが未設定、またはマネージャーが
    対象ドメイン外(取得対象に含まれない)場合はルート扱いにする */
function buildOrgTree(users) {
  const byId = new Map(users.map(u => [u.id, { ...u, children: [] }]));
  const roots = [];
  for (const u of byId.values()) {
    const parent = u.managerId && byId.get(u.managerId);
    if (parent) parent.children.push(u); else roots.push(u);
  }
  const collator = (a, b) => a.name.localeCompare(b.name, 'ja');
  const sortRec = node => { node.children.sort(collator); node.children.forEach(sortRec); };
  roots.sort(collator);
  roots.forEach(sortRec);
  return roots;
}

function countDescendants(node) {
  return node.children.reduce((n, c) => n + 1 + countDescendants(c), 0);
}

/** 初期表示: ルートとその直下(部門長クラス)までを開き、それより下は折りたたんでおく
    (全社員を一度に表示すると縦に長大になるため) */
function defaultExpand(nodes, depth) {
  if (depth > 0) return;
  nodes.forEach(n => { state.expanded.add(n.id); defaultExpand(n.children, depth + 1); });
}

function renderNode(node, depth) {
  const hasChildren = node.children.length > 0;
  const isOpen = state.expanded.has(node.id);
  const sub = [node.title, node.dept].filter(Boolean).join(' ・ ') || node.email;
  return `
  <div>
    <div ${hasChildren ? `data-toggle="${esc(node.id)}"` : ''} style="display:flex;align-items:center;gap:10px;padding:9px 14px 9px ${14 + depth * 24}px;border-bottom:1px solid #f2f5f9;${hasChildren ? 'cursor:pointer' : ''}">
      <span style="width:14px;text-align:center;color:#8a99a8;font-size:11px;flex-shrink:0">${hasChildren ? (isOpen ? '▾' : '▸') : ''}</span>
      <span style="width:30px;height:30px;border-radius:50%;background:#4a7fc0;color:#ffffff;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0">${esc(node.name.charAt(0))}</span>
      <span style="display:flex;flex-direction:column;min-width:0;line-height:1.35">
        <span style="font-size:13px;font-weight:700;color:#1c2b3a">${esc(node.name)}${hasChildren ? ` <span style="font-weight:500;color:#8a99a8;font-size:11px">(配下 ${countDescendants(node)}名)</span>` : ''}</span>
        <span style="font-size:11px;color:#6b7d8f;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(sub)}</span>
      </span>
    </div>
    ${hasChildren && isOpen ? node.children.map(c => renderNode(c, depth + 1)).join('') : ''}
  </div>`;
}

function renderTree() {
  const el = document.getElementById('org-tree');
  if (Auth.mode !== 'entra') {
    el.innerHTML = '<p style="margin:0;padding:24px 20px;font-size:13px;color:#8a99a8">devモードでは組織図を確認できません(Entra IDでのサインインが必要です)</p>';
    return;
  }
  if (!state.tree.length) {
    el.innerHTML = '<p style="margin:0;padding:24px 20px;font-size:13px;color:#8a99a8">組織情報が見つかりませんでした</p>';
    return;
  }
  // Entra ID側で「マネージャー」が未設定の社員が多いと、階層にならず大半がルート(トップ階層)に
  // 並んでしまう。その場合は原因が分かるよう案内を出す(ユーザー側でのEntra ID設定不足の可能性が高いため)
  const warn = state.rootCount > 1 && state.rootCount >= state.totalCount * 0.3
    ? `<p style="margin:0;padding:12px 20px;font-size:12px;color:#8a6d1f;background:#fdf6e7;border-bottom:1px solid #f0e4c8">
        トップ階層に${state.rootCount}名が並んでいます。多くの社員でEntra IDの「マネージャー」が未設定の可能性があります。
        正しい階層で表示するには、Entra ID(entra.microsoft.com)の各ユーザーの「マネージャー」欄を設定してください。</p>`
    : '';
  el.innerHTML = warn + state.tree.map(n => renderNode(n, 0)).join('');
  el.querySelectorAll('[data-toggle]').forEach(row => row.addEventListener('click', () => {
    const id = row.dataset.toggle;
    if (state.expanded.has(id)) state.expanded.delete(id); else state.expanded.add(id);
    renderTree();
  }));
}

async function loadAndRender() {
  const el = document.getElementById('org-tree');
  if (Auth.mode !== 'entra') { renderTree(); return; }
  el.innerHTML = '<p style="margin:0;padding:24px 20px;font-size:13px;color:#8a99a8">読み込み中…</p>';
  try {
    const users = await fetchOrgUsers();
    state.tree = buildOrgTree(users);
    state.totalCount = users.length;
    state.rootCount = state.tree.length;
    state.expanded = new Set();
    defaultExpand(state.tree, 0);
    renderTree();
  } catch (e) {
    console.error(e);
    state.tree = [];
    el.innerHTML = `<p style="margin:0;padding:24px 20px;font-size:13px;color:#c05a5a">${esc(e.message || String(e))}</p>`;
  }
}

// 自動リフレッシュ(共通方針: 2分間隔・非表示タブはスキップ・差分があるときだけ静かに差し替え)。
// 開閉状態(state.expanded)は保持したまま、ツリーの中身だけ差し替える
async function autoRefresh() {
  if (document.hidden || Auth.mode !== 'entra') return;
  try {
    const users = await fetchOrgUsers();
    const tree = buildOrgTree(users);
    if (JSON.stringify(tree) !== JSON.stringify(state.tree)) {
      state.tree = tree;
      state.totalCount = users.length;
      state.rootCount = tree.length;
      renderTree();
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
