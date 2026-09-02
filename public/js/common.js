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
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
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
  const url = 'https://graph.microsoft.com/v1.0/users' +
    `?$search=${encodeURIComponent(search)}&$select=displayName,mail,userPrincipalName,department&$top=5`;
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

/** 指定部門(department)に所属するメンバー一覧を取得する(組織図用。2026-08-22追加)。
    entraモードのみ(devモードは空配列)。委任: User.Read.All */
async function fetchDepartmentMembers(department) {
  if (Auth.mode !== 'entra') return [];
  const token = await Auth.getGraphToken(['User.Read.All']);
  const filter = `department eq '${String(department).replace(/'/g, "''")}'`;
  const url = 'https://graph.microsoft.com/v1.0/users' +
    `?$filter=${encodeURIComponent(filter)}` +
    '&$select=id,displayName,mail,businessPhones,mobilePhone,department' +
    '&$count=true&$orderby=displayName&$top=200';
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, ConsistencyLevel: 'eventual' }
  });
  if (!res.ok) throw new Error(`組織情報の取得に失敗しました(HTTP ${res.status})`);
  const data = await res.json();
  return (data.value || []).map(u => ({
    name: u.displayName || '(名前未設定)',
    email: u.mail || '',
    // 内線ではなく電話番号を表示する方針(ユーザー指示 2026-08-22)。businessPhonesが空ならmobilePhoneで代替
    phone: (u.businessPhones && u.businessPhones[0]) || u.mobilePhone || ''
  }));
}
