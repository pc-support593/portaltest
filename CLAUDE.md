# 社内ポータル(Portal)

## 概要

社員向け社内ポータル。4画面: ポータルトップ(お知らせ・クイックリンク・予定)/ 会議室予約(拠点別カレンダー、**デザインサンプルのまま**)/ スケジュール(個人 + 拠点別会議室、**両方実データ**)/ 管理画面(コンテンツCRUD)。
Claude Design のハンドオフ([design/README.md](design/README.md))を移植。**統括方針「Entra ID SSO + ポータル」構成のMS365実環境検証が目的**(→ ベンダー要件提示の説得材料)。Entra IDアプリ登録・サインイン・Graphでの個人予定連携・**実際のExchange会議室リソースとの連携は実装済み・稼働中**。

## 技術スタック

- Node.js >= 24、Express 4、素のHTML/CSS/JS(ビルド工程なし)
- DB: `node:sqlite`(標準モジュール、WALモード)→ `data/portal.db`(webinputsystemと同方式)
- ポート: **3100**(webinputsystem が 3000 のため)
- 認証: `.env` で `AUTH_MODE=dev|entra` を切替(`.env.example` 参照)。entraモードはEntra ID(MSAL.js)+ サーバー側トークン検証(`jose`)。手順・権限は [docs/entra-setup.md](docs/entra-setup.md)
- Graph呼び出しは**ブラウザから直接**(`Auth.getGraphToken(scopes)`)。サーバーはポータル自前APIの認可のみ行い、Graphのアクセストークンを中継しない(シークレットレス設計を維持するため)

## 主要ファイル

- `server.js` — 全API(config/me/content/admin CRUD/users検索/bookings CRUD/layout)+ 静的配信 + entraモードのトークン検証
- `src/db.js` — スキーマ + ハンドオフ準拠のシードデータ
- `public/js/roomsData.js` — **拠点・会議室マスタの単一の正**(実際のExchange会議室リソース。5拠点33室・email付き)。`rooms.js` と `schedule.js` の両方が読み込む(schedule.htmlとrooms.htmlの両方でscriptタグ読込。マスタが増減したらここ1箇所を直す)。あわせて `rooms.js` 用のダミー予約データと純粋関数 `bookingsFor(roomId, date, extraBookings)` を持つ。**schedule.js側で同名のconst(SITES/ROOMS等)を再宣言しないこと**(グローバル衝突でSyntaxErrorになる)。`bookingsFor` の期間別の返り値(ユーザー指示・2026-08-21):
  - **〜2026-06-30**: 曜日パターンのダミー `PATTERNS` + 実予約(サーバーSQLite)
  - **2026-07-01〜2026-08-23**: `SAMPLE_HISTORY`(1日1〜5件・固定シードで一度だけ生成したフローズンなランダムサンプル。再生成しない)**のみ**。実予約は反映せず、`rooms.js`側のフォームでも予約操作不可(`formError`でブロック)
  - **2026-08-24〜**: 実予約(サーバーSQLite)**のみ**。曜日パターンのダミーは適用しない(=この日以降は実際に作成・変更・取消した予約がそのまま反映される)
