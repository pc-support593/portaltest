# Entra ID 連携のセットアップ手順

現在ポータルは **devモード**(モックユーザー: 佐藤 美咲)で動作している。
組織のMS365アカウントでのサインイン(SSO方針: [_governance/identity/sso-policy.md](../../_governance/identity/sso-policy.md))に切り替えるには、以下の手順を行う。

## 0. まず「ログインだけ」試す最小手順(localhost・管理者同意不要)

Graph連携なしで、本人のMS365アカウントでのサインインと画面右上の本人名表示だけを確認する手順。

1. [entra.microsoft.com](https://entra.microsoft.com) にサインイン → 「アプリの登録」→「新規登録」
   - 名前: `Yoshimura-Portal`
   - アカウントの種類: **この組織ディレクトリのみ**
   - リダイレクトURI: 「**シングルページ アプリケーション(SPA)**」で `http://localhost:3100`
2. 「APIの公開」→「アプリケーションIDのURI」を既定値(`api://<クライアントID>`)で設定
   → 「スコープの追加」: スコープ名 `access_as_user`、同意できるのは「**管理者とユーザー**」、表示名・説明は任意(例: ポータルAPIへのアクセス)
3. 「マニフェスト」→ `"requestedAccessTokenVersion"` を `2` に変更して保存(v2トークン必須。`null` のままだと401になる)
4. 「概要」画面の **テナントID(ディレクトリID)** と **クライアントID** を控える
5. `Portal\.env.example` をコピーして `Portal\.env` を作り、控えた2つのIDを記入:
   ```
   AUTH_MODE=entra
   TENANT_ID=<テナントID>
   CLIENT_ID=<クライアントID>
   ```
   その後、**既に動いているサーバーを止めてから**起動する(起動中のターミナルで Ctrl+C、または新しく `npm start` して「EADDRINUSE」エラーが出たら別のウィンドウで動いている):
   ```powershell
   cd Desktop\claude\Portal
   npm start
   # 起動ログに「認証: entra」と出ることを確認(「認証: dev」なら .env が読めていない)
   ```
6. `http://localhost:3100` を開く → Microsoftのサインイン画面に遷移 → 自分のMS365アカウントでサインイン
   → 初回のみ同意画面(User.Read と access_as_user。**ユーザー同意で足りるため管理者ロール不要**)
   → 画面右上にモックの「佐藤 美咲」ではなく**本人の氏名とメール**が表示されれば成功

この段階の既知の制約(正常な挙動):
- 「今日の予定」等はまだダミー表示(Graph連携は §3)
- 管理画面の追加・編集・削除は 403(`Portal.Admin` アプリロール未割当のため。§1-5 で割り当てると使える)
- 会議室予約の作成は本人名義で動く(シードされたデモ予約は「佐藤 美咲」名義のため編集不可になる)

> 登録したら [app-registrations.md](../../_governance/identity/app-registrations.md) の台帳に記録すること。
> ※組織設定で一般ユーザーのアプリ登録が無効化されている場合、手順1で「新規登録」が出ない。その場合は管理者ロールが必要(本文末尾の確認方法参照)

## 1. Entra ID アプリ登録(フル機能版: Graph連携まで見据えた設定)

1. [entra.microsoft.com](https://entra.microsoft.com) → 「アプリの登録」→「新規登録」
2. 設定値:
   - 名前: `Yoshimura-Portal`(例)
   - サポートされているアカウントの種類: **この組織ディレクトリのみ**(単一テナント)
   - リダイレクトURI: プラットフォーム「**シングルページ アプリケーション(SPA)**」で
     - 開発: `http://localhost:3100`(`localhost` のみ http 可。それ以外は https 必須)
     - 本番: 公開URL(決定後に追加。URIは完全一致で照合されるためワイルドカード不可)
   - SPAプラットフォームは 認可コードフロー + PKCE で動作する(暗黙的フローのチェックは不要。有効化しない)
3. 「APIのアクセス許可」で以下の **委任されたアクセス許可** を追加:
   | 権限 | 用途 |
   |---|---|
   | `User.Read` | サインインとプロフィール表示 |
   | `User.ReadBasic.All` | 社内メンバー検索(予約フォーム)。`GET /users` の最小権限(`User.Read.All` は過剰。基本プロフィールのみ読めれば足りる) |
   | `Calendars.ReadWrite` | 今日の予定表示・会議室予約の作成/変更/削除(`getSchedule` / `calendarView` は `Calendars.Read` 相当としてこれに包含) |
   | `Place.Read.All` | 会議室(拠点・部屋)一覧の取得 ※管理者同意が必要 |
4. 「管理者の同意を与えます」を実行(`Place.Read.All` が管理者同意必須のため。他3つはユーザー同意可能だが、初回サインイン時の同意画面を出さないよう一括で同意しておくのが運用上楽)
5. 管理画面のアクセス制御用に「アプリ ロール」を作成:
   - 表示名 / 値: `Portal.Admin`、許可されるメンバーの種類: ユーザー/グループ
   - 「エンタープライズ アプリケーション」→ ユーザーとグループ → 管理者にするユーザーへ `Portal.Admin` を割り当て

> **登録したら必ず [_governance/identity/app-registrations.md](../../_governance/identity/app-registrations.md) の台帳に記録すること。**
> クライアントシークレットは不要(SPA + 委任権限のため)。作らないこと。

## 2. ポータル側の設定

`Portal\.env` に設定して起動する(`.env.example` をコピー。環境変数でも同じ値を渡せるが、設定漏れしにくい `.env` を推奨):

```
AUTH_MODE=entra
TENANT_ID=<テナントID(ディレクトリID)>
CLIENT_ID=<アプリ登録のクライアントID>
```

- `public/js/auth.js` が MSAL.js(`@azure/msal-browser` **v5系**)を読み込み、Entra ID サインイン(リダイレクト方式)を行う
  - Microsoft CDN(`alcdn.msauth.net`)は v3 以降**廃止**。jsDelivr からバージョン固定(現在 `5.18.0`)で読み込んでいる。バージョンを上げるときは auth.js の URL を更新する
  - v3 以降は `PublicClientApplication` 生成後に `await initialize()` が必須(auth.js 実装済み)
- ⚠️ entraモードのコードパスは**実テナントでのアプリ登録が済むまで未検証**。切替時に動作確認すること
- サーバー側のトークン検証は**実装済み**(§4)。entraモードでは有効なアクセストークンのない全APIリクエストを401で拒否する(fail-closed)。例外は `/api/config` のみ(MSAL起動に必要な公開情報)。認証は `/api` プレフィックスへのミドルウェア一括適用(→ [P002](../../_governance/knowledge/patterns/P002_api-auth-middleware.md))

## 3. Graph API への置き換え(段階的)

現在ローカル実装している箇所と、置き換え先のGraphエンドポイント(ハンドオフREADME準拠):

| 現在(devモード) | 置き換え先 |
|---|---|
| 拠点・会議室マスタ(`rooms.js` の `SITES` / `ROOMS`) | `GET /places/microsoft.graph.room`(Room List) |
| 曜日パターンのダミー予約(`rooms.js` の `PATTERNS`) | `POST /me/calendar/getSchedule`(会議室メールアドレス指定) |
| ポータルの「今日の予定」ダミー(`portal.js` の `TODAY_EVENTS`) | `GET /me/calendarView?startDateTime=&endDateTime=` |
| 予約の作成(`POST /api/bookings`) | `POST /me/events`(会議室を `attendees` の `type: "resource"` で指定) |
| 予約の変更/取消(`PUT`/`DELETE /api/bookings/:id`) | `PATCH` / `DELETE /me/events/{id}` |
| 社内メンバー検索(`GET /api/users?q=`) | `GET /users?$search="displayName:{q}"`(※`$search` はリクエストヘッダー `ConsistencyLevel: eventual` が必須) |

実装方針(ハンドオフREADMEの指定):
- 同期方式は**リアルタイム取得**(表示中の月・会議室のみ都度取得)。定期バッチ同期は同期の谷間で二重予約が起きるため不可
- 主催者判定は `organizer` と `attendees` の照合で「主催 / 参加 / 無関係」を決定
- 変更・取消は主催者のみ(Exchange側でも主催者以外の削除は403)
- 管理者による代理削除が必要になったら: Room mailbox へのフルアクセス付与、または `Portal.Admin` ロール + アプリケーション権限。削除ログと主催者への通知をセットで用意する

## 4. サーバー側のトークン検証(実装済み)

**IDトークンをAPIのBearerに流用しない**(IDトークンはクライアントでのサインイン証明用で、API保護用ではない)。同じアプリ登録に自前APIのスコープを公開し、**アクセストークン**で保護する。以下は実装済み:

1. アプリ登録 → 「APIの公開」→ アプリケーションIDのURIを `api://<クライアントID>` に設定し、スコープ `access_as_user` を追加(同意可能: 管理者とユーザー)← ここだけAzure側の作業(§0手順2)
2. クライアント(`auth.js` の `getApiToken` + `common.js` の `api()`)はポータルAPI呼び出し時に `api://<クライアントID>/access_as_user` スコープでアクセストークンを取得し、`Authorization: Bearer <アクセストークン>` を自動付与する(Graph用トークンとは別物。混同しない)
3. サーバー(`server.js` の `verifyEntraToken`)は `jose` でJWTを検証する(手書き検証禁止):
   - 署名: JWKS `https://login.microsoftonline.com/<テナントID>/discovery/v2.0/keys`(`createRemoteJWKSet` が鍵のキャッシュ+ローテーション追従を行う)
   - `iss` = `https://login.microsoftonline.com/<テナントID>/v2.0`(**v2トークン前提。マニフェストの `requestedAccessTokenVersion: 2` が必須**)
   - `aud` = クライアントID または `api://<クライアントID>`
   - `scp` に `access_as_user` を含むこと、`exp`(joseが検証)
4. 検証済みクレームから `name` / `preferred_username`(メール)/ `roles`(Portal.Admin判定)を取得して `me()` の戻り値にする(部署はトークンに入らないため、当面メールを表示。Graph連携時に `/me` から取得予定)

管理画面のCRUD APIは `roles` に `Portal.Admin` が含まれるユーザーのみ許可する(実装済みの `requireAdmin` がそのまま使える)。
`roles` クレームは**アプリロールを割り当てたユーザーのトークンにしか入らない**(未割当ユーザーはクレーム自体が無い)点に注意。
トークン・クレームの内容をログに出力しないこと(統括ルール)。

## 付録: 自分のアカウントの管理者権限を確認する方法

1. [entra.microsoft.com](https://entra.microsoft.com) にサインイン → 左メニュー「ユーザー」→「すべてのユーザー」→ 自分の名前 → 「**割り当てられたロール**」
   - 「グローバル管理者」があれば全操作可能
   - 「アプリケーション管理者」「クラウド アプリケーション管理者」でもアプリ登録・管理者同意は可能
   - 何も表示されなければ一般ユーザー
2. 簡易確認: [admin.microsoft.com](https://admin.microsoft.com)(Microsoft 365 管理センター)が開ければ何らかの管理者ロールを持っている
3. 権限別にできること:
   | 操作 | 必要な権限 |
   |---|---|
   | アプリ登録の作成(§0) | 既定では**一般ユーザーでも可**(組織で無効化されていなければ) |
   | ログインテスト(§0)の同意 | 一般ユーザーで可(User.Read + access_as_user はユーザー同意可能) |
   | `Place.Read.All` 等の管理者同意(§1) | グローバル管理者 / 特権ロール管理者 / クラウド アプリケーション管理者 |
   | `Portal.Admin` アプリロールの割り当て | グローバル管理者 / アプリケーション管理者 等 |
