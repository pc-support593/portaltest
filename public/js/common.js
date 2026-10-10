// 共通ユーティリティ(全画面で読み込む)
'use strict';

/** HTMLエスケープ(動的テキストは必ずこれを通す) */
function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** fetch ラッパー。失敗時は Error(message = サーバーのerror文言) を投げる。
    entraモードではポータルAPI用アクセストークンを自動付与(/api/config は認証不要のため除外) */
async function api(path, options) {
  const headers = { 'Content-Type': 'application/json' };
  if (typeof Auth !== 'undefined' && Auth.mode === 'entra' && path !== '/api/config') {
    const token = await Auth.getApiToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(path, {
    method: (options && options.method) || 'GET',
    headers,
    body: options && options.body != null ? JSON.stringify(options.body) : undefined
  });
  let data = null;
  try { data = await res.json(); } catch { /* 空レスポンス */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `HTTP ${res.status}`);
    err.data = data; // サーバーが errors 配列等の詳細情報を返す場合に呼び出し元で参照できるようにする(2026-10-02追加)
    throw err;
  }
  return data;
}

/** ヘッダーのユーザー表示(data-me属性の要素)を埋める */
function fillMe(user) {
  document.querySelectorAll('[data-me="name"]').forEach(el => { el.textContent = user.name; });
  document.querySelectorAll('[data-me="dept"]').forEach(el => { el.textContent = user.dept; });
  document.querySelectorAll('[data-me="avatar"]').forEach(el => { el.textContent = user.name.charAt(0); });
}

/** 名字(スペース区切りの先頭) */
function surname(name) {
  return String(name || '').split(/[ 　]/)[0];
}

/** Graphのユーザーオブジェクトから表示用の電話番号一覧を組み立てる(2026-10-05追加・ユーザー指示)。
    基本は携帯電話(mobilePhone。単一の文字列項目)を表示し、事業所の電話(businessPhones。配列・
    複数件あり得る)が登録されていれば2件目以降として追加する(どちらか一方のフォールバックではなく、
    両方登録されていれば両方とも表示する)。organization.js・todayAttendance.jsで共用 */
function phoneListOf(u) {
  const list = [];
  if (u.mobilePhone) list.push(u.mobilePhone);
  if (Array.isArray(u.businessPhones)) list.push(...u.businessPhones.filter(Boolean));
  return list;
}

/** ISO 8601(YYYY-MM-DD)→ 表示用 'M/D'。ISO以外はそのまま返す */
function fmtMD(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  return m ? `${Number(m[2])}/${Number(m[3])}` : String(iso || '');
}

/** 社内メンバー検索(会議室予約・個人スケジュールの参加者選択で共用)。
    devモードはダミー名簿(/api/users)、entraモードは Graph /users(委任: User.Read.All。
    2026-08-22に User.ReadBasic.All から引き上げ済み。部署(department)まで取得できる) */
async function searchMembers(q) {
  if (Auth.mode !== 'entra') return api(`/api/users?q=${encodeURIComponent(q)}`);

  const token = await Auth.getGraphToken(['User.Read.All']);
  // $search はプロパティ単位でクォートし OR で連結する(Graphの仕様。ConsistencyLevel: eventual が必須)
  const search = `"displayName:${q}" OR "mail:${q}"`;
  // 社内ポータル対象の2ドメイン(yoshimuraichi.com/yumesumika.com)以外のアカウント(他ドメイン・外部ゲスト等)は除外する
  // (ユーザー指示 2026-09-07)。endsWith を使う$filterは advanced query 扱いのため $count=true が必須
  const domainFilter = "(endsWith(mail,'@yoshimuraichi.com') or endsWith(mail,'@yumesumika.com'))";
  const url = 'https://graph.microsoft.com/v1.0/users' +
    `?$search=${encodeURIComponent(search)}&$filter=${encodeURIComponent(domainFilter)}` +
    '&$count=true&$select=displayName,mail,userPrincipalName,department&$top=5';
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, ConsistencyLevel: 'eventual' }
  });
  if (!res.ok) throw new Error(`メンバー検索に失敗しました(HTTP ${res.status})`);
  const data = await res.json();
  return (data.value || []).map(u => ({
    name: u.displayName || '(名前未設定)',
    dept: u.department || '',
    email: u.mail || u.userPrincipalName || ''
  }));
}

