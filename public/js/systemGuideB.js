// システム案内(案B: 記事型)(2026-10-19に枠組みを作成、2026-10-20に第1段階=DBの記事+添付の中の文字の検索を実装。ユーザー依頼)
// 記事は管理画面の「システム案内」タブで登録する(guide テーブル。分野・種類・本文・添付)。分野と種類の定義はサーバー(/api/guide の categories / kinds)。
// 検索はサーバーで行う(タイトル・本文・添付PDF/Word/Excel/PowerPointの中の文字を、すべての語を含むものでAND検索)。
// 記事が1件も登録されていない間は、見た目を確認するための仮の記事(PREVIEW_ARTICLES)を表示する(管理画面から記事を追加すると、仮の記事は出なくなる)。
'use strict';

const PREVIEW_CATEGORIES = [
  { id: 'pc', icon: '💻', label: 'PC・周辺機器', desc: '貸与・故障・購入申請、プリンタ、ソフトの導入' },
  { id: 'network', icon: '🌐', label: 'ネットワーク', desc: 'Wi-Fi・VPN・社外から使う方法、ファイルサーバー' },
  { id: 'm365', icon: '🔑', label: 'MS365', desc: 'サインイン・パスワード、Teams・Outlook・OneDrive' },
  { id: 'jinjer', icon: '🕘', label: 'jinjer(人事)', desc: '打刻・修正、休暇申請、出勤状況の見かた' },
  { id: 'apply', icon: '📝', label: '申請・手続き', desc: '入社/退社時の準備、アカウント申請、機器の返却' }
];
// 仮の記事(ダミー)。DBに記事が無いときだけ表示する
const PREVIEW_ARTICLES = [
  { id: -1, cat: 'network', kind: '手順', title: '社外から社内システムを使うには(仮)', updated: '2026-10-19', popular: '1', body: '(仮の本文です)\n1. 手順の1つ目\n2. 手順の2つ目', attachments: [], hits: [] },
  { id: -2, cat: 'm365', kind: '手順', title: 'パスワードを変更する・忘れたとき(仮)', updated: '2026-10-19', popular: '1', body: '(仮の本文です)', attachments: [], hits: [] },
  { id: -3, cat: 'jinjer', kind: '手順', title: '打刻のしかた・打刻を直したいとき(仮)', updated: '2026-10-19', popular: '1', body: '(仮の本文です)', attachments: [], hits: [] },
  { id: -4, cat: 'pc', kind: 'FAQ', title: 'PCが遅い・動かないとき(仮)', updated: '2026-10-19', popular: '1', body: '(仮の本文です)', attachments: [], hits: [] }
];
// 障害・メンテナンスの案内(将来、管理画面で入力できるようにする。空文字なら表示しない)
const GUIDE_NOTICE = '';

const gb = { cat: '', kind: '', q: '', open: 0, categories: PREVIEW_CATEGORIES, kinds: ['手順', 'FAQ', '申請', 'お知らせ'], all: [], shown: [], preview: false };
const gel = id => document.getElementById(id);
const catOf = id => gb.categories.find(c => c.id === id) || { label: '(分野なし)', icon: '📄', desc: '' };

let searchSeq = 0; // 検索の応答が前後しても、最後の入力の結果だけを表示するための番号

/** サーバーから記事を取得する(q があれば、サーバー側で添付の中の文字も含めて検索する)。失敗したら null */
async function fetchGuide(q) {
  try {
    return await api('/api/guide' + (q ? `?q=${encodeURIComponent(q)}` : ''));
  } catch (e) {
    console.error('システム案内の取得に失敗しました', e);
    return null;
  }
}

function applyData(data) {
  if (!data) { gb.shown = []; return; }
  gb.categories = data.categories || PREVIEW_CATEGORIES;
  gb.kinds = data.kinds || gb.kinds;
  gb.shown = data.articles || [];
}

