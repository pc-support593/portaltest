// 共通ユーティリティ(全画面で読み込む)
'use strict';

/** HTMLエスケープ(動的テキストは必ずこれを通す) */
function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** 業務システムリンク・社内規程のタイルの名称を、HTML文字列にして返す。「(」(全角)か「(」(半角)があれば、その直前で改行して2行目に「(…)」を出す(2026-10-28・ユーザー依頼)。
    「(」が先頭にある名称・「(」が無い名称は改行しない。文字は esc でエスケープする */
function tileLabelHtml(label) {
  const s = String(label ?? '');
  const i = s.search(/[(（]/);
  if (i <= 0) return esc(s);
  return `${esc(s.slice(0, i))}<br>${esc(s.slice(i))}`;
}

// ---- 打ち合わせの区分(2026-10-30・ユーザー依頼)。管理画面「打ち合わせの区分」で登録した選択肢を、予定の画面のプルダウンに出し、
//      選んだ区分を Outlook(Exchange)の予定の分類項目(categories)に、名前のまま保存する。ゆめすみか展示場の会議室を選んだ予定・会議室予約で出す ----
let MEETING_KINDS = []; // 登録済みの区分の名前(表示順)
let meetingKindsPromise = null;
const MEETING_KIND_RESOURCE_TYPES = ['yumesumika']; // この会議室・車の種類を選んだときだけ、プルダウンを出す(予定の画面。会議室予約の画面はゆめすみか展示場のページだけ)
/** 区分の一覧を取得して MEETING_KINDS に入れる(1回だけ)。失敗しても画面を止めず、空のまま(=プルダウンを出さない) */
function loadMeetingKinds() {
  if (!meetingKindsPromise) {
    meetingKindsPromise = api('/api/meeting-kinds')
      .then(rows => { MEETING_KINDS = (rows || []).map(r => r.label); })
      .catch(() => { meetingKindsPromise = null; });
  }
  return meetingKindsPromise;
}
/** 予定の分類項目のうち、登録済みの区分に当たる最初の1つ(なければ空) */
function kindOfCategories(categories, kinds) {
  return (categories || []).find(c => kinds.includes(c)) || '';
}
/** 保存する分類項目: もとの分類項目から、登録済みの区分を除き(ほかの分類項目は残す)、選んだ区分を足す */
function categoriesWithKind(existing, kinds, kind) {
  const keep = (existing || []).filter(c => !kinds.includes(c));
  return kind ? [...keep, kind] : keep;
}
/** プルダウンを出すか: 区分が登録されていて、(対象の会議室を選んでいる、または既に区分が付いている) */
function meetingKindVisible(resourceType, currentKind) {
  return MEETING_KINDS.length > 0 && (MEETING_KIND_RESOURCE_TYPES.includes(resourceType) || !!currentKind);
}
/** 「区分」のプルダウン(HTML文字列)。selected が登録済みの区分に無くても、その値は選択肢に残す */
function meetingKindFieldHtml(id, selected) {
  const opts = MEETING_KINDS.includes(selected) || !selected ? MEETING_KINDS : [...MEETING_KINDS, selected];
  return `<label style="display:flex;flex-direction:column;gap:5px">
          <span style="font-size:12px;font-weight:700;color:#6b7d8f">区分(任意)</span>
          <select id="${id}" class="in-input">
            <option value="">選択しない</option>
            ${opts.map(k => `<option value="${esc(k)}" ${k === selected ? 'selected' : ''}>${esc(k)}</option>`).join('')}
          </select>
        </label>`;
}

/** 文字の中の http:// と https:// のURLを、新しいタブで開くリンクにして返す(HTML文字列)。それ以外の文字は esc でエスケープする(2026-10-26・ユーザー依頼)。
    リンクにするのは http・https だけ(javascript: などは対象外)。URLに使える半角の文字だけを拾い(日本語はURLに含めない)、末尾の句読点・閉じ括弧は含めない。
    お知らせ・全社スケジュールの本文、予定の場所に使う。改行は呼び出し側の white-space:pre-wrap で保つ */
function linkify(text) {
  const s = String(text == null ? '' : text);
  const re = /https?:\/\/[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+/g;
  let out = '', last = 0, m;
  while ((m = re.exec(s))) {
    let url = m[0], trail = '';
    const tail = url.match(/[)\]'.,;:!?*]+$/);
    if (tail) { trail = tail[0]; url = url.slice(0, -trail.length); }
    out += esc(s.slice(last, m.index)) + `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer" style="color:#1e5fa8;text-decoration:underline;word-break:break-all">${esc(url)}</a>` + esc(trail);
    last = m.index + m[0].length;
  }
  return out + esc(s.slice(last));
}

/** 文字の中のURL(http・https)の一覧(重複なし・最大 max 件)。予定の本文の会議リンクなどを、カードに出すために使う */
function extractUrls(text, max) {
  const found = [];
  String(text == null ? '' : text).replace(/https?:\/\/[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+/g, u => {
    const url = u.replace(/[)\]'.,;:!?*]+$/, '');
    if (!found.includes(url)) found.push(url);
    return u;
  });
  return found.slice(0, max || 3);
}

/** 予定カードに出す、本文のURLの行(1行に収め、長いURLは「…」で省略。クリックでフルのURLを新しいタブで開く)。URLが無ければ空文字 */
function eventLinksHtml(urls) {
  return (urls || []).map(u => `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer" style="font-size:12px;color:#1e5fa8;text-decoration:underline;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block;max-width:100%">${esc(u)}</a>`).join('');
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

/** 画面に出す名前: MS365の「姓」「名」から、姓→名の順・間に半角スペース1つで作る(2026-10-16・ユーザー指示。社員名簿・スタッフ予定2ページ)。
    姓か名のどちらかが空のときは、表示名(displayName)にする(括弧書きの会社名は従来どおり取り除く) */
function fullNameOf(surname, givenName, displayNameFallback) {
  const sn = String(surname ?? '').trim(), gn = String(givenName ?? '').trim();
  if (sn && gn) return sn + ' ' + gn;
  return displayName(displayNameFallback);
}

/** 日本時間(JST)の日付 'YYYY-MM-DD'。入社日の判定を、サーバー・ブラウザのタイムゾーンに依らず日本の暦で行うため */
function jstDateKey(date) {
  return new Date(date.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** 従業員入社日(Entra IDのemployeeHireDate)がまだ来ていない人か(入社日が日本時間の今日より後)。
    入社日当日から表示する。入社日が空・日付として読めない場合は、これまでどおり表示する(false)。
    社員名簿・スタッフ予定2ページ・社内検索・本日の出勤者で共通(2026-10-13・ユーザー指示。ポータル上の表示だけの話) */
function isBeforeHireDate(hireDate) {
  if (!hireDate) return false;
  const t = new Date(hireDate);
  if (Number.isNaN(t.getTime())) return false;
  return jstDateKey(t) > jstDateKey(new Date());
}

/** ISO 8601(YYYY-MM-DD)→ 表示用 'M/D'。ISO以外はそのまま返す */
function fmtMD(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  return m ? `${Number(m[2])}/${Number(m[3])}` : String(iso || '');
}

/** メンバー検索の入力を、空白(半角・全角)で語に分ける。`"` は検索式を壊すため除く(2026-10-30・ユーザー依頼: 姓・名でも検索) */
function memberSearchTerms(q) {
  return String(q || '').replace(/"/g, ' ').split(/[\s\u3000]+/).filter(Boolean);
}
/** Graph の $search の式: 最初の語を、表示名・姓・名・メールのどれかに当てる(OR)。残りの語は、結果に対して memberMatchesTerms で絞る
    (Graph の $search は、括弧でのグループ化がはっきりしないため、ANDは画面側で行う) */
function memberSearchExpr(term) {
  return ['displayName', 'surname', 'givenName', 'mail'].map(p => `"${p}:${term}"`).join(' OR ');
}
/** Graph のユーザー1件が、すべての語に当たるか(表示名・姓・名・「姓名」・メールの、どこかに含まれる。大文字小文字は区別しない) */
function memberMatchesTerms(u, terms) {
  const hay = [u.displayName, u.surname, u.givenName, `${u.surname || ''}${u.givenName || ''}`, u.mail, u.userPrincipalName].join(' ').toLowerCase();
  return terms.every(t => hay.includes(t.toLowerCase()));
}

/** 社内メンバー検索(会議室予約・個人スケジュールの参加者選択で共用)。
    devモードはダミー名簿(/api/users)、entraモードは Graph /users(委任: User.Read.All。
    2026-08-22に User.ReadBasic.All から引き上げ済み。部署(department)まで取得できる) */
async function searchMembers(q) {
  if (Auth.mode !== 'entra') return api(`/api/users?q=${encodeURIComponent(q)}`);

  const token = await Auth.getGraphToken(['User.Read.All']);
  const terms = memberSearchTerms(q);
  if (!terms.length) return [];
  // $search はプロパティ単位でクォートし OR で連結する(Graphの仕様。ConsistencyLevel: eventual が必須)。
  // 表示名・姓・名・メールのどれかに、最初の語が当たる人を探し、2語目以降は画面側で絞る(「山田 太郎」でも「山田」でも「太郎」でも見つかる)
  const search = memberSearchExpr(terms[0]);
  // 社内ポータル対象の2ドメイン(yoshimuraichi.com/yumesumika.com)以外のアカウント(他ドメイン・外部ゲスト等)は除外する
  // (ユーザー指示 2026-09-07)。endsWith を使う$filterは advanced query 扱いのため $count=true が必須
  const domainFilter = "(endsWith(mail,'@yoshimuraichi.com') or endsWith(mail,'@yumesumika.com'))";
  const url = 'https://graph.microsoft.com/v1.0/users' +
    `?$search=${encodeURIComponent(search)}&$filter=${encodeURIComponent(domainFilter)}` +
    `&$count=true&$select=displayName,surname,givenName,mail,userPrincipalName,department,employeeHireDate&$top=${terms.length > 1 ? 25 : 5}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, ConsistencyLevel: 'eventual' }
  });
  if (!res.ok) throw new Error(`メンバー検索に失敗しました(HTTP ${res.status})`);
  const data = await res.json();
  return (data.value || []).filter(u => !isBeforeHireDate(u.employeeHireDate) && memberMatchesTerms(u, terms)).slice(0, 5).map(u => ({ // 入社日前の人は出さない。2語目以降にも当たる人だけ
    name: fullNameOf(u.surname, u.givenName, u.displayName) || '(名前未設定)', // 「姓 名」(空なら表示名)。検索は、表示名・姓・名・メールで行う
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
  { title: '組織図', url: 'organization-chart.html', desktopOnly: true, keywords: ['組織図', '組織', '役職', '部長', '課長', '係長', '主任', '部門', '会長', '社長', '専務'] },
  { title: '出勤状況', url: 'attendance.html', feature: 'attendance', keywords: ['出勤', '退勤', '打刻', '出勤状況', '誰が出勤', 'jinjer', 'ジンジャー'] },
  { title: '本日の出勤者', url: 'today-attendance.html', keywords: ['出勤', '班', 'A班', 'B班', 'C班', '当番'] },
  // 「本日のお休み」(today-off.html)は一時停止中のため検索対象から外している(2026-10-07。再開時は ENABLE_DAYOFFS=true とあわせて戻す):
  // { title: '本日のお休み', url: 'today-off.html', keywords: ['休み', '休暇', '有給', '有休', '半休', '休日', '不在', 'jinjer', 'ジンジャー'] },
  { title: '年間カレンダー', url: 'work-calendar.html', keywords: ['年間カレンダー', '出社日', '定休日', '振替休日', '班'] },
  { title: 'システム案内(案B)', url: 'system-guide-b.html', keywords: ['システム', 'IT', 'PC', 'ネットワーク', 'Wi-Fi', 'VPN', 'MS365', 'パスワード', 'jinjer', 'ジンジャー', '困った', 'ヘルプ'] },
  { title: 'システム案内(案C)', url: 'system-guide-c.html', keywords: ['システム', 'IT', 'PC', 'ネットワーク', 'Wi-Fi', 'VPN', 'MS365', 'パスワード', 'jinjer', 'ジンジャー', '困った', 'ヘルプ'] },
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
  const e = String(email || '').toLowerCase();
  return e.endsWith('@yoshimuraichi.com') || SHIFT_TEAM_EXTRA_EMAILS.includes(e);
}

/** 当番表・班の臨時交代の対象に、@yoshimuraichi.com 以外から個別に加える人(ユーザー指示 2026-10-20: s-yamanaka@yumesumika.com のみ)。
    メールアドレス(小文字)の完全一致。定休グループは、ドメインの既定(@yumesumika.com=水曜定休)のまま(calendarGroupFor) */
const SHIFT_TEAM_EXTRA_EMAILS = ['s-yamanaka@yumesumika.com'];

/** ポータル内ページ検索(タイトル・キーワードの部分一致) */
function searchPortalPages(q) {
  const query = String(q || '').trim().toLowerCase();
  if (!query) return [];
  const features = (typeof Auth !== 'undefined' && Auth.config && Auth.config.features) || {};
  const mobile = typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(max-width: 760px)').matches; // スマホ幅では、desktopOnly のページ(組織図)を検索結果に出さない
  return PORTAL_PAGES.filter(p => !(p.desktopOnly && mobile)).filter(p => !p.feature || features[p.feature]).filter(p => // feature付きのページは、そのサーバーで有効なときだけ(整理案F)
    p.title.toLowerCase().includes(query) || p.keywords.some(k => k.toLowerCase().includes(query))
  );
}


// ---- 全ページ共通のヘッダー: 「吉村一建設/ゆめすみか ポータル」(2026-10-14に名称変更)=TOPへのリンク + ナビメニュー(2026-10-08・ユーザー指示) ----
// 各ページのヘッダーのマークアップは個別に持つため、ここで一括して組み立てる(メニューの定義はこの1か所だけ)。
// 並び・追加・削除はこの PORTAL_NAV を直す。管理(admin)は右上のユーザー名のメニューにあり、Portal.Admin ロールの人にだけ表示する(showPortalAdminLink)。
const PORTAL_NAV = [
  { label: 'ホーム', href: 'index.html' },
  { label: '社員名簿', href: 'organization.html' },
  { label: '組織図', href: 'organization-chart.html', desktopOnly: true }, // desktopOnly: スマホ幅(☰メニュー・ホームの検索)では出さない(2026-10-26・ユーザー指示。組織図はスマホでは使わない)
  { label: '年間カレンダー', href: 'work-calendar.html' },
  { label: 'スケジュール', href: 'schedule.html' },
  // スタッフ予定(2026-10-08・ユーザー指示)。既定の遷移先は吉村一建設。ゆめすみかのアカウントの人は、サインイン後に
  // yumesumika-schedule.html へ切り替わる(showPortalAdminLink内)。2つのページはどちらでも、このメニューを強調表示する
  { label: 'スタッフ予定', href: 'yoshimuraichi-schedule.html', also: ['yumesumika-schedule.html'], id: 'staff-nav-link' },
  // システム案内(2026-10-19・ユーザー依頼): 案B(記事型)と案C(外部リンク型)の枠組みを、テスト環境で見比べるための仮のメニュー。案が決まったら1つに統合する
  { label: 'システム案内B', href: 'system-guide-b.html' },
  { label: 'システム案内C', href: 'system-guide-c.html' },
  { label: '社内報', href: 'igrace-login.html', external: true }
  // 「管理」は、右上のユーザー名のメニュー(setupUserMenu)の中に移した(2026-10-11・ユーザー指示)
];

/** 右上のユーザー名(アイコン+名前)をクリックするとメニューを開く。中身は「管理」(管理者のみ)と「ログアウト」。
    ログアウトは各ページのヘッダーにある #logout-link をそのままメニューへ移す(auth.jsが有効化・クリック処理をする)。
    devモードではログアウトは非表示のまま。開ける項目が無い場合は開かない(2026-10-11・ユーザー指示。全ページ共通) */
function setupUserMenu(header) {
  const avatar = header.querySelector('[data-me="avatar"]');
  const box = avatar && avatar.parentElement;
  if (!box || box.classList.contains('portal-user')) return;

  if (!document.getElementById('portal-user-menu-style')) {
    const st = document.createElement('style');
    st.id = 'portal-user-menu-style';
    st.textContent = '.portal-menu-item{display:block;padding:9px 14px;border-radius:7px;font-size:13px;font-weight:500;color:#1c2b3a;text-decoration:none;white-space:nowrap;text-align:left}' +
      '.portal-menu-item:hover{background:#f2f6fb}.portal-user:focus-visible{outline:2px solid #a8bdd6;outline-offset:3px;border-radius:8px}';
    document.head.appendChild(st);
  }

  box.classList.add('portal-user');
  box.setAttribute('role', 'button');
  box.setAttribute('aria-haspopup', 'menu');
  box.setAttribute('aria-expanded', 'false');
  box.tabIndex = 0;
  box.style.position = 'relative';
  box.style.cursor = 'pointer';
  box.style.userSelect = 'none';

  const caret = document.createElement('span');
  caret.textContent = '▾';
  caret.style.cssText = 'font-size:11px;color:#a8bdd6;margin-left:2px';
  box.appendChild(caret);

  const menu = document.createElement('div');
  menu.className = 'portal-user-menu';
  menu.setAttribute('role', 'menu');
  menu.style.cssText = 'display:none;position:absolute;top:calc(100% + 10px);right:0;min-width:160px;background:#ffffff;border-radius:10px;box-shadow:0 8px 24px rgba(15,35,60,0.25);padding:6px;z-index:60;cursor:default;flex-direction:column;gap:2px';

  const admin = document.createElement('a');
  admin.href = 'admin.html';
  admin.id = 'admin-nav-link';
  admin.className = 'portal-menu-item';
  admin.setAttribute('role', 'menuitem');
  admin.textContent = '管理';
  admin.style.display = 'none'; // 管理者にだけ showPortalAdminLink が表示する
  if ((location.pathname.split('/').pop() || '') === 'admin.html') admin.style.cssText += ';font-weight:700;color:#1e5fa8';
  menu.appendChild(admin);

  const logout = document.getElementById('logout-link');
  if (logout) {
    logout.className = 'portal-menu-item';
    logout.setAttribute('role', 'menuitem');
    logout.style.cssText = 'display:none'; // entraモードのときだけ auth.js が表示する
    menu.appendChild(logout);
  }
  box.appendChild(menu);

  const isOpen = () => menu.style.display !== 'none';
  const close = () => { menu.style.display = 'none'; box.setAttribute('aria-expanded', 'false'); };
  const open = () => {
    const hasItem = [...menu.children].some(c => c.style.display !== 'none');
    if (!hasItem) return; // 開ける項目が無い(例: devモードの管理者以外)ときは何もしない
    menu.style.display = 'flex';
    box.setAttribute('aria-expanded', 'true');
  };
  box.addEventListener('click', e => {
    if (menu.contains(e.target)) return; // メニュー内の項目は、そのままリンク・ログアウトの処理へ
    isOpen() ? close() : open();
  });
  box.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); isOpen() ? close() : open(); }
  });
  document.addEventListener('click', e => { if (!box.contains(e.target)) close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
}

/** スマホ幅(760px以下)用の「≡」メニュー(2026-10-14・ユーザー指示。スマホ対応の第1段階)。
    PC用のナビは幅760px以下で隠れるため、同じ項目(PORTAL_NAV)をメニューとして開く。あわせて、スマホでは
    ヘッダーに収まらない「｜ページ名」「ポータルへ戻る」「ユーザー名の文字」を隠すための目印のクラスを付ける
    (隠す・表示するはCSS=portal.cssの幅の指定で行う。PCの表示は変わらない) */
function setupMobileMenu(header) {
  const avatar = header.querySelector('[data-me="avatar"]');
  const userBox = avatar && avatar.parentElement;
  if (!userBox || header.querySelector('.portal-burger')) return;

  if (avatar.nextElementSibling) avatar.nextElementSibling.classList.add('portal-user-text');
  header.querySelectorAll('a').forEach(a => { if (a.textContent.includes('戻る')) a.classList.add('portal-back'); });

  const burger = document.createElement('button');
  burger.type = 'button';
  burger.className = 'portal-burger';
  burger.setAttribute('aria-label', 'メニュー');
  burger.setAttribute('aria-expanded', 'false');
  burger.textContent = '☰';
  userBox.parentElement.insertBefore(burger, userBox);

  const current = location.pathname.split('/').pop() || 'index.html';
  const menu = document.createElement('div');
  menu.className = 'portal-mobile-menu';
  menu.innerHTML = PORTAL_NAV.filter(item => !item.desktopOnly).map(item => {
    const active = item.href === current || (item.also || []).includes(current);
    return '<a href="' + item.href + '"' + (item.external ? ' target="_blank" rel="noopener"' : '') +
      (item.id === 'staff-nav-link' ? ' data-staff-nav="1"' : '') +
      ' class="portal-mobile-link' + (active ? ' active' : '') + '">' + item.label + '</a>';
  }).join('');
  header.appendChild(menu);

  const close = () => { menu.classList.remove('open'); burger.setAttribute('aria-expanded', 'false'); };
  burger.addEventListener('click', e => {
    e.stopPropagation();
    const open = !menu.classList.contains('open');
    menu.classList.toggle('open', open);
    burger.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  menu.addEventListener('click', e => { if (e.target.closest('a')) close(); });
  document.addEventListener('click', e => { if (!menu.contains(e.target) && e.target !== burger) close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
}

function setupPortalHeader() {
  const header = document.querySelector('header');
  // 画面を下にスクロールしてもヘッダーを上部に固定する(2026-10-11・ユーザー指示。全ページ共通)。
  // z-indexは、スタッフ予定の名前列(2)・候補リスト(10)より上、モーダル(100・110)より下
  if (header) { header.style.position = 'sticky'; header.style.top = '0'; header.style.zIndex = '50'; }
  if (header) { setupUserMenu(header); setupMobileMenu(header); }
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
  [...brand.children].forEach(el => { if (!el.classList.contains('portal-brand')) el.classList.add('portal-brand-page'); }); // 「｜ページ名」(スマホでは隠す)

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
  const staffHref = String(user.email || '').toLowerCase().endsWith('@yumesumika.com')
    ? 'yumesumika-schedule.html' : 'yoshimuraichi-schedule.html';
  const staffLink = document.getElementById('staff-nav-link');
  if (staffLink) staffLink.href = staffHref;
  document.querySelectorAll('[data-staff-nav]').forEach(a => { a.href = staffHref; }); // スマホのメニューの「スタッフ予定」も同じ
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
  { id: 'reform', name: 'リフォーム部', groupMail: 'renovation@yoshimuraichi.com' },
  { id: 'raimu', name: '来夢エンジニア', groupMail: 'laimengineer@yoshimuraichi.com' }
];

// ---- 固定メンバー(MS365グループを介さず、メールアドレスを直接指定)の取得: ゆめすみか・吉村一建設の両スタッフ予定ページの「本社」タブで共通 ----
/** 指定したメールアドレスのユーザー情報(表示名)を個別に取得する(MS365グループを介さない
    固定メンバーリスト用。2026-10-02追加。既存のUser.Read.Allで足りるため新規権限は不要)。
    1人ずつtry/catchし、取得に失敗した人はメールアドレスをそのまま表示名にする */
async function fetchStaticMembers(emails) {
  const token = await Auth.getGraphToken(['User.Read.All']);
  const results = await Promise.all(emails.map(async email => {
    try {
      const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(email)}?$select=id,displayName,surname,givenName,mail,employeeType,employeeHireDate`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) throw new Error(await graphErrorMessage(res));
      const u = await res.json();
      return { id: u.id, name: fullNameOf(u.surname, u.givenName, u.displayName) || email, email: u.mail || email, empType: String(u.employeeType || '').trim(), hireDate: u.employeeHireDate || null };
    } catch (e) {
      console.error(`「${email}」のユーザー情報取得に失敗しました`, e);
      return { id: email, name: email, email, empType: '' };
    }
  }));
  return results.filter(m => !isBeforeHireDate(m.hireDate)); // 指定した配列の順に表示する(並べ替えない。ユーザー指示 2026-10-13)。入社日前の人は除く
}

/** ログインしている人が直接入っているMS365グループのメールアドレス(小文字)の集合を返す(スタッフ予定の、最初に開くタブを決めるため。
    2026-10-15・ユーザー指示)。devモード・取得に失敗・5秒以内に返らないときは空の集合(=従来どおりの表示。画面は止めない) */
async function fetchMyGroupMails() {
  if (Auth.mode !== 'entra') return new Set();
  try {
    return await withTimeout((async () => {
      const token = await Auth.getGraphToken(['GroupMember.Read.All']);
      const mails = new Set();
      let url = 'https://graph.microsoft.com/v1.0/me/memberOf/microsoft.graph.group?$select=mail&$top=200';
      while (url) {
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        (data.value || []).forEach(g => { if (g.mail) mails.add(String(g.mail).toLowerCase()); });
        url = data['@odata.nextLink'] || null;
      }
      return mails;
    })(), 5000, '所属グループの取得が時間内に完了しませんでした');
  } catch (e) {
    console.error('所属グループの取得に失敗しました', e);
    return new Set();
  }
}

/** スタッフ予定の最初に開くタブのid: ログインした人が入っているグループ(固定メンバーのタブは自分のメールアドレスが含まれるもの)のうち、
    タブの並び(tabs。1行目→2行目の順)で最も前にあるもの。どれにも当てはまらなければ null(=従来の先頭のタブ) */
async function pickDefaultStaffTab(tabs) {
  const mails = await fetchMyGroupMails();
  const myEmail = String((Auth.me && Auth.me.email) || '').toLowerCase();
  for (const g of tabs) {
    if (g.groupMail && mails.has(g.groupMail.toLowerCase())) return g.id;
    if (g.members && myEmail && g.members.some(e => e.toLowerCase() === myEmail)) return g.id;
  }
  return null;
}
