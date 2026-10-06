// 社内報(igrace.jp)への自動ログイン中継ページ(2026-10-06)。
// サインイン済みのユーザーだけがサーバーから共通ID/パスワードを受け取り、
// WordPressのログインフォームを非表示で自動送信する(資格情報はこのファイルにも書かない)。
'use strict';

(async function init() {
  const status = document.getElementById('igrace-status');
  try {
    await Auth.init();
    const { action, fields } = await api('/api/external-login/igrace');
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = action;
    Object.entries(fields).forEach(([name, value]) => {
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = name;
      input.value = value;
      form.appendChild(input);
    });
    document.body.appendChild(form);
    form.submit();
  } catch (e) {
    console.error(e);
    status.style.color = '#c05a5a';
    status.textContent = `社内報へのログインに失敗しました: ${e.message || e}`;
  }
})();
