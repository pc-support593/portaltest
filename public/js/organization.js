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

const state = { left: [], right: [], failedLeft: [], failedRight: [] }; // 各列: [{ dept, members: [{name,email,phone}] }]。failed*=取得に失敗したグループ名

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
  // 検索条件($filter・$count・ConsistencyLevel: eventual)つきの取得(advanced query)は、変更の反映が遅れる(古い値が返る)ため使わない。
  // 通常の一覧取得で全ユーザーを取り、メールアドレスのドメインはこちらで絞り込む(2026-10-10。従業員の種類の変更が名簿に出ない不具合の対策)
  let url = 'https://graph.microsoft.com/v1.0/users' +
    '?$select=id,displayName,mail,department,jobTitle,employeeType,businessPhones,mobilePhone' +
    '&$top=999';

  const rows = [];
  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(await graphErrorMessage(res, `社員名簿の取得に失敗しました(HTTP ${res.status})`));
    const data = await res.json();
    rows.push(...(data.value || []));
    url = data['@odata.nextLink'] || null;
  }

  const isOrgMail = mail => /@(yoshimuraichi|yumesumika)\.com$/i.test(mail || '');
  return rows
    .filter(u => isOrgMail(u.mail))
    .filter(u => !RESOURCE_EMAILS.has((u.mail || '').toLowerCase()))
    .map(u => ({
      name: u.displayName || '(名前未設定)',
      email: u.mail || '',
      dept: u.department || '',
      title: u.jobTitle || '',
      empType: String(u.employeeType || '').trim(), // 従業員の種類。「1」なら役職を組織名として表示(buildGroups)
      // 電話番号表示(2026-10-05変更・ユーザー指示): 基本は携帯電話(mobilePhone)を表示し、
      // 事業所の電話(businessPhones。配列・複数件あり得る)が登録されていれば2件目以降として追加表示する
      // (どちらか一方のフォールバックではなく、両方登録されていれば両方とも表示する)
      phone: phoneListOf(u).join(' / ')
    }));
}

// ゆめすみか側の部門分けはdepartment属性ではなくMS365グループで判定する(2026-10-05・ユーザー指示。
// yumesumika-schedule.jsのSHOWROOM_GROUPSと同じグループ・同じ理由=department属性より実際の運用
// (MS365グループ)の方が正確なため)。いずれのグループにも所属しないゆめすみか社員は表示しない
// (ユーザー指示。department属性へのフォールバックはしない)
const YUMESUMIKA_GROUPS = [
  { label: '福田展示場', groupMail: 'yumesumika_1@yumesumika.com' },
  { label: '中百舌鳥展示場', groupMail: 'yumesumika_2@yumesumika.com' },
  { label: '平野展示場', groupMail: 'yumesumika_3@yumesumika.com' },
  { label: '花博展示場', groupMail: 'yumesumika_4@yumesumika.com' },
  { label: '西宮展示場', groupMail: 'yumesumika_5@yumesumika.com' },
  { label: '設計', groupMail: 'yumesumika_6@yumesumika.com' }
];
const YUMESUMIKA_GROUP_ORDER = YUMESUMIKA_GROUPS.map(g => g.label);

/** 指定したMS365グループのメンバーのメールアドレス一覧を取得する
    (yumesumikaSchedule.jsのfetchGroupMembersと同じ方式。GroupMember.Read.Allは既に許可済みのため新規権限不要) */