/** ヘッダー社内検索のページ検索対象(2026-09-07追加。新しい画面を追加したらここにも追記する) */
const PORTAL_PAGES = [
  { title: 'ホーム', url: 'index.html', keywords: ['ホーム', 'トップ', 'ポータル', '社内規程', '就業規則', 'クイックリンク', '業務システムリンク'] },
  { title: '会議室予約(ゆめすみか展示場)', url: 'rooms.html', keywords: ['会議室', '予約', 'ゆめすみか', '展示場'] },
  { title: '会議室予約(吉村一建設会議室)', url: 'rooms.html?view=yoshimura', keywords: ['会議室', '予約', '吉村一建設', 'アネックスプラザ', 'ゲストプラザ', '本社', '社長室', '会長室'] },
  { title: '予約(社用車)', url: 'rooms.html?view=cars', keywords: ['社用車', '車', '予約', '車両'] },
  { title: 'スケジュール', url: 'schedule.html', keywords: ['スケジュール', '予定', 'カレンダー', '会議室の予約状況'] },
  { title: '吉村一建設スタッフ予定', url: 'yoshimuraichi-schedule.html', keywords: ['吉村一建設', 'スタッフ', '予定', '部署', '会議室'] },
  { title: 'ゆめすみかスタッフ予定', url: 'yumesumika-schedule.html', keywords: ['ゆめすみか', 'スタッフ', '予定', '展示場', 'タイムライン'] },
  { title: '社員名簿', url: 'organization.html', keywords: ['社員名簿', '組織図', '総務部', '部門', '組織'] },
  { title: '本日の出勤者', url: 'today-attendance.html', keywords: ['出勤', '班', 'A班', 'B班', 'C班', '当番'] },
  // 「本日のお休み」(today-off.html)は一時停止中のため検索対象から外している(2026-10-07。再開時は ENABLE_DAYOFFS=true とあわせて戻す):
  // { title: '本日のお休み', url: 'today-off.html', keywords: ['休み', '休暇', '有給', '有休', '半休', '休日', '不在', 'jinjer', 'ジンジャー'] },
  { title: '年間カレンダー', url: 'work-calendar.html', keywords: ['年間カレンダー', '出社日', '定休日', '振替休日', '班'] },
  { title: '社内報', url: 'igrace-login.html', keywords: ['社内報', 'ニュース', 'GRACE', 'igrace'] },
  { title: '管理画面', url: 'admin.html', keywords: ['管理', 'admin', 'お知らせ編集'] }
];

// ---- 出社日(A/B/C班ローテーション)年間カレンダー関連の共通ヘルパー(2026-10-02追加) ----

// department属性が実態と異なる例外用(organization.jsのDEPARTMENT_OVERRIDESと同じ仕組み)。
// 現時点では該当者なしのため空。メールアドレス(小文字)→部門名の上書き
const CALENDAR_GROUP_OVERRIDES = {};

/** 定休グループ(sunday_off=日曜定休 / wednesday_off=水曜定休)を判定する(ユーザー指示 2026-10-02)。
    既定: @yoshimuraichi.com→日曜定休、@yumesumika.com→水曜定休。
    例外: @yoshimuraichi.comのうち不動産部だけ水曜定休 */
function calendarGroupFor(email, department) {
  const domain = String(email || '').split('@')[1]?.toLowerCase() || '';
  if (domain === 'yumesumika.com') return 'wednesday_off';
  if (domain === 'yoshimuraichi.com') {
    const dept = CALENDAR_GROUP_OVERRIDES[String(email || '').toLowerCase()] || department;
    return dept === '不動産部' ? 'wednesday_off' : 'sunday_off';
  }
  return null;
}

/** A/B/C班ローテーションの対象かどうか(ユーザー確認 2026-10-02: 吉村一建設グループ全体
    <本体・㈱来夢エンジニア・㈱ライトウエスト、すべて@yoshimuraichi.com>が対象。
    ㈱ゆめすみか<@yumesumika.com>は対象外) */
function isShiftTeamEligible(email) {
  return String(email || '').toLowerCase().endsWith('@yoshimuraichi.com');
}

/** ポータル内ページ検索(タイトル・キーワードの部分一致) */
function searchPortalPages(q) {
  const query = String(q || '').trim().toLowerCase();
  if (!query) return [];
  return PORTAL_PAGES.filter(p =>
    p.title.toLowerCase().includes(query) || p.keywords.some(k => k.toLowerCase().includes(query))
  );
}