function renderCats() {
  gel('gb-cats').innerHTML = gb.categories.map(c => {
    const sel = gb.cat === c.id;
    const n = gb.all.filter(a => a.cat === c.id).length;
    return `<button type="button" data-cat="${esc(c.id)}" style="text-align:left;border:1px solid ${sel ? '#1e5fa8' : '#e4eaf1'};background:${sel ? '#eef5fc' : '#ffffff'};border-radius:12px;padding:14px 16px;cursor:pointer;font-family:inherit;display:flex;flex-direction:column;gap:6px">
      <span style="font-size:22px">${c.icon}</span>
      <span style="font-size:14px;font-weight:700;color:#1c2b3a">${esc(c.label)} <span style="font-size:11px;font-weight:400;color:#8a99a8">${n}件</span></span>
      <span style="font-size:12px;color:#6b7d8f">${esc(c.desc)}</span>
    </button>`;
  }).join('');
  gel('gb-cats').querySelectorAll('[data-cat]').forEach(b => b.addEventListener('click', () => {
    gb.cat = gb.cat === b.dataset.cat ? '' : b.dataset.cat; // もう一度押すと全体に戻る
    gb.open = 0;
    render();
  }));
}

function renderKinds() {
  const mk = (k, label) => `<button type="button" data-kind="${esc(k)}" style="border:1px solid ${gb.kind === k ? '#1e5fa8' : '#dfe8f0'};background:${gb.kind === k ? '#1e5fa8' : '#ffffff'};color:${gb.kind === k ? '#ffffff' : '#1c2b3a'};border-radius:14px;padding:3px 12px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit">${esc(label)}</button>`;
  gel('gb-kinds').innerHTML = mk('', 'すべて') + gb.kinds.map(k => mk(k, k)).join('');
  gel('gb-kinds').querySelectorAll('[data-kind]').forEach(b => b.addEventListener('click', () => { gb.kind = b.dataset.kind; gb.open = 0; render(); }));
}

/** 表示する記事(分野・種類で絞る)。検索語も分野も種類も無いときは「よくある困りごと」(popular)だけ。新しい順(更新日→id) */
function visibleArticles() {
  const searching = gb.q.trim() !== '';
  return gb.shown.filter(a => {
    if (gb.cat && a.cat !== gb.cat) return false;
    if (gb.kind && a.kind !== gb.kind) return false;
    if (!gb.cat && !searching && !gb.kind) return a.popular === '1';
    return true;
  }).sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || '')) || b.id - a.id);
}

function renderList() {
  const list = visibleArticles();
  const c = gb.cat ? catOf(gb.cat) : null;
  gel('gb-list-title').textContent = gb.q.trim() ? `「${gb.q.trim()}」の検索結果` : c ? c.label : 'よくある困りごと';
  gel('gb-list').innerHTML = list.length ? list.map(a => `
    <button type="button" data-article="${a.id}" class="hv-row" style="display:flex;flex-direction:column;gap:4px;padding:11px 20px;border:none;border-bottom:1px solid #f2f5f9;background:transparent;text-align:left;cursor:pointer;font-family:inherit;width:100%">
      <span style="display:flex;align-items:center;gap:12px;width:100%">
        <span style="font-size:11px;font-weight:700;color:#1e5fa8;background:#e9f1fa;border-radius:4px;padding:2px 8px;white-space:nowrap">${esc(a.kind)}</span>
        <span style="font-size:13px;color:#1c2b3a">${esc(a.title)}</span>
        ${(a.attachments || []).length ? `<span title="添付ファイルあり" style="font-size:12px">📎</span>` : ''}
        <span style="margin-left:auto;font-size:11px;color:#8a99a8;white-space:nowrap">${esc(catOf(a.cat).label)} ・ 更新 ${esc(a.updated)}</span>
      </span>
      ${(a.hits || []).map(h => `<span style="font-size:11px;color:#6b7d8f;padding-left:6px;border-left:3px solid #dfe8f0">📎 ${esc(h.name)}: ${esc(h.snippet)}</span>`).join('')}
    </button>`).join('') : `<p style="margin:0;padding:18px 20px;font-size:13px;color:#8a99a8">${gb.q.trim() ? '該当する記事はありません(添付の中の文字も探しました。スキャンした画像のPDFは、文字を探せません)' : '該当する記事はありません'}</p>`;
  gel('gb-list').querySelectorAll('[data-article]').forEach(b => b.addEventListener('click', () => { gb.open = Number(b.dataset.article); renderArticle(); gel('gb-article').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }));
}