async function fetchGroupMemberEmails(groupMail) {
  const token = await Auth.getGraphToken(['GroupMember.Read.All']);
  const groupUrl = 'https://graph.microsoft.com/v1.0/groups' +
    `?$filter=${encodeURIComponent(`mail eq '${groupMail}'`)}&$select=id`;
  const groupRes = await fetch(groupUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (!groupRes.ok) throw new Error(await graphErrorMessage(groupRes, `グループの取得に失敗しました(${groupMail})`));
  const groupData = await groupRes.json();
  const group = (groupData.value || [])[0];
  if (!group) throw new Error(`グループが見つかりませんでした(${groupMail})`);

  let url = `https://graph.microsoft.com/v1.0/groups/${group.id}/members?$select=mail&$top=200`;
  const emails = [];
  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(await graphErrorMessage(res, `メンバー一覧の取得に失敗しました(${groupMail})`));
    const data = await res.json();
    emails.push(...(data.value || []).map(m => (m.mail || '').toLowerCase()).filter(Boolean));
    url = data['@odata.nextLink'] || null;
  }
  return emails;
}

/** 指定したグループ一覧について、メールアドレス(小文字)→所属グループ名(見出し)の配列、のマップを作る。
    1人が複数のグループに入っていれば、その全ての見出しに表示する(ユーザー指示 2026-10-10)。
    グループは並行取得し、1グループの取得失敗で全体を壊さないようtry/catchする。
    取得に失敗したグループ名は failed に返し、画面に表示する(黙って人が消えないように) */
async function fetchGroupLabelMap(groups) {
  const map = {};
  const failed = [];
  await Promise.all(groups.map(async g => {
    try {
      (await fetchGroupMemberEmails(g.groupMail)).forEach(email => {
        (map[email] ||= []).includes(g.label) || map[email].push(g.label);
      });
    } catch (e) {
      console.error(`「${g.label}」のメンバー取得に失敗しました`, e);
      failed.push(g.label);
    }
  }));
  return { map, failed };
}

// 吉村一建設側(左列)の部署グループ。スタッフ予定と同じ(common.jsのYOSHIMURA_STAFF_GROUPS)。見出し名・並び順もそのまま
const LEFT_GROUPS = YOSHIMURA_STAFF_GROUPS.map(g => ({ label: g.name, groupMail: g.groupMail }));
const LEFT_GROUP_ORDER = LEFT_GROUPS.map(g => g.label);

// MS365アカウント(メールアドレス)を持たない社員の手動追加リスト(2026-10-05・ユーザー指示)。
// Graph APIには存在しないため、Entra ID取得結果とは別にこの配列を直接buildGroupsへ合流させる。
// email/phoneを持たない項目はrenderColumn側の表示で空欄・「未登録」として扱われる(既存のロジックのまま)。
// 「物流部」は吉村一建設側の部門のため column:'left'(右列=ゆめすみかはMS365グループ判定のため、
// メールアドレスの無いこの方式では右列には乗せられないことに注意)
const MANUAL_MEMBERS = [
  { name: '松岡 謙次', dept: '物流事業係', phone: '080-4429-6487', column: 'left' },
  { name: '荒井 正義', dept: '物流事業係', phone: '', column: 'left' }
];

/** MANUAL_MEMBERSの1件を、buildGroups/renderColumnが期待する形(email/title付き)に変換する */
function manualMemberToUser(m) {
  return { name: m.name, email: '', dept: m.dept, title: '', empType: '', phone: m.phone || '' };
}

// 従業員の種類(employeeType)が「1」の人は、役職(jobTitle)を組織名(見出し)として先頭に表示し、MS365グループ側には載せない
// (2026-10-10・ユーザー指示)。この配列は、そのうち会長・社長・専務の見出しの表示順を決める(これ以外の役職は後ろに出現順)
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
// 2026-10-05: 森下直美さんの下の役職として「マネージャー」を新設、k-ohira@yumesumika.comが対象
// (ユーザー指示)。表示順はOVERRIDE_GROUP_ORDERで保証する(下記参照)
const PERSON_OVERRIDES = {
  'n-morishita@yoshimuraichi.com': { column: 'right', group: 'ゆめすみか常務取締役' },
  'k-ohira@yumesumika.com': { column: 'right', group: 'マネージャー' },
  's-tada@yumesumika.com': { column: 'left' },
  'katsu-oshima@yumesumika.com': { column: 'left' },
  's-yamanaka@yumesumika.com': { column: 'left' }
};