// ---- 全ページ共通のヘッダー: 「吉村一建設 ポータル」=TOPへのリンク + ナビメニュー(2026-10-08・ユーザー指示) ----
// 各ページのヘッダーのマークアップは個別に持つため、ここで一括して組み立てる(メニューの定義はこの1か所だけ)。
// 並び・追加・削除はこの PORTAL_NAV を直す。管理(admin)は Portal.Admin ロールの人にだけ表示する(showPortalAdminLink)。
const PORTAL_NAV = [
  { label: 'ホーム', href: 'index.html' },
  { label: '社員名簿', href: 'organization.html' },
  { label: '年間カレンダー', href: 'work-calendar.html' },
  { label: 'スケジュール', href: 'schedule.html' },
  // スタッフ予定(2026-10-08・ユーザー指示)。既定の遷移先は吉村一建設。ゆめすみかのアカウントの人は、サインイン後に
  // yumesumika-schedule.html へ切り替わる(showPortalAdminLink内)。2つのページはどちらでも、このメニューを強調表示する
  { label: 'スタッフ予定', href: 'yoshimuraichi-schedule.html', also: ['yumesumika-schedule.html'], id: 'staff-nav-link' },
  { label: '社内報', href: 'igrace-login.html', external: true },
  { label: '管理', href: 'admin.html', id: 'admin-nav-link', hidden: true }
];

function setupPortalHeader() {
  const header = document.querySelector('header');
  const brand = header && header.firstElementChild;
  if (!brand || brand.querySelector('a.portal-brand')) return;

  // アイコンとタイトルをTOPページへのリンクにする(右側の「｜ ページ名」はリンクにしない)
  const icon = brand.children[0];
  const title = brand.children[1];
  if (icon && title && title.textContent.includes('ポータル')) {
    const a = document.createElement('a');
    a.href = 'index.html';
    a.className = 'portal-brand';
    a.title = 'ポータルのトップへ';
    a.style.cssText = 'display:flex;align-items:center;gap:10px;text-decoration:none;color:inherit';
    brand.insertBefore(a, icon);
    a.appendChild(icon);
    a.appendChild(title);
  }

  let nav = header.querySelector('nav.portal-nav');
  if (!nav) {
    nav = document.createElement('nav');
    nav.className = 'portal-nav';
    nav.style.cssText = 'display:flex;align-items:center;gap:20px;min-width:0;overflow:hidden;margin-left:10px';
    brand.after(nav);
  }
  const current = location.pathname.split('/').pop() || 'index.html';
  nav.innerHTML = PORTAL_NAV.map(item => {
    const active = item.href === current || (item.also || []).includes(current);
    return `<a href="${item.href}"${item.external ? ' target="_blank" rel="noopener"' : ''}${item.id ? ` id="${item.id}"` : ''} class="nav-link${active ? ' active' : ''}"${item.hidden ? ' style="display:none"' : ''}>${item.label}</a>`;
  }).join('');
}

/** 「管理」メニューは Portal.Admin ロールを持つ人にだけ表示する(実際の操作はサーバー側でも強制される) */
function showPortalAdminLink(user) {
  const link = document.getElementById('admin-nav-link');
  if (link && (user.roles || []).includes('Portal.Admin')) link.style.display = '';
  // 「スタッフ予定」メニューは、ご自身の会社のページを開く(@yumesumika.com→ゆめすみか、それ以外→吉村一建設)
  const staffLink = document.getElementById('staff-nav-link');
  if (staffLink) {
    staffLink.href = String(user.email || '').toLowerCase().endsWith('@yumesumika.com')
      ? 'yumesumika-schedule.html' : 'yoshimuraichi-schedule.html';
  }
}

setupPortalHeader();

// ---- 添付ファイル(お知らせ・全社スケジュール。2026-10-08) ----
// ダウンロードはAPIが認証必須(Bearerトークン)のため、通常のリンクでは取得できない。fetchで取得して保存する。

/** 添付ファイルの大きさを読みやすい表記にする(例: 1.2MB / 340KB) */
function fmtFileSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

/** 添付ファイルを認証付きで取得し、ブラウザの保存として開始する。失敗時は alert で理由を示す */
async function downloadAttachment(id, name) {
  try {
    const headers = {};
    if (typeof Auth !== 'undefined' && Auth.mode === 'entra') {
      const token = await Auth.getApiToken();
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    const res = await fetch(`/api/attachments/${encodeURIComponent(id)}/download`, { headers });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { msg = (await res.json()).error || msg; } catch { /* 本文なし */ }
      throw new Error(msg);
    }
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  } catch (e) {
    alert(`ダウンロードできませんでした: ${e.message || e}`);
  }
}

