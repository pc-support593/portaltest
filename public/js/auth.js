// 認証アダプタ
// - entraモード(既定): MSAL.js による Entra ID サインイン(docs/entra-setup.md 参照)
// - devモード: AUTH_MODE=dev を明示したときだけ。サーバーのモックユーザーをそのまま使う(ローカル確認用。認証なし)
// どちらのモードかはサーバー(/api/config の authMode)が決める。サーバーは entra/dev 以外の値では起動しない
//   ※ entraモードのコードパスはテナントでのアプリ登録が済むまで未検証。
'use strict';

const Auth = {
  mode: 'dev',
  config: null,
  me: null,
  _msal: null,

  /** ポータルAPI保護用のカスタムスコープ(アプリ登録の「APIの公開」で定義) */
  get apiScope() { return `api://${this.config.clientId}/access_as_user`; },

  async init() {
    try {
      this.config = await api('/api/config');
      this.mode = this.config.authMode;
      if (this.mode === 'entra') {
        await this._initEntra(); // 未サインインならMicrosoftのログインへ移動し、ここから戻らない(画面は非表示のまま)
      }
      this.me = await api('/api/me');
      this.me.name = displayName(this.me.name); // 姓・名が取れるまでの仮の名前も、会社名の括弧書きは除く
      fillMe(this.me);
      showPortalAdminLink(this.me);
      this._initLogoutLink();
      document.querySelectorAll('[data-feature]').forEach(e => { e.hidden = !(this.config.features || {})[e.dataset.feature]; }); // 無効な機能のリンクは隠す(整理案F)
      this._applyFullName(); // 待たない(画面を止めない)。取得できたら、右上の名前と挨拶を差し替える
      this._revealPage();
      return this.me;
    } catch (e) {
      this._revealPage(); // エラー時は画面を表示して、各ページがエラー内容を出せるようにする(真っ白のままにしない)
      throw e;
    }
  },

  /** ログインした人自身の名前も、MS365の「姓」「名」から「姓 名」(半角スペース)にする(2026-10-16・ユーザー指示。右上の表示・挨拶)。
      サーバーが返す名前(トークンの表示名)を先に出し、取得できたら差し替える。失敗・5秒以内に返らないときは、そのまま(画面は止めない。P004) */
  async _applyFullName() {
    if (this.mode !== 'entra') return;
    try {
      const token = await withTimeout(this.getGraphToken(['User.Read']), 5000, 'トークンの取得が時間内に完了しませんでした');
      const res = await withTimeout(fetch('https://graph.microsoft.com/v1.0/me?$select=displayName,surname,givenName', {
        headers: { Authorization: `Bearer ${token}` }
      }), 5000, '自分の名前の取得が時間内に完了しませんでした');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const u = await res.json();
      const name = fullNameOf(u.surname, u.givenName, u.displayName);
      if (name && this.me && name !== this.me.name) {
        this.me.name = name;
        fillMe(this.me);
        window.dispatchEvent(new CustomEvent('portal:me-updated', { detail: this.me })); // トップの挨拶などが、名前を差し替える
      }
    } catch (e) {
      console.error('自分の名前(姓・名)の取得に失敗しました', e);
    }
  },

  /** サインインの確認が済むまで画面を隠している(各ページ先頭の html.auth-pending)を解除する */
  _revealPage() {
    document.documentElement.classList.remove('auth-pending');
  },

  /** ヘッダーの「ログアウト」リンク(id="logout-link")を有効化する。devモードでは非表示のまま */
  _initLogoutLink() {
    const link = document.getElementById('logout-link');
    if (!link || this.mode !== 'entra') return;
    link.style.display = '';
    link.addEventListener('click', e => {
      e.preventDefault();
      this.logout();
    });
  },

  /** Entra ID からサインアウトする(このブラウザのMicrosoftサインインセッションも終了する) */
  logout() {
    if (this.mode !== 'entra' || !this._msal) return;
    this._msal.logoutRedirect({ postLogoutRedirectUri: window.location.origin });
  },

  async _initEntra() {
    if (!this.config.clientId || !this.config.tenantId) {
      alert('Entra ID の設定(CLIENT_ID / TENANT_ID)がありません。docs/entra-setup.md を参照してください。');
      throw new Error('Entra ID 未設定');
    }
    // MSAL.js を動的読み込み(devモードでは一切読み込まない)
    // 注: Microsoft CDN(alcdn.msauth.net)は msal-browser v3 以降で廃止。
    //     npm CDN(jsDelivr)からバージョン固定 + SRI(integrity)で読み込む。
    //     バージョン更新時は integrity ハッシュの再計算と docs/entra-setup.md の更新もセットで行うこと
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/@azure/msal-browser@5.18.0/lib/msal-browser.min.js';
      s.integrity = 'sha384-FQfSZjxaWBhzqI7u0+3M2/K/kFajbcK45G1GMnQdDzVZszPTSjjvWY9YEnJ9tEia';
      s.crossOrigin = 'anonymous';
      s.onload = resolve; s.onerror = () => reject(new Error('MSAL.js の読み込みに失敗しました'));
      document.head.appendChild(s);
    });
    this._msal = new msal.PublicClientApplication({
      auth: {
        clientId: this.config.clientId,
        authority: `https://login.microsoftonline.com/${this.config.tenantId}`,
        redirectUri: window.location.origin
      },
      cache: { cacheLocation: 'sessionStorage' }
    });
    await this._msal.initialize(); // v3以降は必須(呼ばずに他のAPIを使うと例外)
    const result = await this._msal.handleRedirectPromise();
    if (result) this._msal.setActiveAccount(result.account);
    if (!this._msal.getActiveAccount()) {
      const accounts = this._msal.getAllAccounts();
      if (accounts.length) this._msal.setActiveAccount(accounts[0]);
      else {
        // ページ遷移するためここには戻らない
        await this._msal.loginRedirect({ scopes: [this.apiScope, 'User.Read'] });
        return new Promise(() => {}); // 遷移完了までinitを進めない
      }
    }
  },

  /** ポータルAPI呼び出し用のアクセストークン(entraモードのみ) */
  async getApiToken() {
    return this.getGraphToken([this.apiScope]);
  },

  /** Graph API 呼び出し用のアクセストークン(entraモードのみ) */
  async getGraphToken(scopes) {
    if (this.mode !== 'entra' || !this._msal) return null;
    try {
      const r = await this._msal.acquireTokenSilent({ scopes });
      if (!r || !r.accessToken) throw new Error('トークンが取得できませんでした');
      return r.accessToken;
    } catch (e) {
      // ユーザー操作が必要な失敗のみリダイレクトで再認証(ページ遷移するため戻らない)。
      // ネットワークエラー等まで無条件にリダイレクトするとループの恐れがあるため区別する
      if (e instanceof msal.InteractionRequiredAuthError) {
        // acquireTokenRedirectはページ遷移するだけでトークン文字列を返さないため、
        // ここで待ち受けると呼び出し元が空のトークンでAPIを呼んでしまう(Graph側で
        // InvalidAuthenticationToken/Access token is emptyになる)。遷移は裏で開始しつつ、
        // 呼び出し元には明確なエラーを投げて空トークンでのAPI呼び出しを防ぐ
        this._msal.acquireTokenRedirect({ scopes });
        throw new Error('サインインの有効期限が切れました。再度サインインしています…');
      }
      throw e;
    }
  }
};