- `public/js/rooms.js` — 会議室予約の全ロジック(カレンダー、予約フォーム、CSV出力)。**拠点・会議室名は実際のExchange会議室(roomsData.jsのマスタ)を表示**。予約データは上記`bookingsFor`の期間別ルールに従う(**Outlook/Exchangeへは連携しない。あくまでポータル内のSQLite保存**。rule 5参照)。自分の予約はDB実データ(src/db.jsで初回シード。旧ダミー会議室IDからの移行は db.js の ROOM_ID_MIGRATION)で、カレンダーチップのクリックまたは日別ポップアップから変更・取消できる(2026-08-24以降の日付のみ。8/23以前はサンプル期間のため操作不可)。予約フォームの参加者は「社内メンバー」(`searchMembers`。§共通ファイル参照)と「外部参加者」(`guests`。自由入力の別枠、社外顧客等)を分けて入力する
- `public/js/schedule.js` — スケジュール画面。**個人のスケジュール・拠点別の会議室スケジュールとも実データ**。
  - 個人: Graph `/me/calendarView` で表示、`/me/events` で作成
  - 会議室マスタ: ファイル冒頭の `SITES`/`ROOMS_NAMES_BY_SITE` に**実際のExchange会議室リソースをハードコード**(5拠点33室。平野9・花博7・西宮9・中百舌鳥6・福田2。ドメインは`yumesumika.com`)。マスタが増減したら Exchange 管理者に確認しこの配列を直す(`Get-Mailbox -RecipientTypeDetails RoomMailbox` で最新一覧を取得できる)。Graph `Place.Read.All` は使わない設計(ハードコード運用と決定済み)ため不要
  - 空き状況: `fetchRoomBusy()` が `POST /me/calendar/getSchedule` を33室ぶんまとめて1回で呼び、`state.roomBusy`(roomId→busy配列)に格納。件名(`subject`)はExchangeの既定の空き時間共有設定により**表示されない場合がある**(取得できた場合のみ表示。取得できなくても時間帯は正しい)
  - 予約作成: 「会議室を使用する」チェック時、選択した会議室を `attendees` に `type: "resource"` で追加して `POST /me/events`。**Exchange側が空きなら自動承諾・埋まっていれば自動辞退する本物の予約**(サンプルではない。サーバー側のSQLite保存は使わない)。場所は `locationEmailAddress` で会議室本体と紐づける(文字列だけだと自動承諾時に場所が二重表記になる)
  - 重複の事前チェック: 送信直前に `fetchRoomBusy` で最新の空き状況を取り直し、重複していたら**予定自体を作らずエラー表示**(変更時は自分の元の時間帯を重複扱いしない)。すり抜けた場合の最終判定はExchange(自動辞退。ただし主催者の予定表には残る=Outlook標準挙動)
  - 会議室が未承諾の予定は「承諾待ち」バッジ+半透明で表示(getScheduleの `tentative`)。全33室は `AutoAccept` + `AllowConflicts: False` 設定済み(Exchange側)
  - **既知の制約(2026-08-21確認)**: Exchange側が**過去日時の会議室予約を処理しない**(会議室が出席者として一切追加されず、`getSchedule`でも常に空きのまま)。ポータル側のコードには過去日時を防ぐ処理がなく、検証時は必ず未来の時間帯で予約すること
  - 拠点別の会議室スケジュール表示(`siteGridHtml`)はメイン画面用。予定作成モーダル内は `freeRoomsHtml`(選択中の拠点・時間帯で**空いている会議室だけ**をチップ表示・縦スクロール。クリックで選択、開始/終了/拠点の変更に追随。ユーザー指示 2026-08-21)。**会議室のプルダウンは無し**: 「会議室」欄は読み取り専用の表示欄で、チップのクリックでのみ選択される(直接入力・自動選択なし。拠点を切り替えると選択はクリアされる)。予定作成フォームの参加者は`rooms.js`と同様に「社内メンバー」(`searchMembers`)と「外部参加者」(自由入力、Outlook本文にメモ記載)を分けて入力する
- `public/js/portal.js` — トップ画面。「今日の予定」も実データ(Graph `/me/calendarView`)。お知らせのトップ表示ルール(ユーザー指示 2026-08-21): **掲載期限(`expires`。管理画面で入力)があればその日まで表示**、未入力なら掲載日が過ぎたら非表示(日付なしは表示継続)。過去分は「すべて見る」の一覧モーダル(`openNewsListModal`。全件・新しい順)から見る。セクション配置はドラッグ&ドロップで並び替え可能(ドラッグハンドル`.drag-handle`のみ起点、ネイティブHTML5 DnD)。並び順は`/api/layout`でユーザー単位(email)にサーバー保存し、他端末でも同じ配置になる
- `public/js/auth.js` — 認証アダプタ(MSAL.js v5、SPA + PKCE)。`getGraphToken(scopes)` でGraph用トークンを取得
- `public/js/common.js` — 全画面共通ユーティリティ(`api()` / `esc()` 等)。`searchMembers(q)`(社内メンバー検索。entraモードはGraph `/users`実データ、devモードはダミー名簿`/api/users`)を`rooms.js`と`schedule.js`で共用

## 実装ルール

