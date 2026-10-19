// 出勤状況ページ(2026-10-17追加。ユーザー指示)。
// jinjerの打刻データをサーバー(src/jinjerAttendance.js)が10分おきに取り込んで保存し、このページは /api/attendance のキャッシュだけを読む
// (画面からjinjerを直接呼ばない)。jinjerの社用メールアドレスとMS365のメールアドレスを突き合わせ、社員名簿と同じ部門(MS365グループ)・
// 同じ並び順・同じ氏名(姓 名)で表示する(2026-10-17・ユーザー指示。部門の組み立ては社員名簿と共用の orgData.js)。
// どの部門にも入らない人(メールアドレス未登録・MS365に無い人など)は、各列の末尾の「その他」にjinjerの氏名(分かればMS365の氏名)で表示する。
// 部門の取得が失敗・遅延しても一覧は止めない(先に部門なしで表示し、取得できたら部門分けに切り替える)。
// 退勤の打刻がある人はグレー+退勤時刻。「退勤済みも表示」を外すと退勤済みは非表示(退勤済みだけの部門は見出しごと隠す)。退勤の打刻をしていない人は出勤中のまま。
// 自動リフレッシュは共通方針(CLAUDE.md ルール11)に準拠: 2分間隔・非表示タブはスキップ・差分があるときだけ差し替え。
'use strict';

const el = id => document.getElementById(id);
const SHOW_LEFT_KEY = 'attendance.showLeft';
let lastSignature = '';
let lastData = null;
let loadSeq = 0; // 手動更新と自動更新が重なったとき、古い応答で新しい表示を上書きしないための番号
let org = null; // 社員名簿と共用の部門情報(loadOrgData の結果)。取得できるまで・失敗時は null(部門なしで表示)
let orgFailed = false; // 部門情報の取得に失敗した(画面に注意書きを出す)
let orgLoadedAt = 0, orgLoading = null;
const ORG_TIMEOUT_MS = 20000; // 部門情報の取得の時間制限(一覧の表示を止めない。P004)
const ORG_REFRESH_MS = 10 * 60 * 1000; // 部門(グループ)の所属は頻繁に変わらないため、取得は10分に1回まで

function formatDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return '';
  const w = '日月火水木金土'[new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getDay()];
  return `${Number(m[1])}年${Number(m[2])}月${Number(m[3])}日(${w})`;
}

