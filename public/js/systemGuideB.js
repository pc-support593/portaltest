// システム案内(案B: 記事型)の枠組み(2026-10-19・ユーザー依頼。テスト環境で案Cと見比べるための試作)。
// 実装案: 記事(分野・種類・タイトル・本文・更新日・添付)をDBに持ち、管理画面から追加・編集する(お知らせ・社内規程と同じ方式)。
// この試作では、DBを作る前に見た目と使い勝手を確認するため、記事は下の GUIDE_* の仮データ(ダミー)で表示している。
// 案が決まったら、DBテーブルの設計(db-architectの確認とデータ台帳の更新が必要)→管理画面→この仮データの置き換え、の順で進める。
'use strict';

const GUIDE_CATEGORIES = [
  { id: 'pc', icon: '💻', label: 'PC・周辺機器', desc: '貸与・故障・購入申請、プリンタ、ソフトの導入' },
  { id: 'network', icon: '🌐', label: 'ネットワーク', desc: 'Wi-Fi・VPN・社外から使う方法、ファイルサーバー' },
  { id: 'm365', icon: '🔑', label: 'MS365', desc: 'サインイン・パスワード、Teams・Outlook・OneDrive' },
  { id: 'jinjer', icon: '🕘', label: 'jinjer(人事)', desc: '打刻・修正、休暇申請、出勤状況の見かた' },
  { id: 'apply', icon: '📝', label: '申請・手続き', desc: '入社/退社時の準備、アカウント申請、機器の返却' }
];
const GUIDE_KINDS = ['手順', 'FAQ', '申請', 'お知らせ'];

// 仮の記事(ダミー)。実際は管理画面で登録した内容を表示する
const GUIDE_ARTICLES = [
  { id: 1, cat: 'network', kind: '手順', title: '社外から社内システムを使うには(仮)', updated: '2026-10-19', popular: true, body: ['(仮の本文です)', '1. 手順の1つ目', '2. 手順の2つ目', '3. うまくいかない場合は、連絡先へ'] },
  { id: 2, cat: 'network', kind: 'FAQ', title: 'Wi-Fiにつながらないとき(仮)', updated: '2026-10-19', popular: true, body: ['(仮の本文です)', '・まず確認すること', '・それでも直らないとき'] },
  { id: 3, cat: 'm365', kind: '手順', title: 'パスワードを変更する・忘れたとき(仮)', updated: '2026-10-19', popular: true, body: ['(仮の本文です)', '1. サインイン画面で「パスワードを忘れた場合」', '2. 本人確認(MFA)', '3. 新しいパスワードを設定'] },
  { id: 4, cat: 'm365', kind: 'FAQ', title: 'Teams・Outlookが開けないとき(仮)', updated: '2026-10-19', popular: false, body: ['(仮の本文です)'] },
  { id: 5, cat: 'jinjer', kind: '手順', title: '打刻のしかた・打刻を直したいとき(仮)', updated: '2026-10-19', popular: true, body: ['(仮の本文です)', '・打刻の方法', '・修正の申請'] },
  { id: 6, cat: 'jinjer', kind: '申請', title: '休暇の申請方法(仮)', updated: '2026-10-19', popular: false, body: ['(仮の本文です)'] },
  { id: 7, cat: 'pc', kind: '申請', title: 'PC・周辺機器の購入申請(仮)', updated: '2026-10-19', popular: false, body: ['(仮の本文です)'] },
  { id: 8, cat: 'pc', kind: 'FAQ', title: 'PCが遅い・動かないとき(仮)', updated: '2026-10-19', popular: true, body: ['(仮の本文です)'] },
  { id: 9, cat: 'apply', kind: '申請', title: '入社・退社時のアカウントと機器の手続き(仮)', updated: '2026-10-19', popular: false, body: ['(仮の本文です)'] },
  { id: 10, cat: 'network', kind: 'お知らせ', title: '【仮】定期メンテナンスのお知らせ', updated: '2026-10-19', popular: false, body: ['(仮の本文です)'] }
];
// 障害・メンテナンスの案内(実際は管理画面で入力。空文字なら表示しない)
const GUIDE_NOTICE = '';

const gb = { cat: '', kind: '', q: '', open: 0 };
const gel = id => document.getElementById(id);
const catOf = id => GUIDE_CATEGORIES.find(c => c.id === id);