/** 外部呼び出し(Graph等)に時間制限を付ける。ms以内に完了しなければ Error(message) で失敗させる
    (応答が返ってこない呼び出しが、画面の初期化や自動更新を止めないようにするため。P004) */
function withTimeout(promise, ms, message) {
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message || `${ms}ミリ秒以内に完了しませんでした`)), ms); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

/** 表示名から「(吉村一建設)」「(ゆめすみか)」などの会社名の括弧書きを取り除く(全角・半角の括弧に対応。
    社員名簿・スタッフ予定で共通。2026-10-09・ユーザー指示)。括弧書きの前後の空白も整える。
    取り除くと空になる場合(名前が括弧書きだけ)は、元の名前をそのまま返す */
function displayName(name) {
  const original = String(name ?? '');
  if (!/[(（][^)）]*(吉村一建設|ゆめすみか)[^)）]*[)）]/.test(original)) return original; // 該当しない名前は一切変えない(空白も含めて)
  const cleaned = original
    .replace(/\s*[(（][^)）]*(吉村一建設|ゆめすみか)[^)）]*[)）]\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || original;
}


// ---- 並び順(五十音順の代用): 社員名簿・スタッフ予定2ページで共通(2026-10-10。organization.jsから移動) ----
/** 従業員の種類(Entra IDのemployeeType)の「2以降の数字」を、MS365グループ表示内での順位として返す(小さい順。2026-10-10・ユーザー指示)。
    「1」(組織名扱い)・空・数字以外は順位なし=Infinity(順位のある人より後ろ) */
function employeeTypeRank(empType) {
  const s = String(empType ?? '').trim();
  if (!/^\d+$/.test(s)) return Infinity;
  const n = Number(s);
  return n >= 2 ? n : Infinity;
}

/** グループ内のメンバーの並び順: ①従業員の種類の数字(2以降)が小さい順 ②同じ順位(順位なし同士を含む)は五十音順
    (メールアドレスの姓のローマ字)。社員名簿・スタッフ予定2ページで共通。a/bは { empType, email } を持つこと */
function compareMembersByRank(a, b) {
  const ra = employeeTypeRank(a.empType), rb = employeeTypeRank(b.empType);
  if (ra !== rb) return ra < rb ? -1 : 1;
  return compareRomajiGojuon(sortKeyFromEmail(a.email), sortKeyFromEmail(b.email));
}

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

// ---- 吉村一建設の部署ごとのMS365グループ(スタッフ予定・社員名簿で共通。2026-10-10に社員名簿もこのグループ判定へ変更) ----
// 部署ごとのMS365グループ(ユーザー提供・2026-10-08。タブはこの並び順)。メンバーを変えたいときは
// グループのメンバーを変更する(コードの修正は不要)。グループを増やすときはここに1行足す
const YOSHIMURA_STAFF_GROUPS = [
  { id: 'soumu', name: '総務部', groupMail: 'soumu@yoshimuraichi.com' },
  { id: 'fudosan', name: '不動産部', groupMail: 'fudosan@yoshimuraichi.com' },
  { id: 'sekkei_kikaku', name: '設計企画部', groupMail: 'sekkei@yoshimuraichi.com' },
  { id: 'koubai', name: '購買部', groupMail: 'koubai@yoshimuraichi.com' },
  { id: 'customer', name: 'カスタマーサポート室', groupMail: 'customer@yoshimuraichi.com' },
  { id: 'exterior', name: 'エクステリア事業係', groupMail: 'exterior@yoshimuraichi.com' },
  { id: 'logistics', name: '物流事業係', groupMail: 'logistics@yoshimuraichi.com' },
  { id: 'carpenter', name: 'フレミング大工', groupMail: 'carpenter@yoshimuraichi.com' },
  { id: 'kenchiku', name: '建築営業部', groupMail: 'kenchiku@yoshimuraichi.com' },
  { id: 'koumu_1', name: '工務部(本社)', groupMail: 'koumu_1@yoshimuraichi.com' },
  { id: 'koumu_2', name: '工務部(平野)', groupMail: 'koumu_2@yoshimuraichi.com' },
  { id: 'koumu_3', name: '工務部(西宮)', groupMail: 'koumu_3@yoshimuraichi.com' },
  { id: 'reform', name: 'リフォーム部', groupMail: 'renovation@yoshimuraichi.com' }
];
