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
  { label: '会議室予約', href: 'schedule.html' }, // 2026-10-09・ユーザー指示でrooms.htmlからschedule.htmlへ変更(「スケジュール」と同じ遷移先)
  { label: 'スケジュール', href: 'schedule.html', also: ['yumesumika-schedule.html'] },
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
}

setupPortalHeader();

// ---- 添付ファイル(お知らせ・全社スケジュール。2026-10-09) ----
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
