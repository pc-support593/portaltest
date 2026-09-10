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

// roomsData.js の実マスタ(ROOMS/YOSHIMURA_ROOMS/CARS)のメールアドレス一覧。
// 社員名簿には「人」だけを出したいため、これらは取得結果から除外する
const RESOURCE_EMAILS = new Set(
  [...ROOMS, ...YOSHIMURA_ROOMS, ...CARS].map(r => r.email.toLowerCase())
);

const state = { left: [], right: [] }; // 各列: [{ dept, members: [{name,email,phone}] }]

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
    '?$select=id,displayName,mail,department,jobTitle,businessPhones,mobilePhone' +
    `&$filter=${encodeURIComponent(domainFilter)}` +
    '&$count=true&$top=999';

  const rows = [];
  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, ConsistencyLevel: 'eventual' } });
    if (!res.ok) throw new Error(await graphErrorMessage(res, `社員名簿の取得に失敗しました(HTTP ${res.status})`));
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
      title: u.jobTitle || '',
      phone: (u.businessPhones && u.businessPhones[0]) || u.mobilePhone || ''
    }));
}

// 役職(jobTitle)にこれらの語を含む場合は部門を無視し、この語自体を部門扱いにして先頭に表示する。
// この順番がそのまま表示順になる(左列=吉村一建設側で使用)
const PRIORITY_TITLES = ['会長', '社長', '専務'];

// 特定の個人を、実際のEntra ID属性(部門・メールドメイン)に関わらず固定の列・見出しに
// 割り当てる特別対応(メールアドレスの完全一致・大文字小文字を区別しない)。
// 氏名の表記ゆれ(姓名間のスペース等)に影響されないよう、氏名ではなくメールアドレスで判定する。
// 2026-09-10: 森下直美(n-morishita@yoshimuraichi.com)を、メールドメインは@yoshimuraichi.comの
// ままだが実務はゆめすみかのため、右列(ゆめすみか)の「ゆめすみか常務取締役」として
// 会長/社長/専務と同様の先頭見出し扱いで表示する(ユーザー指示)。
// 逆に、不動産部・㈱来夢エンジニアの3名はメールドメインが@yumesumika.comだが実務は
// 吉村一建設側のため左列に表示する(groupを指定しないので部門名は実際のdepartment属性のまま。
// ユーザー指示 2026-09-10。これにより右列の不動産部・来夢エンジニアのグループは
// 該当者がいなくなり自動的に表示されなくなる)
const PERSON_OVERRIDES = {
  'n-morishita@yoshimuraichi.com': { column: 'right', group: 'ゆめすみか常務取締役' },
  's-tada@yumesumika.com': { column: 'left' },
  'katsu-oshima@yumesumika.com': { column: 'left' },
  's-yamanaka@yumesumika.com': { column: 'left' }
};

// 特定の個人を、Entra ID側のdepartment属性に関わらず指定の部門に固定する特別対応
// (メールアドレスの完全一致・大文字小文字を区別しない)。
// 2026-09-10: naofumi_kotani@yumesumika.com を設計企画部に固定(ユーザー指示。Entra ID側の
// department属性が実際の所属と異なる/未設定のための個別対応)
const DEPARTMENT_OVERRIDES = { 'naofumi_kotani@yumesumika.com': '設計企画部' };

/** メールアドレスの最初の「-」より後ろの部分(ローマ字の姓)を並び順のキーにする
    (ユーザー指示 2026-09-10)。漢字の氏名はEntra IDにふりがな属性が無く、Unicode上の
    文字コード順にしかならず正しい五十音順にできない(実際に検証済み: 「友藤/東/森本/千葉/巽/
    森下/小谷」を日本語ロケールでソートすると本来の読み順と一致しなかった)ため、
    このメールアドレスの命名規則(頭文字-姓のローマ字)を五十音順の代用として使う。
    「-」が無いメールアドレス(例: naofumi_kotani@…)は@より前の全体をそのまま使う */
function sortKeyFromEmail(email) {
  const local = String(email || '').split('@')[0].toLowerCase();
  const idx = local.indexOf('-');
  return idx >= 0 ? local.slice(idx + 1) : local;
}

/** 役職優先グループ(PERSON_OVERRIDESの該当者 → priorityTitlesの語順、該当者がいるものだけ)
    → 残りをdepartment属性(DEPARTMENT_OVERRIDESがあればそちらを優先)でグループ化。
    部門が空欄の社員は表示しない */