function renderArticle() {
  const a = gb.shown.find(x => x.id === gb.open);
  const box = gel('gb-article');
  if (!a) { box.style.display = 'none'; box.innerHTML = ''; return; }
  box.style.display = '';
  const atts = a.attachments || [];
  box.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px">
      <span style="font-size:11px;font-weight:700;color:#1e5fa8;background:#e9f1fa;border-radius:4px;padding:2px 8px">${esc(a.kind)}</span>
      <span style="font-size:12px;color:#8a99a8">${esc(catOf(a.cat).label)} ・ 更新 ${esc(a.updated)}</span>
      <button type="button" id="gb-close" style="margin-left:auto;border:1px solid #dfe8f0;background:#ffffff;border-radius:8px;padding:5px 12px;font-size:12px;cursor:pointer;font-family:inherit">閉じる</button>
    </div>
    <h2 style="margin:0 0 10px;font-size:17px;font-weight:700">${esc(a.title)}</h2>
    <div style="font-size:13px;line-height:1.8;color:#1c2b3a;white-space:pre-wrap;word-break:break-word">${esc(a.body)}</div>
    ${atts.length ? `
    <div style="margin-top:14px;display:flex;flex-direction:column;gap:6px">
      <span style="font-size:12px;font-weight:700;color:#6b7d8f">添付ファイル(マニュアルなど)</span>
      ${atts.map((f, i) => `<button type="button" data-dl="${i}" style="display:flex;align-items:center;gap:8px;border:1px solid #dfe8f0;background:#ffffff;border-radius:8px;padding:8px 12px;cursor:pointer;font-family:inherit;font-size:13px;text-align:left"><span>📎</span><span style="color:#1e5fa8">${esc(f.name)}</span><span style="margin-left:auto;font-size:11px;color:#8a99a8;white-space:nowrap">${esc(fmtFileSize(f.size))}</span></button>`).join('')}
    </div>` : ''}
    ${gb.preview ? '<p style="margin:12px 0 0;font-size:12px;color:#8a99a8">(これは仮の記事です。管理画面の「システム案内」で記事と添付を登録できます)</p>' : ''}`;
  gel('gb-close').addEventListener('click', () => { gb.open = 0; renderArticle(); });
  box.querySelectorAll('[data-dl]').forEach(b => b.addEventListener('click', () => {
    const f = atts[Number(b.dataset.dl)];
    if (f) downloadAttachment(f.id, f.name);
  }));
}

function render() {
  renderCats();
  renderKinds();
  renderList();
  renderArticle();
  gel('gb-preview').style.display = gb.preview ? '' : 'none';
}

let searchTimer = null;
function onSearchInput() {
  gb.q = gel('gb-search').value;
  if (gb.q.trim()) gb.cat = ''; // 検索は全分野から探す(選択中の分野は外す)
  gb.open = 0;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 250);
}

async function runSearch() {
  const seq = ++searchSeq;
  if (gb.preview) { // 仮の記事の表示中は、画面の中だけで探す
    const q = normalizeQ(gb.q);
    gb.shown = q ? PREVIEW_ARTICLES.filter(a => normalizeQ(a.title + a.body).includes(q)) : PREVIEW_ARTICLES;
    return render();
  }
  const data = await fetchGuide(gb.q.trim());
  if (seq !== searchSeq) return; // 古い応答は捨てる
  applyData(data);
  render();
}
const normalizeQ = s => String(s || '').normalize('NFKC').toLowerCase().trim();

(async function init() {
  try {
    await Auth.init();
  } catch (e) {
    console.error(e);
  }
  const n = gel('gb-notice');
  if (GUIDE_NOTICE) { n.style.display = ''; n.textContent = GUIDE_NOTICE; }
  gel('gb-search').addEventListener('input', onSearchInput);
  const data = await fetchGuide('');
  applyData(data);
  gb.all = gb.shown.slice();
  if (data && !gb.all.length) { // 記事が1件も無い: 仮の記事を表示する
    gb.preview = true;
    gb.shown = PREVIEW_ARTICLES;
    gb.all = PREVIEW_ARTICLES;
  }
  render();
})();
