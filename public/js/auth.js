// 認証アダプタ
// - devモード(既定): サーバーのモックユーザーをそのまま使う
// - entraモード: MSAL.js による Entra ID サインイン(アプリ登録後に有効化。docs/entra-setup.md 参照)
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
    this.config = await api('/api/config');
    this.mode = this.config.authMode;
    if (this.mode === 'entra') {
      await this._initEntra();
    }
    this.me = await api('/api/me');
    fillMe(this.me);
    this._initLogoutLink();
    return this.me;
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