// PERSON_OVERRIDESのgroup指定による優先見出しの表示順(2026-10-05追加)。
// buildGroups内のoverrideOrderはGraph APIの返却順(保証されない)に依存してしまうため、
// 複数のgroupが存在する場合に備えてこの配列で明示的に順序を固定する
const OVERRIDE_GROUP_ORDER = ['ゆめすみか常務取締役', 'マネージャー'];

// 特定の個人を、Entra ID側のdepartment属性に関わらず指定の部門に固定する特別対応
// (メールアドレスの完全一致・大文字小文字を区別しない)。
// 2026-09-10: naofumi_kotani@yumesumika.com / kotani@yoshimuraichi.com をどちらも設計企画部に
// 固定(ユーザー指示。Entra ID側のdepartment属性が実際の所属と異なる/未設定のための個別対応)
const DEPARTMENT_OVERRIDES = {
  'naofumi_kotani@yumesumika.com': '設計企画部',
  'kotani@yoshimuraichi.com': '設計企画部'
};

/** 役職優先グループ(PERSON_OVERRIDESの該当者 → priorityTitlesの語順、該当者がいるものだけ)
    → 残りを通常グループ(既定はdepartment属性。DEPARTMENT_OVERRIDESがあればそちらを優先)でグループ化。
    グループが決まらない社員は表示しない。
    options.deptsOf(u)=その人が表示される見出し(グループ名)の配列(複数所属なら全てに表示)、options.deptOrder=見出しの表示順。
    従業員の種類(empType)が「1」の人は、役職(title)を見出しにして先頭に表示し、deptsOfは使わない(2026-10-10・ユーザー指示) */
function buildGroups(users, priorityTitles, options) {
  const opts = options || {};
  const deptsOf = opts.deptsOf || (() => []); // その人が表示される見出し(グループ名)の配列。複数所属なら全てに表示
  const deptOrder = opts.deptOrder || null;

  const priorityBuckets = new Map();
  const overrideOrder = []; // PERSON_OVERRIDES由来の見出しは priorityTitles の後ろ・出現順に追加
  const byDept = new Map();

  users.forEach(u => {
    const person = PERSON_OVERRIDES[u.email.toLowerCase()];
    // 従業員の種類が「1」の人は、役職を組織名として扱いグループ側には入れない(役職が空なら表示しない)
    const key = (person && person.group) || (u.empType === '1' ? (u.title || null) : null);
    if (!key && u.empType === '1') return;
    if (key) {
      if (!priorityBuckets.has(key)) {
        priorityBuckets.set(key, []);
        if (!priorityTitles.includes(key)) overrideOrder.push(key);
      }
      priorityBuckets.get(key).push(u);
      return;
    }
    deptsOf(u).filter(Boolean).forEach(dept => {
      if (!byDept.has(dept)) byDept.set(dept, []);
      byDept.get(dept).push(u);
    });
  });

  // メールアドレスを持たない社員(MANUAL_MEMBERS。sortKeyFromEmailが空文字を返す)は、
  // 五十音順コラレータでは常に先頭に来てしまう(空配列同士/空配列と比較した際の挙動のため)。
  // メールアドレスが無い=五十音順の判定材料が無いという意味なので、該当者は各グループの末尾に回す
  // (2026-10-05・ユーザー指示: 物流事業係に手動追加した2名を下のほうに表示したい)
  const collator = (a, b) => {
    const aHasEmail = !!a.email, bHasEmail = !!b.email;
    if (aHasEmail !== bHasEmail) return aHasEmail ? -1 : 1;
    return compareMembersByRank(a, b); // 従業員の種類の数字(2以降)の小さい順→五十音順
  };
  // overrideOrderはusers配列の出現順(Graph APIの返却順。保証されない)に依存してしまうため、
  // OVERRIDE_GROUP_ORDERで明示した順序で並べ替える(そこに無いgroup名は出現順のまま末尾側に残す)
  overrideOrder.sort((a, b) => {
    const ia = OVERRIDE_GROUP_ORDER.indexOf(a), ib = OVERRIDE_GROUP_ORDER.indexOf(b);
    if (ia === -1 && ib === -1) return 0;
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
  const priorityKeys = [...priorityTitles.filter(t => priorityBuckets.has(t)), ...overrideOrder];
  const priorityGroups = priorityKeys.map(key => ({ dept: key, members: priorityBuckets.get(key).sort(collator) }));
  const deptKeys = deptOrder
    ? deptOrder.filter(d => byDept.has(d))
    : [...byDept.keys()].sort((a, b) => a.localeCompare(b, 'ja'));
  const deptGroups = deptKeys.map(dept => ({ dept, members: byDept.get(dept).sort(collator) }));
  return [...priorityGroups, ...deptGroups];
}

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
      <div style="display:flex;align-items:center;gap:14px;padding:11px 20px;border-bottom:1px solid #f2f5f9">
        <div style="width:32px;height:32px;border-radius:50%;background:#4a7fc0;color:#ffffff;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0">${esc(m.name.charAt(0))}</div>
        <span style="font-size:13px;font-weight:700;color:#1c2b3a;min-width:110px">${esc(displayName(m.name))}</span>
        <span style="font-size:12px;color:#6b7d8f;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${m.email ? `<a href="mailto:${esc(m.email)}" style="color:#1e5fa8;text-decoration:none" onmouseover="this.style.textDecoration='underline'" onmouseout="this.style.textDecoration='none'">${esc(m.email)}</a>` : ''}</span>
        <span style="font-size:12px;color:#6b7d8f;white-space:nowrap;flex-shrink:0;text-align:right">${esc(m.phone || '未登録')}</span>
      </div>`).join('')}
    </div>`).join('');
}