1. **デザインは design/README.md が正**(色・余白・挙動は確定値)。見た目を変えるときは必ず照合する。ZIP内プロトタイプはREADMEより古い版なので仕様の根拠にしない
2. マークアップはプロトタイプ準拠のインラインスタイル + hover/focusのみ `css/portal.css` のクラス。この方式を維持する
3. 動的テキストは必ず `esc()` を通す(XSS対策)
4. **実データ(Graph)とサンプル(ダミー)を画面上で必ず区別する**(バッジ表示: 「Outlook 連携」「Exchange 連携」= 実データ、「サンプル表示」「デザインサンプル」= ダミー)。ユーザーが誤って「本物」と誤解しないようにするため
5. `rooms.js`(デザインサンプル)は**ユーザーの明示的な指示により実データ化しない**。会議室の実データ連携が必要な画面は `schedule.js` 側に実装する(2画面で役割が分かれている)
6. **サンプルデータの削除禁止(ユーザー指示・2026-08-20)**: 仮のサンプルデータ(`roomsData.js`、`src/db.js`のシード、rooms.html一式、devモードの各ダミー)は、ユーザーから明示的に依頼されない限り削除しない。リファクタリングでも実データとの並存を維持する
7. サンプル画面(rooms.html)の予約は**一旦、サインイン済みなら誰でも変更・取消可能**(ユーザー指示 2026-08-20。シードされたサンプル予約も編集できるようにするため。サーバー側 `ownBooking` の主催者チェックをコメントアウト中)。実データ化する際は主催者のみに戻す。スケジュール画面(実データ)の変更・削除は主催者のみ(Graph/Exchange側で強制される)
8. Entra ID アプリ登録の設定を変更したら [_governance/identity/app-registrations.md](../_governance/identity/app-registrations.md) の記録も更新する(統括ルール)
9. Graph権限は都度最小限を追加する(現在: `User.Read`, `Calendars.ReadWrite`, `User.ReadBasic.All`, `Calendars.ReadWrite.Shared`(拠点代表者の会議室削除機能用。§12参照)、自アプリの `access_as_user`。`Place.Read.All`は不使用)。このテナントは**低リスク権限でも管理者の同意が必須**な設定になっているため、権限追加のたびに管理者に同意実行を依頼する
10. 社内メンバー検索(`User.ReadBasic.All`)は基本プロフィールのみで部署(department)は取得できない。表示上も部署欄は空のままにする(過剰な権限要求をしない)
11. **自動リフレッシュの共通方針(ユーザー承認・2026-08-20)**: 動的データの表示は「2分間隔で裏側から再取得・モーダル表示中と非表示タブ(document.hidden)はスキップ・差分があるときだけ静かに差し替え(自動更新時はローディング表示を出さない)・失敗は静かに無視して次回再試行」。実装済み: portal.js(今日の予定)・schedule.js(個人+拠点別)・rooms.js(サンプル予約)。**今後、動的表示を新設するときも同方針を適用する**
12. **拠点代表者による会議室予約の削除機能(2026-08-20)**: `schedule.js` 冒頭の `SITE_REPS`(拠点ID→担当者メール配列)を直接編集して運用する。担当拠点は `siteGridHtml` に「担当拠点」バッジ+各予約に削除ボタンが出る。**未完了の前提条件**: ① `SITE_REPS` に実際の担当者メールを入力、② Exchange側で担当者に各会議室カレンダーの編集権限を付与(`Add-MailboxFolderPermission -Identity "<会議室>:\Calendar" -User <担当者> -AccessRights Editor`)、③ Entra側アプリに `Calendars.ReadWrite.Shared`(委任)を追加+管理者の同意。3つとも揃わないと削除ボタンが出ない/押しても失敗する

## 今後のロードマップ(統括計画)

1. ✅ プロジェクト化・devモードで4画面稼働
2. ✅ テスト用 Entra ID アプリ登録(台帳記録: Yoshimura-Portal)
3. ✅ MSALログイン有効化(`AUTH_MODE=entra`)+ サーバー側トークン検証(jose)
4. ✅ 個人の予定表連携(表示: `/me/calendarView`、作成: `/me/events`。会議室を含まない予定のみ)
5. ✅ 会議室の実データ化(`schedule.js`。5拠点33室の実Exchangeリソース+`getSchedule`+resource出席者予約)。`rooms.js`はデザインサンプルとして意図的に凍結
6. ✅ 社内メンバー検索の実データ化(`User.ReadBasic.All` + Graph `/users`。**Azure側でのAPI権限追加+管理者同意が未実施の場合は動作しない**。§0参照)
7. webinputsystem(経費精算)へのSSO遷移確認
