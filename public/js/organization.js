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

/** ゆめすみか社員のメールアドレス(小文字)→所属グループ名のマップを作る。
    6グループを並行取得し、1グループの取得失敗で全体を壊さないようtry/catchする
    (失敗したグループのメンバーはどのグループにも属さない扱いになり、該当者は表示されなくなる=安全側に劣化) */
async function fetchYumesumikaGroupMap() {
  const map = {};
  await Promise.all(YUMESUMIKA_GROUPS.map(async g => {
    try {
      (await fetchGroupMemberEmails(g.groupMail)).forEach(email => { map[email] = g.label; });
    } catch (e) {
      console.error(`「${g.label}」のメンバー取得に失敗しました`, e);
    }
  }));
  return map;
}

// MS365アカウント(メールアドレス)を持たない社員の手動追加リスト(2026-10-05・ユーザー指示)。
// Graph APIには存在しないため、Entra ID取得結果とは別にこの配列を直接buildGroupsへ合流させる。
// email/phoneを持たない項目はrenderColumn側の表示で空欄・「未登録」として扱われる(既存のロジックのまま)。
// 「物流部」は吉村一建設側の部門のため column:'left'(右列=ゆめすみかはMS365グループ判定のため、
// メールアドレスの無いこの方式では右列には乗せられないことに注意)
const MANUAL_MEMBERS = [
  { name: '松岡 謙次', dept: '物流部', phone: '080-4429-6487', column: 'left' },
  { name: '荒井 正義', dept: '物流部', phone: '', column: 'left' }
];

/** MANUAL_MEMBERSの1件を、buildGroups/renderColumnが期待する形(email/title付き)に変換する */
function manualMemberToUser(m) {
  return { name: m.name, email: '', dept: m.dept, title: '', phone: m.phone || '' };
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

// ---- ローマ字を五十音(あいうえお)順に並べるための簡易コラレータ(2026-09-17追加) ----
// ユーザー指示: 「根本的にローマ字順(アルファベット順)になっている。あいうえお順にしてほしい」
// 例: alphabet順だと Chiba < Higashi < Kotani だが、五十音順は こ(Kotani) < ち(Chiba) < ひ(Higashi)
// のように行(あかさたな…)→段(あいうえお)の順で決まるため、単純な文字コード比較では実現できない。
// ローマ字を1モーラ(拍)ずつ行・段に分解し、行→段→清濁の順で比較する
const ROW_OF = { '': 0, k: 1, g: 1, s: 2, z: 2, j: 2, t: 3, d: 3, n: 4, h: 5, f: 5, b: 5, p: 5, m: 6, y: 7, r: 8, w: 9 };
const VOICED_OF = { g: 1, z: 1, j: 1, d: 1, b: 1, p: 2 }; // 未指定(清音)は0
const VOWEL_IDX = { a: 0, i: 1, u: 2, e: 3, o: 4 };
// 拗音(きゃ等)は行の「い段」と「う段」の間に来る(き<きゃ<きゅ<きょ<く)よう、い段(1)〜う段(2)の間の値にする
const YOUON_VOWEL = { a: 1.1, u: 1.2, o: 1.3 };
const YOUON = {
  kya: ['k', 'a'], kyu: ['k', 'u'], kyo: ['k', 'o'],
  sha: ['s', 'a'], shu: ['s', 'u'], sho: ['s', 'o'],
  cha: ['t', 'a'], chu: ['t', 'u'], cho: ['t', 'o'],
  nya: ['n', 'a'], nyu: ['n', 'u'], nyo: ['n', 'o'],
  hya: ['h', 'a'], hyu: ['h', 'u'], hyo: ['h', 'o'],
  mya: ['m', 'a'], myu: ['m', 'u'], myo: ['m', 'o'],
  rya: ['r', 'a'], ryu: ['r', 'u'], ryo: ['r', 'o'],
  gya: ['g', 'a'], gyu: ['g', 'u'], gyo: ['g', 'o'],
  bya: ['b', 'a'], byu: ['b', 'u'], byo: ['b', 'o'],
  pya: ['p', 'a'], pyu: ['p', 'u'], pyo: ['p', 'o']
};

/** ローマ字1モーラを { row(行), vowel(段。拗音は小数), voiced(清濁: 0=清音/1=濁音/2=半濁音) } の
    配列に分解する(姓の読みの近似のため、完璧な仮名変換ではなく実用上妥当な範囲の近似) */
function tokenizeMora(s) {
  const tokens = [];
  const isVowel = c => 'aiueo'.includes(c);
  let i = 0;
  while (i < s.length) {
    // 促音(っ): 子音の連続(same文字が2つ)→ 全ての行より前に来る小さな一拍として扱う
    if (i + 1 < s.length && s[i] === s[i + 1] && !isVowel(s[i]) && s[i] !== 'n') {
      tokens.push({ row: -1, vowel: -1, voiced: 0 });
      i += 1;
      continue;
    }
    // 拗音(きゃ・しゃ・ちゃ 等の3文字パターン)
    const three = s.slice(i, i + 3);
    if (YOUON[three]) {
      const [cons, v] = YOUON[three];
      tokens.push({ row: ROW_OF[cons], vowel: YOUON_VOWEL[v], voiced: VOICED_OF[cons] || 0 });
      i += 3;
      continue;
    }
    // じゃ/じゅ/じょ(2文字+母音)
    const two = s.slice(i, i + 2);
    if (two === 'ja' || two === 'ju' || two === 'jo') {
      tokens.push({ row: ROW_OF.j, vowel: YOUON_VOWEL[two[1]], voiced: 1 });
      i += 2;
      continue;
    }
    // し(shi)・ち(chi)・つ(tsu): 段がローマ字表記とずれる特殊拍
    if (two === 'sh' || two === 'ch' || two === 'ts') {
      const rowKey = two === 'sh' ? 's' : 't';
      const vowel = two === 'ts' ? VOWEL_IDX.u : VOWEL_IDX.i;
      tokens.push({ row: ROW_OF[rowKey], vowel, voiced: 0 });
      i += (two === 'ts' ? 3 : 3); // shi/chi/tsu は常に3文字
      continue;
    }
    const c = s[i];
    if (isVowel(c)) { // 単独母音(あ行)
      tokens.push({ row: 0, vowel: VOWEL_IDX[c], voiced: 0 });
      i += 1;
      continue;
    }
    if (c === 'n') {
      const next = s[i + 1];
      if (next && isVowel(next)) { // な行
        tokens.push({ row: ROW_OF.n, vowel: VOWEL_IDX[next], voiced: 0 });
        i += 2;
      } else { // 撥音(ん)。全ての行より後ろに来る
        tokens.push({ row: 10, vowel: 0, voiced: 0 });
        i += 1;
      }
      continue;
    }
    const next = s[i + 1];
    if (next && isVowel(next) && ROW_OF[c] !== undefined) {
      tokens.push({ row: ROW_OF[c], vowel: VOWEL_IDX[next], voiced: VOICED_OF[c] || 0 });
      i += 2;
      continue;
    }
    i += 1; // 未知のパターンは読み飛ばす(安全側: ソート結果が多少ずれても処理は止めない)
  }
  return tokens;
}

/** モーラ列同士を先頭から順に「行→段→清濁」で比較する(短い方を先にする) */
function compareMoraTokens(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (!a[i]) return -1;
    if (!b[i]) return 1;
    if (a[i].row !== b[i].row) return a[i].row - b[i].row;
    if (a[i].vowel !== b[i].vowel) return a[i].vowel - b[i].vowel;
    if (a[i].voiced !== b[i].voiced) return a[i].voiced - b[i].voiced;
  }
  return 0;
}

