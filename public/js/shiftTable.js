// 月間の休み表ページ(2026-11-04追加。ユーザー指示)。出勤以外(休日・休暇・半休・時間休)を、社員×日の表で出す。振休は文字色を変える。
// サーバー(src/jinjerShift.js)が jinjer の勤務予定・休暇から作った /api/shift-table だけを読む(画面からjinjerを直接呼ばない)。
// 氏名は名字だけ。部門・並び順・列(吉村一建設/ゆめすみか)は社員名簿と同じ(orgData.js の loadOrgData を共用。出勤状況と同じ作り)。
// 部門の取得が失敗・遅延しても表は止めない(先に部門なしで表示し、取得できたら部門分けに切り替える)。
// 自動リフレッシュは共通方針(CLAUDE.md ルール11)に準拠: 5分間隔・非表示タブはスキップ・差分があるときだけ差し替え。
'use strict';

const el = id => document.getElementById(id);
let month = new URLSearchParams(location.search).get('month') || ''; // 空=現在の月(サーバーが決める)
let lastSignature = '';
let lastData = null;
let loadSeq = 0;
let org = null, orgFailed = false, orgLoadedAt = 0, orgLoading = null;
const ORG_TIMEOUT_MS = 20000;
const ORG_REFRESH_MS = 10 * 60 * 1000;