function buildGroups(users, priorityTitles) {
  const priorityBuckets = new Map();
  const overrideOrder = []; // PERSON_OVERRIDES由来の見出しは priorityTitles の後ろ・出現順に追加
  const byDept = new Map();

  users.forEach(u => {
    const person = PERSON_OVERRIDES[u.email.toLowerCase()];
    const key = (person && person.group) || priorityTitles.find(t => u.title.includes(t));
    if (key) {
      if (!priorityBuckets.has(key)) {
        priorityBuckets.set(key, []);
        if (!priorityTitles.includes(key)) overrideOrder.push(key);
      }
      priorityBuckets.get(key).push(u);
      return;
    }
    const dept = DEPARTMENT_OVERRIDES[u.email.toLowerCase()] || u.dept;
    if (!dept) return;
    if (!byDept.has(dept)) byDept.set(dept, []);
    byDept.get(dept).push(u);
  });

  const collator = (a, b) => sortKeyFromEmail(a.email).localeCompare(sortKeyFromEmail(b.email));
  const priorityKeys = [...priorityTitles.filter(t => priorityBuckets.has(t)), ...overrideOrder];
  const priorityGroups = priorityKeys.map(key => ({ dept: key, members: priorityBuckets.get(key).sort(collator) }));
  const deptGroups = [...byDept.keys()].sort((a, b) => a.localeCompare(b, 'ja'))
    .map(dept => ({ dept, members: byDept.get(dept).sort(collator) }));
  return [...priorityGroups, ...deptGroups];
}

function renderColumn(elId, groups) {
  const el = document.getElementById(elId);
  if (Auth.mode !== 'entra') {
    el.innerHTML = '<p style="margin:0;padding:24px 20px;font-size:13px;color:#8a99a8">devモードでは組織情報を確認できません(Entra IDでのサインインが必要です)</p>';
    return;
  }
  if (!groups.length) {
    el.innerHTML = '<p style="margin:0;padding:24px 20px;font-size:13px;color:#8a99a8">該当するメンバーが見つかりませんでした</p>';
    return;
  }
  el.innerHTML = groups.map(g => `
    <div style="border-bottom:8px solid #f7fafd">
      <div style="padding:13px 20px;background:#f7fafd;display:flex;align-items:center;gap:9px;border-bottom:1px solid #e8edf3">
        <h3 style="margin:0;font-size:14px;font-weight:700">${esc(g.dept)}</h3>
        <span style="font-size:11px;color:#8a99a8">${g.members.length}名</span>
      </div>
      ${g.members.map(m => `
      <div style="display:flex;align-items:center;gap:14px;padding:11px 20px;border-bottom:1px solid #f2f5f9">
        <div style="width:32px;height:32px;border-radius:50%;background:#4a7fc0;color:#ffffff;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0">${esc(m.name.charAt(0))}</div>
        <span style="font-size:13px;font-weight:700;color:#1c2b3a;min-width:110px">${esc(m.name)}</span>
        <span style="font-size:12px;color:#6b7d8f;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(m.email)}</span>
        <span style="font-size:12px;color:#6b7d8f;white-space:nowrap">${esc(m.phone || '未登録')}</span>
      </div>`).join('')}
    </div>`).join('');
}

function renderAll() {
  renderColumn('org-left', state.left);
  renderColumn('org-right', state.right);
}

/** @yumesumika.com は右列(ゆめすみか)、それ以外は左列に振り分ける(ユーザー指示 2026-09-10)。
    PERSON_OVERRIDESで列が指定されている場合はメールドメインより優先する
    (森下直美はメールドメインが@yoshimuraichi.comのままだが右列に表示するため) */
function splitByCompany(users) {
  const right = [], left = [];
  users.forEach(u => {
    const person = PERSON_OVERRIDES[u.email.toLowerCase()];
    const isRight = person ? person.column === 'right' : u.email.toLowerCase().endsWith('@yumesumika.com');
    (isRight ? right : left).push(u);
  });
  return { left, right };
}

async function loadAndRender() {
  if (Auth.mode !== 'entra') { renderAll(); return; }
  const loading = '<p style="margin:0;padding:24px 20px;font-size:13px;color:#8a99a8">読み込み中…</p>';
  document.getElementById('org-left').innerHTML = loading;
  document.getElementById('org-right').innerHTML = loading;
  try {
    const { left, right } = splitByCompany(await fetchOrgUsers());
    state.left = buildGroups(left, PRIORITY_TITLES);
    state.right = buildGroups(right, []);
    renderAll();
  } catch (e) {
    console.error(e);
    state.left = []; state.right = [];
    const msg = `<p style="margin:0;padding:24px 20px;font-size:13px;color:#c05a5a">${esc(e.message || String(e))}</p>`;
    document.getElementById('org-left').innerHTML = msg;
    document.getElementById('org-right').innerHTML = msg;
  }
}

// 自動リフレッシュ(共通方針: 2分間隔・非表示タブはスキップ・差分があるときだけ静かに差し替え)
async function autoRefresh() {
  if (document.hidden || Auth.mode !== 'entra') return;
  try {
    const { left, right } = splitByCompany(await fetchOrgUsers());
    const newLeft = buildGroups(left, PRIORITY_TITLES);
    const newRight = buildGroups(right, []);
    if (JSON.stringify(newLeft) !== JSON.stringify(state.left) || JSON.stringify(newRight) !== JSON.stringify(state.right)) {
      state.left = newLeft; state.right = newRight;
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