/** ローマ字文字列を五十音順に比較する(アルファベット順ではなく、行(あかさたな…)→段(あいうえお)の順) */
function compareRomajiGojuon(a, b) {
  return compareMoraTokens(tokenizeMora(String(a || '').toLowerCase()), tokenizeMora(String(b || '').toLowerCase()));
}

/** 役職優先グループ(PERSON_OVERRIDESの該当者 → priorityTitlesの語順、該当者がいるものだけ)
    → 残りを通常グループ(既定はdepartment属性。DEPARTMENT_OVERRIDESがあればそちらを優先)でグループ化。
    グループが決まらない社員は表示しない。
    options.deptOf(u)/options.deptOrder で通常グループの判定方法・表示順を差し替え可能
    (2026-10-05追加・ゆめすみか側をMS365グループ判定にするため。省略時は従来どおりdepartment属性+五十音順) */
function buildGroups(users, priorityTitles, options) {
  const opts = options || {};
  const deptOf = opts.deptOf || (u => DEPARTMENT_OVERRIDES[u.email.toLowerCase()] || u.dept || null);
  const deptOrder = opts.deptOrder || null;

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
    const dept = deptOf(u);
    if (!dept) return;
    if (!byDept.has(dept)) byDept.set(dept, []);
    byDept.get(dept).push(u);
  });

  const collator = (a, b) => compareRomajiGojuon(sortKeyFromEmail(a.email), sortKeyFromEmail(b.email));
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
        <span style="font-size:12px;color:#6b7d8f;white-space:nowrap;flex-shrink:0;min-width:190px">${esc(m.phone || '未登録')}</span>
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
    const yumesumikaGroupMap = await fetchYumesumikaGroupMap();
    const manualLeft = MANUAL_MEMBERS.filter(m => m.column === 'left').map(manualMemberToUser);
    const manualRight = MANUAL_MEMBERS.filter(m => m.column === 'right').map(manualMemberToUser);
    state.left = buildGroups([...left, ...manualLeft], PRIORITY_TITLES);
    state.right = buildGroups([...right, ...manualRight], [], {
      deptOf: u => yumesumikaGroupMap[u.email.toLowerCase()] || null,
      deptOrder: YUMESUMIKA_GROUP_ORDER
    });
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
    const yumesumikaGroupMap = await fetchYumesumikaGroupMap();
    const manualLeft = MANUAL_MEMBERS.filter(m => m.column === 'left').map(manualMemberToUser);
    const manualRight = MANUAL_MEMBERS.filter(m => m.column === 'right').map(manualMemberToUser);
    const newLeft = buildGroups([...left, ...manualLeft], PRIORITY_TITLES);
    const newRight = buildGroups([...right, ...manualRight], [], {
      deptOf: u => yumesumikaGroupMap[u.email.toLowerCase()] || null,
      deptOrder: YUMESUMIKA_GROUP_ORDER
    });
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
