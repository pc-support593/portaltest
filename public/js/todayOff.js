// 本日のお休みページ(2026-10-07追加。ユーザー指示)。
// jinjerの休日休暇データをサーバー(src/jinjerDayOffs.js)が毎朝6:00に取り込んで保存し、
// このページは /api/day-offs のキャッシュだけを読む(画面からjinjerを直接呼ばない)。
// 「最新の情報に更新」ボタンは POST /api/day-offs/sync で手動取り込み(電話連絡の当日休みの反映用)。
// 自動リフレッシュは共通方針(CLAUDE.md ルール11)に準拠: 2分間隔・非表示タブはスキップ・差分があるときだけ差し替え。
'use strict';

const el = id => document.getElementById(id);
let lastSignature = '';

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

function rowHtml(it) {
  const pending = it.status === 'pending';
  const badge = pending
    ? '<span style="font-size:11px;font-weight:700;color:#b36b00;background:#fff3dc;border-radius:10px;padding:2px 9px;white-space:nowrap">申請中</span>'
    : '';
  return `
  <div style="display:flex;align-items:center;gap:14px;padding:11px 20px;border-bottom:1px solid #f2f5f9;${pending ? 'opacity:0.85' : ''}">
    <div style="width:32px;height:32px;border-radius:50%;background:#4a7fc0;color:#ffffff;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0">${esc(it.name.charAt(0))}</div>
    <span style="font-size:13px;font-weight:700;color:#1c2b3a;min-width:110px">${esc(it.name)}</span>
    <span style="flex:1"></span>
    ${badge}
  </div>`;
}

function render(data) {
  const sig = JSON.stringify(data);
  if (sig === lastSignature) return; // 差分がなければ何もしない(自動更新時のちらつき防止)
  lastSignature = sig;

  el('dayoff-title').textContent = `本日のお休み(${formatDate(data.date)})`;

  const st = data.sync;
  let status = '';
  if (!data.configured) status = 'jinjerのAPIキーが未設定のため、取り込みは行われていません(サーバーの設定が必要です)。';
  else if (!st) status = 'まだ取り込みが実行されていません。「最新の情報に更新」を押してください。';
  else if (st.ok) status = `最終取り込み: ${formatTime(st.runAt)}`;
  else status = `最終取り込みに失敗しました(${formatTime(st.runAt)}): ${st.message || '原因不明'}` +
    (st.lastSuccessDate === data.date ? '。表示は本日の前回成功分です。' : '。表示が最新でない可能性があります。');
  const statusEl = el('dayoff-status');
  statusEl.textContent = status;
  statusEl.style.color = (st && !st.ok) || !data.configured ? '#c05a5a' : '#6b7d8f';

  const list = el('dayoff-list');
  // 朝6:00前や取り込み失敗が続いたときに「お休みなし」と誤解させない(本日分が未取込なら0件表示にしない)
  const todayLoaded = st && st.lastSuccessDate === data.date;
  if (!data.items.length && !todayLoaded) {
    list.innerHTML = '<p style="margin:0;padding:24px 20px;font-size:13px;color:#8a99a8">本日分はまだ取り込まれていません(毎朝6:00に取り込みます。「最新の情報に更新」でも取り込めます)</p>';
    return;
  }
  if (!data.items.length) {
    list.innerHTML = '<p style="margin:0;padding:24px 20px;font-size:13px;color:#8a99a8">本日お休みの方はいません</p>';
    return;
  }
  list.innerHTML = `
    <div style="padding:13px 20px;border-bottom:1px solid #e8edf3">
      <span style="font-size:11px;color:#8a99a8">${data.items.length}名</span>
    </div>
    ${data.items.map(rowHtml).join('')}`;
}

async function load({ silent } = {}) {
  try {
    render(await api('/api/day-offs'));
  } catch (e) {
    console.error(e);
    if (!silent) {
      el('dayoff-list').innerHTML = `<p style="margin:0;padding:24px 20px;font-size:13px;color:#c05a5a">読み込みに失敗しました: ${esc(e.message || String(e))}</p>`;
    }
  }
}

async function manualSync() {
  const btn = el('dayoff-sync');
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = '更新中…';
  try {
    render(await api('/api/day-offs/sync', { method: 'POST' }));
  } catch (e) {
    // 失敗理由(未設定・連続実行・jinjer障害など)を表示し、一覧は前回の内容のまま残す
    el('dayoff-status').textContent = `更新できませんでした: ${e.message || e}`;
    el('dayoff-status').style.color = '#c05a5a';
    lastSignature = ''; // 次の自動更新で正しい状態表示に戻す
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

(async function init() {
  try {
    await Auth.init();
    el('dayoff-sync').addEventListener('click', manualSync);
    await load();
    setInterval(() => { if (!document.hidden) load({ silent: true }); }, 2 * 60 * 1000);
  } catch (e) {
    console.error(e);
    el('dayoff-list').innerHTML =
      `<p style="margin:0;padding:24px 20px;font-size:13px;color:#c05a5a">読み込みに失敗しました: ${esc(e.message || e)}</p>`;
  }
})();
