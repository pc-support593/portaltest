# 社内ポータル(Portal)

## 概要

社員向け社内ポータル。4画面: ポータルトップ(お知らせ・クイックリンク・予定)/ 会議室予約(拠点別カレンダー、サンプル)/ スケジュール(個人の実データ + 拠点別会議室のサンプルを1画面に)/ 管理画面(コンテンツCRUD)。
Claude Design のハンドオフ([design/README.md](design/README.md))を移植。**統括方針「Entra ID SSO + ポータル」構成のMS365実環境検証が目的**(→ ベンダー要件提示の説得材料)。Entra IDアプリ登録・サインイン・Graphでの個人予定連携は**実装済み・稼働中**。

## 技術スタック

- Node.js >= 24、Express 4、素のHTML/CSS/JS(ビルド工程なし)
- DB: `node:sqlite`(標準モジュール、WALモード)→ `data/portal.db`(webinputsystemと同方式)
- ポート: **3100**(webinputsystem が 3000 のため)
- 認証: `.env` で `AUTH_MODE=dev|entra` を切替(`.env.example` 参照)。entraモードはEntra ID(MSAL.js)+ サーバー側トークン検証(`jose`)。手順・権限は [docs/entra-setup.md](docs/entra-setup.md)
- Graph呼び出しは**ブラウザから直接**(`Auth.getGraphToken(scopes)`)。サーバーはポータル自前APIの認可のみ行い、Graphのアクセストークンを中継しない(シークレットレス設計を維持するため)

## 主要ファイル

- `server.js` — 全API(config/me/content/admin CRUD/users検索/bookings CRUD/layout)+ 静的配信 + entraモードのトークン検証
- `src/db.js` — スキーマ + ハンドオフ準拠のシードデータ
- `public/js/roomsData.js` — 拠点・会議室マスタ + 曜日パターンのダミー予約(純粋関数 `bookingsFor(roomId, date, extraBookings)`)。`rooms.js` と `schedule.js` の両方が読み込む共有データ。**マスタを変更するときはここ1箇所を直す**
- `public/js/rooms.js` — 会議室予約の全ロジック(カレンダー、予約フォーム、CSV出力)。会議室・予約自体は**サンプル表示のまま**(Exchangeの会議室リソースが未整備のため、ここでの操作はOutlook側には反映されない)。自分の予約はDB実データ(src/db.jsで初回シード)で、カレンダーチップのクリックまたは日別ポップアップから変更・取消できる(主催者のみ、サーバー側で強制)。予約フォームの参加者は「社内メンバー」(`searchMembers`。§共通ファイル参照)と「外部参加者」(`guests`。自由入力の別枠、社外顧客等)を分けて入力する
- `public/js/schedule.js` — スケジュール画面。**個人のスケジュールは実データ**(Graph `/me/calendarView` で表示、`/me/events` で作成)。予定作成フォームの参加者は`rooms.js`と同様に「社内メンバー」(`searchMembers`で検索・選択、メール確定→Outlookの`attendees`として招待)と「外部参加者」(`rooms.js`と同じくフリーワードの自由入力。メール不要のため招待はできず、Outlook予定の本文にメモとして記載)を分けて入力する。「会議室を使用する」をチェックすると拠点・会議室を選べ、`rooms.js`と同じ仕組み(サーバーSQLite保存・サンプル)で会議室を確保してからOutlookに反映する(重複時は409エラーで作成を中止。Outlook側の作成に失敗した場合は確保済みの会議室予約を`DELETE /api/bookings/:id`で自動的に取り消してロールバックする)。拠点別の会議室スケジュール表示(`siteGridHtml`)はメイン画面と予定作成モーダルの両方から呼ぶ共有関数
- `public/js/portal.js` — トップ画面。「今日の予定」も実データ(Graph `/me/calendarView`)。セクション配置はドラッグ&ドロップで並び替え可能(ドラッグハンドル`.drag-handle`のみ起点、ネイティブHTML5 DnD)。並び順は`/api/layout`でユーザー単位(email)にサーバー保存し、他端末でも同じ配置になる
- `public/js/auth.js` — 認証アダプタ(MSAL.js v5、SPA + PKCE)。`getGraphToken(scopes)` でGraph用トークンを取得
- `public/js/common.js` — 全画面共通ユーティリティ(`api()` / `esc()` 等)。`searchMembers(q)`(社内メンバー検索。entraモードはGraph `/users`実データ、devモードはダミー名簿`/api/users`)を`rooms.js`と`schedule.js`で共用

## 実装ルール

1. **デザインは design/README.md が正**(色・余白・挙動は確定値)。見た目を変えるときは必ず照合する。ZIP内プロトタイプはREADMEより古い版なので仕様の根拠にしない
2. マークアップはプロトタイプ準拠のインラインスタイル + hover/focusのみ `css/portal.css` のクラス。この方式を維持する
3. 動的テキストは必ず `esc()` を通す(XSS対策)
4. **実データ(Graph)とサンプル(ダミー)を画面上で必ず区別する**(バッジ表示: 「Outlook 連携」= 実データ、「サンプル表示」= ダミー)。ユーザーが誤って「本物」と誤解しないようにするため
5. 会議室予約(`rooms.js`)を実データ化する際は、Exchangeに実際の会議室リソースメールボックスが存在することを先に確認すること。存在しない状態でGraph連携すると空リストになるか失敗する
6. 予約の変更・取消は主催者のみ(サーバー側 `ownBooking` で強制。Exchangeと同じ制約)
7. Entra ID アプリ登録の設定を変更したら [_governance/identity/app-registrations.md](../_governance/identity/app-registrations.md) の記録も更新する(統括ルール)
8. Graph権限は都度最小限を追加する(現在: `User.Read`, `Calendars.ReadWrite`, `User.ReadBasic.All`, 自アプリの `access_as_user`)。このテナントは**低リスク権限でも管理者の同意が必須**な設定になっているため、権限追加のたびに管理者に同意実行を依頼する
9. 社内メンバー検索(`User.ReadBasic.All`)は基本プロフィールのみで部署(department)は取得できない。表示上も部署欄は空のままにする(過剰な権限要求をしない)

## 今後のロードマップ(統括計画)

1. ✅ プロジェクト化・devモードで4画面稼働
2. ✅ テスト用 Entra ID アプリ登録(台帳記録: Yoshimura-Portal)
3. ✅ MSALログイン有効化(`AUTH_MODE=entra`)+ サーバー側トークン検証(jose)
4. ✅ 個人の予定表連携(表示: `/me/calendarView`、作成: `/me/events`。会議室を含まない予定のみ)
5. 会議室予約の実データ化(Exchangeの会議室リソース整備が前提。§実装ルール5)
6. ✅ 社内メンバー検索の実データ化(`User.ReadBasic.All` + Graph `/users`。**Azure側でのAPI権限追加+管理者同意が未実施の場合は動作しない**。§0参照)
7. webinputsystem(経費精算)へのSSO遷移確認