function renderAll() {
  renderColumn('org-left', state.left, state.failedLeft);
  renderColumn('org-right', state.right, state.failedRight);
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

/** 社員名簿の表示内容を作る(ユーザー・グループの取得→左右の振り分け→見出しごとにまとめる)。
    見出しは全てMS365グループで決める(2026-10-10・ユーザー指示。左=吉村一建設の部署グループ13個、右=ゆめすみか6グループ)。
    従業員の種類が「1」の人だけは、役職を組織名として表示しグループ側には載せない(buildGroups) */
async function loadOrgData() {
  const { left, right } = splitByCompany(await fetchOrgUsers());
  const [leftMaps, rightMaps] = await Promise.all([fetchGroupLabelMap(LEFT_GROUPS), fetchGroupLabelMap(YUMESUMIKA_GROUPS)]);
  const manualLeft = MANUAL_MEMBERS.filter(m => m.column === 'left').map(manualMemberToUser);
  const manualRight = MANUAL_MEMBERS.filter(m => m.column === 'right').map(manualMemberToUser);
  // メールアドレスの無い手動追加メンバーは、指定した見出し(dept)に表示する。個別指定(DEPARTMENT_OVERRIDES)は追加で効かせる
  const leftDepts = u => {
    const labels = new Set(u.email ? (leftMaps.map[u.email.toLowerCase()] || []) : (u.dept ? [u.dept] : []));
    const ov = DEPARTMENT_OVERRIDES[u.email.toLowerCase()];
    if (ov) labels.add(ov);
    return [...labels];
  };
  const rightDepts = u => (u.email ? (rightMaps.map[u.email.toLowerCase()] || []) : (u.dept ? [u.dept] : []));
  return {
    left: buildGroups([...left, ...manualLeft], PRIORITY_TITLES, { deptsOf: leftDepts, deptOrder: LEFT_GROUP_ORDER }),
    right: buildGroups([...right, ...manualRight], [], { deptsOf: rightDepts, deptOrder: YUMESUMIKA_GROUP_ORDER }),
    failedLeft: leftMaps.failed,
    failedRight: rightMaps.failed
  };
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