function formatTime(isoUtc) {
  const d = new Date(isoUtc);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function getShowLeft() {
  try { return localStorage.getItem(SHOW_LEFT_KEY) !== 'false'; } catch { return true; }
}
function setShowLeft(v) {
  try { localStorage.setItem(SHOW_LEFT_KEY, String(v)); } catch { /* 保存できなくても動作に影響しない */ }
}

/** 社員名簿と共用の部門情報を取得する(Entraのときだけ)。同時に1回だけ・10分に1回まで。失敗しても一覧は止めない */
function ensureOrg() {
  if (Auth.mode !== 'entra') return Promise.resolve();
  if (orgLoading) return orgLoading;
  if (org && Date.now() - orgLoadedAt < ORG_REFRESH_MS) return Promise.resolve();
  orgLoading = withTimeout(loadOrgData(), ORG_TIMEOUT_MS, '部門情報の取得が時間内に完了しませんでした')
    .then(next => { org = next; orgFailed = false; orgLoadedAt = Date.now(); })
    .catch(e => { console.error('部門情報の取得に失敗しました', e); orgFailed = true; })
    .finally(() => { orgLoading = null; });
  return orgLoading;
}

/** 表示する氏名: 部門情報にあればMS365の「姓 名」、なければjinjerの氏名 */
function nameOf(it) {
  const n = org && org.names && org.names[(it.email || '').toLowerCase()];
  return n || it.name || '(氏名不明)';
}

function rowHtml(it, name) {
  const left = !!it.left_at;
  const nameColor = left ? '#9aa7b4' : '#1c2b3a';
  const avatarBg = left ? '#c3ccd6' : '#4a7fc0';
  const status = left
    ? `<span style="font-size:12px;color:#9aa7b4;white-space:nowrap">退勤 ${esc(it.left_at)}</span>`
    : `<span style="font-size:12px;font-weight:700;color:#2e7d4f;white-space:nowrap">出勤中</span>`;
  return `
  <div style="display:flex;align-items:center;gap:12px;padding:10px 20px;border-bottom:1px solid #f2f5f9">
    <div style="width:30px;height:30px;border-radius:50%;background:${avatarBg};color:#ffffff;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0">${esc([...name][0] || '')}</div>
    <span style="font-size:13px;font-weight:700;color:${nameColor};flex:1;min-width:0">${esc(name)}</span>
    <span style="font-size:11px;color:#8a99a8;white-space:nowrap">${esc(it.attended)}〜</span>
    ${status}
  </div>`;
}

/** 1列分(吉村一建設 or ゆめすみか)の見出し付きグループを組み立てる(社員名簿と同じ部門・同じ並び順。純粋な関数)。
    orgGroups: 社員名簿の列(buildGroups の結果 [{ dept, members:[{email,...}] }])か null(部門なし)、
    items: この列の出勤データ。部門に入らなかった人は末尾の「その他」へ(jinjerの氏名順)。
    戻り値: [{ dept, rows:[{ it, name }] }]。メンバーのいない部門は含めない(1人が複数部門なら、それぞれに出る) */
function buildAttendanceGroups(orgGroups, items, names) {
  const byEmail = new Map();
  items.forEach(it => { const e = (it.email || '').toLowerCase(); if (e) byEmail.set(e, it); });
  // メールアドレスを持たない社員(社員名簿の手動追加メンバー=MANUAL_MEMBERS。物流事業係の2名)は、メールではなく氏名で突き合わせる
  // (2026-10-19・ユーザー指示。jinjer側もメールアドレス未登録の人だけが対象。空白の違い(全角・半角・有無)は無視する)
  const normName = s => String(s || '').replace(/[\s　]+/g, '');
  const byName = new Map();
  items.forEach(it => { if (!(it.email || '').trim() && normName(it.name)) byName.set(normName(it.name), it); });
  const nameFor = it => (names && names[(it.email || '').toLowerCase()]) || it.name || '(氏名不明)';
  const placed = new Set();
  const groups = [];
  (orgGroups || []).forEach(g => {
    const itemOf = m => (m.email ? byEmail.get(m.email.toLowerCase()) : byName.get(normName(m.name)));
    const rows = g.members.filter(m => itemOf(m)).map(m => {
      const it = itemOf(m);
      placed.add(it);
      return { it, name: m.name || nameFor(it) };
    });
    if (rows.length) groups.push({ dept: g.dept, rows });
  });
  const others = items.filter(it => !placed.has(it)).map(it => ({ it, name: nameFor(it) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  if (others.length) groups.push({ dept: orgGroups ? 'その他' : '', rows: others });
  return groups;
}

function groupsHtml(groups) {
  if (!groups.length) return '<p style="margin:0;padding:18px 20px;font-size:13px;color:#8a99a8">該当する方はいません</p>';
  return groups.map(g => `
    <div style="border-bottom:8px solid #f7fafd">
      ${g.dept ? `<div style="padding:11px 20px;background:#f7fafd;border-bottom:1px solid #e8edf3"><h4 style="margin:0;font-size:13px;font-weight:700">${esc(g.dept)}</h4></div>` : ''}
      ${g.rows.map(r => rowHtml(r.it, r.name)).join('')}
    </div>`).join('');
}

function render(data) {
  lastData = data;
  const showLeft = el('att-show-left').checked;
  const sig = JSON.stringify([data, showLeft, org, orgFailed]);
  if (sig === lastSignature) return; // 差分がなければ何もしない(自動更新時のちらつき防止)
  lastSignature = sig;

  el('att-title').textContent = `出勤状況(${formatDate(data.date)})`;

  const st = data.sync;
  let status = '';
  if (!data.configured) status = 'jinjerのAPIキーが未設定のため、取り込みは行われていません(サーバーの設定が必要です)。';
  else if (!st) status = 'まだ取り込みが実行されていません(サーバーが10分おきに自動で取り込みます。しばらくしてから開き直してください)。';
  else if (st.ok) status = `最終取り込み: ${formatTime(st.runAt)}`;
  else status = `最終取り込みに失敗しました(${formatTime(st.runAt)}): ${st.message || '原因不明'}` +
    (st.lastSuccessDate === data.date ? '。表示は本日の前回成功分です。' : '。表示が最新でない可能性があります。');
  const orgNotice = orgFailed ? '部門情報を取得できなかったため、部門分けせずに表示しています。'
    : (org && [...org.failedLeft, ...org.failedRight].length) ? `次のグループを取得できませんでした(該当する方が「その他」に出ている可能性があります): ${[...org.failedLeft, ...org.failedRight].join('、')}` : '';
  const statusEl = el('att-status');
  statusEl.textContent = [status, orgNotice].filter(Boolean).join(' ');
  statusEl.style.color = (st && !st.ok) || !data.configured || orgNotice ? '#c05a5a' : '#6b7d8f';

  const loaded = st && st.lastSuccessDate === data.date;
  const working = data.items.filter(i => !i.left_at).length;
  const left = data.items.length - working;
  el('att-summary').textContent = data.items.length || loaded ? `出勤中 ${working}名 / 退勤済み ${left}名` : '';

  // 本日分がまだ取り込まれていない(日付が変わった直後・取り込み失敗が続いたとき)は「出勤者なし」と誤解させない
  if (!data.items.length && !loaded) {
    const msg = '<p style="margin:0;padding:18px 20px;font-size:13px;color:#8a99a8">本日分はまだ取り込まれていません(サーバーが10分おきに自動で取り込みます。しばらくしてから「最新の情報に更新」を押してください)</p>';
    el('att-left').innerHTML = msg;
    el('att-right').innerHTML = '';
    return;
  }

  const visible = data.items.filter(i => showLeft || !i.left_at);
  const isYume = i => (i.email || '').toLowerCase().endsWith('@yumesumika.com');
  // 列の振り分けは社員名簿と同じ(個別指定 PERSON_OVERRIDES があればそれを優先)。部門情報がなければメールアドレスのドメインで分ける
  const person = i => PERSON_OVERRIDES[(i.email || '').toLowerCase()];
  const isRight = i => (person(i) ? person(i).column === 'right' : isYume(i));
  const names = org && org.names;
  el('att-left').innerHTML = groupsHtml(buildAttendanceGroups(org && org.left, visible.filter(i => !isRight(i)), names));
  el('att-right').innerHTML = groupsHtml(buildAttendanceGroups(org && org.right, visible.filter(isRight), names));
}

/** 先に(部門情報がなければ部門なしで)描画し、部門情報の取得は裏で行う(Graphが遅くても一覧が出る)。取得できたら再描画して部門分けにする */
function applyData(data) {
  render(data);
  ensureOrg()
    .then(() => { if (lastData === data) render(data); })
    .catch(e => console.error('部門情報の取得に失敗しました', e));
}

async function load({ silent } = {}) {
  const seq = ++loadSeq;
  try {
    const data = await api('/api/attendance');
    if (seq === loadSeq) applyData(data);
  } catch (e) {
    console.error(e);
    if (!silent) {
      el('att-left').innerHTML = `<p style="margin:0;padding:18px 20px;font-size:13px;color:#c05a5a">読み込みに失敗しました: ${esc(e.message || String(e))}</p>`;
    }
  }
}

/** 「最新の情報に更新」: サーバーが保存している内容を読み直すだけ(jinjerのAPIは呼ばない。jinjerからの取り込みは、サーバーが10分おきに自動で行う。2026-10-19・ユーザー指示) */
async function reloadFromServer() {
  const btn = el('att-sync');
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = '更新中…';
  const seq = ++loadSeq;
  try {
    const data = await api('/api/attendance');
    if (seq === loadSeq) applyData(data);
  } catch (e) {
    el('att-status').textContent = `更新できませんでした: ${e.message || e}`;
    el('att-status').style.color = '#c05a5a';
    lastSignature = ''; // 次の自動更新で正しい状態表示に戻す
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

(async function init() {
  try {
    await Auth.init();
    el('att-show-left').checked = getShowLeft();
    el('att-show-left').addEventListener('change', () => { setShowLeft(el('att-show-left').checked); if (lastData) render(lastData); });
    el('att-sync').addEventListener('click', reloadFromServer);
    setInterval(() => { if (!document.hidden) load({ silent: true }); }, 2 * 60 * 1000); // 初回表示の成否に関わらず自動更新を登録する
    await load();
  } catch (e) {
    console.error(e);
    el('att-left').innerHTML =
      `<p style="margin:0;padding:18px 20px;font-size:13px;color:#c05a5a">読み込みに失敗しました: ${esc(e.message || e)}</p>`;
  }
})();
