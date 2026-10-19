// システム案内(案C: 外部ページへのリンク型)の枠組み(2026-10-19・ユーザー依頼。テスト環境で案Bと見比べるための試作)。
// 実装案: 分野ごとの説明ページはSharePoint等(外部)に作り、ポータルは入口とリンクだけを持つ。
// url が空のリンクは「準備中」と表示する(リンク先は、SharePointのページを作ってから設定する)。外部リンクは新しいタブで開く。
'use strict';

const GUIDE_LINKS = [
  {
    icon: '💻', label: 'PC・周辺機器', desc: '貸与・故障・購入申請、プリンタ、ソフトの導入',
    links: [{ label: 'PC・周辺機器のガイド(SharePoint)', url: '' }, { label: 'PC・周辺機器の購入申請', url: '' }]
  },
  {
    icon: '🌐', label: 'ネットワーク', desc: 'Wi-Fi・VPN・社外から使う方法、ファイルサーバー',
    links: [{ label: 'ネットワークのガイド(SharePoint)', url: '' }, { label: '社外から使う方法(VPN)', url: '' }]
  },
  {
    icon: '🔑', label: 'MS365', desc: 'サインイン・パスワード、Teams・Outlook・OneDrive',
    links: [{ label: 'MS365の使い方(SharePoint)', url: '' }, { label: 'パスワードのリセット', url: 'https://passwordreset.microsoftonline.com/' }, { label: 'アカウント設定(MFAなど)', url: 'https://mysignins.microsoft.com/' }]
  },
  {
    icon: '🕘', label: 'jinjer(人事)', desc: '打刻・修正、休暇申請、出勤状況の見かた',
    links: [{ label: 'jinjerの使い方(SharePoint)', url: '' }, { label: 'jinjerにログイン', url: '' }, { label: '出勤状況(このポータル)', url: 'attendance.html', internal: true, feature: 'attendance' }]
  },
  {
    icon: '📝', label: '申請・手続き', desc: '入社/退社時の準備、アカウント申請、機器の返却',
    links: [{ label: '入社・退社時の手続きのガイド(SharePoint)', url: '' }]
  }
];

function linkHtml(l) {
  if (!l.url) return `<li style="font-size:13px;color:#a8b4c0">${esc(l.label)} <span style="font-size:11px;background:#f0f4f8;border-radius:4px;padding:1px 6px">準備中</span></li>`;
  const attrs = l.internal ? '' : ' target="_blank" rel="noopener"';
  return `<li style="font-size:13px"><a href="${esc(l.url)}"${attrs} style="color:#1e5fa8;text-decoration:none"${l.feature ? ` data-feature="${esc(l.feature)}" hidden` : ''}>${esc(l.label)}${l.internal ? '' : ' ↗'}</a></li>`;
}

function renderCats() {
  document.getElementById('gc-cats').innerHTML = GUIDE_LINKS.map(c => `
    <section style="background:#ffffff;border-radius:12px;box-shadow:0 1px 3px rgba(30,60,100,0.08);padding:16px 20px;display:flex;flex-direction:column;gap:8px">
      <div style="display:flex;align-items:center;gap:10px"><span style="font-size:24px">${c.icon}</span><h2 style="margin:0;font-size:15px;font-weight:700">${esc(c.label)}</h2></div>
      <p style="margin:0;font-size:12px;color:#6b7d8f">${esc(c.desc)}</p>
      <ul style="margin:4px 0 0;padding-left:18px;display:flex;flex-direction:column;gap:6px">${c.links.map(linkHtml).join('')}</ul>
    </section>`).join('');
}

(async function init() {
  try {
    await Auth.init(); // data-feature の要素(無効な機能のリンク)の出し分けも、ここで行われる
  } catch (e) {
    console.error(e);
  }
  renderCats();
  // renderCats は Auth.init の後に描くため、data-feature の出し分けをここでもう一度行う
  if (Auth.config) document.querySelectorAll('[data-feature]').forEach(e => { e.hidden = !(Auth.config.features || {})[e.dataset.feature]; });
})();