function renderCats() {
  gel('gb-cats').innerHTML = GUIDE_CATEGORIES.map(c => {
    const sel = gb.cat === c.id;
    const n = GUIDE_ARTICLES.filter(a => a.cat === c.id).length;
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
  gel('gb-kinds').innerHTML = mk('', 'すべて') + GUIDE_KINDS.map(k => mk(k, k)).join('');
  gel('gb-kinds').querySelectorAll('[data-kind]').forEach(b => b.addEventListener('click', () => { gb.kind = b.dataset.kind; gb.open = 0; render(); }));
}

/** 表示する記事(分野・種類・検索語で絞る)。分野も検索語もないときは「よくある困りごと」(popular)だけ */
function visibleArticles() {
  const q = gb.q.trim().toLowerCase();
  return GUIDE_ARTICLES.filter(a => {
    if (gb.cat && a.cat !== gb.cat) return false;
    if (gb.kind && a.kind !== gb.kind) return false;
    if (q && !(a.title + ' ' + a.body.join(' ')).toLowerCase().includes(q)) return false;
    if (!gb.cat && !q && !gb.kind) return a.popular;
    return true;
  });
}

function renderList() {
  const list = visibleArticles();
  const c = catOf(gb.cat);
  gel('gb-list-title').textContent = gb.q.trim() ? `「${gb.q.trim()}」の検索結果` : c ? c.label : 'よくある困りごと';
  gel('gb-list').innerHTML = list.length ? list.map(a => `
    <button type="button" data-article="${a.id}" class="hv-row" style="display:flex;align-items:center;gap:12px;padding:11px 20px;border:none;border-bottom:1px solid #f2f5f9;background:transparent;text-align:left;cursor:pointer;font-family:inherit;width:100%">
      <span style="font-size:11px;font-weight:700;color:#1e5fa8;background:#e9f1fa;border-radius:4px;padding:2px 8px;white-space:nowrap">${esc(a.kind)}</span>
      <span style="font-size:13px;color:#1c2b3a">${esc(a.title)}</span>
      <span style="margin-left:auto;font-size:11px;color:#8a99a8;white-space:nowrap">${esc(catOf(a.cat).label)} ・ 更新 ${esc(a.updated)}</span>
    </button>`).join('') : '<p style="margin:0;padding:18px 20px;font-size:13px;color:#8a99a8">該当する記事はありません</p>';
  gel('gb-list').querySelectorAll('[data-article]').forEach(b => b.addEventListener('click', () => { gb.open = Number(b.dataset.article); renderArticle(); gel('gb-article').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }));
}

function renderArticle() {
  const a = GUIDE_ARTICLES.find(x => x.id === gb.open);
  const box = gel('gb-article');
  if (!a) { box.style.display = 'none'; box.innerHTML = ''; return; }
  box.style.display = '';
  box.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px">
      <span style="font-size:11px;font-weight:700;color:#1e5fa8;background:#e9f1fa;border-radius:4px;padding:2px 8px">${esc(a.kind)}</span>
      <span style="font-size:12px;color:#8a99a8">${esc(catOf(a.cat).label)} ・ 更新 ${esc(a.updated)}</span>
      <button type="button" id="gb-close" style="margin-left:auto;border:1px solid #dfe8f0;background:#ffffff;border-radius:8px;padding:5px 12px;font-size:12px;cursor:pointer;font-family:inherit">閉じる</button>
    </div>
    <h2 style="margin:0 0 10px;font-size:17px;font-weight:700">${esc(a.title)}</h2>
    ${a.body.map(p => `<p style="margin:0 0 6px;font-size:13px;line-height:1.7;color:#1c2b3a">${esc(p)}</p>`).join('')}
    <p style="margin:12px 0 0;font-size:12px;color:#8a99a8">(実際の記事では、画像・添付ファイル(PDF等)・関連記事へのリンクも付けられます)</p>`;
  gel('gb-close').addEventListener('click', () => { gb.open = 0; renderArticle(); });
}

function render() {
  renderCats();
  renderKinds();
  renderList();
  renderArticle();
}

(async function init() {
  try {
    await Auth.init();
  } catch (e) {
    console.error(e);
  }
  const n = gel('gb-notice');
  if (GUIDE_NOTICE) { n.style.display = ''; n.textContent = GUIDE_NOTICE; }
  gel('gb-search').addEventListener('input', () => { gb.q = gel('gb-search').value; if (gb.q.trim()) gb.cat = ''; gb.open = 0; render(); }); // 検索は全分野から探す(選択中の分野は外す)
  render();
})();