function shiftMonth(m, n) {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(Date.UTC(y, mo - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function surname(name) {
  return String(name || '').trim().split(/[\s　]+/)[0] || '(氏名不明)';
}

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

/** 1列分(吉村一建設 or ゆめすみか)の、部門ごとのグループを作る(社員名簿と同じ部門・並び順。純粋な関数)。
    orgGroups: 社員名簿の列 [{ dept, members:[{email,name}] }] か null(部門なし)、people: この列の人(サーバーの people)。
    メールアドレスのないメンバー(手動追加)は氏名(空白の違いを無視)で突き合わせる。部門に入らない人は、休暇がある人だけ「その他」へ(退職者などが並ばないように)。
    戻り値: [{ dept, rows:[{ p, name }] }] */
function buildShiftGroups(orgGroups, people) {
  const normName = s => String(s || '').replace(/[\s　]+/g, '');
  const byEmail = new Map(), byName = new Map();
  people.forEach(p => { if (p.email) byEmail.set(p.email.toLowerCase(), p); else if (normName(p.name)) byName.set(normName(p.name), p); });
  if (!orgGroups) return people.length ? [{ dept: '', rows: people.map(p => ({ p, name: surname(p.name) })) }] : [];
  const placed = new Set();
  const groups = [];
  orgGroups.forEach(g => {
    const rows = [];
    g.members.forEach(m => {
      const p = m.email ? byEmail.get(m.email.toLowerCase()) : byName.get(normName(m.name));
      if (p) { placed.add(p); rows.push({ p, name: surname(m.name || p.name) }); }
    });
    if (rows.length) groups.push({ dept: g.dept, rows });
  });
  const others = people.filter(p => !placed.has(p) && Object.values(p.cells).some(c => c.t === 'leave'))
    .map(p => ({ p, name: surname(p.name) }));
  if (others.length) groups.push({ dept: 'その他', rows: others });
  return groups;
}

function cellHtml(c, date, today) {
  const base = 'text-align:center;font-size:11px;white-space:nowrap;padding:5px 2px;border-bottom:1px solid #f2f5f9;border-left:1px solid #f2f5f9';
  const bgToday = date === today ? 'box-shadow:inset 0 0 0 1px #9cc2ea;' : '';
  if (!c) return `<td style="${base};${bgToday}"></td>`;
  const style = c.t === 'holiday' ? 'background:#eef1f5;color:#6b7d8f'
    : c.furi ? 'background:#f3eafa;color:#7b3fa0;font-weight:700'
    : 'background:#fff4e0;color:#b26a00;font-weight:700';
  return `<td style="${base};${bgToday}${style}" title="${esc(c.label)}${c.pending ? '(申請中)' : ''}">${esc(c.label)}${c.pending ? '※' : ''}</td>`;
}

function tableHtml(data, groups) {
  const [y, m] = data.month.split('-').map(Number);
  const dates = Array.from({ length: data.days }, (_, i) => `${data.month}-${String(i + 1).padStart(2, '0')}`);
  const nameCol = 'position:sticky;left:0;z-index:1;background:#ffffff;min-width:84px;max-width:110px;padding:5px 10px;font-size:12px;font-weight:700;color:#1c2b3a;white-space:nowrap;border-bottom:1px solid #f2f5f9;border-right:1px solid #e1e8f0';
  const head = dates.map((date, i) => {
    const dow = new Date(y, m - 1, i + 1).getDay();
    const color = dow === 0 ? '#c05a5a' : dow === 6 ? '#2e6fc0' : '#4a5b6c';
    const bg = date === data.today ? '#e3effb' : '#f7fafd';
    return `<th style="position:sticky;top:0;z-index:2;background:${bg};color:${color};font-size:11px;font-weight:700;padding:4px 2px;min-width:40px;border-bottom:1px solid #e8edf3;border-left:1px solid #f2f5f9;line-height:1.3">${i + 1}<br>${'日月火水木金土'[dow]}</th>`;
  }).join('');
  const rows = groups.map(g => {
    const hbg = g.company ? 'background:#1e3a5f;color:#ffffff' : 'background:#f7fafd;border-bottom:1px solid #e8edf3'; // 会社の見出し(濃色)と部門の見出し
    const deptRow = g.dept ? `<tr><td colspan="${data.days + 1}" style="position:sticky;left:0;padding:8px 12px;${hbg};font-size:12px;font-weight:700">${esc(g.dept)}</td></tr>` : '';
    return deptRow + g.rows.map(r => `<tr><td style="${nameCol}">${esc(r.name)}</td>${dates.map(d => cellHtml(r.p.cells[d], d, data.today)).join('')}</tr>`).join('');
  }).join('');
  return `<table style="border-collapse:separate;border-spacing:0;width:max-content;min-width:100%"><thead><tr><th style="position:sticky;top:0;left:0;z-index:3;background:#f7fafd;border-bottom:1px solid #e8edf3;border-right:1px solid #e1e8f0;font-size:11px;color:#6b7d8f;padding:4px 10px;text-align:left">氏名</th>${head}</tr></thead><tbody>${rows}</tbody></table>`;
}

function render(data) {
  lastData = data;
  const sig = JSON.stringify([data, org, orgFailed]);
  if (sig === lastSignature) return; // 差分がなければ何もしない(自動更新時のちらつき防止)
  lastSignature = sig;
  month = data.month;
  const [y, m] = data.month.split('-').map(Number);
  el('st-title').textContent = `月間の休み表(${y}年${m}月)`;
  el('st-next').disabled = data.month >= data.today.slice(0, 7);
  const notes = [];
  if (data.stale) notes.push(`最新の取得に失敗したため、前回取得した内容を表示しています(${data.stale})。`);
  else notes.push(`取得: ${new Date(data.fetchedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`);
  if (orgFailed) notes.push('部門情報を取得できなかったため、部門分けせずに表示しています(部門に入らない方の表示は、休暇のある方に限りません)。');
  else if (org && [...org.failedLeft, ...org.failedRight].length) notes.push(`次のグループを取得できませんでした(該当する方が「その他」に出ている可能性があります): ${[...org.failedLeft, ...org.failedRight].join('、')}`);
  el('st-status').textContent = notes.join(' ');
  el('st-status').style.color = data.stale || orgFailed ? '#c05a5a' : '#6b7d8f';

  const isYume = p => (p.email || '').toLowerCase().endsWith('@yumesumika.com');
  const orgRight = new Set(((org && org.users && org.users.right) || []).map(u => (u.email || '').toLowerCase()).filter(Boolean));
  const personOv = p => PERSON_OVERRIDES[(p.email || '').toLowerCase()];
  const isRight = p => orgRight.has((p.email || '').toLowerCase()) || (personOv(p) ? personOv(p).column === 'right' : isYume(p));
  const sections = [
    { title: '吉村一建設', groups: buildShiftGroups(org && org.left, data.people.filter(p => !isRight(p))) },
    { title: 'ゆめすみか', groups: buildShiftGroups(org && org.right, data.people.filter(isRight)) }
  ].filter(s => s.groups.length);
  if (!sections.length) { el('st-body').innerHTML = '<p style="margin:0;padding:18px 20px;font-size:13px;color:#8a99a8">該当する方はいません</p>'; return; }
  // 会社ごとの見出し行を、表の部門見出しの上に入れる(1つの表にして、日付の列をそろえる)
  const groups = sections.flatMap(s => [{ dept: s.title, company: true, rows: [] }, ...s.groups]);
  el('st-body').innerHTML = tableHtml(data, groups);
}

function applyData(data) {
  render(data);
  ensureOrg()
    .then(() => { if (lastData === data) render(data); })
    .catch(e => console.error('部門情報の取得に失敗しました', e));
}

async function load({ silent } = {}) {
  const seq = ++loadSeq;
  try {
    const data = await api('/api/shift-table' + (month ? `?month=${encodeURIComponent(month)}` : ''));
    if (seq === loadSeq) applyData(data);
  } catch (e) {
    console.error(e);
    if (!silent && seq === loadSeq) {
      el('st-body').innerHTML = `<p style="margin:0;padding:18px 20px;font-size:13px;color:#c05a5a">読み込みに失敗しました: ${esc(e.message || String(e))}</p>`;
      lastSignature = '';
    }
  }
}

function go(n) {
  if (!month) return;
  month = shiftMonth(month, n);
  history.replaceState(null, '', `?month=${month}`);
  lastSignature = '';
  el('st-body').innerHTML = '<p style="margin:0;padding:18px 20px;font-size:13px;color:#8a99a8">読み込み中…</p>';
  load();
}

(async function init() {
  try {
    await Auth.init();
    el('st-prev').addEventListener('click', () => go(-1));
    el('st-next').addEventListener('click', () => go(1));
    setInterval(() => { if (!document.hidden) load({ silent: true }); }, 5 * 60 * 1000);
    await load();
  } catch (e) {
    console.error(e);
    el('st-body').innerHTML = `<p style="margin:0;padding:18px 20px;font-size:13px;color:#c05a5a">読み込みに失敗しました: ${esc(e.message || e)}</p>`;
  }
})();
