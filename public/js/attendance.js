// 出勤状況ページ(2026-10-17追加。ユーザー指示)。
// jinjerの打刻データをサーバー(src/jinjerAttendance.js)が5分おきに取り込んで保存し、このページは /api/attendance のキャッシュだけを読む
// (画面からjinjerを直接呼ばない)。氏名はjinjerの社用メールアドレスとMS365のメールアドレスを突き合わせ、Graphから「姓 名」を取得する
// (社員名簿などと表記を揃える)。メールアドレスが未登録・一致しない人はjinjerの氏名で表示する。
// 退勤の打刻がある人はグレー+退勤時刻。「退勤済みも表示」を外すと退勤済みは非表示。退勤の打刻をしていない人は出勤中のまま。
// 自動リフレッシュは共通方針(CLAUDE.md ルール11)に準拠: 2分間隔・非表示タブはスキップ・差分があるときだけ差し替え。
'use strict';

const el = id => document.getElementById(id);
const SHOW_LEFT_KEY = 'attendance.showLeft';
const nameCache = new Map(); // email(小文字) → 「姓 名」(取得失敗は '' を入れて再取得しない)
let lastSignature = '';
let lastData = null;
let loadSeq = 0; // 手動更新と自動更新が重なったとき、古い応答で新しい表示を上書きしないための番号
const resolving = new Set(); // 氏名取得中のメールアドレス(二重取得しない)
const GRAPH_TIMEOUT_MS = 8000;

/** Promiseに制限時間を付ける(Graphが無応答でも画面の描画・自動更新を止めない) */
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('タイムアウト')), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

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

/** MS365の氏名(姓 名)をGraphから取得してキャッシュする。取得済み・取得中のメールアドレスは再取得しない。
    1人ずつtry/catchし、失敗した人はjinjerの氏名で表示する(1人の失敗で全体を壊さない)。
    恒久的に存在しない(404)場合だけ失敗をキャッシュし、429・5xx・タイムアウトは次回の更新で再試行する */
async function resolveNames(items) {
  if (Auth.mode !== 'entra') return;
  const emails = [...new Set(items.map(i => (i.email || '').toLowerCase()).filter(e => e && !nameCache.has(e) && !resolving.has(e)))];
  if (!emails.length) return;
  emails.forEach(e => resolving.add(e));
  try {
    const token = await withTimeout(Auth.getGraphToken(['User.Read.All']), GRAPH_TIMEOUT_MS);
    const CONCURRENCY = 8;
    for (let i = 0; i < emails.length; i += CONCURRENCY) {
      await Promise.all(emails.slice(i, i + CONCURRENCY).map(async email => {
        try {
          const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(email)}?$select=displayName,surname,givenName`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS)
          });
          if (res.status === 404) { nameCache.set(email, ''); return; } // MS365に無いアドレス(以後はjinjerの氏名で表示)
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const u = await res.json();
          nameCache.set(email, fullNameOf(u.surname, u.givenName, u.displayName) || '');
        } catch (e) {
          console.error(`「${email}」のMS365氏名取得に失敗しました(次回の更新で再試行します)`, e);
        }
      }));
    }
  } finally {
    emails.forEach(e => resolving.delete(e));
  }
}

function nameOf(it) {
  const email = (it.email || '').toLowerCase();
  return (email && nameCache.get(email)) || it.name || '(氏名不明)';
}

function rowHtml(it) {
  const left = !!it.left_at;
  const name = nameOf(it);
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

function columnHtml(items) {
  if (!items.length) return '<p style="margin:0;padding:18px 20px;font-size:13px;color:#8a99a8">該当する方はいません</p>';
  return items.map(rowHtml).join('');
}

function render(data) {
  lastData = data;
  const showLeft = el('att-show-left').checked;
  const sig = JSON.stringify([data, showLeft, [...nameCache.entries()]]);
  if (sig === lastSignature) return; // 差分がなければ何もしない(自動更新時のちらつき防止)
  lastSignature = sig;

  el('att-title').textContent = `出勤状況(${formatDate(data.date)})`;

  const st = data.sync;
  let status = '';
  if (!data.configured) status = 'jinjerのAPIキーが未設定のため、取り込みは行われていません(サーバーの設定が必要です)。';
  else if (!st) status = 'まだ取り込みが実行されていません。「最新の情報に更新」を押してください。';
  else if (st.ok) status = `最終取り込み: ${formatTime(st.runAt)}`;
  else status = `最終取り込みに失敗しました(${formatTime(st.runAt)}): ${st.message || '原因不明'}` +
    (st.lastSuccessDate === data.date ? '。表示は本日の前回成功分です。' : '。表示が最新でない可能性があります。');
  const statusEl = el('att-status');
  statusEl.textContent = status;
  statusEl.style.color = (st && !st.ok) || !data.configured ? '#c05a5a' : '#6b7d8f';

  const loaded = st && st.lastSuccessDate === data.date;
  const working = data.items.filter(i => !i.left_at).length;
  const left = data.items.length - working;
  el('att-summary').textContent = data.items.length || loaded ? `出勤中 ${working}名 / 退勤済み ${left}名` : '';

  // 本日分がまだ取り込まれていない(日付が変わった直後・取り込み失敗が続いたとき)は「出勤者なし」と誤解させない
  if (!data.items.length && !loaded) {
    const msg = '<p style="margin:0;padding:18px 20px;font-size:13px;color:#8a99a8">本日分はまだ取り込まれていません(5分おきに自動で取り込みます。「最新の情報に更新」でも取り込めます)</p>';
    el('att-left').innerHTML = msg;
    el('att-right').innerHTML = '';
    return;
  }

  const visible = data.items.filter(i => showLeft || !i.left_at);
  const byName = (a, b) => nameOf(a).localeCompare(nameOf(b), 'ja');
  // 出勤中を先、退勤済みを後に。それぞれ氏名順
  const order = (a, b) => (!!a.left_at - !!b.left_at) || byName(a, b);
  const isYume = i => (i.email || '').toLowerCase().endsWith('@yumesumika.com');
  el('att-left').innerHTML = columnHtml(visible.filter(i => !isYume(i)).sort(order));
  el('att-right').innerHTML = columnHtml(visible.filter(isYume).sort(order));
}

/** 先にjinjerの氏名で描画し、MS365の氏名の取得は裏で行う(Graphが遅くても一覧が出る)。取得できたら再描画して置き換える */
function applyData(data) {
  render(data);
  resolveNames(data.items)
    .then(() => { if (lastData === data) render(data); })
    .catch(e => console.error('MS365氏名の取得に失敗しました', e));
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

async function manualSync() {
  const btn = el('att-sync');
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = '更新中…';
  const seq = ++loadSeq;
  try {
    const data = await api('/api/attendance/sync', { method: 'POST' });
    if (seq === loadSeq) applyData(data);
  } catch (e) {
    // 失敗理由(未設定・連続実行・jinjer障害など)を表示し、一覧は前回の内容のまま残す
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
    el('att-sync').addEventListener('click', manualSync);
    setInterval(() => { if (!document.hidden) load({ silent: true }); }, 2 * 60 * 1000); // 初回表示の成否に関わらず自動更新を登録する
    await load();
  } catch (e) {
    console.error(e);
    el('att-left').innerHTML =
      `<p style="margin:0;padding:18px 20px;font-size:13px;color:#c05a5a">読み込みに失敗しました: ${esc(e.message || e)}</p>`;
  }
})();
